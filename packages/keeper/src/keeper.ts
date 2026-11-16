/**
 * The keeper loop. One cycle = for each vault: drop settled txids, skip if anything touching the vault is
 * unconfirmed, read health, decide, build, broadcast. Runtime-neutral (no node: imports), so the same class
 * runs under the Node CLI and, if the builders allow it, in a Worker `scheduled` handler.
 */
import type { Health, LoanState, VaultPolicy, VaultReader } from '@sigsig/core';
import type { KeeperConfig, VaultEntry } from './config.js';
import { decide, type Decision } from './decide.js';
import type { Logger } from './log.js';
import type { KeeperBuilders, KeeperChain, KeeperFunding, KeeperTx } from './ports.js';
import { sleep as realSleep, withRetry } from './retry.js';
import type { CycleLock, PendingStore } from './store.js';

export interface KeeperWallet {
  address: string;
  wif: string;
}

export interface KeeperDeps {
  config: Pick<KeeperConfig, 'vaults' | 'dryRun' | 'decide' | 'txBytes' | 'fallbackFeeRateSatPerByte' | 'retry' | 'intervalMs'>;
  reader: VaultReader;
  builders: KeeperBuilders;
  chain: KeeperChain;
  store: PendingStore;
  lock: CycleLock;
  logger: Logger;
  /** Fee wallet. null = cannot build (dry run without a WIF just logs the plan). */
  wallet: KeeperWallet | null;
  sleep?: (ms: number) => Promise<void>;
}

export interface VaultSnapshot {
  policy: VaultPolicy;
  loan: LoanState;
  priceCents: bigint;
  buffer: { sats: bigint; pusdCents: bigint };
  health: Health;
}

export interface VaultEvaluation {
  vault: VaultEntry;
  snap: VaultSnapshot;
  pendingTxids: string[];
  decision: Decision;
}

export type OutcomeAction = 'noop' | 'skip' | 'broadcast' | 'dry-run' | 'error';

export interface VaultOutcome {
  vaultId: string;
  action: OutcomeAction;
  decision?: Decision;
  txid?: string;
  error?: string;
}

export interface CycleReport {
  cycleId: string;
  startedAt: string;
  durationMs: number;
  /** Set when the cycle did not run because another one holds the lock. */
  locked?: true;
  outcomes: VaultOutcome[];
}

let cycleCounter = 0;

export class Keeper {
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(private readonly d: KeeperDeps) {}

