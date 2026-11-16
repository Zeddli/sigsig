/** Structured JSON-lines logger. bigint fields are written as strings. */
export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return { name: v.name, message: v.message };
  return v;
}

export function createLogger(
  write: (line: string) => void = (l) => console.log(l),
  base: Record<string, unknown> = {},
  now: () => Date = () => new Date(),
): Logger {
  return {
    log(level, msg, fields = {}) {
      write(JSON.stringify({ ts: now().toISOString(), level, msg, ...base, ...fields }, jsonReplacer));
    },
    child(fields) {
      return createLogger(write, { ...base, ...fields }, now);
    },
  };
}

/** Collects entries in memory (tests). */
export function memoryLogger(): Logger & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const make = (base: Record<string, unknown>): Logger => ({
    log(level, msg, fields = {}) {
      entries.push({ level, msg, ...base, ...fields });
    },
    child(fields) {
      return make({ ...base, ...fields });
    },
  });
  return Object.assign(make({}), { entries });
}
