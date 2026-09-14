"""Bounded opaque CONNECT relay; deployment/credential isolation belongs to launcher.

No TLS inspection: allowed authorities do not constrain encrypted HTTP paths or
prove the tunnel's TLS identity. The caller must authenticate server TLS normally.
Only fixed readiness/status counters are emitted; never print caught exceptions.
"""
import argparse
import asyncio
import ipaddress
import json
import signal
import socket
import sys
import time

LISTEN = ("127.0.0.2", 18443)
AUTHORITIES = {"chatgpt.com:443": "chatgpt.com", "auth.openai.com:443": "auth.openai.com"}
MAX_HEADER = 8192
HEADER_SECONDS = 10
CONNECT_SECONDS = 10
DNS_SECONDS = 10
MAX_ADDRESSES = 32
MAX_CONCURRENT = 8
MAX_ACCEPTED = 64
MAX_LIFETIME = 900
MAX_TUNNEL_SECONDS = 300
IDLE_SECONDS = 60
MAX_TUNNEL_BYTES = 32 * 1024 * 1024
CHUNK = 16384


class Refused(Exception):
    """Fixed failure class; never contains untrusted text."""


def parse_connect(header):
    """Require one unambiguous authority, no bodies/auth or extension headers."""
    if len(header) > MAX_HEADER or not header.endswith(b"\r\n\r\n"):
        raise Refused()
    try:
        text = header.decode("ascii")
    except UnicodeDecodeError:
        raise Refused() from None
    lines = text[:-4].split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT" or parts[2] != "HTTP/1.1":
        raise Refused()
    authority = parts[1]
    if authority not in AUTHORITIES:
        raise Refused()
    headers = {}
    for line in lines[1:]:
        if ":" not in line or any(ord(c) < 32 or ord(c) > 126 for c in line):
            raise Refused()
        key, value = line.split(":", 1)
        key = key.lower()
        if key not in {"host", "user-agent", "proxy-connection", "connection"} or key in headers:
            raise Refused()
        value = value.strip(" ")
        if not value or (key in {"connection", "proxy-connection"} and value != "keep-alive"):
            raise Refused()
        headers[key] = value
    if headers.get("host") != authority:
        raise Refused()
    return AUTHORITIES[authority]


def validate_addresses(records):
    """Reject the entire resolution if any address is not plain global unicast."""
    if not isinstance(records, list) or not 1 <= len(records) <= MAX_ADDRESSES:
        raise Refused()
    approved = []
    for record in records:
        if not isinstance(record, list) or len(record) != 2:
            raise Refused()
        family, raw = record
        if not isinstance(family, int) or isinstance(family, bool) or family not in (socket.AF_INET, socket.AF_INET6):
            raise Refused()
        if not isinstance(raw, str) or "%" in raw:
            raise Refused()
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            raise Refused() from None
        if (address.version != (4 if family == socket.AF_INET else 6)
                or not address.is_global or address.is_private or address.is_reserved
                or address.is_loopback or address.is_link_local or address.is_multicast
                or address.is_unspecified
                or (address.version == 6 and (address.ipv4_mapped is not None
                                             or address.sixtofour is not None
                                             or address.teredo is not None))):
            raise Refused()
        item = (family, str(address))
        if item not in approved:
            approved.append(item)
    return approved


DNS_WORKER = """import json,socket,sys
try:
    if sys.argv[1] not in ('chatgpt.com','auth.openai.com'): raise ValueError()
    infos=socket.getaddrinfo(sys.argv[1],443,type=socket.SOCK_STREAM,proto=socket.IPPROTO_TCP)
    if not 1 <= len(infos) <= 32: raise ValueError()
    records=[[family,sockaddr[0]] for family,kind,proto,canon,sockaddr in infos]
    sys.stdout.write(json.dumps(records,separators=(',',':')))
except (OSError,ValueError):
    sys.exit(2)
"""


async def resolve_once(host):
    if host not in AUTHORITIES.values():
        raise Refused()
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-I", "-S", "-B", "-c", DNS_WORKER, host,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, limit=8192,
        env={"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"}, close_fds=True)
    try:
        async with asyncio.timeout(DNS_SECONDS):
            # A fixed child can produce at most 32 numeric addresses; also bound
            # reading independently in case a deployment integrity check fails.
            output = bytearray()
            while True:
                chunk = await process.stdout.read(8193 - len(output))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 8192:
                    raise Refused()
            await process.wait()
        if process.returncode != 0:
            raise Refused()
        return validate_addresses(json.loads(output))
    except (TimeoutError, ValueError, UnicodeDecodeError):
        raise Refused() from None
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()


