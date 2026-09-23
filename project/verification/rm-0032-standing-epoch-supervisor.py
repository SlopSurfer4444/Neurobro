"""Pinned public capsule preparation and bounded private duplex supervision.

No I/O on import. The host precomposes the client capsule before constructing
the outer source packet: neither source boundary exceeds its historical cap.
Only decoded records traverse the private pipes after each source bootstrap.
Per-turn completion is not Telegram delivery or outer process settlement.
"""
import asyncio
import base64
import hashlib
import inspect
import json
import os
import re
import struct
import time
import types
import zlib

SOURCE_CAP = 262144
PUBLIC_BUNDLE_CAP = 393216
PARALLEL_PUBLIC_BUNDLE_CAP = 524288
EXECUTABLE_CAP = 120000
FRAME_CAP = 3 * 1024 * 1024
VISUAL_INPUT_FRAME_CAP = 12 * 1024 * 1024
INNER_CAP = 512 * 1024 * 1024
CONTROL_CAP = 65536
FRAME_COUNT = 1024
PREP_SECONDS = 120
EPOCH_SECONDS = 900
CLEANUP_SECONDS = 35
TOTAL_SECONDS = 1055
RELAY_BYTE_CAP = 1024 * 1024 * 1024
SUPERVISOR_PIN = 'feb8522b2cfdd87c8121221b95287a1a5cb5c27938126b7fdfd5c097040639c0'
RELAY_PIN = 'c46f4136c37b1154b1e8178b3e5989844e1a2b47fb8e38e8a344361e5d077a7e'
IDLE = object()
PARALLEL_MODE = 'standing-parallel-epoch-v1'
PARALLEL_SCHEMA = 'decadans.rm0032.standing-parallel-epoch.v1'

BOOTSTRAP = """import sys,os,struct,hashlib
def exact(n):
 b=bytearray()
 while len(b)<n:
  p=os.read(sys.stdin.fileno(),n-len(b))
  if not p: raise ValueError('frame')
  b.extend(p)
 return bytes(b)
n=struct.unpack('>I',exact(4))[0]
if not 1<=n<=262144: raise ValueError('source-bound')
h=exact(64).decode('ascii');s=exact(n)
if hashlib.sha256(s).hexdigest()!=h: raise ValueError('source-integrity')
exec(compile(s.decode('utf-8'),'<reviewed-epoch-bridge>','exec'),{'__name__':'__main__'})
"""


class Refused(ValueError):
    def __init__(self): super().__init__('standing-epoch-supervisor-refused')


def require(value):
    if not value: raise Refused()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


def decoded(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result); result[key] = value
        return result
    return json.loads(data.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False))


def sha(source): return hashlib.sha256(source.encode('utf-8')).hexdigest()


def replace_exact(source, before, after, count=1):
    require(source.count(before) == count)
    return source.replace(before, after)


def load(source, name, pin=None):
    require(type(source) is str and 0 < len(source.encode('utf-8')) <= SOURCE_CAP)
    require(pin is None or sha(source) == pin.lower())
    module = types.ModuleType(name)
    exec(compile(source, '<' + name + '>', 'exec'), module.__dict__)
    return module


def config_valid(config):
    require(type(config) is dict and set(config) == {'root', 'cwd', 'profile', 'relayUnit', 'clientUnit'})
    require(type(config['root']) is str and re.fullmatch(r'/run/decadans-standing-epoch-[a-z0-9-]{1,64}', config['root']))
    require(config['cwd'] == config['root'] + '/workspace')
    require(type(config['profile']) is str and re.fullmatch(r'decadans-standing-epoch-[a-z0-9-]{1,64}', config['profile']))
    for key in ('relayUnit', 'clientUnit'):
        require(type(config[key]) is str and re.fullmatch(r'decadans-standing-epoch-[a-z0-9-]{1,70}\.service', config[key]))
    require(config['relayUnit'] != config['clientUnit'])
    return config


def source_frame(source):
    raw = source.encode('utf-8')
    require(0 < len(raw) <= SOURCE_CAP)
    return struct.pack('>I', len(raw)) + hashlib.sha256(raw).hexdigest().encode('ascii') + raw


RELAY_REJECTIONS = ('closing', 'concurrent', 'acceptedLimit')
RELAY_FAILURES = ('header', 'dns', 'connect', 'response', 'tunnelIdle', 'tunnelDuration',
                  'tunnelBytes', 'aggregateBytes', 'tunnelIo', 'tunnelOther')


def standing_relay_limits(worker_count):
    require(type(worker_count) is int and 1 <= worker_count <= 8)
    # Four connections per bounded turn/tool exchange is engineering headroom,
    # not a provider guarantee. Include all eight calls and four refusals.
    return 8 + 8*worker_count + 4*16*(1+8+4), max(8, 4*worker_count)


def normalize_standing_relay(value):
    require(type(value) is dict and set(value) in ({'version', 'settled', 'counters'},
            {'version', 'settled', 'counters', 'diagnostics'}))
    require(type(value['version']) is int and value['version'] == 1 and value['settled'] is True)
    names = {'accepted', 'over_limit', 'refused', 'connected', 'completed', 'failed', 'cancelled', 'internal_error'}
    counts = value['counters']
    require(type(counts) is dict and set(counts) == names and all(type(v) is int and 0 <= v <= 1000000 for v in counts.values()))
    result = {'version': 1, 'settled': True, 'counters': {k: counts[k] for k in sorted(names)}}
    if 'diagnostics' not in value:
        require(counts['accepted'] <= 64)
        return result
    d = value['diagnostics']
    require(type(d) is dict and set(d) == {'schema', 'workerCount', 'turnLimit', 'toolCallLimit', 'toolRefusalLimit',
            'maxAccepted', 'maxConcurrent', 'reservedBytes', 'rejections', 'failures'})
    require(d['schema'] == 'standing-relay-budget-v1')
    accepted, concurrent = standing_relay_limits(d['workerCount'])
    for key, expected in (('turnLimit', 16), ('toolCallLimit', 8), ('toolRefusalLimit', 4),
                          ('maxAccepted', accepted), ('maxConcurrent', concurrent)):
        require(type(d[key]) is int and d[key] == expected)
    require(type(d['reservedBytes']) is int and 0 <= d['reservedBytes'] <= 1024*1024*1024 and counts['accepted'] <= accepted)
    copied = {k: d[k] for k in d if k not in ('rejections', 'failures')}
    for field, keys in (('rejections', RELAY_REJECTIONS), ('failures', RELAY_FAILURES)):
        require(type(d[field]) is dict and set(d[field]) == set(keys) and
                all(type(v) is int and 0 <= v <= 1000000 for v in d[field].values()))
        copied[field] = {k: d[field][k] for k in keys}
    require(sum(d['rejections'].values()) == counts['over_limit'])
    require(sum(d['failures'].values()) == counts['failed'] + counts['refused'])
    require(counts['completed'] <= counts['connected'] <= counts['accepted'] - counts['refused'])
    require(counts['completed'] + counts['failed'] + counts['refused'] + counts['cancelled'] <= counts['accepted'])
    result['diagnostics'] = copied
    return result


