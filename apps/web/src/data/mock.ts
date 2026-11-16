/**
 * Mock data source: fixed, realistic chipnet numbers so every screen can be built, demoed and prerendered
 * without a network. Amounts follow packages/core/src/types.ts (sats, PUSD cents, bps). The CR math is
 * Paryon's integer formula (format.ts), so the numbers agree with each other.
 */
import type { BuiltTx, DecodedIo, DecodedTx, Health, PolicyCheck, VaultPolicy } from '@sigsig/core';
import type {
  ActivityItem,
  DataSource,
  KeeperAction,
  Net,
  NewVaultDraft,
  PayCheck,
  PayDraft,
  SetupStep,
  SignRequest,
  VaultSummary,
  VaultView,
} from './source';
import { bch, centsToSats, crBps, limit, liquidationPrice, maxBorrow, pct, pusd, sats, statusFor } from './format';

const PRICE_CENTS = 54_012n; // $540.12 per BCH, the mock oracle's last message
const PUSD_CATEGORY = '0c4a8e0b7f8f3b8f0d2a6b1e3c5d7f9a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e';
const DUST = 1_000n;

/* deterministic hex, so ids and txids stay the same between renders */
function hex(seed: string, bytes = 32): string {
  let h1 = 0x811c9dc5 ^ seed.length;
  let out = '';
  for (let i = 0; out.length < bytes * 2; i++) {
    const c = seed.charCodeAt(i % seed.length) + i;
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    out += h1.toString(16).padStart(8, '0');
  }
  return out.slice(0, bytes * 2);
}
function cashaddr(seed: string, kind: 'z' | 'q' | 'p' = 'z'): string {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const h = hex(seed, 26);
  let body = kind;
  for (let i = 0; i < 41; i++) body += alphabet[parseInt(h.slice(i, i + 2), 16) % 32];
  return `bchtest:${body}`;
}
const pub = (seed: string) => '02' + hex(seed, 32);

interface Seed {
  id: string;
  name: string;
  collateralSats: bigint;
  debtCents: bigint;
  buffer: { sats: bigint; pusdCents: bigint };
  policy: Partial<VaultPolicy>;
  m: 1 | 2 | 3;
}

const SEEDS: Seed[] = [
  { id: 'ops-treasury', name: 'Ops treasury', collateralSats: 76_000_000n, debtCents: 25_000n,
    buffer: { sats: 12_000_000n, pusdCents: 8_000n }, policy: { spentToday: 4_000n }, m: 2 },
  { id: 'grants-dao', name: 'Grants DAO', collateralSats: 60_000_000n, debtCents: 26_000n,
    buffer: { sats: 15_000_000n, pusdCents: 2_500n }, policy: { spentToday: 0n }, m: 2 },
  { id: 'fund-reserve', name: 'Fund reserve', collateralSats: 210_000_000n, debtCents: 48_000n,
    buffer: { sats: 4_000_000n, pusdCents: 12_000n }, policy: { spentToday: 9_000n }, m: 3 },
  { id: 'builders-guild', name: 'Builders guild', collateralSats: 55_000_000n, debtCents: 20_000n,
    buffer: { sats: 6_000_000n, pusdCents: 1_000n }, policy: { spentToday: 2_500n }, m: 1 },
];

const PAYEES = [
  { label: 'Payroll — Ops', address: cashaddr('payroll-ops', 'q') },
  { label: 'Fulcrum node hosting', address: cashaddr('hosting', 'q') },
  { label: 'Audit retainer', address: cashaddr('audit', 'q') },
  { label: 'Grants — BCH builders', address: cashaddr('grants-builders', 'q') },
];

const SIGNERS = [
  { label: 'Treasurer', pubkey: pub('treasurer') },
  { label: 'Ops lead', pubkey: pub('ops-lead') },
  { label: 'Board seat', pubkey: pub('board') },
];

