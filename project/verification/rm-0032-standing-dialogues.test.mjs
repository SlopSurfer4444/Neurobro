import test from 'node:test';
import assert from 'node:assert/strict';
import { readStandingDialogues } from './rm-0032-standing-dialogues.mjs';

function fixture(failure = false, outcomePatch = {}) {
  const events = [], passphrase = 'invented-long-journal-passphrase';
  const ports = {
    async prepare() { events.push('prepare'); return { directory: 'invented', binding: { accountId: '71', peerId: '-91' } }; },
    async credentials() { events.push('credentials'); return { apiId: 123, apiHash: 'secret-hash', passphrase }; },
    async journal(options) {
      events.push('open'); assert.equal(options.readOnly, true); assert.equal(options.passphrase, passphrase);
      return { async read(options) {
        events.push('read'); assert.equal(options.scanLimit, 100);
        if (failure) throw new Error('invented unavailable');
        return { dialogues: [{ key: '0000000077', question: { primary: { ownerId: '111', chatId: '-91', text: 'ПРОМПТ что ты сказал?' }, source: { date: 1700000000, displayName: 'Участник' } }, recordedAt: 1700000001,
          modelAdmission: { attemptRef: 'private-job' }, outcome: { delivery: 'unknown', answer: 'Предыдущий ответ', kind: 'model', ...outcomePatch }, status: 'unknown' }], scanned: 1, hasOlder: false };
      }, close() { events.push('close'); } };
    },
  };
  return { ports, events };
}
test('authorized view contains dialogue and honest delivery, excludes credentials and transport identifiers', async () => {
  const f = fixture(), result = await readStandingDialogues({ limit: 5 }, f.ports);
  assert.deepEqual(f.events, ['prepare','credentials','open','read','close']);
  assert.equal(result.dialogues[0].delivery, 'unknown'); assert.equal(result.dialogues[0].answer, 'Предыдущий ответ');
  assert.equal(result.completeChatHistory, false); assert.equal(result.contextRecorded, false);
  for (const word of ['secret-hash','passphrase','private-job','ownerId','chatId','accountId','0000000077']) assert.equal(JSON.stringify(result).includes(word), false);
  assert.equal(result.dialogues[0].reference, 1);
});
test('operator distinguishes submitted formatting from verified readback and unknown legacy formatting', async () => {
  for (const delivery of ['verified', 'unknown']) {
    const f = fixture(false, { delivery, deliveryDiagnostic: delivery === 'unknown' ? 'readback-mismatch' : undefined,
      entities: [{type:'bold',offset:0,length:10}, {type:'textUrl',offset:11,length:5,url:'https://example.com/private-source'}] });
    const row = (await readStandingDialogues({}, f.ports)).dialogues[0];
    assert.deepEqual(row.formatting, { basis: delivery === 'verified' ? 'verified-entities' : 'submitted-entities', counts: {bold:1,textUrl:1} });
    assert.equal(row.deliveryDiagnostic, delivery === 'unknown' ? 'readback-mismatch' : null);
    assert.equal(JSON.stringify(row).includes('private-source'), false);
  }
  const old = (await readStandingDialogues({}, fixture().ports)).dialogues[0];
  assert.equal(old.formatting, null); assert.equal(old.deliveryDiagnostic, null);
});
test('read failure always closes journal without writer fallback', async () => {
  const f = fixture(true); await assert.rejects(readStandingDialogues({}, f.ports)); assert.equal(f.events.at(-1), 'close');
});
test('invalid ranges and oversized requests are refused before credential load', async () => {
  for (const options of [{limit:21},{limit:0},{limit:1.5},{fromDate:2,toDate:1},{fromDate:0},{raw:true}]) {
    const f = fixture(); await assert.rejects(readStandingDialogues(options, f.ports)); assert.deepEqual(f.events, []);
  }
});
