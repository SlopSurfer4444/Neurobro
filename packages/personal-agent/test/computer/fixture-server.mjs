import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
let initialized = false;
let handshake;
let calls = 0;
let held;
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const lines = createInterface({ input: process.stdin });
// This is a local protocol fixture. It never starts Codex or accesses credentials.
lines.on('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    handshake = frame.params;
    if (mode === 'init-hang') return;
    if (mode === 'init-error') { send({ id: frame.id, error: { code: -32000, message: 'initialize refused' } }); return; }
    send({ id: frame.id, result: { userAgent: 'fixture' } });
    return;
  }
  if (frame.method === 'initialized') { initialized = true; return; }
  if (frame.method === 'handshake') {
    send({ id: frame.id, result: { initialized, handshake, calls, marker: process.env.TRANSPORT_FIXTURE_MARKER ?? null } });
    return;
  }
  if (frame.method === 'hang') { calls++; return; }
  if (frame.method === 'exit') { process.exit(23); }
  if (frame.method === 'malformed') { process.stdout.write('{broken\n'); return; }
  if (frame.method === 'oversized') { process.stdout.write('x'.repeat(4097)); return; }
  if (frame.method === 'oversized-chunks') {
    process.stdout.write('x'.repeat(100));
    setTimeout(() => process.stdout.write('x'.repeat(100)), 10);
    return;
  }
  if (frame.method === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 10])); return; }
  if (frame.method === 'partial-exit') { process.stdout.write('{"id":', () => process.exit(0)); return; }
  if (frame.method === 'bad-frame') { send(frame.params.frame); return; }
  if (frame.method === 'error') { send({ id: frame.id, error: { code: -32001, message: 'fixture refusal' } }); return; }
  if (frame.method === 'unknown') {
    send({ id: String(frame.id), result: 'wrong string identity' });
    send({ id: frame.id + 1000, result: 'wrong numeric identity' });
    setTimeout(() => send({ id: frame.id, result: 'correct' }), 10);
    return;
  }
  if (frame.method === 'reverse') {
    if (!held) held = frame;
    else {
      process.stdout.write(JSON.stringify({ id: frame.id, result: frame.params.value }) + '\n' +
        JSON.stringify({ id: held.id, result: held.params.value }) + '\n');
      held = undefined;
    }
    return;
  }
  if (frame.method === 'chunked') {
    const response = Buffer.from(JSON.stringify({ id: frame.id, result: 'Привет 🚀' }) + '\n');
    let offset = 0;
    const emit = () => {
      process.stdout.write(response.subarray(offset, offset + 1));
      offset++;
      if (offset < response.length) setTimeout(emit, 1);
    };
    emit();
    return;
  }
  if (frame.method === 'notifications') {
    send({ method: 'fixture/notice', params: { value: 1 } });
    send({ id: frame.id, result: true });
    return;
  }
  if (frame.method === 'server-request') {
    held = frame;
    send({ id: 'server-approval', method: 'item/commandExecution/requestApproval', params: { command: 'unsafe' } });
    return;
  }
  if (frame.id === 'server-approval') {
    send({ id: held.id, result: frame });
    held = undefined;
    return;
  }
  send({ id: frame.id, result: frame.params });
});
lines.on('close', () => {
  if (mode === 'ignore-eof') setInterval(() => {}, 1000);
  else process.exit(0);
});