def specialize_relay(source, *, worker_count=1):
    """Public counted specialization; original allowlist/DNS/TLS opacity intact.

    The sole event loop reserves combined bytes before forwarding. All accepted
    tunnels share one 1GiB budget, including canceled or partial writes; the old
    64*32MiB theoretical total was 2GiB. Standing-only connection headroom is
    derived from the existing worker/turn/tool budgets. No retry or payload retention.
    """
    require(sha(source) == RELAY_PIN)
    accepted, concurrent = standing_relay_limits(worker_count)
    changes = [
        ('MAX_ACCEPTED = 64', 'MAX_ACCEPTED = %d\nWORKER_COUNT = %d' % (accepted, worker_count)),
        ('MAX_CONCURRENT = 8', 'MAX_CONCURRENT = %d' % concurrent),
        ('MAX_LIFETIME = 900', 'MAX_LIFETIME = 1055'),
        ('MAX_TUNNEL_SECONDS = 300', 'MAX_TUNNEL_SECONDS = 1055'),
        ('IDLE_SECONDS = 60', 'IDLE_SECONDS = 300'),
        ('MAX_TUNNEL_BYTES = 32 * 1024 * 1024', 'MAX_TUNNEL_BYTES = 1024 * 1024 * 1024'),
        ('duration=MAX_TUNNEL_SECONDS):', 'duration=MAX_TUNNEL_SECONDS, reserve=None):'),
        ('            moved += len(data)\n            if moved > byte_limit:',
         '            if reserve is not None:\n                reserve(len(data))\n            moved += len(data)\n            if moved > byte_limit:'),
        ('        self.closing = False', '        self.closing = False\n        self.reserved_bytes = 0\n'
         '        self.rejections = dict.fromkeys(%r, 0)\n        self.failures = dict.fromkeys(%r, 0)' % (RELAY_REJECTIONS, RELAY_FAILURES)),
        ('    def finished(self, task):',
         '    @property\n    def diagnostics(self):\n'
         '        return dict(schema="standing-relay-budget-v1", workerCount=WORKER_COUNT, turnLimit=16, toolCallLimit=8, toolRefusalLimit=4,\n'
         '            maxAccepted=MAX_ACCEPTED, maxConcurrent=MAX_CONCURRENT, reservedBytes=self.reserved_bytes,\n'
         '            rejections=dict(self.rejections), failures=dict(self.failures))\n\n'
         '    def reserve(self, count):\n        if type(count) is not int or count <= 0 or self.reserved_bytes + count > MAX_TUNNEL_BYTES:\n            raise Refused("aggregateBytes")\n        self.reserved_bytes += count\n\n    def finished(self, task):'),
        ('await tunnel(reader, writer, remote_reader, remote_writer)',
         'await tunnel(reader, writer, remote_reader, remote_writer, reserve=self.reserve)'),
        ('backlog=MAX_CONCURRENT, reuse_address=False)', 'backlog=MAX_CONCURRENT, reuse_address=True, reuse_port=False)'),
        ('            await self.server.wait_closed()\n            tasks = list(self.tasks)', '            tasks = list(self.tasks)'),
        ('            await asyncio.gather(*tasks, return_exceptions=True)\n        return dict(self.counts)',
         '            await asyncio.gather(*tasks, return_exceptions=True)\n            await self.server.wait_closed()\n        return dict(self.counts)'),
        ('    """Fixed failure class; never contains untrusted text."""',
         '    """Fixed failure class; never contains untrusted text."""\n'
         '    def __init__(self, reason="tunnelOther"):\n'
         '        self.reason = reason if reason in %r else "tunnelOther"\n        super().__init__(self.reason)' % (RELAY_FAILURES,)),
        ('            if moved > byte_limit:\n                raise Refused()',
         '            if moved > byte_limit:\n                raise Refused("tunnelBytes")'),
        ('            if remaining <= 0:\n                raise TimeoutError()',
         '            if remaining <= 0:\n                raise Refused("tunnelIdle")'),
        ('        async with asyncio.timeout(duration):',
         '        duration_timeout = asyncio.timeout(duration)\n        async with duration_timeout:'),
        ('        return moved\n    finally:',
         '        return moved\n    except TimeoutError:\n        if duration_timeout.expired():\n            raise Refused("tunnelDuration") from None\n        raise\n    finally:'),
        ('        if self.closing or len(self.tasks) >= MAX_CONCURRENT or self.counts["accepted"] >= MAX_ACCEPTED:\n'
         '            self.counts["over_limit"] += 1',
         '        reason = "closing" if self.closing else "acceptedLimit" if self.counts["accepted"] >= MAX_ACCEPTED else "concurrent" if len(self.tasks) >= MAX_CONCURRENT else None\n'
         '        if reason is not None:\n            self.rejections[reason] += 1\n            self.counts["over_limit"] += 1'),
        ('        established = False\n        try:', '        established = False\n        stage = "header"\n        try:'),
        ('            addresses = await self.resolver(host)', '            stage = "dns"\n            addresses = await self.resolver(host)'),
        ('            remote_reader, remote_writer = await self.connector(addresses)',
         '            stage = "connect"\n            remote_reader, remote_writer = await self.connector(addresses)\n            stage = "response"'),
        ('            await tunnel(reader, writer, remote_reader, remote_writer, reserve=self.reserve)',
         '            stage = "tunnel"\n            await tunnel(reader, writer, remote_reader, remote_writer, reserve=self.reserve)'),
        ('                asyncio.LimitOverrunError):\n            self.counts["failed" if established else "refused"] += 1',
         '                asyncio.LimitOverrunError) as error:\n'
         '            reason = stage if stage != "tunnel" else error.reason if isinstance(error, Refused) else "tunnelIo" if isinstance(error, OSError) else "tunnelOther"\n'
         '            self.failures[reason] += 1\n            self.counts["failed" if established else "refused"] += 1'),
        ('{"version": 1, "settled": True, "counters": counts}',
         '{"version": 1, "settled": True, "counters": counts, "diagnostics": relay.diagnostics}'),
    ]
    for before, after in changes: source = replace_exact(source, before, after)
    require(len(source.encode()) < EXECUTABLE_CAP)
    compile(source, '<reviewed-warm-relay>', 'exec')
    return source


def build_bundle(relay_source, client_sources, client_source, wire_source, config, pins, *,
                 session_mode=None, work_profile=None, parallel_options=None):
    """Pure host preparation. Parallel dependencies use an explicit decoded cap;
    individual sources and authenticated capsule input keep their 262144 bound.

    pins must cover precisely the managed client's dependencies plus _client and
    _wire. The frozen supervisor independently checks the finished capsule hash.
    """
    config_valid(config)
    require(session_mode in (None, PARALLEL_MODE))
    if session_mode is None:
        require(work_profile is None and parallel_options is None)
    else:
        require(work_profile in (None, 'team-assistant', 'community-team'))
        require(type(parallel_options) is dict and set(parallel_options) == {'analysisWorkers', 'communityAssessment'})
        require(type(parallel_options['communityAssessment']) is bool and type(parallel_options['analysisWorkers']) is int and
                1 <= parallel_options['analysisWorkers'] <= 7-int(parallel_options['communityAssessment']))
    require(type(client_sources) is dict and type(pins) is dict)
    require(not ({'_client', '_wire'} & set(client_sources)))
    contents = {**client_sources, '_client': client_source, '_wire': wire_source}
    require(set(contents) == set(pins))
    for name, source in contents.items():
        require(type(name) is str and type(source) is str and type(pins[name]) is str and
                0 < len(source.encode('utf-8')) <= SOURCE_CAP and
                re.fullmatch('[a-fA-F0-9]{64}', pins[name]) and sha(source) == pins[name].lower())
    client = load(client_source, 'reviewed_epoch_client_schema')
    dependency_pins = {**client.PINS, **client.PARALLEL_PINS} if session_mode == PARALLEL_MODE else client.PINS
    require(set(client_sources) == set(dependency_pins))
    require(all(pins[name].upper() == dependency_pins[name] for name in client_sources))
    raw = encoded(contents)
    public_cap = PARALLEL_PUBLIC_BUNDLE_CAP if session_mode == PARALLEL_MODE else PUBLIC_BUNDLE_CAP
    require(len(raw) <= public_cap)
    payload = base64.b64encode(zlib.compress(raw)).decode('ascii')
    public_config = {k: config[k] for k in ('root', 'cwd', 'profile')}
    capsule = '''import base64,hashlib,json,zlib,sys
_d=zlib.decompressobj()
_raw=_d.decompress(base64.b64decode(%r,validate=True),393217)
assert len(_raw)<=393216 and _d.eof and not _d.unused_data and not _d.unconsumed_tail
_sources=json.loads(_raw.decode('utf-8'))
_pins=json.loads(%r)
assert type(_sources) is dict and set(_sources)==set(_pins)
assert all(type(v) is str and 0<len(v.encode())<=262144 and hashlib.sha256(v.encode()).hexdigest()==_pins[k].lower() for k,v in _sources.items())
_wire={'__name__':'reviewed_epoch_wire'}
exec(compile(_sources.pop('_wire'),'<reviewed-epoch-wire>','exec'),_wire)
_client={'__name__':'reviewed_epoch_client'}
exec(compile(_sources.pop('_client'),'<reviewed-epoch-client>','exec'),_client)
_config=json.loads(%r)
def normalize_result(value): return _client['normalize_result'](value)
def wire_class(): return _wire['NativeEpochWire']
if __name__=='__main__':
 _io=wire_class()(sys.stdin.fileno(),sys.stdout.fileno(),idle=_client['IDLE'])
 try: _value=_client['main'](_sources,_config,_io.receive,_io.emit)
 finally: _io.close()
 raise SystemExit(0 if _value['outcome']=='observed' else 1)
''' % (payload, json.dumps(pins, separators=(',', ':')), json.dumps(public_config, separators=(',', ':')))
    if session_mode == PARALLEL_MODE:
        capsule = replace_exact(capsule, '_d.decompress(base64.b64decode(%r,validate=True),393217)' % payload,
            '_d.decompress(base64.b64decode(%r,validate=True),524289)' % payload)
        capsule = replace_exact(capsule, 'len(_raw)<=393216', 'len(_raw)<=524288')
        capsule = replace_exact(capsule, "def wire_class(): return _wire['NativeEpochWire']",
            "def wire_class(): return __import__('functools').partial(_wire['NativeEpochWire'],parallel=True)")
        capsule = replace_exact(capsule, "_client['main'](_sources,_config,_io.receive,_io.emit)",
            "_client['main'](_sources,_config,_io.receive,_io.emit,session_mode=%r,work_profile=%r,parallel_options=_parallel_options)" %
            (session_mode, work_profile))
        capsule = replace_exact(capsule, 'def normalize_result(value):',
            '_parallel_options=%r\ndef worker_count(): return 1+_parallel_options["analysisWorkers"]+int(_parallel_options["communityAssessment"])\ndef normalize_result(value):' % parallel_options)
    # launch passes only BOOTSTRAP in argv. The authenticated source travels
    # through source_frame's existing 262144-byte pipe, not the old argv cap.
    require(len(capsule.encode()) <= SOURCE_CAP)
    relay = specialize_relay(relay_source, worker_count=1 if session_mode is None else
                             1+parallel_options['analysisWorkers']+int(parallel_options['communityAssessment']))
    return {name: {'source': source, 'sha256': sha(source)} for name, source in (('relay', relay), ('client', capsule))}


