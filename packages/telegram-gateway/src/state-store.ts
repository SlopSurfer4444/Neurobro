import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-file.js";
import type { PersistentState } from "./types.js";

export function createEmptyState(): PersistentState {
  return {
    schemaVersion: 1,
    cursors: {},
    requestTimestamps: [],
    circuitBreaker: {
      consecutiveTransientFailures: 0,
    },
  };
}

function parseState(raw: unknown): PersistentState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("State file must contain an object.");
  }
  const state = raw as Partial<PersistentState>;
  if (state.schemaVersion !== 1 || !state.cursors || !Array.isArray(state.requestTimestamps)) {
    throw new Error("State file has an unsupported schema.");
  }
  if (!state.circuitBreaker || !Number.isInteger(state.circuitBreaker.consecutiveTransientFailures)) {
    throw new Error("State file has malformed circuit-breaker state.");
  }
  return state as PersistentState;
}

export class StateStore {
  private state: PersistentState | undefined;

  constructor(readonly filePath: string) {}

  async load(): Promise<PersistentState> {
    if (this.state) return this.state;
    try {
      this.state = parseState(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = createEmptyState();
    }
    return this.state;
  }

  async save(): Promise<void> {
    const state = await this.load();
    await writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