function policyFor(s: Seed): VaultPolicy {
  return {
    version: 1,
    defendCrBps: 13_000,
    targetCrBps: 15_000,
    skimCrBps: 20_000,
    keeperFeeMaxSats: 20_000,
    payeeRoot: hex(`root-${s.id}`, 20),
    // limits are sats of value, as in Vault.pay (PUSD payments are valued at the oracle price)
    perPaymentMax: centsToSats(5_000n, PRICE_CENTS),  // ≈ 50.00 PUSD
    dailyBudget: centsToSats(10_000n, PRICE_CENTS),   // ≈ 100.00 PUSD
    dayIndex: 6_669,
    ...s.policy,
    spentToday: centsToSats(s.policy.spentToday ?? 0n, PRICE_CENTS),
  };
}

function healthFor(coll: bigint, debt: bigint, p: VaultPolicy, price = PRICE_CENTS): Health {
  const cr = crBps(coll, price, debt);
  return {
    priceCentsPerBch: price,
    crBps: cr,
    liquidationPriceCents: liquidationPrice(coll, debt),
    maxBorrowCents: maxBorrow(coll, price),
    status: statusFor(cr, p),
  };
}

function view(s: Seed): VaultView {
  const policy = policyFor(s);
  return {
    id: s.id,
    name: s.name,
    network: 'chipnet',
    address: cashaddr(`vault-${s.id}`),
    params: {
      paryonTokenId: PUSD_CATEGORY,
      loanKeyCategory: hex(`loankey-${s.id}`),
      stateCategory: hex(`state-${s.id}`),
      signerPubkeys: [SIGNERS[0].pubkey, SIGNERS[1].pubkey, SIGNERS[2].pubkey],
      m: s.m,
    },
    policy,
    loan: {
      borrowedAmount: s.debtCents,
      amountBeingRedeemed: 0n,
      status: 1,
      lastPeriodInterestPaid: 412,
      currentInterestRate: 150,
      nextInterestRate: 150,
      collateralSats: s.collateralSats,
    },
    health: healthFor(s.collateralSats, s.debtCents, policy),
    buffer: s.buffer,
    payees: PAYEES,
    signers: SIGNERS,
    budgetResetHeight: 960_336,
    sources: {
      loanUtxo: `${hex(`loan-${s.id}`)}:2`,
      stateUtxo: `${hex(`stateutxo-${s.id}`)}:1`,
      priceUtxo: `${hex('price-msg')}:0`,
    },
    interestBps: 150,
    redemptionRisk: 'low',
  };
}

const ago = (min: number) => new Date(Date.UTC(2026, 10, 16, 14, 0) - min * 60_000).toISOString();

function activityFor(id: string): ActivityItem[] {
  const base: ActivityItem[] = [
    { txid: hex(`a1-${id}`), kind: 'pay', summary: 'Pay 40.00 PUSD to Payroll — Ops', height: 960_301, confirmations: 4, at: ago(38) },
    { txid: hex(`a2-${id}`), kind: 'defend', summary: 'Defend: +0.0410 BCH collateral, CR 128% → 151%', height: 960_288, confirmations: 17, at: ago(162) },
    { txid: hex(`a3-${id}`), kind: 'skim', summary: 'Skim: 0.0300 BCH back to the buffer, CR 207% → 182%', height: 960_190, confirmations: 115, at: ago(1_140) },
    { txid: hex(`a4-${id}`), kind: 'admin', summary: 'Policy: daily budget 80.00 → 100.00 PUSD', height: 960_102, confirmations: 203, at: ago(2_020) },
    { txid: hex(`a5-${id}`), kind: 'borrow', summary: 'Borrow 250.00 PUSD against 0.7600 BCH', height: 959_980, confirmations: 325, at: ago(3_240) },
  ];
  return base;
}

/* ---------------------------------------------------------------- decoded txs */