class Budget:
    """One clock origin and one first-close cleanup deadline; no renewed windows."""
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.started = clock(); self.hard_end = self.started + TOTAL_SECONDS
        self.end = self.started + PREP_SECONDS; self.ready = self.closing = False

    def remaining(self, maximum):
        left = min(self.end, self.hard_end) - self.clock()
        require(left > 0)
        return min(maximum, left)

    def admit_epoch(self):
        self.remaining(PREP_SECONDS); require(not self.ready and not self.closing)
        self.ready = True
        self.end = min(self.clock() + EPOCH_SECONDS, self.hard_end - CLEANUP_SECONDS)

    def close(self):
        if not self.closing:
            self.closing = True
            self.end = min(self.clock() + CLEANUP_SECONDS, self.end + CLEANUP_SECONDS, self.hard_end)


def prepare_runtime(supervisor_source, config):
    """Fixed identities, duration and the existing framed-source admission bound.

    Frozen ownership, UID, network, filesystem and binary predicates remain
    source-identical. The argv-era bundle cap now matches source_frame, since
    launch substitutes BOOTSTRAP before spawning. This module owns its shared
    deadlines instead of invoking the old EOF-per-request run/main functions.
    """
    config_valid(config); require(sha(supervisor_source) == SUPERVISOR_PIN)
    source = supervisor_source
    for before, after, count in [
        ('/run/decadans-managed-custody-20260910-v2', config['root'], 1),
        ('decadans-managed-relay-20260910-v2.service', config['relayUnit'], 1),
        ('decadans-managed-custody-20260910-v2.service', config['clientUnit'], 1),
        ('Decadans managed relay 20260910 v2', 'Decadans standing epoch relay ' + config['relayUnit'], 1),
        ('Decadans managed custody 20260910 v2', 'Decadans standing epoch client ' + config['clientUnit'], 1),
        ("'250s' if unit == RELAY else '180s'", "'1055s' if unit == RELAY else '1055s'", 1),
        ("100 < len(value['source']) < 120000", "100 < len(value['source'].encode('utf-8')) <= 262144", 1),
    ]: source = replace_exact(source, before, after, count)
    runtime = load(source, 'reviewed_epoch_supervisor_runtime')
    runtime.normalize_relay = normalize_standing_relay
    return runtime


def configure_parallel_task_limit(runtime, worker_count):
    """Scale only the client task count; every other exact unit option survives.

    The caller obtains population from the authenticated capsule's same options
    object used to construct its actual pool. Relay and legacy remain at 64.
    """
    require(type(worker_count) is int and 1 <= worker_count <= 8)
    original = runtime.unit_argv
    def unit_argv(unit, source):
        args = original(unit, source)
        if unit == runtime.CLIENT:
            require(args.count('--property=TasksMax=64') == 1)
            args = [('--property=TasksMax=%d' % (64 * worker_count))
                    if item == '--property=TasksMax=64' else item for item in args]
        return args
    runtime.unit_argv = unit_argv


