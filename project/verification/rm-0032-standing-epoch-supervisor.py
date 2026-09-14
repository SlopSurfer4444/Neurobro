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
EXECUTABLE_CAP = 120000
FRAME_CAP = 786432
VISUAL_INPUT_FRAME_CAP = 12 * 1024 * 1024
INNER_CAP = 203423744
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


def specialize_relay(source):
    """Public counted specialization; original allowlist/DNS/TLS opacity intact.

    The sole event loop reserves combined bytes before forwarding. All accepted
    tunnels share one 1GiB budget, including canceled or partial writes; the old
    64*32MiB theoretical total was 2GiB. No reconnect, retry or payload retention.
    """
    require(sha(source) == RELAY_PIN)
    changes = [
        ('MAX_LIFETIME = 900', 'MAX_LIFETIME = 1055'),
        ('MAX_TUNNEL_SECONDS = 300', 'MAX_TUNNEL_SECONDS = 1055'),
        ('IDLE_SECONDS = 60', 'IDLE_SECONDS = 300'),
        ('MAX_TUNNEL_BYTES = 32 * 1024 * 1024', 'MAX_TUNNEL_BYTES = 1024 * 1024 * 1024'),
        ('duration=MAX_TUNNEL_SECONDS):', 'duration=MAX_TUNNEL_SECONDS, reserve=None):'),
        ('            moved += len(data)\n            if moved > byte_limit:',
         '            if reserve is not None:\n                reserve(len(data))\n            moved += len(data)\n            if moved > byte_limit:'),
        ('        self.closing = False', '        self.closing = False\n        self.reserved_bytes = 0'),
        ('    def finished(self, task):',
         '    def reserve(self, count):\n        if type(count) is not int or count <= 0 or self.reserved_bytes + count > MAX_TUNNEL_BYTES:\n            raise Refused()\n        self.reserved_bytes += count\n\n    def finished(self, task):'),
        ('await tunnel(reader, writer, remote_reader, remote_writer)',
         'await tunnel(reader, writer, remote_reader, remote_writer, reserve=self.reserve)'),
        ('backlog=MAX_CONCURRENT, reuse_address=False)', 'backlog=MAX_CONCURRENT, reuse_address=True, reuse_port=False)'),
        ('            await self.server.wait_closed()\n            tasks = list(self.tasks)', '            tasks = list(self.tasks)'),
        ('            await asyncio.gather(*tasks, return_exceptions=True)\n        return dict(self.counts)',
         '            await asyncio.gather(*tasks, return_exceptions=True)\n            await self.server.wait_closed()\n        return dict(self.counts)'),
    ]
    for before, after in changes: source = replace_exact(source, before, after)
    require(len(source.encode()) < EXECUTABLE_CAP)
    compile(source, '<reviewed-warm-relay>', 'exec')
    return source


