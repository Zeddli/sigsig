import { describe, expect, it } from 'vitest';
import { DEFAULT_DECIDE_OPTIONS } from '../src/decide.js';
import { createFakePorts, FakeBuilders, FakeWorld, demoVaults } from '../src/fake.js';
import { Keeper, type KeeperDeps } from '../src/keeper.js';
import { memoryLogger } from '../src/log.js';
import { MemoryLock, MemoryPendingStore } from '../src/store.js';

function setup(opts: { dryRun?: boolean; world?: FakeWorld } = {}) {
  const ports = createFakePorts(opts.world ?? new FakeWorld());
  const logger = memoryLogger();
  const store = new MemoryPendingStore();
  const deps: KeeperDeps = {
    config: {
      vaults: ports.world.entries(),
      dryRun: opts.dryRun ?? false,
      decide: DEFAULT_DECIDE_OPTIONS,
      txBytes: { defend: 2_500, skim: 2_300 },
      fallbackFeeRateSatPerByte: 1,
      retry: { attempts: 3, baseMs: 1, maxMs: 2 },
      intervalMs: 10,
    },
    reader: ports.reader,
    builders: ports.builders,
    chain: ports.chain,
    store,
    lock: new MemoryLock(),
    logger,
    wallet: ports.wallet,
    sleep: async () => {},
  };
  return { ...ports, logger, store, deps, keeper: new Keeper(deps) };
}

const byVault = (outcomes: { vaultId: string; action: string }[]) =>
  Object.fromEntries(outcomes.map((o) => [o.vaultId, o.action]));