class OutputGate:
    """Outer control ordering only; inner turn/tool semantics remain endpoint-owned."""
    INNER = {'ready', 'scope', 'tool', 'imageBegin', 'imageChunk', 'imageEnd', 'completed', 'released', 'notAdmitted', 'closed'}

    def __init__(self, normalize, budget, *, session_mode=None):
        require(session_mode in (None, PARALLEL_MODE))
        self.normalize, self.budget = normalize, budget
        self.session_mode = session_mode
        self.custody = self.ready = False
        self.closed = self.receipt = self.proof = None
        self.inner_bytes = self.control_bytes = self.frames = 0
        self.mode = self.active_scope = None
        self.workers = {}

    def purposes(self):
        return ('conversation', 'history-analysis', 'community-assessment') if self.mode == 'scoped-v2' else ('conversation', 'history-analysis')

    @staticmethod
    def names(names):
        require(type(names) is list and 1 <= len(names) <= 32)
        require(all(type(name) is str and re.fullmatch(r'neurobro_[a-z][a-z0-9_]{0,54}', name) is not None for name in names))
        require(names[0] == 'neurobro_read_history' and len(set(names)) == len(names))

    def scoped_frame(self, value):
        """Mode closure and purpose association; endpoints own tool/turn semantics."""
        kind = value['kind']
        if self.mode == 'legacy':
            require('purpose' not in value and 'protocol' not in value)
            if kind in {'scope', 'completed'}:
                scope = value.get('scope')
                require(type(scope) is dict and 'purpose' not in scope and 'threadTurnNumber' not in scope)
            if kind == 'closed':
                require(type(value.get('facts')) is dict and value['facts'].get('schema') == 'neurobro-native-image-epoch-v1')
            return
        if kind in {'scope', 'completed', 'tool', 'released'}:
            if kind in {'scope', 'completed'}:
                require(set(value) == ({'kind', 'scope'} if kind == 'scope' else
                    {'kind', 'scope', 'answer', 'kindOfAnswer', 'toolCalls', 'toolRefusals'}))
                scope = value['scope']
                require(type(scope) is dict and set(scope) == {'purpose', 'requestRef', 'threadId', 'turnId', 'turnNumber', 'threadTurnNumber'})
            else:
                require(set(value) == ({'kind', 'purpose', 'requestRef', 'callRef', 'name', 'arguments'} if kind == 'tool' else
                    {'kind', 'purpose', 'requestRef', 'delivery'}))
                scope = value
            purpose, ref = scope['purpose'], scope['requestRef']
            require(type(purpose) is str and purpose in self.purposes())
            if kind == 'tool': require(purpose != 'community-assessment')
            require(type(ref) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', ref) is not None)
            binding = (purpose, ref)
            require(self.active_scope is None or self.active_scope == binding)
            if kind == 'released':
                require(self.active_scope == binding)
                if purpose != 'conversation': require(value['delivery'] == 'not-sent')
                self.active_scope = None
            else:
                self.active_scope = binding
                if kind == 'completed' and purpose != 'conversation': require(value['kindOfAnswer'] == 'text')
        elif kind in {'imageBegin', 'imageChunk', 'imageEnd'}:
            require(self.active_scope is not None and self.active_scope[0] == 'conversation' and 'purpose' not in value)
        elif kind == 'closed':
            require(type(value.get('facts')) is dict and value['facts'].get('schema') ==
                ('neurobro-native-scoped-epoch-v2' if self.mode == 'scoped-v2' else 'neurobro-native-scoped-epoch-v1'))

    def accept(self, value, length):
        if self.session_mode == PARALLEL_MODE:
            return self.accept_parallel(value, length)
        self.budget.remaining(TOTAL_SECONDS)
        require(type(value) is dict and type(value.get('kind')) is str and self.receipt is None)
        self.frames += 1; require(self.frames <= FRAME_COUNT)
        kind = value['kind']
        if kind in {'custodyReady', 'epochResult'}:
            self.control_bytes += length; require(self.control_bytes <= CONTROL_CAP)
        else:
            self.inner_bytes += length; require(self.inner_bytes <= INNER_CAP)
        if kind == 'custodyReady':
            require(not self.custody and not self.ready and set(value) == {'kind', 'proof'})
            proof = value['proof']
            require(type(proof) is dict and set(proof) == {'custody', 'capabilities'})
            c, cap = proof['custody'], proof['capabilities']
            require(type(c) is dict and set(c) == {'initialize', 'profile', 'controlsPassed', 'relayAfter', 'probePass', 'probeExitCodes', 'accountChatgpt', 'astraMedium'})
            require(all(c[k] is True for k in ('initialize', 'profile', 'controlsPassed', 'accountChatgpt', 'astraMedium')) and c['relayAfter'] is False)
            require(type(c['probePass']) is list and c['probePass'] == [True] * 9 and all(type(x) is bool for x in c['probePass']))
            allowed = [{0}] + [{20, 21, 22}] * 5 + [{40}, {30}, {60, 61}]
            require(type(c['probeExitCodes']) is list and len(c['probeExitCodes']) == 9 and
                    all(type(code) is int and code in choices for code, choices in zip(c['probeExitCodes'], allowed)))
            require(type(cap) is dict and set(cap) == {'checked', 'imageGeneration', 'namespaceTools', 'webSearch'} and
                    all(type(x) is bool for x in cap.values()) and cap['checked'] and cap['imageGeneration'])
            self.budget.admit_epoch(); self.custody = True; self.proof = decoded(encoded(proof))
        elif kind == 'epochResult':
            require(set(value) == {'kind', 'receipt'})
            receipt = self.normalize(value['receipt'])
            if self.ready:
                require(receipt['schema'] == ('decadans.rm0032.standing-scoped-epoch.v2' if self.mode == 'scoped-v2' else
                    'decadans.rm0032.standing-scoped-epoch.v1' if self.mode == 'scoped' else 'decadans.rm0032.standing-epoch.v1'))
            require(receipt['session']['custodyPublished'] == self.custody and receipt['session']['ready'] == self.ready)
            require(receipt['session']['closed'] == (self.closed is not None))
            if self.closed is not None:
                require(receipt['session']['code'] == self.closed['code'] and receipt['session']['facts'] == self.closed['facts'])
            if self.proof is not None:
                require(receipt['capabilities'] == self.proof['capabilities'])
                require({**receipt['custody'], 'relayAfter': False} == self.proof['custody'])
            self.receipt = receipt; self.budget.close()
        else:
            require(kind in self.INNER and self.custody and self.closed is None)
            if kind == 'ready':
                require(not self.ready)
                if set(value) == {'kind', 'protocol', 'scopes'}:
                    require(value['protocol'] in ('standing-scoped-epoch-v1', 'standing-scoped-epoch-v2'))
                    v2 = value['protocol'] == 'standing-scoped-epoch-v2'
                    scopes = value['scopes']
                    require(type(scopes) is list and len(scopes) == (3 if v2 else 2))
                    require(all(type(scope) is dict and set(scope) == {'purpose', 'tools'} for scope in scopes))
                    require(scopes[0]['purpose'] == 'conversation' and scopes[1]['purpose'] == 'history-analysis')
                    self.names(scopes[0]['tools'])
                    require(scopes[1]['tools'] == ['neurobro_analysis_material', 'neurobro_analysis_notes', 'neurobro_analysis_commit'])
                    if v2: require(scopes[2]['purpose'] == 'community-assessment' and scopes[2]['tools'] == [])
                    self.mode = 'scoped-v2' if v2 else 'scoped'
                else:
                    require(set(value) in ({'kind'}, {'kind', 'tools'}))
                    if 'tools' in value: self.names(value['tools'])
                    self.mode = 'legacy'
                # Exact registry membership/order is checked by both endpoints.
                # Preserve the named envelope unchanged, including its order.
                self.ready = True
            else: require(self.ready)
            if kind != 'ready': self.scoped_frame(value)
            if kind == 'notAdmitted':
                require(set(value) == ({'kind', 'requestRef', 'reason', 'turnsAdmitted', 'purpose', 'turnStartDispatches'} if self.mode != 'legacy' else
                    {'kind', 'requestRef', 'reason', 'turnsAdmitted'}))
                if self.mode != 'legacy':
                    require(type(value['purpose']) is str and value['purpose'] in self.purposes())
                    require(type(value['turnStartDispatches']) is int and 0 <= value['turnStartDispatches'] <= 16)
                require(type(value['requestRef']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value['requestRef']) is not None)
                require(type(value['reason']) is str and value['reason'] in {'time', 'turns'})
                require(type(value['turnsAdmitted']) is int and 0 <= value['turnsAdmitted'] <= 16)
            if kind == 'closed':
                require(set(value) == {'kind', 'code', 'facts'})
                self.closed = decoded(encoded(value)); self.budget.close()
        return value

    @staticmethod
    def identifier(value):
        return type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value) is not None

    @staticmethod
    def custody_proof(proof):
        require(type(proof) is dict and set(proof) == {'workerId', 'processId', 'purpose', 'custody', 'capabilities'})
        require(OutputGate.identifier(proof['workerId']) and type(proof['processId']) is int and proof['processId'] > 0)
        require(proof['purpose'] in ('conversation', 'history-analysis', 'community-assessment'))
        c, cap = proof['custody'], proof['capabilities']
        require(type(c) is dict and set(c) == {'initialize', 'profile', 'controlsPassed', 'relayAfter', 'probePass', 'probeExitCodes', 'accountChatgpt', 'astraMedium'})
        require(all(c[k] is True for k in ('initialize', 'profile', 'controlsPassed', 'accountChatgpt', 'astraMedium')) and c['relayAfter'] is False)
        require(type(c['probePass']) is list and len(c['probePass']) == 9 and all(x is True for x in c['probePass']))
        allowed = [{0}] + [{20, 21, 22}] * 5 + [{40}, {30}, {60, 61}]
        require(type(c['probeExitCodes']) is list and len(c['probeExitCodes']) == 9 and
                all(type(code) is int and code in choices for code, choices in zip(c['probeExitCodes'], allowed)))
        require(type(cap) is dict and set(cap) == {'checked', 'imageGeneration', 'namespaceTools', 'webSearch'} and
                all(type(x) is bool for x in cap.values()) and cap['checked'] and cap['imageGeneration'])

    def parallel_worker_frame(self, worker, frame):
        require(type(frame) is dict and type(frame.get('kind')) is str)
        kind, purpose = frame['kind'], worker['purpose']
        require(kind in self.INNER and worker['closed'] is None)
        if kind == 'ready':
            require(not worker['ready'] and set(frame) == {'kind', 'protocol', 'scopes'} and frame['protocol'] == PARALLEL_MODE)
            scopes = frame['scopes']
            require(type(scopes) is list and len(scopes) == 1 and type(scopes[0]) is dict and
                    set(scopes[0]) == {'purpose', 'tools'} and scopes[0]['purpose'] == purpose)
            if purpose == 'conversation': self.names(scopes[0]['tools'])
            elif purpose == 'history-analysis':
                require(scopes[0]['tools'] == ['neurobro_analysis_material', 'neurobro_analysis_notes', 'neurobro_analysis_commit'])
            else: require(scopes[0]['tools'] == [])
            worker['ready'] = True; worker['tools'] = tuple(scopes[0]['tools'])
            return
        require(worker['ready'])
        if kind in {'scope', 'completed', 'tool', 'released', 'notAdmitted'}:
            if kind in {'scope', 'completed'}:
                require(set(frame) == ({'kind', 'scope'} if kind == 'scope' else
                    {'kind', 'scope', 'answer', 'kindOfAnswer', 'toolCalls', 'toolRefusals'}))
                scope = frame['scope']
                require(type(scope) is dict and set(scope) == {'purpose', 'requestRef', 'threadId', 'turnId', 'turnNumber'})
                require(self.identifier(scope['threadId']) and self.identifier(scope['turnId']) and
                        type(scope['turnNumber']) is int and 1 <= scope['turnNumber'] <= 16)
            else:
                keys = {'tool': {'kind', 'purpose', 'requestRef', 'callRef', 'name', 'arguments'},
                        'released': {'kind', 'purpose', 'requestRef', 'delivery'},
                        'notAdmitted': {'kind', 'purpose', 'requestRef', 'reason', 'turnsAdmitted'}}
                require(set(frame) == keys[kind]); scope = frame
            require(scope['purpose'] == purpose and self.identifier(scope['requestRef']))
            ref = scope['requestRef']
            require(worker['active'] is None or worker['active'] == ref)
            if kind == 'released':
                require(worker['active'] == ref and worker['completed'] and
                        frame['delivery'] in ('verified', 'not-sent', 'unknown'))
                if purpose != 'conversation': require(frame['delivery'] == 'not-sent')
                worker.update(active=None, scope=None, completed=False)
            elif kind == 'notAdmitted':
                require(worker['active'] is None and frame['reason'] in ('time', 'turns') and
                        type(frame['turnsAdmitted']) is int and 0 <= frame['turnsAdmitted'] <= 16)
                worker['retired'] = True
            else:
                require(not worker['retired'] and not worker['completed'])
                worker['active'] = ref
                if kind == 'tool':
                    require(purpose != 'community-assessment' and self.identifier(frame['callRef']) and
                            type(frame['name']) is str and frame['name'] in worker['tools'])
                elif kind == 'scope':
                    require(worker['scope'] is None); worker['scope'] = decoded(encoded(scope))
                elif kind == 'completed':
                    require(worker['scope'] == scope and frame['kindOfAnswer'] in ('text', 'image'))
                    require(type(frame['answer']) is str and frame['answer'].strip() and '\0' not in frame['answer'] and
                            len(frame['answer'].encode('utf-8')) <= 4096)
                    require(all(type(frame[k]) is int and 0 <= frame[k] <= cap for k, cap in (('toolCalls', 8), ('toolRefusals', 4))))
                    if purpose != 'conversation': require(frame['kindOfAnswer'] == 'text')
                    worker['completed'] = True
        elif kind in {'imageBegin', 'imageChunk', 'imageEnd'}:
            require(purpose == 'conversation' and worker['scope'] is not None and not worker['completed'] and 'purpose' not in frame)
        elif kind == 'closed':
            require(set(frame) == {'kind', 'code', 'facts'})
            require(frame['code'] in ('CLOSED', 'EPOCH_LIMIT', 'TURN_LIMIT', 'INPUT_REFUSED', 'PROTOCOL_REFUSED',
                                     'IO_UNKNOWN', 'NATIVE_UNKNOWN', 'RELEASE_UNKNOWN', 'INTERNAL_UNKNOWN'))
            facts = frame['facts']
            require(type(facts) is dict and set(facts) == {'threadStarted', 'poisoned', 'busy', 'turnsAttempted', 'toolCalls', 'schema',
                'turnsAdmitted', 'turnLimit', 'epochSeconds', 'turnSeconds', 'running', 'releasePending', 'closed',
                'resourceSettlementObserved', 'unreleasedTurn'})
            require(all(type(facts[k]) is bool for k in ('threadStarted', 'poisoned', 'busy', 'running', 'releasePending',
                                                       'closed', 'resourceSettlementObserved', 'unreleasedTurn')))
            require(all(type(facts[k]) is int and 0 <= facts[k] <= cap for k, cap in
                        (('turnsAttempted', 16), ('turnsAdmitted', 16), ('toolCalls', 193))))
            # Native turn closure never attests physical child or relay settlement.
            require(facts['schema'] == 'neurobro-native-image-epoch-v1' and facts['resourceSettlementObserved'] is False and
                    facts['turnLimit'] == 16 and facts['epochSeconds'] == 900 and facts['turnSeconds'] == 300)
            worker['closed'] = decoded(encoded(frame))

    def accept_parallel(self, value, length):
        self.budget.remaining(TOTAL_SECONDS)
        require(type(value) is dict and self.receipt is None)
        self.frames += 1; require(self.frames <= FRAME_COUNT)
        kind = value.get('kind')
        if kind in ('poolCustodyReady', 'poolClosed', 'epochResult'):
            self.control_bytes += length; require(self.control_bytes <= CONTROL_CAP)
        else:
            self.inner_bytes += length; require(self.inner_bytes <= INNER_CAP)
        if kind == 'poolCustodyReady':
            require(set(value) == {'kind', 'proof'} and not self.custody and not self.ready and self.closed is None)
            proofs = value['proof']
            require(type(proofs) is list and 2 <= len(proofs) <= 8)
            for proof in proofs: self.custody_proof(proof)
            require(len({p['workerId'] for p in proofs}) == len(proofs) and len({p['processId'] for p in proofs}) == len(proofs))
            require(sum(p['purpose'] == 'conversation' for p in proofs) == 1 and
                    sum(p['purpose'] == 'community-assessment' for p in proofs) <= 1 and
                    any(p['purpose'] == 'history-analysis' for p in proofs))
            self.budget.admit_epoch(); self.custody = True; self.proof = decoded(encoded(proofs))
        elif kind == 'poolReady':
            require(set(value) == {'kind', 'protocol', 'workers'} and value['protocol'] == PARALLEL_MODE and
                    self.custody and not self.ready and self.closed is None)
            require(value['workers'] == [{'workerId': p['workerId'], 'purpose': p['purpose']} for p in self.proof])
            self.workers = {p['workerId']: dict(purpose=p['purpose'], ready=False, active=None, scope=None,
                completed=False, retired=False, closed=None) for p in self.proof}
            self.ready = True; self.mode = PARALLEL_MODE
        elif kind == 'poolClosed':
            require(set(value) == {'kind', 'protocol', 'code', 'receipt'} and value['protocol'] == PARALLEL_MODE and self.closed is None)
            require(value['code'] in ('CLOSED', 'EPOCH_LIMIT', 'TURN_LIMIT', 'INPUT_REFUSED', 'PROTOCOL_REFUSED',
                                     'IO_UNKNOWN', 'NATIVE_UNKNOWN', 'RELEASE_UNKNOWN', 'INTERNAL_UNKNOWN'))
            require(all(w['closed'] is not None and w['closed']['code'] == value['code'] for w in self.workers.values()))
            check = self.normalize({'schema': PARALLEL_SCHEMA, 'outcome': 'unknown', 'code': 'SESSION_UNKNOWN',
                'stage': 'session', 'injectedPorts': False, 'custodyChildren': self.proof or [], 'pool': value['receipt']})
            require(check['pool'] is not None and check['pool'] == value['receipt'])
            if self.proof is not None:
                require([(c['workerId'], c['processId']) for c in check['pool']['children']] ==
                        [(p['workerId'], p['processId']) for p in self.proof])
            self.closed = decoded(encoded(value)); self.budget.close()
        elif kind == 'epochResult':
            require(set(value) == {'kind', 'receipt'})
            receipt = self.normalize(value['receipt'])
            require(receipt['schema'] == PARALLEL_SCHEMA)
            if self.proof is not None: require(receipt['custodyChildren'] == self.proof)
            if self.closed is not None: require(receipt['pool'] == self.closed['receipt'])
            else: require(receipt['outcome'] != 'observed')
            if receipt['outcome'] == 'observed':
                require(self.custody and self.ready and self.closed is not None)
                require(all(w['active'] is None and w['closed']['facts']['closed'] is True and
                            all(w['closed']['facts'][k] is False for k in
                                ('poisoned', 'busy', 'running', 'releasePending', 'unreleasedTurn')) for w in self.workers.values()))
            self.receipt = receipt; self.budget.close()
        else:
            require(set(value) == {'workerId', 'frame'} and self.identifier(value['workerId']) and
                    self.ready and self.closed is None and value['workerId'] in self.workers)
            self.parallel_worker_frame(self.workers[value['workerId']], value['frame'])
        return value


