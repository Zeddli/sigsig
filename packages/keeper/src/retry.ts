export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Called before each wait. */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter: wait in [0.5, 1] × min(maxMs, baseMs·2^(n-1)). */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const wait = o.sleep ?? sleep;
  const rnd = o.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= o.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === o.attempts) break;
      const cap = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
      const delay = Math.round(cap * (0.5 + rnd() / 2));
      o.onRetry?.(attempt, delay, err);
      await wait(delay);
    }
  }
  throw lastErr;
}
