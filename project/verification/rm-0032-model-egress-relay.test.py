"""Offline tests: fake DNS/dials/streams; no credentials or network access."""
import asyncio
import importlib.util
import pathlib
import socket
import unittest
from unittest.mock import AsyncMock, Mock, patch

SPEC = importlib.util.spec_from_file_location("relay", pathlib.Path(__file__).with_name("rm-0032-model-egress-relay.py"))
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)


def request(authority="chatgpt.com:443", extra=b""):
    return (f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n".encode()
            + extra + b"\r\n")


class Writer:
    def __init__(self):
        self.data = bytearray()
        self.eof = False
        self.closed = False
        self.transport = Mock()

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        await asyncio.sleep(0)

    def write_eof(self):
        self.eof = True

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass


def reader(data=b"", eof=True):
    stream = asyncio.StreamReader(limit=relay.MAX_HEADER)
    stream.feed_data(data)
    if eof:
        stream.feed_eof()
    return stream


class Parsing(unittest.TestCase):
    def test_exact_authorities_and_supported_standard_headers(self):
        for authority, host in relay.AUTHORITIES.items():
            self.assertEqual(relay.parse_connect(request(authority)), host)
            self.assertEqual(relay.parse_connect(request(authority,
                b"User-Agent: offline-fixture\r\nProxy-Connection: keep-alive\r\n")), host)

    def test_authority_bypasses_refused(self):
        for authority in ("chatgpt.com", "CHATGPT.com:443", "chatgpt.com.:443",
                          "chatgpt.com:0443", "chatgpt.com:80", "auth.openai.com:444",
                          "user@chatgpt.com:443", "127.0.0.1:443", "[::1]:443",
                          "chatgpt.com.attacker.test:443", "chatgpt.com:443/",
                          "https://chatgpt.com:443", "chatgpt.com:443#x"):
            with self.subTest(authority=authority), self.assertRaises(relay.Refused):
                relay.parse_connect(request(authority))

    def test_methods_and_header_ambiguity_refused(self):
        variants = [request().replace(b"CONNECT", method) for method in (b"GET", b"connect", b"POST")]
        variants += [request().replace(b"HTTP/1.1", b"HTTP/1.0"),
                     request().replace(b"CONNECT ", b"CONNECT  "),
                     request().replace(b"\r\n", b"\n"),
                     request().replace(b"Host:", b" Host:"),
                     request().replace(b"Host:", b"Host :"),
                     request().replace(b"Host: chatgpt.com:443\r\n", b""),
                     request().replace(b"Host: chatgpt.com", b"Host: auth.openai.com"),
                     request(extra=b"hOsT: chatgpt.com:443\r\n"),
                     request(extra=b"Content-Length: 0\r\n"),
                     request(extra=b"Transfer-Encoding: chunked\r\n"),
                     request(extra=b"Proxy-Authorization: fixture\r\n"),
                     request(extra=b"Connection: upgrade\r\n"),
                     request(extra=b"User-Agent: a\r\nuser-agent: b\r\n"),
                     request(extra=b"User-Agent: a\x00b\r\n"),
                     request(extra=b"User-Agent: a\tb\r\n"),
                     request(extra=b"User-Agent: \xff\r\n"),
                     request(extra=b"User-Agent: " + b"x" * relay.MAX_HEADER + b"\r\n"),
                     request() + b"payload"]
        for index, value in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(relay.Refused):
                relay.parse_connect(value)

    def test_address_set_must_be_entirely_global(self):
        public = [socket.AF_INET, "8.8.8.8"]
        self.assertEqual(relay.validate_addresses([public, public]), [(socket.AF_INET, "8.8.8.8")])
        for raw in ("127.0.0.1", "0.0.0.0", "10.0.0.1", "192.168.0.1", "169.254.169.254",
                    "100.64.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255", "240.0.0.1",
                    "::1", "::", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
                    "::ffff:8.8.8.8", "2002:0808:0808::1", "fe80::1%eth0"):
            family = socket.AF_INET6 if ":" in raw else socket.AF_INET
            with self.subTest(raw=raw), self.assertRaises(relay.Refused):
                relay.validate_addresses([public, [family, raw]])
        for invalid in ([], [public] * 33, [[True, "8.8.8.8"]], [[socket.AF_INET6, "8.8.8.8"]],
                        [[socket.AF_INET, "chatgpt.com"]], [[socket.AF_INET, "010.0.0.1"]]):
            with self.assertRaises(relay.Refused):
                relay.validate_addresses(invalid)