async def read_output(reader, gate, emit):
    while True:
        line = await asyncio.wait_for(reader.readline(), gate.budget.remaining(TOTAL_SECONDS))
        if not line:
            require(gate.receipt is not None)
            return gate.receipt, gate.inner_bytes + gate.control_bytes
        require(line.endswith(b'\n') and 1 < len(line) <= FRAME_CAP + 1)
        value = decoded(line[:-1]); require(encoded(value) + b'\n' == line)
        try: gate.accept(value, len(line))
        except Exception:
            if gate.frames > FRAME_COUNT or gate.inner_bytes > INNER_CAP or gate.control_bytes > CONTROL_CAP:
                # Physical cleanup must not reset an exhausted semantic budget.
                if hasattr(reader, 'failed'): reader.failed = True
            raise
        seconds = gate.budget.remaining(20)
        require(await asyncio.wait_for(emit(value, seconds), seconds) is True)


def input_frame_cap(value, *, session_mode=None):
    # Only the existing conversation visual turn may use the larger host->guest
    # frame. Tool results, output, metadata, analysis and ordinary text retain
    # their prior bounds; the inner session validates image bytes again.
    if session_mode == PARALLEL_MODE:
        if type(value) is not dict or set(value) != {'workerId', 'frame'}: return FRAME_CAP
        return input_frame_cap(value['frame'])
    if type(value) is not dict or value.get('kind') != 'turn': return FRAME_CAP
    if set(value) == {'kind','requestRef','conversation','images'}:
        text = value['conversation']
    elif set(value) == {'kind','purpose','requestRef','input','images'} and value['purpose'] == 'conversation':
        text = value['input']
    else: return FRAME_CAP
    if type(text) is not str or not 1 <= len(text.encode('utf-8')) <= 24576: return FRAME_CAP
    images = value['images']
    if type(images) is not list or not 1 <= len(images) <= 2: return FRAME_CAP
    for image in images:
        if (type(image) is not dict or set(image) != {'mimeType','base64'} or
                image['mimeType'] not in ('image/png','image/jpeg') or type(image['base64']) is not str): return FRAME_CAP
    return VISUAL_INPUT_FRAME_CAP