function payTx(v: VaultView, payeeIndex: number, amount: bigint): BuiltTx {
  // layout from contracts/Vault.cash, pay (PUSD): in 0 State | 1 PriceContract | 2 Pusd; out 0 payee | 1 PriceContract |
  // 2 State | 3 Pusd change. The miner fee comes out of the vault's BCH, within keeperFeeMax: no wallet input.
  const payee = v.payees[payeeIndex];
  const fee = 1_620n;
  const price = (index: number): DecodedIo => ({ index, label: 'paryon-price', name: 'Paryon price', sats: 1_000n, address: cashaddr('paryon-paryon-price', 'p') });
  const inputs: DecodedIo[] = [
    { index: 0, label: 'vault-state', name: 'Vault state', address: v.address, sats: v.buffer.sats,
      tokenCategory: v.params.stateCategory, nftCommitment: hex(`commit-${v.id}`, 52) },
    price(1),
    { index: 2, label: 'vault-pusd', name: 'Vault PUSD', address: v.address, sats: DUST,
      tokenCategory: PUSD_CATEGORY, tokenAmount: v.buffer.pusdCents },
  ];
  const outputs: DecodedIo[] = [
    { index: 0, label: 'payee', name: payee.label, address: payee.address, sats: DUST,
      tokenCategory: PUSD_CATEGORY, tokenAmount: amount },
    price(1),
    { index: 2, label: 'vault-state', name: 'Vault state', address: v.address, sats: v.buffer.sats - fee,
      tokenCategory: v.params.stateCategory, nftCommitment: hex(`commit2-${v.id}`, 52) },
    { index: 3, label: 'vault-pusd', name: 'Vault PUSD', address: v.address, sats: DUST,
      tokenCategory: PUSD_CATEGORY, tokenAmount: v.buffer.pusdCents - amount },
  ];
  const left = v.policy.dailyBudget - v.policy.spentToday;
  const px = v.health.priceCentsPerBch;
  const amountSats = centsToSats(amount, px);
  const checks: PolicyCheck[] = [
    { id: 'allowlist', ok: true, text: 'Payee in allowlist' },
    { id: 'per-payment', ok: amountSats <= v.policy.perPaymentMax, text: `${sats(amountSats)} ≤ ${limit(v.policy.perPaymentMax, px)} per payment` },
    { id: 'budget', ok: amountSats <= left, text: `Budget left ${limit(left, px)} → ${limit(left - amountSats, px)}` },
    { id: 'cr', ok: true, text: `CR unchanged ${pct(v.health.crBps)}` },
  ];
  const title = `Pay ${pusd(amount)} PUSD to ${payee.label}`;
  const decoded: DecodedTx = { title, inputs, outputs, checks, feeSats: fee };
  return { txHex: '02000000' + hex(`tx-${v.id}-${payeeIndex}-${amount}`, 180), sourceOutputs: [], summary: title, decoded };
}

/** A request whose second output goes to an address nobody listed: the signer view must refuse it. */
function unknownTx(v: VaultView): BuiltTx {
  const t = payTx(v, 0, 3_000n);
  t.decoded.outputs.splice(1, 0, {
    index: 1, label: 'unknown', name: 'Unknown address', address: cashaddr('attacker', 'q'), sats: DUST,
    tokenCategory: PUSD_CATEGORY, tokenAmount: 2_000n,
  });
  t.decoded.outputs.forEach((o, i) => (o.index = i));
  t.decoded.outputs[4].tokenAmount = v.buffer.pusdCents - 5_000n;
  t.decoded.checks = [
    { id: 'allowlist', ok: false, text: 'Output 1 is not in the allowlist' },
    ...t.decoded.checks.slice(1),
  ];
  t.decoded.title = 'Pay 30.00 PUSD to Payroll — Ops';
  return t;
}

