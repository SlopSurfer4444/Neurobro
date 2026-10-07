import readline from 'node:readline';
const messages = new Map(); let next = 1000;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
out({ '@type': 'neurobroSidecarStatus', state: 'ready', client_id: 1 });
for await (const line of readline.createInterface({ input: process.stdin })) {
  const q = JSON.parse(line); let value;
  switch (q['@type']) {
    case 'getMe': value = { '@type': 'user', id: 1, first_name: 'Owner' }; break;
    case 'getAuthorizationState': value = { '@type': 'authorizationStateReady' }; break;
    case 'testPut': messages.set(`${q.message.chat_id}/${q.message.id}`, q.message); value = { '@type': 'ok' }; break;
    case 'testStats': value = { '@type': 'testStats', messages: [...messages.values()] }; break;
    case 'getMessage': value = messages.get(`${q.chat_id}/${q.message_id}`) ?? { '@type': 'error', code: 404, message: 'Not found' }; break;
    case 'getChatHistory': value = { '@type': 'messages', messages: [...messages.values()].filter(m => String(m.chat_id) === String(q.chat_id)).slice(0,q.limit) }; break;
    case 'sendMessage': {
      value = { '@type': 'message', id: next++, chat_id: q.chat_id, sender_id: { '@type': 'messageSenderUser', user_id: 1 }, date: Math.floor(Date.now()/1000), is_outgoing: true, content: { '@type': 'messageText', text: q.input_message_content.text }, sending_state: null, reply_to: q.reply_to };
      messages.set(`${value.chat_id}/${value.id}`, value); break;
    }
    case 'editMessageText': {
      const previous = messages.get(`${q.chat_id}/${q.message_id}`);
      if (!previous) { value = { '@type': 'error', code: 404, message: 'Not found' }; break; }
      value = { ...previous, content: { '@type': 'messageText', text: q.input_message_content.text }, edit_date: Math.floor(Date.now()/1000) };
      messages.set(`${value.chat_id}/${value.id}`, value); break;
    }
    case 'close':
      out({ '@type':'ok','@extra':q['@extra'] });
      out({ '@type': 'updateAuthorizationState', authorization_state: { '@type': 'authorizationStateClosed' } });
      out({ '@type': 'neurobroSidecarStatus', state: 'closed', client_id: 1, authorization_closed: true });
      process.stdout.end(() => process.exit(0));
      await new Promise(() => {});
    default: value = { '@type': 'error', code: 400, message: `Fixture unsupported ${q['@type']}` };
  }
  out({ ...value, '@extra': q['@extra'] });
}
