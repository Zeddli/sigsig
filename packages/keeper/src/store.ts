/**
 * Runtime-neutral pieces of keeper state: the pending-txid store and the cycle lock.
 * In-memory versions live here; file-backed (Node) versions live in node-store.ts.
 * A Worker would implement these over KV / a Durable Object.
 */

/** Txids the keeper broadcast per vault and has not yet seen confirmed. */
export interface PendingStore {
  list(vaultId: string): Promise<string[]>;
  add(vaultId: string, txid: string): Promise<void>;
  remove(vaultId: string, txid: string): Promise<void>;
}

/** Returns a release function, or null if another holder has the lock. */
export interface CycleLock {
  acquire(): Promise<(() => Promise<void>) | null>;
}

export class MemoryPendingStore implements PendingStore {
  readonly data = new Map<string, string[]>();
  async list(vaultId: string): Promise<string[]> {
    return [...(this.data.get(vaultId) ?? [])];
  }
  async add(vaultId: string, txid: string): Promise<void> {
    const cur = this.data.get(vaultId) ?? [];
    if (!cur.includes(txid)) this.data.set(vaultId, [...cur, txid]);
  }
  async remove(vaultId: string, txid: string): Promise<void> {
    const cur = (this.data.get(vaultId) ?? []).filter((t) => t !== txid);
    if (cur.length) this.data.set(vaultId, cur);
    else this.data.delete(vaultId);
  }
}

export class MemoryLock implements CycleLock {
  private held = false;
  async acquire(): Promise<(() => Promise<void>) | null> {
    if (this.held) return null;
    this.held = true;
    return async () => {
      this.held = false;
    };
  }
}
