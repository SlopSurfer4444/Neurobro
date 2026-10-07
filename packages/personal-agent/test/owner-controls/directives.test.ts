import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOwnerDirective } from '../../src/owner-controls/directives.ts';

test('complete direct commands accept the optional owner command prefix and preserve selector identity', () => {
  assert.deepEqual(parseOwnerDirective('  /бро наблюдай @Source_1 @source2  '), { kind: 'observe', selectors: ['@Source_1', '@source2'] });
  for (const verb of ['monitor', 'watch', 'НАБЛЮДАЙ']) {
    assert.deepEqual(parseOwnerDirective(`${verb} @abcd`), { kind: 'observe', selectors: ['@abcd'] });
  }
  for (const verb of ['читай', 'read']) {
    assert.deepEqual(parseOwnerDirective(`${verb} @abcd`), { kind: 'read', selectors: ['@abcd'] });
  }
  for (const verb of ['перестань наблюдать', 'unsubscribe']) {
    assert.deepEqual(parseOwnerDirective(`${verb} @abcd`), { kind: 'unsubscribe', selectors: ['@abcd'] });
  }
});

test('public links and private post links normalize only their supported complete grammar', () => {
  assert.deepEqual(parseOwnerDirective('наблюдай t.me/Source_1 https://t.me/source2/ @Source_1 t.me/c/123456/78'), {
    kind: 'observe', selectors: ['@Source_1', '@source2', 'https://t.me/c/123456/78'],
  });
  assert.deepEqual(parseOwnerDirective('read HTTPS://T.ME/c/123456/78/'), { kind: 'read', selectors: ['https://t.me/c/123456/78'] });
  assert.deepEqual(parseOwnerDirective(`watch @a${'x'.repeat(31)}`), { kind: 'observe', selectors: [`@a${'x'.repeat(31)}`] });
  for (const selector of [
    '@abc', `@a${'x'.repeat(32)}`, '@1234', '@abcd/', '@abcd,', '@abcd.', '@abсd', '@abcd-extra',
    'http://t.me/abcd', 'https://t.me.evil/abcd', 'https://evil/t.me/abcd', 'https://user@t.me/abcd',
    'https://t.me/abcd?x=1', 'https://t.me/abcd#ref', 'https://t.me/abcd/123', 'https://t.me/+invite',
    'https://t.me/c/0/1', 'https://t.me/c/12/0', 'https://t.me/c/-12/1', 'https://t.me/c/012/1',
    'https://t.me/c/12/1?single', 'https://t.me/c/12/1/2', 'https://t.me/c/12',
  ]) assert.equal(parseOwnerDirective(`наблюдай ${selector}`), undefined, selector);
});

test('forward references produce an explicit marker, requiring trusted provenance at the caller', () => {
  for (const text of ['наблюдай этот источник', '/бро наблюдай этот источник', 'monitor this source', 'watch this source']) {
    assert.deepEqual(parseOwnerDirective(text), { kind: 'observe', selectors: [], forwardedSource: true });
  }
  for (const text of ['этот источник', 'наблюдай его', 'наблюдай это', 'наблюдай этот источник @abcd', 'read this source']) {
    assert.equal(parseOwnerDirective(text), undefined, text);
  }
});

test('quoted commands, negation, descriptions and partial selector lists never become directives', () => {
  for (const text of [
    '"наблюдай @abcd"', '«наблюдай @abcd»', '`watch @abcd`', '> watch @abcd',
    'не наблюдай @abcd', '/бро не наблюдай @abcd', 'do not watch @abcd',
    'Он сказал: наблюдай @abcd', 'Команда наблюдай @abcd', 'Напиши "наблюдай @abcd"',
    'можешь наблюдать @abcd?', 'пожалуйста наблюдай @abcd', 'наблюдай @abcd если возможно',
    'watch @abcd and @efgh', 'watch @abcd invalid', 'read @abcd; unsubscribe @efgh',
    'разрешаю @abcd', 'согласен на все @abcd', 'да наблюдай @abcd', 'approve @abcd',
    '/бро@bot watch @abcd', '/броwatch @abcd', 'watch', 'наблюдай', '',
  ]) assert.equal(parseOwnerDirective(text), undefined, text);
});

test('anchored approval can bind a proposal and an exact comma-separated subset without granting a source', () => {
  for (const text of ['да', 'подтверждаю', 'подтверждаю.', 'да, делай', 'ага', 'ок', 'давай', 'approve', 'yes', '/бро YES']) {
    assert.deepEqual(parseOwnerDirective(text), { kind: 'approve' });
  }
  assert.deepEqual(parseOwnerDirective('/бро подтвердить #proposal-123 только a,b'), {
    kind: 'approve', proposalId: 'proposal-123', selectedIds: ['a', 'b'],
  });
  assert.deepEqual(parseOwnerDirective('approve #Proposal_123 only item-1, item_2'), {
    kind: 'approve', proposalId: 'Proposal_123', selectedIds: ['item-1', 'item_2'],
  });
  assert.deepEqual(parseOwnerDirective('да только a,b'), { kind: 'approve', selectedIds: ['a', 'b'] });
  for (const text of ['да,', 'yes please', 'не подтверждаю', '"approve"', 'approve proposal',
    'approve #', 'approve #bad.id', 'approve #id only a b', 'approve only a,', 'approve only a,a',
    'approve only @abcd', 'approve only a,*', `approve #${'a'.repeat(65)}`,
  ]) assert.equal(parseOwnerDirective(text), undefined, text);
});

test('rejection has no selector or subset interpretation', () => {
  for (const text of ['нет', 'отклонить', 'отклоняю', 'reject', 'no']) {
    assert.deepEqual(parseOwnerDirective(text), { kind: 'reject' });
  }
  assert.deepEqual(parseOwnerDirective('/бро отклонить #proposal-123'), { kind: 'reject', proposalId: 'proposal-123' });
  for (const text of ['no @abcd', 'reject #id only a', 'отклонить все', 'Он ответил нет']) {
    assert.equal(parseOwnerDirective(text), undefined, text);
  }
});

test('input and token limits fail closed, including control characters and invisible direction changes', () => {
  for (const character of ['\0', '\n', '\r', '\t', '\x7f', '\x85', '\u200b', '\u202e', '\u2066', '\ufeff']) {
    assert.equal(parseOwnerDirective(`${character}watch @abcd`), undefined);
    assert.equal(parseOwnerDirective(`watch @ab${character}cd`), undefined);
    assert.equal(parseOwnerDirective(`yes${character}`), undefined);
  }
  assert.equal(parseOwnerDirective(`watch @abcd${' '.repeat(4096)}`), undefined);
  assert.equal(parseOwnerDirective(`watch ${Array.from({ length: 33 }, (_, i) => `@source${i}`).join(' ')}`), undefined);
  assert.equal(parseOwnerDirective(`approve only ${Array.from({ length: 33 }, (_, i) => `item${i}`).join(',')}`), undefined);
  assert.equal(parseOwnerDirective('watch @abcd\u2028unsubscribe @efgh'), undefined);
});
