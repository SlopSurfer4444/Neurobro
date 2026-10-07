import type { Observation, TelegramPort } from './contracts.ts';

/** Intake control remains responsive while ordinary admission waits on files/providers.
 * All queued observations already belong to the durable transport spool; abort does not acknowledge them. */
export async function consumeObservations(telegram: TelegramPort, signal: AbortSignal, handle: (observation: Observation) => Promise<unknown>, options: { concurrency?: number; queueLimit?: number } = {}): Promise<void> {
  const concurrency = options.concurrency ?? 8, queueLimit = options.queueLimit ?? 1000;
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(queueLimit) || queueLimit < concurrency) throw new Error('Invalid intake limits');
  const waiting: Observation[] = []; const active = new Set<Promise<void>>();
  const fault = new AbortController(); const feedSignal = AbortSignal.any([signal, fault.signal]);
  let running = 0; let failure: unknown;
  const pump = () => {
    while (!failure && !signal.aborted && running < concurrency && waiting.length) launch(waiting.shift()!, false);
  };
  const launch = (observation: Observation, control: boolean) => {
    if (!control) running++;
    const promise = handle(observation).then(() => undefined).catch(error => { failure ??= error; fault.abort(); }).finally(() => { active.delete(promise); if (!control) running--; pump(); });
    active.add(promise);
  };
  try {
    for await (const observation of telegram.observations(feedSignal)) {
      if (failure) throw failure;
      // This is scheduling priority only. The broker still authenticates every event.
      const control = observation.kind !== 'message' || /^\/бро\s+(?:стоп|отмен|статус|status|cancel|stop)(?:\s|$)/iu.test(observation.text ?? '');
      if (control) launch(observation, true);
      else { if (waiting.length >= queueLimit) throw new Error('Durable intake backlog requires reconciliation'); waiting.push(observation); pump(); }
    }
  } finally { while (active.size) await Promise.allSettled(active); }
  if (failure) throw failure;
}
