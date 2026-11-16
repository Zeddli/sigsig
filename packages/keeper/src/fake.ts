/**
 * In-memory implementations of every port (VaultReader, KeeperBuilders, KeeperChain) so the keeper runs end to
 * end before @sigsig/core exists: `keeper once --dry-run` with KEEPER_BACKEND=fake (the default for now).
 * Broadcast txs sit in a fake mempool; `chain.mine()` confirms them and applies their effect to the loan.
 */
import type { BuiltTx, Health, LoanState, VaultParams, VaultPolicy, VaultReader } from '@sigsig/core';
import type { VaultEntry } from './config.js';
import { compareCr, crBps } from './decide.js';
import type {
  DefendPlan, KeeperBuilders, KeeperChain, KeeperFunding, KeeperTx, KeeperUtxo, SkimPlan, TxStatus,
} from './ports.js';

export interface FakeVault {
  entry: VaultEntry;
  policy: VaultPolicy;
  loan: LoanState;
  buffer: { sats: bigint; pusdCents: bigint };
}

/** Deterministic 32-byte hex from a string (not cryptographic; fake ids only). */
export function fakeHex32(seed: string): string {
  let out = '';
  for (let block = 0; block < 8; block++) {
    let h = (0x811c9dc5 ^ Math.imul(block + 1, 0x9e3779b1)) >>> 0; // FNV-1a over the whole seed, per block
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export function fakeVaultParams(id: string): VaultParams {
  return {
    paryonTokenId: fakeHex32('paryon'),
    loanKeyCategory: fakeHex32(`loankey:${id}`),
    stateCategory: fakeHex32(`state:${id}`),
    signerPubkeys: ['02' + fakeHex32(`${id}:1`), '02' + fakeHex32(`${id}:2`), '03' + fakeHex32(`${id}:3`)],
    m: 2,
  };
}

export const DEFAULT_POLICY: VaultPolicy = {
  version: 1,
  defendCrBps: 13_000,
  targetCrBps: 14_000,
  skimCrBps: 16_000,
  keeperFeeMaxSats: 3_000,
  payeeRoot: '00'.repeat(20),
  perPaymentMax: 100_000n,
  dailyBudget: 500_000n,
  dayIndex: 0,
  spentToday: 0n,
};

function loan(collateralSats: bigint, borrowedAmount: bigint, amountBeingRedeemed = 0n): LoanState {
  return { borrowedAmount, amountBeingRedeemed, status: 1, lastPeriodInterestPaid: 0, currentInterestRate: 200, nextInterestRate: 200, collateralSats };
}

function fakeVault(id: string, l: LoanState, buffer: FakeVault['buffer'], policy: Partial<VaultPolicy> = {}): FakeVault {
  return { entry: { id, params: fakeVaultParams(id) }, policy: { ...DEFAULT_POLICY, ...policy }, loan: l, buffer };
}

/** Demo scenarios at $500/BCH, policy 130% / 140% / 160%. One per keeper branch. */
export function demoVaults(): FakeVault[] {
  return [
    fakeVault('defend-pusd', loan(60_000_000n, 24_000n), { sats: 2_000_000n, pusdCents: 5_000n }), // CR 125%
    fakeVault('defend-bch', loan(60_000_000n, 24_000n), { sats: 10_000_000n, pusdCents: 0n }), // CR 125%
    fakeVault('skim', loan(100_000_000n, 25_000n), { sats: 500_000n, pusdCents: 0n }), // CR 200%
    fakeVault('skim-redeeming', loan(100_000_000n, 25_000n, 5_000n), { sats: 500_000n, pusdCents: 0n }),
    fakeVault('in-band', loan(100_000_000n, 33_333n), { sats: 500_000n, pusdCents: 1_000n }), // CR 150%
    fakeVault('empty-buffer', loan(60_000_000n, 24_000n), { sats: 1_000n, pusdCents: 0n }), // CR 125%, nothing to use
  ];
}

export class FakeWorld {
  priceCents: bigint;
  readonly vaults = new Map<string, FakeVault>();

  constructor(vaults: FakeVault[] = demoVaults(), priceCents = 50_000n) {
    this.priceCents = priceCents;
    for (const v of vaults) this.vaults.set(v.entry.id, v);
  }

  entries(): VaultEntry[] {
    return [...this.vaults.values()].map((v) => v.entry);
  }

  byParams(p: VaultParams): FakeVault {
    for (const v of this.vaults.values()) if (v.entry.params.stateCategory === p.stateCategory) return v;
    throw new Error(`fake: unknown vault ${p.stateCategory.slice(0, 8)}`);
  }
}

export function healthOf(policy: VaultPolicy, l: LoanState, priceCents: bigint): Health {
  const { collateralSats: c, borrowedAmount: debt } = l;
  const cr = crBps(c, debt, priceCents);
  const maxBorrowCents = ((c * 10n) / 11n) * priceCents / 100_000_000n;
  const liquidationPriceCents = c > 0n ? (debt * 100_000_000n * 11n + c * 10n - 1n) / (c * 10n) : 0n;
  const status: Health['status'] =
    debt > maxBorrowCents ? 'liquidatable'
      : compareCr(c, debt, priceCents, policy.defendCrBps) < 0 ? 'defend'
        : compareCr(c, debt, priceCents, policy.skimCrBps) > 0 ? 'skim'
          : compareCr(c, debt, priceCents, policy.targetCrBps) < 0 ? 'watch' : 'safe';
  return { priceCentsPerBch: priceCents, crBps: cr, liquidationPriceCents, maxBorrowCents, status };
}

export class FakeReader implements VaultReader {
  constructor(private readonly w: FakeWorld) {}
  async getPolicy(v: VaultParams) { return { ...this.w.byParams(v).policy }; }
  async getLoan(v: VaultParams) { return { ...this.w.byParams(v).loan }; }
  async getPriceCents() { return this.w.priceCents; }
  async getBuffer(v: VaultParams) { return { ...this.w.byParams(v).buffer }; }
  async getHealth(v: VaultParams) {
    const fv = this.w.byParams(v);
    return healthOf(fv.policy, fv.loan, this.w.priceCents);
  }
}

export const FAKE_WALLET = { address: 'bchtest:qpfakekeeperfeewallet0000000000000000000', wif: 'fake-wif-not-a-key' };

export class FakeChain implements KeeperChain {
  readonly mempool = new Map<string, () => void>(); // txid -> effect applied on mine()
  readonly confirmed = new Set<string>();
  readonly broadcasts: string[] = [];
  /** Extra mempool txids per address (simulates another keeper's tx). */
  readonly foreignMempool = new Map<string, string[]>();
  feeRate = 1;
  utxos: KeeperUtxo[] = [{ txid: fakeHex32('keeper-utxo'), vout: 0, satoshis: 100_000n }];
  /** Effects registered by FakeBuilders, keyed by txHex, picked up on broadcast. */
  readonly effects = new Map<string, { txid: string; apply: () => void }>();

  async getUtxos(address: string) { return address === FAKE_WALLET.address ? [...this.utxos] : []; }
  async getTxStatus(txid: string): Promise<TxStatus> {
    return this.mempool.has(txid) ? 'mempool' : this.confirmed.has(txid) ? 'confirmed' : 'unknown';
  }
  async getMempoolTxids(address: string) { return [...(this.foreignMempool.get(address) ?? [])]; }
  async getFeeRateSatPerByte() { return this.feeRate; }
  async broadcast(txHex: string) {
    const e = this.effects.get(txHex);
    if (!e) throw new Error('fake: unknown tx');
    this.mempool.set(e.txid, e.apply);
    this.broadcasts.push(e.txid);
    return e.txid;
  }
  /** Confirm everything in the mempool and apply each tx's effect. */
  mine(): void {
    for (const [txid, apply] of this.mempool) {
      apply();
      this.confirmed.add(txid);
    }
    this.mempool.clear();
  }
  /** Forget mempool txs without applying them (simulates a dropped tx). */
  drop(): void { this.mempool.clear(); }
}

export class FakeBuilders implements KeeperBuilders {
  private n = 0;
  constructor(private readonly w: FakeWorld, private readonly chain: FakeChain, private readonly feeSats = 2_500n) {}

  async vaultAddresses(v: VaultParams) { return [`bchtest:pfakevault${v.stateCategory.slice(0, 24)}`]; }

  private make(kind: string, v: FakeVault, funding: KeeperFunding, summary: string, apply: () => void): KeeperTx {
    if (funding.utxos.length === 0) throw new Error('fake: no keeper utxos');
    const txid = fakeHex32(`${kind}:${v.entry.id}:${++this.n}`);
    const txHex = `02000000${txid}`;
    this.chain.effects.set(txHex, { txid, apply });
    const decoded: BuiltTx['decoded'] = { title: summary, inputs: [], outputs: [], checks: [], feeSats: this.feeSats };
    return { txid, txHex, sourceOutputs: [], summary, decoded };
  }

  async buildDefend(vault: VaultParams, _h: Health, funding: KeeperFunding, plan: DefendPlan) {
    const v = this.w.byParams(vault);
    const summary = `defend ${v.entry.id}: repay ${plan.repayCents} cents, add ${plan.addCollateralSats} sats, fee claim ${plan.feeClaimSats}`;
    return this.make('defend', v, funding, summary, () => {
      v.loan = { ...v.loan, borrowedAmount: v.loan.borrowedAmount - plan.repayCents, collateralSats: v.loan.collateralSats + plan.addCollateralSats };
      v.buffer = { sats: v.buffer.sats - plan.addCollateralSats - plan.feeClaimSats, pusdCents: v.buffer.pusdCents - plan.repayCents };
    });
  }

  async buildSkim(vault: VaultParams, _h: Health, funding: KeeperFunding, plan: SkimPlan) {
    const v = this.w.byParams(vault);
    const summary = `skim ${v.entry.id}: withdraw ${plan.withdrawSats} sats to buffer, fee claim ${plan.feeClaimSats}`;
    return this.make('skim', v, funding, summary, () => {
      v.loan = { ...v.loan, collateralSats: v.loan.collateralSats - plan.withdrawSats };
      v.buffer = { ...v.buffer, sats: v.buffer.sats + plan.withdrawSats - plan.feeClaimSats };
    });
  }
}

export function createFakePorts(world = new FakeWorld()) {
  const chain = new FakeChain();
  return { world, reader: new FakeReader(world), chain, builders: new FakeBuilders(world, chain), wallet: FAKE_WALLET };
}
