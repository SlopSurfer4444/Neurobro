import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComputerRegistry, ComputerTask } from './types.ts';

/** One composition root owns this registry. Atomic replacement avoids torn JSON on restart. */
export class JsonFileComputerRegistry implements ComputerRegistry {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  private async load(): Promise<ComputerTask[]> {
    let content: string;
    try { content = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const data: unknown = JSON.parse(content);
    if (!Array.isArray(data) || data.some(t => !t || typeof t.taskId !== 'string' || typeof t.executorId !== 'string' || typeof t.projectRoot !== 'string' || typeof t.state !== 'string')) throw new Error('COMPUTER_REGISTRY_CORRUPT');
    if (new Set(data.map(t => t.taskId)).size !== data.length) throw new Error('COMPUTER_REGISTRY_DUPLICATE');
    return data as ComputerTask[];
  }
  async list(): Promise<ComputerTask[]> { await this.queue; return this.load(); }
  async get(taskId: string): Promise<ComputerTask | undefined> { return (await this.list()).find(t => t.taskId === taskId); }
  put(task: ComputerTask): Promise<void> {
    const write = this.queue.then(async () => {
      const tasks = await this.load();
      const index = tasks.findIndex(t => t.taskId === task.taskId);
      if (index === -1) tasks.push(structuredClone(task)); else tasks[index] = structuredClone(task);
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(tasks), { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, this.path);
    });
    this.queue = write;
    return write;
  }
}