async def forward_input(writer, receive, gate):
    count = frames = 0
    while True:
        seconds = gate.budget.remaining(1)
        try: value = await asyncio.wait_for(receive(seconds), seconds)
        except TimeoutError: continue
        gate.budget.remaining(1)
        if value is IDLE: continue
        if value is None:
            gate.budget.close(); writer.close()
            # The client's session receiver does not yet run during custody.
            # Prompt owned-unit cleanup instead of waiting out all35s first.
            require(gate.ready)
            return
        if gate.session_mode == PARALLEL_MODE:
            require(type(value) is dict)
            closing = value == {'kind': 'close'}
            if not closing:
                require(set(value) in ({'workerId', 'frame'}, {'workerId', 'frame', 'work'}) and
                        gate.identifier(value['workerId']) and value['workerId'] in gate.workers)
                worker, frame = gate.workers[value['workerId']], value['frame']
                require(worker['ready'] and worker['closed'] is None and type(frame) is dict and
                        frame.get('kind') in ('turn', 'toolResult', 'release') and frame.get('purpose') == worker['purpose'])
                if frame['kind'] == 'turn' and worker['purpose'] == 'history-analysis':
                    work = value.get('work')
                    require(type(work) is dict and set(work) == {'taskRef', 'planRef', 'workRef'} and
                            all(gate.identifier(v) for v in work.values()))
                else: require('work' not in value)
        else:
            require(type(value) is dict and value.get('kind') in {'turn', 'toolResult', 'release', 'close'})
            closing = value['kind'] == 'close'
        require(closing or gate.ready)
        raw = encoded(value) + b'\n'; count += len(raw); frames += 1
        require(len(raw) <= input_frame_cap(value, session_mode=gate.session_mode) + 1 and count <= INNER_CAP and frames <= FRAME_COUNT)
        if closing:
            gate.budget.close()
            if not gate.ready:
                writer.close(); raise Refused()
        seconds = gate.budget.remaining(20)
        writer.write(raw)
        await asyncio.wait_for(writer.drain(), seconds)
        if closing:
            writer.close()
            return


PHYSICAL_EVIDENCE = ('clientLaunchCaptured', 'relayLaunchCaptured', 'creationsJoined', 'ownershipKnown',
    'clientUnitAbsent', 'relayUnitAbsent', 'unitChecksAfterCreations', 'transportsJoined',
    'stdinClosed', 'stdoutEof', 'stderrEof', 'sessionTasksJoined')
PHYSICAL_METHODS = ('clientStopRequested', 'relayStopRequested', 'transportKillRequested')


def physical_template():
    return dict.fromkeys((*PHYSICAL_EVIDENCE, *PHYSICAL_METHODS, 'complete'), False)


def result_template():
    return {'schema': 'standing-epoch-supervisor-v1', 'outcome': 'unknown', 'stage': 'preflight',
        'preflight': False, 'custodyReady': False, 'clientNaturalSettlement': False, 'relaySettled': False,
        'allProcessesSettled': False, 'settled': False, 'injectedPorts': False,
        'clientExit': None, 'relayExit': None, 'clientStdoutBytes': 0, 'clientStderrBytes': 0,
        'relayStdoutBytes': 0, 'relayStderrBytes': 0, 'client': None, 'relay': None,
        'physicalCleanup': physical_template()}


