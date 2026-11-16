/** File-backed PendingStore and CycleLock for Node (systemd / Docker). */
import { open, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import type { CycleLock, PendingStore } from './store.js';

export class FilePendingStore implements PendingStore {
  constructor(private readonly path: string) {}

  private async read(): Promise<Record<string, string[]>> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as { pending?: Record<string, string[]> };
      return data.pending ?? {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  private async write(pending: Record<string, string[]>): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ pending }, null, 2));
    await rename(tmp, this.path); // atomic replace
  }

  async list(vaultId: string): Promise<string[]> {
    return (await this.read())[vaultId] ?? [];
  }

  async add(vaultId: string, txid: string): Promise<void> {
    const all = await this.read();
    const cur = all[vaultId] ?? [];
    if (!cur.includes(txid)) all[vaultId] = [...cur, txid];
    await this.write(all);
  }

  async remove(vaultId: string, txid: string): Promise<void> {
    const all = await this.read();
    const cur = (all[vaultId] ?? []).filter((t) => t !== txid);
    if (cur.length) all[vaultId] = cur;
    else delete all[vaultId];
    await this.write(all);
  }
}

/**
 * Cross-process lock: O_EXCL create of a lock file holding our pid. A lock older than `staleMs` is broken
 * (a crashed cycle must not block the keeper forever).
 */
export class FileLock implements CycleLock {
  constructor(private readonly path: string, private readonly staleMs = 10 * 60_000) {}

  async acquire(): Promise<(() => Promise<void>) | null> {
    for (let i = 0; i < 2; i++) {
      try {
        const fh = await open(this.path, 'wx');
        await fh.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        await fh.close();
        return async () => {
          await rm(this.path, { force: true });
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const age = await stat(this.path).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > this.staleMs) {
          await rm(this.path, { force: true });
          continue;
        }
        return null;
      }
    }
    return null;
  }
}