describe('Keeper cycle on fake ports', () => {
  it('dry run builds but never broadcasts', async () => {
    const t = setup({ dryRun: true });
    const r = await t.keeper.runCycle();
    expect(byVault(r.outcomes)).toEqual({
      'defend-pusd': 'dry-run', 'defend-bch': 'dry-run', skim: 'dry-run',
      'skim-redeeming': 'noop', 'in-band': 'noop', 'empty-buffer': 'skip',
    });
    expect(t.chain.broadcasts).toHaveLength(0);
    expect(r.outcomes.find((o) => o.vaultId === 'skim')?.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dry run without a wallet logs the plan only', async () => {
    const t = setup({ dryRun: true });
    const k = new Keeper({ ...t.deps, wallet: null });
    const r = await k.runCycle();
    expect(r.outcomes.filter((o) => o.action === 'dry-run').every((o) => o.txid === undefined)).toBe(true);
  });

  it('broadcasts, then is idempotent while txs are unconfirmed, then settles after mining', async () => {
    const t = setup();
    const r1 = await t.keeper.runCycle();
    expect(r1.outcomes.filter((o) => o.action === 'broadcast').map((o) => o.vaultId)).toEqual(['defend-pusd', 'defend-bch', 'skim']);
    expect(t.chain.broadcasts).toHaveLength(3);

    // Second cycle: same vaults have a tx in the mempool -> skip, no new broadcasts.
    const r2 = await t.keeper.runCycle();
    expect(byVault(r2.outcomes)['defend-pusd']).toBe('skip');
    expect(r2.outcomes.find((o) => o.vaultId === 'skim')?.decision).toMatchObject({ reason: 'pending-keeper-tx' });
    expect(t.chain.broadcasts).toHaveLength(3);

    // Mine: effects apply; store is pruned; vaults are back in band.
    t.chain.mine();
    const r3 = await t.keeper.runCycle();
    expect(byVault(r3.outcomes)).toMatchObject({ 'defend-pusd': 'noop', 'defend-bch': 'noop', skim: 'noop' });
    expect(t.store.data.size).toBe(0);
    expect(t.logger.entries.filter((e) => e.msg === 'keeper tx confirmed')).toHaveLength(3);
    const crs = r3.outcomes.filter((o) => ['defend-pusd', 'defend-bch', 'skim'].includes(o.vaultId)).map((o) => o.decision?.crBps);
    for (const cr of crs) expect(cr).toBeGreaterThanOrEqual(14_000);
  });

  it('a dropped tx is forgotten and the vault is retried', async () => {
    const t = setup();
    await t.keeper.runCycle();
    t.chain.drop();
    const r = await t.keeper.runCycle();
    expect(byVault(r.outcomes)['defend-pusd']).toBe('broadcast');
    expect(t.logger.entries.some((e) => e.msg === 'keeper tx dropped')).toBe(true);
  });

  it('skips a vault with someone else\'s tx in the mempool', async () => {
    const t = setup();
    const v = t.world.vaults.get('skim')!;
    const [addr] = await t.builders.vaultAddresses(v.entry.params);
    t.chain.foreignMempool.set(addr!, ['cd'.repeat(32)]);
    const r = await t.keeper.runCycle();
    expect(r.outcomes.find((o) => o.vaultId === 'skim')).toMatchObject({ action: 'skip', decision: { reason: 'pending-keeper-tx' } });
  });

  it('two overlapping cycles: the second one is refused by the lock', async () => {
    const t = setup({ dryRun: true });
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const slowChain = Object.create(t.chain) as typeof t.chain;
    slowChain.getFeeRateSatPerByte = async () => { await gate; return 1; };
    const k = new Keeper({ ...t.deps, chain: slowChain });
    const first = k.runCycle();
    const second = await k.runCycle();
    expect(second.locked).toBe(true);
    unblock();
    expect((await first).locked).toBeUndefined();
    // Lock released: a third cycle runs.
    expect((await k.runCycle()).locked).toBeUndefined();
  });

  it('built tx fee above the vault cap: skip, no broadcast', async () => {
    const t = setup();
    const k = new Keeper({ ...t.deps, builders: new FakeBuilders(t.world, t.chain, 9_999n) });
    const r = await k.runCycle();
    expect(r.outcomes.filter((o) => o.action === 'broadcast')).toHaveLength(0);
    expect(r.outcomes.find((o) => o.vaultId === 'skim')?.error).toBe('built-fee-over-cap');
  });

  it('network fee estimate above the cap: skip and log', async () => {
    const t = setup();
    t.chain.feeRate = 5; // 2500 bytes * 5 = 12500 > 3000
    const r = await t.keeper.runCycle();
    expect(r.outcomes.find((o) => o.vaultId === 'defend-bch')?.decision).toMatchObject({ kind: 'skip', reason: 'fee-cap-below-network-fee' });
    expect(t.logger.entries.some((e) => e.reason === 'fee-cap-below-network-fee' && e.level === 'warn')).toBe(true);
  });

  it('empty keeper wallet: skip with an error log', async () => {
    const t = setup();
    t.chain.utxos = [];
    const r = await t.keeper.runCycle();
    expect(r.outcomes.find((o) => o.vaultId === 'skim')?.error).toBe('keeper-wallet-empty');
    expect(t.chain.broadcasts).toHaveLength(0);
  });

  it('retries transient read errors and isolates persistent ones per vault', async () => {
    const t = setup({ dryRun: true });
    let flaky = 2;
    const reader = Object.create(t.reader) as typeof t.reader;
    reader.getPriceCents = async () => {
      if (flaky-- > 0) throw new Error('electrum timeout');
      return t.world.priceCents;
    };
    const broken = t.world.vaults.get('in-band')!.entry.params.stateCategory;
    reader.getLoan = async (p) => {
      if (p.stateCategory === broken) throw new Error('loan not found');
      return t.reader.getLoan(p);
    };
    const r = await new Keeper({ ...t.deps, reader }).runCycle();
    expect(byVault(r.outcomes)['in-band']).toBe('error');
    expect(byVault(r.outcomes)['defend-pusd']).toBe('dry-run');
    expect(t.logger.entries.filter((e) => e.msg === 'retrying').length).toBeGreaterThanOrEqual(2);
  });

  it('run() loops until stop()', async () => {
    const t = setup({ dryRun: true });
    let cycles = 0;
    const k = new Keeper({
      ...t.deps,
      sleep: async () => {
        if (++cycles === 3) k.stop();
      },
    });
    await k.run();
    expect(t.logger.entries.filter((e) => e.msg === 'cycle start')).toHaveLength(3);
  });

  it('status() evaluates every vault', async () => {
    const t = setup();
    const rows = await t.keeper.status();
    expect(rows).toHaveLength(demoVaults().length);
    expect(t.chain.broadcasts).toHaveLength(0);
  });
});