async def run_supervisor(supervisor_source, bundle, config, receive, emit, ports=None, *, budget=None, session_mode=None):
    """One bounded run. Tests may replace runtime/spawn/clock, never security data.

    receive/emit must be cancelable async ports; main below joins its actual FD
    worker calls after revocation. No output verdict alone proves settlement.
    """
    config_valid(config); require(callable(receive) and callable(emit))
    require(session_mode in (None, PARALLEL_MODE))
    require(ports is None or type(ports) is dict and set(ports) == {'runtime', 'spawn', 'clock'})
    require(budget is None or type(budget) is Budget)
    budget = budget or Budget(time.monotonic if ports is None else ports['clock'])
    runtime = prepare_runtime(supervisor_source, config) if ports is None else ports['runtime'](supervisor_source, config)
    spawn = asyncio.create_subprocess_exec if ports is None else ports['spawn']
    result = result_template(); result['injectedPorts'] = ports is not None
    runtime.validate_bundle(bundle)
    if session_mode == PARALLEL_MODE:
        capsule = load(bundle['client']['source'], 'reviewed_epoch_worker_population', bundle['client']['sha256'])
        configure_parallel_task_limit(runtime, capsule.worker_count())
    normalize = runtime.client_normalizer(bundle['client']['source'])
    gate = OutputGate(normalize, budget, session_mode=session_mode)
    started, processes, tasks, creations = [], [], [], []
    captured = set()
    ownership_unknown = False
    records, creation_roles, process_waiters = {}, {}, set()
    physical = result['physicalCleanup']

    class Reader:
        """One cumulative byte budget and observed EOF across semantic/tail reads."""
        def __init__(self, raw, cap):
            self.raw, self.cap, self.count = raw, cap, 0
            self.eof = self.failed = self.active = False
        def __getattr__(self, name): return getattr(self.raw, name)
        async def consume(self, method, size=None):
            if self.active or self.failed:
                self.failed = True; raise Refused()
            self.active = True
            try:
                if method == 'readline': data = await self.raw.readline()
                else: data = await self.raw.read(min(size, max(1, self.cap - self.count + 1)))
                self.count += len(data)
                if self.count > self.cap or method == 'readline' and len(data) > FRAME_CAP + 1:
                    self.failed = True; raise Refused()
                if not data: self.eof = True
                return data
            except asyncio.CancelledError: raise
            except Exception:
                self.failed = True; raise
            finally: self.active = False
        async def read(self, size): return await self.consume('read', size)
        async def readline(self): return await self.consume('readline')

    async def wait_proc(proc):
        current = asyncio.current_task(); process_waiters.add(current)
        try:
            value = await proc.wait()
            records[id(proc)]['waited'] = True
            return value
        finally: process_waiters.discard(current)

    def close_stdin(proc):
        nonlocal ownership_unknown
        try:
            if proc.stdin is not None: proc.stdin.close()
        except Exception: ownership_unknown = True

    def capture(creation):
        nonlocal ownership_unknown
        if creation in captured: return
        captured.add(creation)
        try: proc = creation.result()
        except BaseException:
            ownership_unknown = True; return
        processes.append(proc)
        role = creation_roles[creation]
        cap = INNER_CAP + CONTROL_CAP if role == runtime.CLIENT else 5120 if role == runtime.RELAY else 65536
        record = {'proc': proc, 'role': role, 'waited': False, 'stdinClosed': False,
            'stdout': None, 'stderr': None}
        records[id(proc)] = record
        try:
            require(proc.stdout is not None and proc.stderr is not None)
            proc.stdout = Reader(proc.stdout, cap); record['stdout'] = proc.stdout
            proc.stderr = Reader(proc.stderr, 65536); record['stderr'] = proc.stderr
            record['stdinClosed'] = proc.stdin is None
        except Exception: ownership_unknown = True
        if budget.closing: close_stdin(proc)

    async def owned_spawn(argv, kwargs, maximum, role='control'):
        # Never cancel creation at a timeout: the OS child may already exist.
        # Completion captures its handle BEFORE any deadline verdict; cleanup
        # joins all creation attempts or explicitly retains unknown ownership.
        budget.remaining(maximum)
        creation = asyncio.create_task(spawn(*argv, **kwargs)); creations.append(creation)
        creation_roles[creation] = role
        creation.add_done_callback(capture)
        return await wait(asyncio.shield(creation), maximum)

    async def join_creations():
        for creation in list(creations):
            if not creation.done():
                try: await wait(asyncio.shield(creation), 5)
                except Exception: pass
            if creation.done(): capture(creation)

    def kill_transport(proc):
        nonlocal ownership_unknown
        physical['transportKillRequested'] = True
        try: proc.kill()
        except ProcessLookupError: pass  # Exit notification can race kill.
        except Exception: ownership_unknown = True

    async def bounded_read(reader, cap, keep=True):
        retained = bytearray(); count = 0
        while True:
            data = await reader.read(4096)
            if not data: return bytes(retained), count
            count += len(data)
            if count > cap:
                if hasattr(reader, 'failed'): reader.failed = True
                raise Refused()
            if keep: retained.extend(data)

    def task(coro):
        value = asyncio.ensure_future(coro); tasks.append(value); return value

    async def wait(awaitable, maximum):
        try: seconds = budget.remaining(maximum)
        except BaseException:
            if inspect.iscoroutine(awaitable): awaitable.close()
            raise
        call_end = budget.clock() + seconds
        value = await asyncio.wait_for(awaitable, seconds)
        require(budget.clock() <= call_end)
        budget.remaining(maximum)
        return value

    async def control(argv, timeout=12):
        proc = await owned_spawn(argv, {'stdout':asyncio.subprocess.PIPE, 'stderr':asyncio.subprocess.PIPE}, timeout)
        out = task(bounded_read(proc.stdout, 65536)); err = task(bounded_read(proc.stderr, 65536, False))
        try:
            await wait(asyncio.gather(wait_proc(proc), out, err), timeout)
            return proc.returncode, out.result()[0]
        finally:
            if proc.returncode is None:
                kill_transport(proc)
                try: await wait(wait_proc(proc), 5)
                except Exception: pass

    runtime.control = control

    async def absent_after(unit):
        end = min(budget.clock() + 5, budget.end, budget.hard_end)
        while True:
            require(budget.clock() < end)
            info = await wait(runtime.snapshot(unit), end - budget.clock())
            if runtime.absent(info): return True
            if not runtime.owned(info, unit): return False
            await asyncio.sleep(min(.25, max(0, end - budget.clock())))

    async def settle(unit):
        info = await wait(runtime.snapshot(unit), 12)
        if runtime.absent(info): return True
        if not runtime.owned(info, unit): return False
        physical['clientStopRequested' if unit == runtime.CLIENT else 'relayStopRequested'] = True
        await control(['/usr/bin/systemctl', 'stop', unit], 15)
        return await absent_after(unit)

    async def launch(unit, source):
        argv = runtime.unit_argv(unit, source); argv[-1] = BOOTSTRAP
        proc = await owned_spawn(argv, {'stdin':asyncio.subprocess.PIPE, 'stdout':asyncio.subprocess.PIPE,
            'stderr':asyncio.subprocess.PIPE, 'limit':FRAME_CAP + 1}, 15, role=unit)
        stderr = task(bounded_read(proc.stderr, 65536, False))
        proc.stdin.write(source_frame(source)); await wait(proc.stdin.drain(), 15)
        if unit == runtime.RELAY: proc.stdin.close()
        return proc, stderr

    relay = client = incoming = None
    try:
        # Same frozen admission predicates, in the same order.
        runtime.require(runtime.os.geteuid() == 0)
        runtime.relay_identity_available()
        for unit in (runtime.RELAY, runtime.CLIENT): runtime.require(runtime.absent(await runtime.snapshot(unit)))
        runtime.require(not runtime.ROOT.exists() and not runtime.ROOT.is_symlink())
        info = runtime.BINARY.lstat()
        runtime.require(runtime.stat.S_ISREG(info.st_mode) and runtime.stat.S_IMODE(info.st_mode) == 0o555 and
            info.st_uid == 0 and info.st_gid == 0 and info.st_size == 258659424)
        with runtime.BINARY.open('rb') as stream: digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        runtime.require(digest == runtime.BINARY_SHA)
        socket_end = min(budget.clock() + 20, budget.end)
        while True:
            budget.remaining(20)
            tables = {name: runtime.Path('/proc/net/' + name).read_text() for name in ('tcp', 'tcp6', 'udp', 'udp6')}
            if runtime.exclusive_addresses_clear(tables): break
            require(budget.clock() < socket_end); await asyncio.sleep(min(.25, socket_end - budget.clock()))
        budget.remaining(1)
        runtime.ROOT.mkdir(mode=0o700); runtime.os.chown(runtime.ROOT, 20000, 20000)
        result['preflight'] = True; result['stage'] = 'relay_launch'; started.append(runtime.RELAY)
        relay, relay_err = await launch(runtime.RELAY, bundle['relay']['source'])
        ready = await wait(relay.stdout.readline(), 15)
        require(0 < len(ready) < 1024 and decoded(ready) == {'event': 'ready', 'version': 1})
        runtime.require(runtime.owned(await runtime.snapshot(runtime.RELAY), runtime.RELAY))
        relay_out = task(bounded_read(relay.stdout, 4096))
        result['stage'] = 'client_launch'; started.append(runtime.CLIENT)
        client, client_err = await launch(runtime.CLIENT, bundle['client']['source'])
        result['stage'] = 'session'
        output = task(read_output(client.stdout, gate, emit)); incoming = task(forward_input(client.stdin, receive, gate))
        completion = task(asyncio.gather(wait_proc(client), output, client_err))
        # Input may finish normally on close/EOF; an input fault must stop work.
        while not completion.done():
            done, _ = await asyncio.wait({completion, incoming}, timeout=budget.remaining(1), return_when=asyncio.FIRST_COMPLETED)
            if incoming in done:
                incoming.result()
                await wait(asyncio.shield(completion), TOTAL_SECONDS)
            if completion in done: completion.result()
        completion.result(); budget.close()
        incoming.cancel(); await asyncio.gather(incoming, return_exceptions=True)
        result.update(client=output.result()[0], clientStdoutBytes=output.result()[1], clientExit=client.returncode,
            clientStderrBytes=client_err.result()[1], custodyReady=gate.custody)
        result['stage'] = 'settlement'
        result['clientNaturalSettlement'] = await absent_after(runtime.CLIENT)
        result['relaySettled'] = await settle(runtime.RELAY)
        await wait(asyncio.gather(wait_proc(relay), relay_out, relay_err), 15)
        relay_data, count = relay_out.result()
        result.update(relayExit=relay.returncode, relayStdoutBytes=count, relayStderrBytes=relay_err.result()[1],
            relay=runtime.normalize_relay(decoded(relay_data)))
    except (Exception, asyncio.CancelledError):
        budget.close()
    finally:
        budget.close()
        if incoming is not None:
            incoming.cancel()
            try: await wait(asyncio.gather(incoming, return_exceptions=True), CLEANUP_SECONDS)
            except Exception: pass
        await join_creations()
        # An absence snapshot cannot settle a launch still being created: it
        # may start its unit after that snapshot, even if its transport later
        # exits naturally. Such ownership remains unknown for reconciliation.
        creation_proof_incomplete = any(not creation.done() for creation in creations)
        for proc in processes: close_stdin(proc)
        settlements = []
        for unit in reversed(started):
            try: settlements.append(await settle(unit))
            except Exception: settlements.append(False)
        await join_creations()
        for proc in processes: close_stdin(proc)
        for proc in processes:
            if proc.returncode is None:
                try: await wait(wait_proc(proc), 5)
                except Exception:
                    # Only this invocation's local systemd-run/control transport.
                    kill_transport(proc)
                    try: await wait(wait_proc(proc), 5)
                    except Exception: pass
        for pending in tasks:
            if not pending.done(): pending.cancel()
        try: await wait(asyncio.gather(*tasks, return_exceptions=True), CLEANUP_SECONDS)
        except Exception: pass
        # A failed semantic reader is joined before this private bounded tail
        # drain takes ownership. Reader.count is never reset after a refusal.
        for record in list(records.values()):
            proc = record['proc']
            if not record['waited']:
                try: await wait(wait_proc(proc), 5)
                except Exception: pass
            if proc.stdin is not None:
                try:
                    await wait(proc.stdin.wait_closed(), 5)
                    record['stdinClosed'] = True
                except Exception: pass
            for reader in (record['stdout'], record['stderr']):
                if reader is None or reader.active or reader.failed: continue
                try:
                    while not reader.eof:
                        await wait(reader.read(4096), CLEANUP_SECONDS)
                except Exception: pass
        launch_joins = all(c.done() and c in captured for c in creations if creation_roles[c] != 'control')
        if launch_joins and not ownership_unknown:
            # These snapshots postdate all launch completions. Snapshot control
            # processes themselves are captured, drained and waited by control().
            checked = True
            for unit, key in ((runtime.CLIENT, 'clientUnitAbsent'), (runtime.RELAY, 'relayUnitAbsent')):
                try:
                    info = await wait(runtime.snapshot(unit), 12)
                    physical[key] = runtime.absent(info)
                except Exception: checked = False
            physical['unitChecksAfterCreations'] = checked
        values = list(records.values())
        physical.update(clientLaunchCaptured=any(r['role'] == runtime.CLIENT for r in values),
            relayLaunchCaptured=any(r['role'] == runtime.RELAY for r in values),
            creationsJoined=all(c.done() and c in captured for c in creations),
            ownershipKnown=not ownership_unknown,
            transportsJoined=all(r['waited'] and r['proc'].returncode is not None for r in values),
            stdinClosed=all(r['stdinClosed'] for r in values),
            stdoutEof=all(r['stdout'] is not None and r['stdout'].eof and not r['stdout'].failed for r in values),
            stderrEof=all(r['stderr'] is not None and r['stderr'].eof and not r['stderr'].failed for r in values),
            sessionTasksJoined=all(t.done() for t in tasks) and not process_waiters)
        physical['complete'] = all(physical[k] for k in PHYSICAL_EVIDENCE)
        result['settled'] = all(settlements) and not creation_proof_incomplete
        result['allProcessesSettled'] = (not ownership_unknown and all(creation.done() and creation in captured for creation in creations)
                                        and all(proc.returncode is not None for proc in processes))
        result['custodyReady'] = gate.custody
        result['clientStdoutBytes'] = gate.inner_bytes + gate.control_bytes
        if gate.receipt is not None: result['client'] = gate.receipt
        # launch() can fail after capture but before its caller's assignment.
        # Derive exit/counts from the exact owned role handle even in that case.
        for record in values:
            prefix = 'client' if record['role'] == runtime.CLIENT else 'relay' if record['role'] == runtime.RELAY else None
            if prefix:
                result[prefix + 'Exit'] = record['proc'].returncode
                if record['stderr'] is not None: result[prefix + 'StderrBytes'] = min(65536, record['stderr'].count)
    if (result['client'] is not None and result['client']['outcome'] == 'observed' and result['clientExit'] == 0 and
        result['clientNaturalSettlement'] and result['relaySettled'] and result['relayExit'] == 0 and
        result['relay'] is not None and result['settled'] and result['allProcessesSettled'] and
        (session_mode != PARALLEL_MODE or physical['complete'])):
        result['outcome'] = 'observed'; result['stage'] = 'complete'
    return normalize_result(result, normalize, runtime.normalize_relay)


