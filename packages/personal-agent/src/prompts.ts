import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question(question); } finally { prompt.close(); }
}
/** Local interactive secret input: visible stars, Backspace and Ctrl+U, no shell argument/history. */
export function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) return Promise.reject(new Error('Secret entry requires an interactive terminal'));
  stdout.write(question);
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { stdin.removeListener('data', onData); stdin.setRawMode(previousRaw); stdin.pause(); stdout.write('\n'); };
    const onData = (input: string | Buffer) => {
      for (const character of input.toString()) {
        if (character === '\r' || character === '\n') { cleanup(); resolve(value); return; }
        if (character === '\u0003') { cleanup(); reject(new Error('Owner cancelled local secret entry')); return; }
        if (character === '\u0015') { stdout.write('\b \b'.repeat([...value].length)); value = ''; continue; }
        if (character === '\u007f' || character === '\b') { if (value) { value = [...value].slice(0,-1).join(''); stdout.write('\b \b'); } continue; }
        if (character.charCodeAt(0) >= 32 && value.length < 4096) { value += character; stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}