def build_bundle(relay_source, client_sources, client_source, wire_source, config, pins):
    """Pure host preparation. Public dependency bundle has its own decoded cap;
    individual sources, executable capsule and framed input caps are unchanged.

    pins must cover precisely the managed client's dependencies plus _client and
    _wire. The frozen supervisor independently checks the finished capsule hash.
    """
    config_valid(config)
    require(type(client_sources) is dict and type(pins) is dict)
    require(not ({'_client', '_wire'} & set(client_sources)))
    contents = {**client_sources, '_client': client_source, '_wire': wire_source}
    require(set(contents) == set(pins))
    for name, source in contents.items():
        require(type(name) is str and type(source) is str and type(pins[name]) is str and
                0 < len(source.encode('utf-8')) <= SOURCE_CAP and
                re.fullmatch('[a-fA-F0-9]{64}', pins[name]) and sha(source) == pins[name].lower())
    client = load(client_source, 'reviewed_epoch_client_schema')
    require(set(client_sources) == set(client.PINS))
    require(all(pins[name].upper() == client.PINS[name] for name in client_sources))
    raw = encoded(contents)
    require(len(raw) <= PUBLIC_BUNDLE_CAP)
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
    require(len(capsule.encode()) < EXECUTABLE_CAP)
    relay = specialize_relay(relay_source)
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
    """Only fixed identities, duration and suppressed outer print change here.

    All frozen ownership, UID, network, filesystem, binary and bundle predicates
    remain source-identical. This module owns duplex orchestration and its shared
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
    ]: source = replace_exact(source, before, after, count)
    return load(source, 'reviewed_epoch_supervisor_runtime')


class OutputGate:
    """Outer control ordering only; inner turn/tool semantics remain endpoint-owned."""
    INNER = {'ready', 'scope', 'tool', 'imageBegin', 'imageChunk', 'imageEnd', 'completed', 'released', 'notAdmitted', 'closed'}

    def __init__(self, normalize, budget):
        self.normalize, self.budget = normalize, budget
        self.custody = self.ready = False
        self.closed = self.receipt = self.proof = None
        self.inner_bytes = self.control_bytes = self.frames = 0
        self.mode = self.active_scope = None

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
            require(type(purpose) is str and purpose in {'conversation', 'history-analysis'})
            require(type(ref) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', ref) is not None)
            binding = (purpose, ref)
            require(self.active_scope is None or self.active_scope == binding)
            if kind == 'released':
                require(self.active_scope == binding)
                if purpose == 'history-analysis': require(value['delivery'] == 'not-sent')
                self.active_scope = None
            else:
                self.active_scope = binding
                if kind == 'completed' and purpose == 'history-analysis': require(value['kindOfAnswer'] == 'text')
        elif kind in {'imageBegin', 'imageChunk', 'imageEnd'}:
            require(self.active_scope is not None and self.active_scope[0] == 'conversation' and 'purpose' not in value)
        elif kind == 'closed':
            require(type(value.get('facts')) is dict and value['facts'].get('schema') == 'neurobro-native-scoped-epoch-v1')

    def accept(self, value, length):
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
                require(receipt['schema'] == ('decadans.rm0032.standing-scoped-epoch.v1' if self.mode == 'scoped' else 'decadans.rm0032.standing-epoch.v1'))
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
                    require(value['protocol'] == 'standing-scoped-epoch-v1')
                    scopes = value['scopes']
                    require(type(scopes) is list and len(scopes) == 2)
                    require(all(type(scope) is dict and set(scope) == {'purpose', 'tools'} for scope in scopes))
                    require(scopes[0]['purpose'] == 'conversation' and scopes[1]['purpose'] == 'history-analysis')
                    self.names(scopes[0]['tools'])
                    require(scopes[1]['tools'] == ['neurobro_analysis_material', 'neurobro_analysis_notes', 'neurobro_analysis_commit'])
                    self.mode = 'scoped'
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
                require(set(value) == ({'kind', 'requestRef', 'reason', 'turnsAdmitted', 'purpose', 'turnStartDispatches'} if self.mode == 'scoped' else
                    {'kind', 'requestRef', 'reason', 'turnsAdmitted'}))
                if self.mode == 'scoped':
                    require(type(value['purpose']) is str and value['purpose'] in {'conversation', 'history-analysis'})
                    require(type(value['turnStartDispatches']) is int and 0 <= value['turnStartDispatches'] <= 16)
                require(type(value['requestRef']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', value['requestRef']) is not None)
                require(type(value['reason']) is str and value['reason'] in {'time', 'turns'})
                require(type(value['turnsAdmitted']) is int and 0 <= value['turnsAdmitted'] <= 16)
            if kind == 'closed':
                require(set(value) == {'kind', 'code', 'facts'})
                self.closed = decoded(encoded(value)); self.budget.close()
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


def input_frame_cap(value):
    # Only the existing conversation visual turn may use the larger host->guest
    # frame. Tool results, output, metadata, analysis and ordinary text retain
    # their prior bounds; the inner session validates image bytes again.
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
        require(type(value) is dict and value.get('kind') in {'turn', 'toolResult', 'release', 'close'})
        closing = value['kind'] == 'close'
        require(closing or gate.ready)
        raw = encoded(value) + b'\n'; count += len(raw); frames += 1
        require(len(raw) <= input_frame_cap(value) + 1 and count <= INNER_CAP and frames <= FRAME_COUNT)
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


async def run_supervisor(supervisor_source, bundle, config, receive, emit, ports=None, *, budget=None):
    """One bounded run. Tests may replace runtime/spawn/clock, never security data.

    receive/emit must be cancelable async ports; main below joins its actual FD
    worker calls after revocation. No output verdict alone proves settlement.
    """
    config_valid(config); require(callable(receive) and callable(emit))
    require(ports is None or type(ports) is dict and set(ports) == {'runtime', 'spawn', 'clock'})
    require(budget is None or type(budget) is Budget)
    budget = budget or Budget(time.monotonic if ports is None else ports['clock'])
    runtime = prepare_runtime(supervisor_source, config) if ports is None else ports['runtime'](supervisor_source, config)
    spawn = asyncio.create_subprocess_exec if ports is None else ports['spawn']
    result = result_template(); result['injectedPorts'] = ports is not None
    runtime.validate_bundle(bundle)
    normalize = runtime.client_normalizer(bundle['client']['source'])
    gate = OutputGate(normalize, budget)
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
        result['relay'] is not None and result['settled'] and result['allProcessesSettled']):
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
    if value['outcome'] == 'observed':
        require(value['stage'] == 'complete' and all(value[k] for k in ('preflight', 'custodyReady', 'clientNaturalSettlement', 'relaySettled', 'allProcessesSettled', 'settled')))
        require(value['clientExit'] == value['relayExit'] == 0 and result['client'] is not None and
                result['client']['outcome'] == 'observed' and result['relay'] is not None)
    return result


async def main(supervisor_source, bundle, config):
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
        receipt = await run_supervisor(supervisor_source, bundle, config, receive, emit, budget=budget)
        require(await emit({'kind': 'supervisorResult', 'receipt': receipt}, budget.remaining(20)) is True)
        budget.remaining(1)
        return receipt
    finally:
        wire.close()
        if pending: await asyncio.gather(*pending, return_exceptions=True)