class AsyncChecks(unittest.IsolatedAsyncioTestCase):
    async def test_allowed_request_preserves_buffered_tunnel_bytes(self):
        resolver = AsyncMock(return_value=[(socket.AF_INET, "8.8.8.8")])
        remote_writer = Writer()
        connector = AsyncMock(return_value=(reader(b"synthetic-response"), remote_writer))
        service = relay.Relay(resolver=resolver, connector=connector)
        local_writer = Writer()
        await service.handle(reader(request() + b"synthetic-pipelined-tunnel"), local_writer)
        resolver.assert_awaited_once_with("chatgpt.com")
        connector.assert_awaited_once_with([(socket.AF_INET, "8.8.8.8")])
        self.assertEqual(remote_writer.data, b"synthetic-pipelined-tunnel")
        self.assertTrue(local_writer.data.endswith(b"synthetic-response"))
        self.assertTrue(local_writer.closed and remote_writer.closed)
        self.assertEqual(service.counts["completed"], 1)

    async def test_refused_request_never_resolves_or_dials(self):
        resolver, connector = AsyncMock(), AsyncMock()
        service = relay.Relay(resolver=resolver, connector=connector)
        output = Writer()
        await service.handle(reader(request("example.test:443")), output)
        resolver.assert_not_awaited()
        connector.assert_not_awaited()
        self.assertTrue(output.data.startswith(b"HTTP/1.1 403"))
        self.assertTrue(output.closed)

    async def test_partial_and_overlimit_headers_never_dial(self):
        for stream in (reader(b"CONNECT"), reader(b"x" * (relay.MAX_HEADER + 1))):
            connector = AsyncMock()
            service = relay.Relay(connector=connector)
            await service.handle(stream, Writer())
            connector.assert_not_awaited()
            self.assertEqual(service.counts["refused"], 1)

    async def test_header_deadline(self):
        service = relay.Relay(resolver=AsyncMock())
        with patch.object(relay, "HEADER_SECONDS", 0.01):
            await service.handle(reader(b"CONNECT", eof=False), Writer())
        self.assertEqual(service.counts["refused"], 1)
        service.resolver.assert_not_awaited()

    async def test_half_close_retains_delayed_reverse_response(self):
        left, right = reader(b"request"), reader(eof=False)
        left_out, right_out = Writer(), Writer()
        task = asyncio.create_task(relay.tunnel(left, left_out, right, right_out))
        for _ in range(5):
            await asyncio.sleep(0)
        self.assertTrue(right_out.eof)
        self.assertFalse(task.done())
        right.feed_data(b"delayed-response")
        right.feed_eof()
        moved = await task
        self.assertEqual(left_out.data, b"delayed-response")
        self.assertEqual(moved, len(b"requestdelayed-response"))

    async def test_tunnel_byte_idle_and_absolute_bounds(self):
        with self.assertRaises(relay.Refused):
            await relay.tunnel(reader(b"oversized"), Writer(), reader(), Writer(), byte_limit=3)
        with self.assertRaises(TimeoutError):
            await relay.tunnel(reader(eof=False), Writer(), reader(eof=False), Writer(), idle_seconds=0.01)
        with self.assertRaises(TimeoutError):
            await relay.tunnel(reader(eof=False), Writer(), reader(eof=False), Writer(), duration=0.01)

    async def test_mixed_dns_results_refused_before_dial(self):
        service = relay.Relay(resolver=AsyncMock(return_value=[(socket.AF_INET, "8.8.8.8"),
                                                             (socket.AF_INET, "127.0.0.1")]),
                              connector=AsyncMock())
        await service.handle(reader(request()), Writer())
        service.connector.assert_not_awaited()

    async def test_numeric_connector_uses_numeric_endpoint_only(self):
        sock = Mock()
        loop = asyncio.get_running_loop()
        pair = (reader(), Writer())
        with patch.object(relay.socket, "socket", return_value=sock), \
             patch.object(loop, "sock_connect", new_callable=AsyncMock) as dial, \
             patch.object(relay.asyncio, "open_connection", new_callable=AsyncMock, return_value=pair), \
             patch.object(relay.socket, "getaddrinfo", side_effect=AssertionError("must not resolve")):
            result = await relay.connect_numeric([(socket.AF_INET, "8.8.8.8")])
        self.assertIs(result, pair)
        dial.assert_awaited_once_with(sock, ("8.8.8.8", 443))
        sock.close.assert_not_called()

    async def test_failed_numeric_dial_closes_socket(self):
        sock = Mock()
        loop = asyncio.get_running_loop()
        with patch.object(relay.socket, "socket", return_value=sock), \
             patch.object(loop, "sock_connect", new_callable=AsyncMock, side_effect=OSError()), \
             self.assertRaises(relay.Refused):
            await relay.connect_numeric([(socket.AF_INET, "8.8.8.8")])
        sock.close.assert_called_once()

    async def test_dns_child_single_resolution_and_pipe_result(self):
        proc = Mock(returncode=0, stdout=reader(b'[[2,"8.8.8.8"]]'))
        proc.wait = AsyncMock(return_value=0)
        with patch.object(relay.asyncio, "create_subprocess_exec", new_callable=AsyncMock,
                          return_value=proc) as spawn:
            self.assertEqual(await relay.resolve_once("chatgpt.com"), [(socket.AF_INET, "8.8.8.8")])
        self.assertEqual(spawn.await_count, 1)
        self.assertEqual(spawn.call_args.args[-1], "chatgpt.com")
        self.assertEqual(relay.DNS_WORKER.count("socket.getaddrinfo("), 1)
        self.assertNotIn("__file__", relay.DNS_WORKER)
        proc.kill.assert_not_called()

    async def test_dns_timeout_kills_and_reaps_child(self):
        proc = Mock(returncode=None, stdout=reader(eof=False))
        proc.wait = AsyncMock(return_value=-9)
        with patch.object(relay, "DNS_SECONDS", 0.01), \
             patch.object(relay.asyncio, "create_subprocess_exec", new_callable=AsyncMock, return_value=proc), \
             self.assertRaises(relay.Refused):
            await relay.resolve_once("chatgpt.com")
        proc.kill.assert_called_once()
        proc.wait.assert_awaited_once()

    async def test_dns_fragmented_output_and_invalid_results(self):
        fragmented = Mock()
        fragmented.read = AsyncMock(side_effect=[b'[[2,"8.', b'8.8.8"]]', b''])
        proc = Mock(returncode=0, stdout=fragmented)
        proc.wait = AsyncMock(return_value=0)
        with patch.object(relay.asyncio, "create_subprocess_exec", new_callable=AsyncMock, return_value=proc):
            self.assertEqual(await relay.resolve_once("chatgpt.com"), [(socket.AF_INET, "8.8.8.8")])
        for payload in (b'not-json', b'[[2,"127.0.0.1"]]', b'[]', b'x' * 8193):
            proc = Mock(returncode=0, stdout=reader(payload))
            proc.wait = AsyncMock(return_value=0)
            with patch.object(relay.asyncio, "create_subprocess_exec", new_callable=AsyncMock, return_value=proc), \
                 self.assertRaises(relay.Refused):
                await relay.resolve_once("chatgpt.com")

    async def test_cancellation_closes_both_tunnel_sockets(self):
        remote_out, local_out = Writer(), Writer()
        service = relay.Relay(resolver=AsyncMock(return_value=[(socket.AF_INET, "8.8.8.8")]),
                              connector=AsyncMock(return_value=(reader(eof=False), remote_out)))
        task = asyncio.create_task(service.handle(reader(request(), eof=False), local_out))
        for _ in range(8):
            await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(remote_out.closed and local_out.closed)
        self.assertEqual(service.counts["cancelled"], 1)

    async def test_concurrent_directions_share_one_byte_budget(self):
        with self.assertRaises(relay.Refused):
            await relay.tunnel(reader(b"aaaa"), Writer(), reader(b"bbbb"), Writer(), byte_limit=7)

    async def test_shutdown_accept_guard_and_unexpected_error_counter(self):
        service = relay.Relay()
        service.closing = True
        output = Writer()
        service.accept(reader(), output)
        output.transport.abort.assert_called_once()
        self.assertFalse(service.tasks)
        async def fail():
            raise RuntimeError("synthetic not for logs")
        task = asyncio.create_task(fail())
        service.tasks.add(task)
        await asyncio.gather(task, return_exceptions=True)
        service.finished(task)
        self.assertEqual(service.counts["internal_error"], 1)
        self.assertFalse(service.tasks)

    async def test_dns_cancellation_kills_and_reaps_child(self):
        proc = Mock(returncode=None, stdout=reader(eof=False))
        proc.wait = AsyncMock(return_value=-9)
        with patch.object(relay.asyncio, "create_subprocess_exec", new_callable=AsyncMock, return_value=proc):
            task = asyncio.create_task(relay.resolve_once("chatgpt.com"))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        proc.kill.assert_called_once()
        proc.wait.assert_awaited_once()

    async def test_connection_caps_abort_without_new_worker(self):
        service = relay.Relay()
        for _ in range(relay.MAX_CONCURRENT):
            service.accept(reader(eof=False), Writer())
        excess = Writer()
        service.accept(reader(eof=False), excess)
        excess.transport.abort.assert_called_once()
        self.assertEqual(len(service.tasks), relay.MAX_CONCURRENT)
        tasks = list(service.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        service.counts["accepted"] = relay.MAX_ACCEPTED
        excess2 = Writer()
        service.accept(reader(), excess2)
        excess2.transport.abort.assert_called_once()

    async def test_server_fixed_bind_readiness_and_cleanup(self):
        server = Mock()
        server.wait_closed = AsyncMock()
        stop = asyncio.Event()
        service = relay.Relay()
        def ready():
            self.assertIs(service.server, server)
            stop.set()
        with patch.object(relay.asyncio, "start_server", new_callable=AsyncMock, return_value=server) as bind:
            await service.serve(1, stop, ready)
        self.assertEqual(bind.call_args.args[1:], ("127.0.0.2", 18443))
        self.assertFalse(bind.call_args.kwargs["reuse_address"])
        server.close.assert_called_once()
        server.wait_closed.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