async def connect_numeric(addresses):
    """Do not hand a hostname to the connector and never re-resolve on failure."""
    addresses = validate_addresses([list(item) for item in addresses])
    loop = asyncio.get_running_loop()
    async with asyncio.timeout(CONNECT_SECONDS):
        for family, address in addresses:
            sock = socket.socket(family, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            sock.setblocking(False)
            try:
                endpoint = (address, 443) if family == socket.AF_INET else (address, 443, 0, 0)
                # CPython's sock_connect detects numeric inet_pton addresses,
                # bypassing getaddrinfo. Family/address were validated above.
                await loop.sock_connect(sock, endpoint)
                return await asyncio.open_connection(sock=sock, limit=CHUNK)
            except OSError:
                sock.close()
            except BaseException:
                sock.close()
                raise
    raise Refused()


async def close_writer(writer):
    if writer is None:
        return
    writer.close()
    try:
        async with asyncio.timeout(1):
            await writer.wait_closed()
    except (OSError, TimeoutError):
        writer.transport.abort()


async def tunnel(left_reader, left_writer, right_reader, right_writer, *,
                 byte_limit=MAX_TUNNEL_BYTES, idle_seconds=IDLE_SECONDS,
                 duration=MAX_TUNNEL_SECONDS):
    """Bounded bidirectional copy with backpressure and independent half-closes."""
    moved = 0
    last_progress = time.monotonic()

    async def copy(reader, writer):
        nonlocal moved, last_progress
        while True:
            data = await reader.read(CHUNK)
            if not data:
                writer.write_eof()
                await writer.drain()
                return
            moved += len(data)
            if moved > byte_limit:
                raise Refused()
            writer.write(data)
            await writer.drain()
            last_progress = time.monotonic()

    async def idle_watch():
        while True:
            remaining = idle_seconds - (time.monotonic() - last_progress)
            if remaining <= 0:
                raise TimeoutError()
            await asyncio.sleep(min(remaining, 0.5))

    tasks = [asyncio.create_task(copy(left_reader, right_writer)),
             asyncio.create_task(copy(right_reader, left_writer)),
             asyncio.create_task(idle_watch())]
    pending_copies = set(tasks[:2])
    try:
        async with asyncio.timeout(duration):
            while pending_copies:
                done, _ = await asyncio.wait(pending_copies | {tasks[2]},
                                             return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                    pending_copies.discard(task)
        return moved
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


class Relay:
    """One bounded server. Injected resolver/connector are offline test seams."""
    def __init__(self, *, resolver=resolve_once, connector=connect_numeric):
        self.resolver = resolver
        self.connector = connector
        self.tasks = set()
        self.server = None
        self.closing = False
        self.counts = {key: 0 for key in
                       ("accepted", "over_limit", "refused", "connected", "completed", "failed", "cancelled", "internal_error")}

    def finished(self, task):
        self.tasks.discard(task)
        # Retrieve all exceptions so asyncio never logs a traceback containing
        # caller data. Unexpected errors remain visible as fixed counters.
        if not task.cancelled() and task.exception() is not None:
            self.counts["internal_error"] += 1

    def accept(self, reader, writer):
        if self.closing or len(self.tasks) >= MAX_CONCURRENT or self.counts["accepted"] >= MAX_ACCEPTED:
            self.counts["over_limit"] += 1
            writer.transport.abort()
            return
        self.counts["accepted"] += 1
        task = asyncio.create_task(self.handle(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.finished)

    async def handle(self, reader, writer):
        remote_writer = None
        established = False
        try:
            async with asyncio.timeout(HEADER_SECONDS):
                header = await reader.readuntil(b"\r\n\r\n")
                host = parse_connect(header)
            addresses = await self.resolver(host)
            # Validate even injected resolver results before any network dial.
            addresses = validate_addresses([list(item) for item in addresses])
            remote_reader, remote_writer = await self.connector(addresses)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            established = True
            async with asyncio.timeout(HEADER_SECONDS):
                await writer.drain()
            self.counts["connected"] += 1
            await tunnel(reader, writer, remote_reader, remote_writer)
            self.counts["completed"] += 1
        except asyncio.CancelledError:
            self.counts["cancelled"] += 1
            raise
        except (Refused, OSError, TimeoutError, ValueError, asyncio.IncompleteReadError,
                asyncio.LimitOverrunError):
            self.counts["failed" if established else "refused"] += 1
            if not established:
                writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                try:
                    async with asyncio.timeout(1):
                        await writer.drain()
                except (OSError, TimeoutError):
                    pass
        finally:
            await close_writer(remote_writer)
            await close_writer(writer)

    async def serve(self, lifetime=MAX_LIFETIME, stop=None, ready=None):
        if type(lifetime) is not int or not 1 <= lifetime <= MAX_LIFETIME:
            raise ValueError("invalid lifetime")
        stop = stop or asyncio.Event()
        self.server = await asyncio.start_server(self.accept, *LISTEN, limit=MAX_HEADER,
                                                 backlog=MAX_CONCURRENT, reuse_address=False)
        try:
            if ready:
                ready()
            try:
                async with asyncio.timeout(lifetime):
                    await stop.wait()
            except TimeoutError:
                pass
        finally:
            self.closing = True
            self.server.close()
            await self.server.wait_closed()
            tasks = list(self.tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        return dict(self.counts)


async def run(lifetime):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    relay = Relay()
    counts = await relay.serve(lifetime, stop, lambda: print('{"event":"ready","version":1}', flush=True))
    print(json.dumps({"version": 1, "settled": True, "counters": counts}, sort_keys=True), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lifetime", type=int, default=MAX_LIFETIME, choices=range(1, MAX_LIFETIME + 1))
    args = parser.parse_args()
    try:
        asyncio.run(run(args.lifetime))
    except (OSError, RuntimeError, ValueError):
        print('{"version":1,"settled":false,"outcome":"relay_failed"}', flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