function keeperTx(v: VaultView, action: KeeperAction): BuiltTx {
  const p = v.policy;
  const coll = v.loan.collateralSats;
  const debt = v.loan.borrowedAmount;
  const price = v.health.priceCentsPerBch;
  const cr = v.health.crBps;
  if (action === 'defend' && cr >= p.defendCrBps)
    throw new Error(`Refused: CR ${pct(cr)} is not below defend ${pct(p.defendCrBps)}`);
  if (action === 'skim' && cr <= p.skimCrBps)
    throw new Error(`Refused: CR ${pct(cr)} is not above skim ${pct(p.skimCrBps)}`);

  // collateral that puts CR exactly on target
  const targetColl = (BigInt(p.targetCrBps) * debt * 100_000_000n + price * 10_000n - 1n) / (price * 10_000n);
  let delta = targetColl - coll; // > 0 defend (add), < 0 skim (take back)
  if (action === 'defend' && delta > v.buffer.sats) delta = v.buffer.sats;
  const newColl = coll + delta;
  const after = crBps(newColl, price, debt);
  const fee = 8_200n; // miner fee: a Paryon manage tx is ~8 KB at 1 sat/byte

  const paryon = (index: number, label: DecodedIo['label'], name: string, sats: bigint): DecodedIo =>
    ({ index, label, name, sats, address: cashaddr(`paryon-${label}`, 'p') });
  const inputs: DecodedIo[] = [
    paryon(0, 'paryon-price', 'Paryon price', 1_000n),
    { ...paryon(1, 'paryon-loan', 'Paryon loan', coll), tokenCategory: PUSD_CATEGORY },
    paryon(2, 'paryon-sidecar', 'Loan sidecar', 1_000n),
    paryon(3, 'paryon-function', 'Paryon manage', 1_000n),
    { index: 4, label: 'vault-key', name: 'Vault key', address: v.address, sats: 1_000n, tokenCategory: v.params.loanKeyCategory },
    { index: 5, label: 'vault-state', name: 'Vault state', address: v.address, sats: v.buffer.sats, tokenCategory: v.params.stateCategory },
  ];
  const outputs: DecodedIo[] = [
    paryon(0, 'paryon-price', 'Paryon price', 1_000n),
    { ...paryon(1, 'paryon-loan', 'Paryon loan', newColl), tokenCategory: PUSD_CATEGORY },
    paryon(2, 'paryon-sidecar', 'Loan sidecar', 1_000n),
    paryon(3, 'paryon-function', 'Paryon manage', 1_000n),
    { index: 4, label: 'vault-key', name: 'Vault key', address: v.address, sats: 1_000n, tokenCategory: v.params.loanKeyCategory },
    { index: 5, label: 'vault-state', name: 'Vault state', address: v.address, sats: v.buffer.sats - delta - BigInt(p.keeperFeeMaxSats), tokenCategory: v.params.stateCategory },
    { index: 6, label: 'keeper', name: 'Keeper reward', address: cashaddr('keeper-wallet', 'q'), sats: BigInt(p.keeperFeeMaxSats) - fee },
  ];
  const checks: PolicyCheck[] = action === 'defend'
    ? [
        { id: 'below', ok: true, text: `CR ${pct(cr)} is below defend ${pct(p.defendCrBps)}` },
        { id: 'after', ok: after >= p.targetCrBps || delta === v.buffer.sats, text: `CR after ${pct(after)} ≥ target ${pct(p.targetCrBps)}` },
        { id: 'debt', ok: true, text: 'Debt not raised' },
        { id: 'fee', ok: true, text: `Miner fee + keeper reward ${p.keeperFeeMaxSats.toLocaleString('en')} sats, the cap` },
      ]
    : [
        { id: 'above', ok: true, text: `CR ${pct(cr)} is above skim ${pct(p.skimCrBps)}` },
        { id: 'after', ok: after >= p.targetCrBps, text: `CR after ${pct(after)} ≥ target ${pct(p.targetCrBps)}` },
        { id: 'debt', ok: true, text: 'Debt unchanged' },
        { id: 'fee', ok: true, text: `Miner fee + keeper reward ${p.keeperFeeMaxSats.toLocaleString('en')} sats, the cap` },
      ];
  const title = action === 'defend'
    ? `Defend ${v.name}: +${bch(delta)} BCH collateral, CR ${pct(cr)} → ${pct(after)}`
    : `Skim ${v.name}: ${bch(-delta)} BCH to the buffer, CR ${pct(cr)} → ${pct(after)}`;
  return {
    txHex: '02000000' + hex(`keeper-${v.id}-${action}-${coll}`, 260),
    sourceOutputs: [],
    summary: title,
    decoded: { title, inputs, outputs, checks, feeSats: fee },
  };
}