  private retry<T>(what: string, log: Logger, fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      ...this.d.config.retry,
      ...(this.d.sleep ? { sleep: this.d.sleep } : {}),
      onRetry: (attempt, delayMs, err) =>
        log.log('warn', 'retrying', { what, attempt, delayMs, error: String((err as Error)?.message ?? err) }),
    });
  }

  /** Read everything decide() and the status table need. */
  async readVault(v: VaultEntry, log: Logger = this.d.logger): Promise<VaultSnapshot> {
    const r = this.d.reader;
    const [policy, loan, priceCents, buffer, health] = await this.retry('read-vault', log, () =>
      Promise.all([r.getPolicy(v.params), r.getLoan(v.params), r.getPriceCents(), r.getBuffer(v.params), r.getHealth(v.params)]),
    );
    return { policy, loan, priceCents, buffer, health };
  }

  /**
   * Txids still unconfirmed for this vault: our tracked ones (confirmed/dropped ones are pruned) plus any
   * mempool tx at the vault's addresses (another keeper, or a judge's "Run keeper").
   */
  async pendingFor(v: VaultEntry, log: Logger): Promise<string[]> {
    const { store, chain, builders } = this.d;
    const pending = new Set<string>();
    for (const txid of await store.list(v.id)) {
      const status = await this.retry('tx-status', log, () => chain.getTxStatus(txid));
      if (status === 'mempool') pending.add(txid);
      else {
        await store.remove(v.id, txid);
        log.log(status === 'confirmed' ? 'info' : 'warn', status === 'confirmed' ? 'keeper tx confirmed' : 'keeper tx dropped', { txid });
      }
    }
    for (const addr of await builders.vaultAddresses(v.params)) {
      for (const txid of await this.retry('mempool', log, () => chain.getMempoolTxids(addr))) pending.add(txid);
    }
    return [...pending];
  }

  private async feeRate(log: Logger): Promise<number> {
    try {
      const r = await this.retry('fee-rate', log, () => this.d.chain.getFeeRateSatPerByte());
      return Math.max(r, this.d.config.fallbackFeeRateSatPerByte);
    } catch (err) {
      log.log('warn', 'fee rate unavailable, using fallback', { error: String(err) });
      return this.d.config.fallbackFeeRateSatPerByte;
    }
  }

  /** Read + decide for one vault, without building anything. */
  async evaluate(v: VaultEntry, feeRate: number, log: Logger): Promise<VaultEvaluation> {
    const { config } = this.d;
    const pendingTxids = await this.pendingFor(v, log);
    const snap = await this.readVault(v, log);
    const networkFeeSats = {
      defend: BigInt(Math.ceil(config.txBytes.defend * feeRate)),
      skim: BigInt(Math.ceil(config.txBytes.skim * feeRate)),
    };
    const decision = decide(
      { policy: snap.policy, loan: snap.loan, priceCents: snap.priceCents, buffer: snap.buffer, pendingTxids, networkFeeSats },
      config.decide,
    );
    return { vault: v, snap, pendingTxids, decision };
  }

  /** Evaluate every vault (for `keeper status`). Errors are reported per vault. */
  async status(): Promise<Array<VaultEvaluation | { vault: VaultEntry; error: string }>> {
    const log = this.d.logger.child({ cmd: 'status' });
    const feeRate = await this.feeRate(log);
    const rows: Array<VaultEvaluation | { vault: VaultEntry; error: string }> = [];
    for (const v of this.d.config.vaults) {
      try {
        rows.push(await this.evaluate(v, feeRate, log.child({ vault: v.id })));
      } catch (err) {
        rows.push({ vault: v, error: String((err as Error)?.message ?? err) });
      }
    }
    return rows;
  }

  async processVault(v: VaultEntry, feeRate: number, log: Logger): Promise<VaultOutcome> {
    const { config, chain, builders, store, wallet } = this.d;
    const { snap, decision } = await this.evaluate(v, feeRate, log);
    const ctx = {
      crBps: decision.crBps,
      priceCents: snap.priceCents,
      debtCents: snap.loan.borrowedAmount,
      collateralSats: snap.loan.collateralSats,
      buffer: snap.buffer,
      policy: { defend: snap.policy.defendCrBps, target: snap.policy.targetCrBps, skim: snap.policy.skimCrBps, feeMax: snap.policy.keeperFeeMaxSats },
    };

    if (decision.kind === 'noop') {
      log.log('info', 'noop', { ...ctx, reason: decision.reason });
      return { vaultId: v.id, action: 'noop', decision };
    }
    if (decision.kind === 'skip') {
      const level = decision.reason === 'pending-keeper-tx' ? 'info' : 'warn';
      log.log(level, 'skip', { ...ctx, reason: decision.reason, detail: decision.detail });
      return { vaultId: v.id, action: 'skip', decision };
    }

    log.log('info', `decided ${decision.kind}`, { ...ctx, decision });
    if (decision.kind === 'defend' && !decision.reachesTarget) {
      log.log('warn', 'defend cannot reach targetCR with this buffer', { expectedCrBps: decision.expectedCrBps, exhaustsBuffer: decision.exhaustsBuffer });
    }

    if (!wallet) {
      log.log('info', 'dry run without a fee wallet: plan only, not built', { kind: decision.kind });
      return { vaultId: v.id, action: 'dry-run', decision };
    }

    const utxos = (await this.retry('keeper-utxos', log, () => chain.getUtxos(wallet.address)))
      .slice()
      .sort((a, b) => (b.satoshis > a.satoshis ? 1 : b.satoshis < a.satoshis ? -1 : 0));
    const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
    if (total < decision.feeSats + 1_000n) {
      log.log('error', 'keeper fee wallet too low', { address: wallet.address, balanceSats: total, needSats: decision.feeSats + 1_000n });
      return { vaultId: v.id, action: 'skip', decision, error: 'keeper-wallet-empty' };
    }
    const funding: KeeperFunding = { address: wallet.address, wif: wallet.wif, utxos };

    let tx: KeeperTx;
    if (decision.kind === 'defend') {
      const { repayCents, addCollateralSats, feeClaimSats, expectedCrBps, exhaustsBuffer } = decision;
      tx = await builders.buildDefend(v.params, snap.health, funding, { repayCents, addCollateralSats, feeClaimSats, expectedCrBps, exhaustsBuffer });
    } else {
      const { withdrawSats, feeClaimSats, expectedCrBps } = decision;
      tx = await builders.buildSkim(v.params, snap.health, funding, { withdrawSats, feeClaimSats, expectedCrBps });
    }

    // The estimate may be off; re-check the real fee against the vault's cap before spending anything.
    const cap = BigInt(snap.policy.keeperFeeMaxSats);
    const opCap = config.decide.maxFeeSats;
    if (tx.decoded.feeSats > cap || (opCap !== undefined && tx.decoded.feeSats > opCap)) {
      log.log('warn', 'skip', { ...ctx, reason: 'fee-cap-below-network-fee', detail: `built tx fee ${tx.decoded.feeSats} > cap`, txid: tx.txid });
      return { vaultId: v.id, action: 'skip', decision, error: 'built-fee-over-cap' };
    }

    if (config.dryRun) {
      log.log('info', 'dry run: built, not broadcast', { txid: tx.txid, summary: tx.summary, feeSats: tx.decoded.feeSats, bytes: tx.txHex.length / 2 });
      return { vaultId: v.id, action: 'dry-run', decision, txid: tx.txid };
    }

    const txid = await this.retry('broadcast', log, () => chain.broadcast(tx.txHex));
    await store.add(v.id, txid);
    log.log('info', 'broadcast', { txid, kind: decision.kind, summary: tx.summary, feeSats: tx.decoded.feeSats });
    return { vaultId: v.id, action: 'broadcast', decision, txid };
  }

  /** One pass over all vaults. Never overlaps with another cycle (in-process or, with FileLock, cross-process). */
  async runCycle(): Promise<CycleReport> {
    const started = Date.now();
    const cycleId = `${started.toString(36)}-${++cycleCounter}`;
    const log = this.d.logger.child({ cycleId });
    const release = await this.d.lock.acquire();
    if (!release) {
      log.log('warn', 'previous cycle still running, skipping this one');
      return { cycleId, startedAt: new Date(started).toISOString(), durationMs: 0, locked: true, outcomes: [] };
    }
    const outcomes: VaultOutcome[] = [];
    try {
      log.log('info', 'cycle start', { vaults: this.d.config.vaults.length, dryRun: this.d.config.dryRun });
      const feeRate = await this.feeRate(log);
      for (const v of this.d.config.vaults) {
        const vlog = log.child({ vault: v.id });
        try {
          outcomes.push(await this.processVault(v, feeRate, vlog));
        } catch (err) {
          vlog.log('error', 'vault failed', { error: String((err as Error)?.message ?? err) });
          outcomes.push({ vaultId: v.id, action: 'error', error: String((err as Error)?.message ?? err) });
        }
      }
    } finally {
      await release();
    }
    const durationMs = Date.now() - started;
    const count = (a: OutcomeAction) => outcomes.filter((o) => o.action === a).length;
    log.log('info', 'cycle end', {
      durationMs, broadcast: count('broadcast'), dryRun: count('dry-run'), noop: count('noop'), skip: count('skip'), error: count('error'),
    });
    return { cycleId, startedAt: new Date(started).toISOString(), durationMs, outcomes };
  }

  /** Run cycles every `intervalMs` until stop(). The interval counts from the end of a cycle, so cycles never pile up. */
  async run(): Promise<void> {
    this.stopping = false;
    const sleep = this.d.sleep ?? realSleep;
    while (!this.stopping) {
      try {
        await this.runCycle();
      } catch (err) {
        this.d.logger.log('error', 'cycle failed', { error: String((err as Error)?.message ?? err) });
      }
      if (this.stopping) break;
      await Promise.race([sleep(this.d.config.intervalMs), new Promise<void>((r) => (this.wake = r))]);
      this.wake = null;
    }
    this.d.logger.log('info', 'keeper stopped');
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }
}
