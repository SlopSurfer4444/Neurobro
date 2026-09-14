"""Bounded guest controller for real-credential open-only custody probes.

Run as guest root from a source-bound host packet. No credential bytes or raw
App Server frames are read or retained by this controller.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

ROOT = Path('/run/decadans-managed-custody-20260910-v2')
AUTH = '/var/lib/decadans-neurobro-codex-auth-v1'
BINARY = Path('/opt/decadans-neurobro-codex-v0.153.4/vendor/x86_64-unknown-linux-musl/bin/codex')
BINARY_SHA = '56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da'
RELAY = 'decadans-managed-relay-20260910-v2.service'
CLIENT = 'decadans-managed-custody-20260910-v2.service'
DESCRIPTIONS = {RELAY: 'Decadans managed relay 20260910 v2',
                CLIENT: 'Decadans managed custody 20260910 v2'}
OWNERS = {RELAY: '65534', CLIENT: '20000'}
MAX_STREAM = 65536


class Refused(Exception):
    pass


def require(condition):
    if not condition:
        raise Refused()


def exclusive_addresses_clear(tables):
    """Reject wildcard or relay-address sockets, including IPv6 wildcard."""
    for name, content in tables.items():
        for row in content.splitlines()[1:]:
            columns = row.split()
            require(len(columns) >= 4)
            if name.startswith('tcp') and columns[3] != '0A':
                continue
            address = columns[1].split(':')[0]
            if address in ('00000000', '0200007F', '0' * 32,
                           '0000000000000000FFFF00000200007F'):
                return False
    return True


def validate_bundle(bundle):
    require(isinstance(bundle, dict) and set(bundle) == {'relay', 'client'})
    for value in bundle.values():
        require(isinstance(value, dict) and set(value) == {'source', 'sha256'})
        require(isinstance(value['source'], str) and 100 < len(value['source']) < 120000)
        require(hashlib.sha256(value['source'].encode()).hexdigest() == value['sha256'])
        compile(value['source'], '<reviewed-source>', 'exec')
    return bundle


def normalize_relay(value):
    require(isinstance(value, dict) and set(value) == {'version', 'settled', 'counters'})
    require(type(value['version']) is int and value['version'] == 1 and value['settled'] is True)
    keys = {'accepted', 'over_limit', 'refused', 'connected', 'completed', 'failed', 'cancelled', 'internal_error'}
    counts = value['counters']
    require(isinstance(counts, dict) and set(counts) == keys)
    require(all(type(v) is int and 0 <= v <= 1000000 for v in counts.values()))
    require(counts['accepted'] <= 64)
    return {'version': 1, 'settled': True, 'counters': {k: counts[k] for k in sorted(keys)}}


def client_normalizer(source):
    # Source is host-pinned, reviewed and import-pure. Reuse its strict schema
    # without invoking main/run or introducing a second drifting definition.
    namespace = {'__name__': 'reviewed_custody_schema'}
    exec(compile(source, '<reviewed-client-schema>', 'exec'), namespace)
    return namespace['normalize_result']


def relay_identity_available():
    import pwd
    import grp
    require(pwd.getpwuid(65534).pw_gid == 65534 and grp.getgrgid(65534).gr_gid == 65534)
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            require(entry.stat().st_uid != 65534)
        except FileNotFoundError:
            continue


def unit_argv(unit, source):
    properties = {
        'Description': DESCRIPTIONS[unit], 'PrivateNetwork': 'no',
        'RestrictAddressFamilies': 'AF_UNIX AF_INET AF_INET6 AF_NETLINK',
        'MemoryMax': '256M' if unit == RELAY else '1G', 'MemorySwapMax': '0',
        'TasksMax': '64', 'RuntimeMaxSec': '250s' if unit == RELAY else '180s',
        'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '', 'AmbientCapabilities': '',
        'ProtectHome': 'yes', 'ProtectSystem': 'strict', 'PrivateTmp': 'yes',
        'KillMode': 'control-group', 'TimeoutStopSec': '8s',
        'Restart': 'no', 'UMask': '0077',
    }
    environment = ['PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'RUST_LOG=off']
    if unit == RELAY:
        properties['InaccessiblePaths'] = AUTH
        environment += ['HOME=/nonexistent']
    else:
        properties.update({'IPAddressDeny': 'any', 'IPAddressAllow': '127.0.0.2/32',
                           'ReadWritePaths': AUTH + ' ' + str(ROOT)})
        environment += ['HOME=' + AUTH, 'CODEX_HOME=' + AUTH,
                        'HTTPS_PROXY=http://127.0.0.2:18443',
                        'HTTP_PROXY=http://127.0.0.2:18443']
    return ['/usr/bin/systemd-run', '--unit=' + unit, '--pipe', '--wait', '--collect',
            '--quiet', '--service-type=exec', '--uid=' + OWNERS[unit], '--gid=' + OWNERS[unit]] + [
                '--property=' + key + '=' + value for key, value in properties.items()] + [
            '/usr/bin/env', '-i', *environment, '/usr/bin/python3.12', '-I', '-S', '-B', '-c', source]


async def bounded_read(reader, limit=MAX_STREAM):
    retained = bytearray()
    total = 0
    while True:
        data = await reader.read(4096)
        if not data:
            return bytes(retained), total
        total += len(data)
        if len(retained) < limit:
            retained.extend(data[:limit - len(retained)])


async def control(argv, timeout=12):
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
        require(len(stdout) <= MAX_STREAM and len(stderr) <= MAX_STREAM)
        return proc.returncode, stdout
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


async def snapshot(unit):
    _, output = await control(['/usr/bin/systemctl', 'show', unit,
                              '--property=LoadState,ActiveState,MainPID,Description,User,Group'])
    return dict(line.split('=', 1) for line in output.decode().splitlines() if '=' in line)


def absent(info):
    return (info.get('LoadState') == 'not-found' and info.get('ActiveState') == 'inactive'
            and info.get('MainPID') == '0')


def owned(info, unit):
    return (info.get('Description') == DESCRIPTIONS[unit] and
            info.get('User') == OWNERS[unit] and info.get('Group') == OWNERS[unit])


async def settle_owned(unit):
    info = await snapshot(unit)
    if absent(info):
        return True
    if not owned(info, unit):
        return False
    await control(['/usr/bin/systemctl', 'stop', unit], 15)
    return absent(await snapshot(unit))


async def launch(unit, source):
    proc = await asyncio.create_subprocess_exec(*unit_argv(unit, source),
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, limit=MAX_STREAM + 1)
    return proc, asyncio.create_task(bounded_read(proc.stderr, 0))


async def run(bundle, result, started, processes):
    normalize_client = client_normalizer(bundle['client']['source'])
    require(os.geteuid() == 0)
    relay_identity_available()
    for unit in (RELAY, CLIENT):
        require(absent(await snapshot(unit)))
    require(not ROOT.exists() and not ROOT.is_symlink())
    info = BINARY.lstat()
    require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o555 and
            info.st_uid == 0 and info.st_gid == 0 and info.st_size == 258659424)
    with BINARY.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(digest == BINARY_SHA)
    tables = {name: Path('/proc/net/' + name).read_text() for name in ('tcp', 'tcp6', 'udp', 'udp6')}
    require(exclusive_addresses_clear(tables))
    ROOT.mkdir(mode=0o700)
    os.chown(ROOT, 20000, 20000)
    result['preflight'] = True
    result['stage'] = 'relay_launch'
    started.append(RELAY)
    relay, relay_err = await launch(RELAY, bundle['relay']['source'])
    processes.append(relay)
    ready = await asyncio.wait_for(relay.stdout.readline(), 15)
    result['relayFirstLineBytes'] = len(ready)
    result['stage'] = 'relay_readiness'
    if not ready:
        await asyncio.wait_for(relay.wait(), 5)
        _, error_count = await relay_err
        result.update(relayExit=relay.returncode, relayStderrBytes=error_count)
    require(len(ready) < 1024 and json.loads(ready) == {'event': 'ready', 'version': 1})
    require(owned(await snapshot(RELAY), RELAY))
    result['relayReady'] = True
    relay_out = asyncio.create_task(bounded_read(relay.stdout, 4096))
    result['stage'] = 'client_launch'
    started.append(CLIENT)
    client, client_err = await launch(CLIENT, bundle['client']['source'])
    processes.append(client)
    client_out = asyncio.create_task(bounded_read(client.stdout))
    await asyncio.wait_for(client.wait(), 190)
    result['stage'] = 'client_result'
    data, count = await client_out
    _, stderr_count = await client_err
    result.update(clientExit=client.returncode, clientStdoutBytes=count,
                  clientStderrBytes=stderr_count, clientNaturalSettlement=absent(await snapshot(CLIENT)))
    require(count <= MAX_STREAM)
    result['client'] = normalize_client(json.loads(data))
    result['stage'] = 'relay_settlement'
    result['relaySettled'] = await settle_owned(RELAY)
    await asyncio.wait_for(relay.wait(), 15)
    relay_data, relay_count = await relay_out
    _, relay_stderr_count = await relay_err
    result.update(relayExit=relay.returncode, relayStdoutBytes=relay_count,
                  relayStderrBytes=relay_stderr_count)
    require(relay_count <= 4096)
    result['relay'] = normalize_relay(json.loads(relay_data))
    if client.returncode == 0 and result['clientNaturalSettlement'] and result['relaySettled']:
        result['outcome'] = 'completed-review-client-verdict'
        result['stage'] = 'complete'


async def main(bundle):
    result = {'version': 'managed-custody-v2', 'outcome': 'refused', 'stage': 'preflight', 'preflight': False,
              'relayReady': False, 'modelTurn': False, 'telegram': False, 'settled': False}
    started, processes = [], []
    try:
        await asyncio.wait_for(run(validate_bundle(bundle), result, started, processes), 225)
    except (Refused, ValueError, OSError, asyncio.TimeoutError, SyntaxError):
        result['outcome'] = 'refused' if not started else 'inconclusive'
    finally:
        settlements = []
        for unit in reversed(started):
            try:
                settlements.append(await settle_owned(unit))
            except (Refused, ValueError, OSError, asyncio.TimeoutError):
                settlements.append(False)
        for proc in processes:
            if proc.returncode is None:
                try:
                    await asyncio.wait_for(proc.wait(), 5)
                except asyncio.TimeoutError:
                    # Only the local systemd-run transport; never an unknown unit.
                    proc.kill()
                    await proc.wait()
        result['settled'] = all(settlements)
        if not result['settled']:
            result['outcome'] = 'inconclusive'
        print(json.dumps(result, sort_keys=True), flush=True)
    return result


if __name__ == '__main__':
    try:
        packet = sys.stdin.buffer.read(262145)
        require(len(packet) <= 262144)
        asyncio.run(main(json.loads(packet)))
    except Exception:
        # Never expose exception strings, credentials, frames, or raw stderr.
        print(json.dumps({'version': 'managed-custody-v2', 'outcome': 'inconclusive',
                          'settled': False, 'modelTurn': False, 'telegram': False}), flush=True)