function setupTx(step: SetupStep, d: NewVaultDraft): BuiltTx {
  const you = cashaddr('new-vault-owner', 'q');
  const vault = cashaddr(`vault-new-${d.signers.join('')}`);
  const fee = 900n;
  let decoded: DecodedTx;
  if (step === 'loan-key') {
    decoded = {
      title: 'Create the loan key',
      inputs: [
        { index: 0, label: 'paryon-function', name: 'Paryon loan-key factory', sats: 1_000n, address: cashaddr('factory', 'p') },
        { index: 1, label: 'fee', name: 'Your BCH', sats: 50_000n, address: you },
      ],
      outputs: [
        { index: 0, label: 'paryon-function', name: 'Paryon loan-key factory', sats: 1_000n, address: cashaddr('factory', 'p') },
        { index: 1, label: 'vault-key', name: 'Vault key (loan key NFT)', sats: 1_000n, address: vault, tokenCategory: hex('newkey') },
        { index: 2, label: 'change', name: 'Change', sats: 50_000n - 1_000n - fee, address: you },
      ],
      checks: [
        { id: 'key', ok: true, text: 'Loan key goes to the vault address' },
        { id: 'only', ok: true, text: 'No other outputs' },
      ],
      feeSats: fee,
    };
  } else if (step === 'policy') {
    decoded = {
      title: `Write the policy: ${d.m} of ${d.signers.length}, CR ${pct(d.defendCrBps)} · ${pct(d.targetCrBps)} · ${pct(d.skimCrBps)}`,
      inputs: [{ index: 0, label: 'fee', name: 'Your BCH', sats: 200_000n, address: you }],
      outputs: [
        { index: 0, label: 'vault-state', name: 'Vault state (policy NFT)', sats: 100_000n, address: vault,
          tokenCategory: hex('newstate'), nftCommitment: hex('policy-commit', 52) },
        { index: 1, label: 'change', name: 'Change', sats: 100_000n - fee, address: you },
      ],
      checks: [
        { id: 'payees', ok: d.payees.length <= 8, text: `${d.payees.length} payees (8 at most)` },
        { id: 'band', ok: d.defendCrBps < d.targetCrBps && d.targetCrBps < d.skimCrBps, text: 'Defend < target < skim' },
        { id: 'floor', ok: d.defendCrBps > 11_000, text: 'Defend above liquidation (110%)' },
      ],
      feeSats: fee,
    };
  } else {
    const cr = crBps(d.collateralSats, PRICE_CENTS, d.borrowCents);
    decoded = {
      title: `Borrow ${pusd(d.borrowCents)} PUSD against ${bch(d.collateralSats)} BCH`,
      inputs: [
        { index: 0, label: 'paryon-price', name: 'Paryon price', sats: 1_000n, address: cashaddr('paryon-paryon-price', 'p') },
        { index: 1, label: 'paryon-borrowing', name: 'Paryon borrowing', sats: 1_000n, address: cashaddr('borrowing', 'p') },
        { index: 2, label: 'vault-key', name: 'Vault key', sats: 1_000n, address: vault },
        { index: 3, label: 'fee', name: 'Your BCH', sats: d.collateralSats + 20_000n, address: you },
      ],
      outputs: [
        { index: 0, label: 'paryon-price', name: 'Paryon price', sats: 1_000n, address: cashaddr('paryon-paryon-price', 'p') },
        { index: 1, label: 'paryon-borrowing', name: 'Paryon borrowing', sats: 1_000n, address: cashaddr('borrowing', 'p') },
        { index: 2, label: 'paryon-loan', name: 'Paryon loan', sats: d.collateralSats, address: cashaddr('paryon-paryon-loan', 'p') },
        { index: 3, label: 'vault-key', name: 'Vault key', sats: 1_000n, address: vault },
        { index: 4, label: 'vault-pusd', name: 'Vault PUSD', sats: DUST, address: vault, tokenCategory: PUSD_CATEGORY, tokenAmount: d.borrowCents },
        { index: 5, label: 'change', name: 'Change', sats: 20_000n - DUST - fee, address: you },
      ],
      checks: [
        { id: 'cr', ok: cr >= d.targetCrBps, text: `Opening CR ${pct(cr)} ≥ target ${pct(d.targetCrBps)}` },
        { id: 'max', ok: d.borrowCents <= maxBorrow(d.collateralSats, PRICE_CENTS), text: `≤ max borrow ${pusd(maxBorrow(d.collateralSats, PRICE_CENTS))} PUSD` },
        { id: 'pusd', ok: true, text: 'PUSD lands in the vault, not a wallet' },
      ],
      feeSats: fee,
    };
  }
  return { txHex: '02000000' + hex(`setup-${step}`, 200), sourceOutputs: [], summary: decoded.title, decoded };
}