def normalize_result(value, normalize_client, normalize_relay):
    template = result_template()
    require(type(value) is dict and set(value) in (set(template), set(template) - {'physicalCleanup'}) and value['schema'] == template['schema'])
    require(value['outcome'] in {'observed', 'unknown'} and value['stage'] in {'preflight', 'relay_launch', 'client_launch', 'session', 'settlement', 'complete'})
    for key, default in template.items():
        if type(default) is bool: require(type(value[key]) is bool)
    for key in ('clientExit', 'relayExit'):
        require(value[key] is None or type(value[key]) is int and -255 <= value[key] <= 255)
    for key, cap in (('clientStdoutBytes', INNER_CAP + CONTROL_CAP), ('clientStderrBytes', 65536),
                     ('relayStdoutBytes', 4096), ('relayStderrBytes', 65536)):
        require(type(value[key]) is int and 0 <= value[key] <= cap)
    result = dict(value)
    if 'physicalCleanup' in value:
        p = value['physicalCleanup']
        require(type(p) is dict and set(p) == set(physical_template()) and all(type(x) is bool for x in p.values()))
        require(p['complete'] == all(p[k] for k in PHYSICAL_EVIDENCE))
        if p['complete']:
            require(value['clientExit'] is not None and value['relayExit'] is not None and value['allProcessesSettled'])
        result['physicalCleanup'] = dict(p)
    if value['client'] is not None: result['client'] = normalize_client(value['client'])
    if value['relay'] is not None: result['relay'] = normalize_relay(value['relay'])
    if result['client'] is not None and result['relay'] is not None and 'diagnostics' in result['relay']:
        workers = result['relay']['diagnostics']['workerCount']
        if result['client'].get('schema') == PARALLEL_SCHEMA:
            count = len(result['client']['custodyChildren'])
            require(count <= workers and (result['client']['outcome'] != 'observed' or count == workers))
        else:
            require(workers == 1)
    if value['outcome'] == 'observed':
        require(value['stage'] == 'complete' and all(value[k] for k in ('preflight', 'custodyReady', 'clientNaturalSettlement', 'relaySettled', 'allProcessesSettled', 'settled')))
        require(value['clientExit'] == value['relayExit'] == 0 and result['client'] is not None and
                result['client']['outcome'] == 'observed' and result['relay'] is not None)
        if result['client'].get('schema') == PARALLEL_SCHEMA:
            require('physicalCleanup' in result and result['physicalCleanup']['complete'])
    return result


async def main(supervisor_source, bundle, config, *, session_mode=None):
    """Actual private Linux pipe entry, invoked only by the root host's capsule.

    Thread workers perform bounded nonblocking FD calls. Canceling the input
    pump joins its existing <=1s read, without closing the output direction.
    Cancellation joins the same bounded FD call, including repeated cancels.
    A completed output write preserves the wire; failed/unknown writes revoke
    it. No write is retried or given a renewed deadline.
    """
    budget = Budget()
    capsule = load(bundle['client']['source'], 'reviewed_epoch_outer_codec', bundle['client']['sha256'])
    import sys
    wire = capsule.wire_class()(sys.stdin.fileno(), sys.stdout.fileno(), idle=IDLE)
    pending = set()
    async def fd_call(function, *args, writing=False):
        deadline = budget.clock() + args[-1]
        def invoke():
            seconds = min(args[-1], deadline - budget.clock())
            require(seconds > 0)
            return function(*args[:-1], seconds)
        operation = asyncio.create_task(asyncio.to_thread(invoke)); pending.add(operation)
        try:
            await asyncio.wait({operation})
            return operation.result()
        except asyncio.CancelledError:
            while not operation.done():
                try: await asyncio.wait({operation})
                except asyncio.CancelledError: continue
            if writing and (operation.cancelled() or operation.exception() is not None or operation.result() is not True):
                wire.close()
            raise
        finally: pending.discard(operation)
    async def receive(seconds): return await fd_call(wire.receive, seconds)
    async def emit(frame, seconds): return await fd_call(wire.emit, frame, seconds, writing=True)
    try:
        receipt = await run_supervisor(supervisor_source, bundle, config, receive, emit, budget=budget, session_mode=session_mode)
        require(await emit({'kind': 'supervisorResult', 'receipt': receipt}, budget.remaining(20)) is True)
        budget.remaining(1)
        return receipt
    finally:
        wire.close()
        if pending: await asyncio.gather(*pending, return_exceptions=True)