/* ---------------------------------------------------------------- requests (kept in the browser) */

const REQ_KEY = 'sigsig.mock.requests';
const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);

function loadRequests(): Map<string, SignRequest> {
  try {
    const raw = globalThis.localStorage?.getItem(REQ_KEY);
    if (raw) return new Map(JSON.parse(raw, reviver));
  } catch { /* storage blocked: memory only */ }
  return new Map();
}
function saveRequests(m: Map<string, SignRequest>) {
  try { globalThis.localStorage?.setItem(REQ_KEY, JSON.stringify([...m], replacer)); } catch { /* memory only */ }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockSource(): DataSource {
  const vaults = new Map(SEEDS.map((s) => [s.id, view(s)]));
  const requests = loadRequests();
  const pending = new Map<string, { vaultId: string; newColl: bigint; bufferSats: bigint }>();

  function demoRequests() {
    const ops = vaults.get('ops-treasury')!;
    const base = (id: string, built: BuiltTx, signed: boolean[]): SignRequest => ({
      id, vaultId: ops.id, network: 'chipnet', built, m: ops.params.m,
      slots: ops.signers.map((signer, i) => ({ signer, signed: signed[i] })),
      createdAt: ago(6), status: 'collecting',
    });
    if (!requests.has('demo-payroll')) requests.set('demo-payroll', base('demo-payroll', payTx(ops, 0, 3_000n), [true, false, false]));
    if (!requests.has('demo-unknown')) requests.set('demo-unknown', base('demo-unknown', unknownTx(ops), [false, false, false]));
  }
  demoRequests();

  const summary = (v: VaultView): VaultSummary => ({
    id: v.id, name: v.name, network: v.network, address: v.address, health: v.health,
    policy: { defendCrBps: v.policy.defendCrBps, targetCrBps: v.policy.targetCrBps, skimCrBps: v.policy.skimCrBps, keeperFeeMaxSats: v.policy.keeperFeeMaxSats },
    debtCents: v.loan.borrowedAmount, collateralSats: v.loan.collateralSats,
  });

  async function checkPay(d: PayDraft): Promise<PayCheck[]> {
    const v = vaults.get(d.vaultId);
    if (!v) return [];
    const payee = v.payees[d.payeeIndex];
    const left = v.policy.dailyBudget - v.policy.spentToday;
    const px = v.health.priceCentsPerBch;
    const amt = centsToSats(d.amountCents, px); // the covenant values PUSD at the oracle price, in sats
    return [
      { id: 'allowlist', ok: !!payee, text: payee ? 'Allowed payee' : 'Pick a payee from the allowlist' },
      { id: 'per-payment', ok: d.amountCents > 0n && amt <= v.policy.perPaymentMax,
        text: amt > v.policy.perPaymentMax
          ? `Over the per-payment limit: ${sats(amt)} > ${limit(v.policy.perPaymentMax, px)}`
          : `≤ per payment ${limit(v.policy.perPaymentMax, px)}` },
      { id: 'budget', ok: amt <= left,
        text: amt > left
          ? `Over today's budget: ${limit(left, px)} left`
          : `Budget left today ${limit(left, px)} → ${limit(left - amt, px)}` },
      { id: 'buffer', ok: d.amountCents <= v.buffer.pusdCents,
        text: d.amountCents > v.buffer.pusdCents ? `Vault holds only ${pusd(v.buffer.pusdCents)} PUSD` : `Vault PUSD ${pusd(v.buffer.pusdCents)} → ${pusd(v.buffer.pusdCents - d.amountCents)}` },
    ];
  }

  return {
    kind: 'mock',
    async listVaults(network: Net) {
      return [...vaults.values()].filter((v) => v.network === network).map(summary);
    },
    async getVault(id) { return vaults.get(id) ?? null; },
    async getActivity(id) { return vaults.has(id) ? activityFor(id) : []; },
    async getPriceCents() { return PRICE_CENTS; },
    checkPay,
    async createPayRequest(d) {
      const v = vaults.get(d.vaultId);
      if (!v) throw new Error('Vault not found');
      const failed = (await checkPay(d)).filter((c) => !c.ok);
      if (failed.length) throw new Error(`Refused: ${failed[0].text}`);
      const id = hex(`req-${Date.now()}-${Math.random()}`, 6);
      const req: SignRequest = {
        id, vaultId: v.id, network: v.network, built: payTx(v, d.payeeIndex, d.amountCents), m: v.params.m,
        slots: v.signers.map((signer) => ({ signer, signed: false })), createdAt: new Date().toISOString(), status: 'collecting',
      };
      requests.set(id, req);
      saveRequests(requests);
      return req;
    },
    async getSignRequest(id) { return requests.get(id) ?? null; },
    async prepareSignature(id) {
      const r = requests.get(id);
      if (!r) throw new Error('Request not found');
      return r.built;
    },
    async addSignature(id, slotIndex) {
      const r = requests.get(id);
      if (!r) throw new Error('Request not found');
      r.slots[slotIndex].signed = true;
      if (r.slots.filter((s) => s.signed).length >= r.m) r.status = 'ready';
      saveRequests(requests);
      return { ...r };
    },
    async rejectRequest(id) {
      const r = requests.get(id);
      if (!r) throw new Error('Request not found');
      r.status = 'rejected';
      saveRequests(requests);
      return { ...r };
    },
    async buildKeeperTx(vaultId, action) {
      const v = vaults.get(vaultId);
      if (!v) throw new Error('Vault not found');
      const built = keeperTx(v, action);
      const loanOut = built.decoded.outputs[1].sats;
      pending.set(built.txHex, { vaultId, newColl: loanOut, bufferSats: built.decoded.outputs[5].sats });
      return built;
    },
    async buildSetupTx(step, draft) { return setupTx(step, draft); },
    async broadcast(txHex) {
      await wait(700);
      const p = pending.get(txHex);
      if (p) {
        // the mock applies a keeper tx to its own state, so the keeper row's CR updates after "Sent"
        const v = vaults.get(p.vaultId)!;
        const loan = { ...v.loan, collateralSats: p.newColl };
        vaults.set(v.id, { ...v, loan, buffer: { ...v.buffer, sats: p.bufferSats },
          health: healthFor(p.newColl, loan.borrowedAmount, v.policy) });
        pending.delete(txHex);
      }
      return { txid: hex(`bcast-${txHex.slice(0, 40)}-${Date.now()}`) };
    },
  };
}

/** Data the landing prerender and its hydration share (mock only), so the hero shows numbers without script. */
export function mockSnapshot() {
  const ops = view(SEEDS[0]);
  return { vault: ops, activity: activityFor(ops.id) };
}
