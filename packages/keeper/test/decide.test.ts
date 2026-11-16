import { describe, expect, it } from 'vitest';
import {
  compareCr, crBps, decide, maxDebtAt, minCollateralAt, DEFAULT_DECIDE_OPTIONS, type DecideInput, type Decision,
} from '../src/decide.js';

// $500/BCH, policy 130/140/160, keeperFeeMax 3000 sats.
const PRICE = 50_000n;
const base = (over: Partial<DecideInput> & { coll?: bigint; debt?: bigint; redeeming?: bigint } = {}): DecideInput => ({
  policy: { defendCrBps: 13_000, targetCrBps: 14_000, skimCrBps: 16_000, keeperFeeMaxSats: 3_000 },
  loan: { collateralSats: over.coll ?? 100_000_000n, borrowedAmount: over.debt ?? 25_000n, amountBeingRedeemed: over.redeeming ?? 0n },
  priceCents: PRICE,
  buffer: { sats: 10_000_000n, pusdCents: 0n },
  pendingTxids: [],
  networkFeeSats: { defend: 2_500n, skim: 2_300n },
  ...over,
});

// collateral giving exactly X% at debt 25000 cents and $500: coll = bps * 25000 * 1e8 / (50000 * 1e4) = bps * 5000
const collAt = (bps: number) => BigInt(bps) * 5_000n;

function expectKind<K extends Decision['kind']>(d: Decision, k: K): Extract<Decision, { kind: K }> {
  expect(d.kind).toBe(k);
  return d as Extract<Decision, { kind: K }>;
}

describe('CR math', () => {
  it('matches the Paryon formula', () => {
    expect(crBps(100_000_000n, 25_000n, PRICE)).toBe(20_000);
    expect(crBps(collAt(13_000), 25_000n, PRICE)).toBe(13_000);
    expect(crBps(1n, 0n, PRICE)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('compareCr has no rounding at the boundary', () => {
    expect(compareCr(collAt(13_000), 25_000n, PRICE, 13_000)).toBe(0);
    expect(compareCr(collAt(13_000) - 1n, 25_000n, PRICE, 13_000)).toBe(-1);
    expect(compareCr(collAt(13_000) + 1n, 25_000n, PRICE, 13_000)).toBe(1);
  });

  it('maxDebtAt / minCollateralAt are tight', () => {
    const d = maxDebtAt(14_000, 60_000_000n, PRICE);
    expect(compareCr(60_000_000n, d, PRICE, 14_000)).toBeGreaterThanOrEqual(0);
    expect(compareCr(60_000_000n, d + 1n, PRICE, 14_000)).toBe(-1);
    const c = minCollateralAt(14_000, 24_001n, PRICE);
    expect(compareCr(c, 24_001n, PRICE, 14_000)).toBeGreaterThanOrEqual(0);
    expect(compareCr(c - 1n, 24_001n, PRICE, 14_000)).toBe(-1);
  });
});

describe('thresholds', () => {
  it('CR exactly at defendCR is a noop (defend needs strictly below)', () => {
    expect(decide(base({ coll: collAt(13_000) }))).toMatchObject({ kind: 'noop', reason: 'in-band', crBps: 13_000 });
  });

  it('one sat below defendCR defends', () => {
    expectKind(decide(base({ coll: collAt(13_000) - 1n })), 'defend');
  });

  it('CR exactly at skimCR is a noop (skim needs strictly above)', () => {
    expect(decide(base({ coll: collAt(16_000) }))).toMatchObject({ kind: 'noop', reason: 'in-band', crBps: 16_000 });
  });

  it('one sat above skimCR skims down to exactly targetCR', () => {
    const d = expectKind(decide(base({ coll: collAt(16_000) + 1n })), 'skim');
    expect(d.withdrawSats).toBe(collAt(16_000) + 1n - collAt(14_000));
    expect(d.expectedCrBps).toBe(14_000);
  });

  it('CR exactly at targetCR is in band', () => {
    expect(decide(base({ coll: collAt(14_000) })).kind).toBe('noop');
  });

  it('no debt is a noop', () => {
    expect(decide(base({ debt: 0n }))).toMatchObject({ kind: 'noop', reason: 'no-debt' });
  });

  it('rejects a nonsensical policy and price', () => {
    const bad = base({ coll: collAt(12_000) });
    expect(decide({ ...bad, policy: { ...bad.policy, targetCrBps: 13_000 } })).toMatchObject({ kind: 'skip', reason: 'invalid-policy' });
    expect(decide({ ...bad, policy: { ...bad.policy, skimCrBps: 13_500 } })).toMatchObject({ kind: 'skip', reason: 'invalid-policy' });
    expect(decide({ ...bad, priceCents: 0n })).toMatchObject({ kind: 'skip', reason: 'invalid-price' });
  });
});

describe('redemption', () => {
  it('redemption pending means no skim', () => {
    expect(decide(base({ coll: collAt(20_000), redeeming: 1n }))).toMatchObject({ kind: 'noop', reason: 'redemption-pending' });
  });

  it('redemption pending still allows defend (adding and repaying work during redemption)', () => {
    expectKind(decide(base({ coll: collAt(12_000), redeeming: 5_000n })), 'defend');
  });
});

describe('defend', () => {
  it('prefers PUSD repay when the buffer has enough PUSD', () => {
    const d = expectKind(decide(base({ coll: collAt(12_500), buffer: { sats: 10_000_000n, pusdCents: 50_000n } })), 'defend');
    expect(d.addCollateralSats).toBe(0n);
    expect(d.repayCents).toBe(25_000n - maxDebtAt(14_000, collAt(12_500), PRICE));
    expect(d.reachesTarget).toBe(true);
    expect(d.expectedCrBps).toBeGreaterThanOrEqual(14_000);
  });

  it('adds BCH when there is no PUSD', () => {
    const d = expectKind(decide(base({ coll: collAt(12_500), buffer: { sats: 10_000_000n, pusdCents: 0n } })), 'defend');
    expect(d.repayCents).toBe(0n);
    expect(d.addCollateralSats).toBe(collAt(14_000) - collAt(12_500));
    expect(d.reachesTarget).toBe(true);
    expect(d.feeClaimSats).toBe(2_500n);
  });

  it('uses all PUSD then tops up with BCH when PUSD alone is not enough', () => {
    const d = expectKind(decide(base({ coll: collAt(12_500), buffer: { sats: 10_000_000n, pusdCents: 500n } })), 'defend');
    expect(d.repayCents).toBe(500n);
    expect(d.addCollateralSats).toBe(minCollateralAt(14_000, 24_500n, PRICE) - collAt(12_500));
    expect(compareCr(collAt(12_500) + d.addCollateralSats, 24_500n, PRICE, 14_000)).toBeGreaterThanOrEqual(0);
    expect(d.reachesTarget).toBe(true);
  });

  it('caps by the buffer and flags a partial defend that uses the whole buffer', () => {
    const buffer = { sats: 1_000n + 2_500n + 1_000_000n, pusdCents: 300n }; // stateMin + fee + 0.01 BCH
    const d = expectKind(decide(base({ coll: collAt(12_000), buffer })), 'defend');
    expect(d.repayCents).toBe(300n);
    expect(d.addCollateralSats).toBe(1_000_000n);
    expect(d.reachesTarget).toBe(false);
    expect(d.exhaustsBuffer).toBe(true);
    expect(d.expectedCrBps).toBeGreaterThan(12_000);
    expect(d.expectedCrBps).toBeLessThan(14_000);
  });

  it('buffer empty: skip and say so', () => {
    expect(decide(base({ coll: collAt(12_000), buffer: { sats: 0n, pusdCents: 0n } }))).toMatchObject({ kind: 'skip', reason: 'buffer-empty' });
  });

  it('buffer with only the StateUTXO dust + fee is empty too', () => {
    const d = decide(base({ coll: collAt(12_000), buffer: { sats: 1_000n + 2_500n, pusdCents: 0n } }));
    expect(d).toMatchObject({ kind: 'skip', reason: 'buffer-empty' });
  });

  it('PUSD-only buffer: defends with repay; the fee claim is limited to what BCH there is', () => {
    const d = expectKind(decide(base({ coll: collAt(12_500), buffer: { sats: 1_500n, pusdCents: 10_000n } })), 'defend');
    expect(d.repayCents).toBeGreaterThan(0n);
    expect(d.addCollateralSats).toBe(0n);
    expect(d.feeClaimSats).toBe(500n);
  });

  it('never repays below Paryon minimum debt', () => {
    // debt 10_500 cents, CR 120%: repay room is only 500 cents above the 100 PUSD minimum.
    const debt = 10_500n;
    const coll = minCollateralAt(12_000, debt, PRICE);
    const d = expectKind(decide(base({ coll, debt, buffer: { sats: 10_000_000n, pusdCents: 100_000n } })), 'defend');
    expect(d.repayCents).toBe(500n);
    expect(d.addCollateralSats).toBeGreaterThan(0n); // BCH covers the rest
    expect(d.reachesTarget).toBe(true);
  });

  it('defend always reaches target when the buffer is large (sweep)', () => {
    for (let bps = 11_000; bps < 13_000; bps += 37) {
      for (const pusd of [0n, 100n, 3_000n, 1_000_000n]) {
        const coll = collAt(bps) + 7n;
        const d = expectKind(decide(base({ coll, buffer: { sats: 1_000_000_000n, pusdCents: pusd } })), 'defend');
        expect(compareCr(coll + d.addCollateralSats, 25_000n - d.repayCents, PRICE, 14_000)).toBeGreaterThanOrEqual(0);
        expect(d.repayCents).toBeLessThanOrEqual(pusd);
      }
    }
  });
});

describe('fees', () => {
  it('vault fee cap lower than the network fee: skip (defend)', () => {
    const d = decide(base({ coll: collAt(12_000), networkFeeSats: { defend: 3_001n, skim: 100n } }));
    expect(d).toMatchObject({ kind: 'skip', reason: 'fee-cap-below-network-fee' });
    expect((d as { detail: string }).detail).toContain('3001');
  });

  it('vault fee cap lower than the network fee: skip (skim)', () => {
    expect(decide(base({ coll: collAt(20_000), networkFeeSats: { defend: 100n, skim: 5_000n } })))
      .toMatchObject({ kind: 'skip', reason: 'fee-cap-below-network-fee' });
  });

  it('fee exactly at the cap is fine', () => {
    expectKind(decide(base({ coll: collAt(12_000), networkFeeSats: { defend: 3_000n, skim: 3_000n } })), 'defend');
  });

  it('operator maxFeeSats below the vault cap also skips', () => {
    const d = decide(base({ coll: collAt(12_000) }), { ...DEFAULT_DECIDE_OPTIONS, maxFeeSats: 2_000n });
    expect(d).toMatchObject({ kind: 'skip', reason: 'fee-cap-below-network-fee' });
  });

  it('in-band vaults are not affected by fees', () => {
    expect(decide(base({ coll: collAt(15_000), networkFeeSats: { defend: 99_999n, skim: 99_999n } })).kind).toBe('noop');
  });
});

describe('skim', () => {
  it('withdraws to exactly target and no further', () => {
    const coll = collAt(20_000) + 123n;
    const d = expectKind(decide(base({ coll })), 'skim');
    expect(compareCr(coll - d.withdrawSats, 25_000n, PRICE, 14_000)).toBeGreaterThanOrEqual(0);
    expect(compareCr(coll - d.withdrawSats - 1n, 25_000n, PRICE, 14_000)).toBe(-1);
    expect(d.feeClaimSats).toBe(2_300n);
  });

  it('too small to be worth a tx is a noop', () => {
    // Tiny debt: CR just above 160%, excess over 140% = 8001 sats; minus the 2300 fee is below minSkim (10000).
    const debt = 20n;
    const coll = minCollateralAt(16_000, debt, PRICE) + 1n;
    expect(decide(base({ coll, debt }))).toMatchObject({ kind: 'noop', reason: 'skim-too-small' });
    // The same vault with a lower operator threshold skims.
    expectKind(decide(base({ coll, debt }), { ...DEFAULT_DECIDE_OPTIONS, minSkimSats: 1_000n }), 'skim');
  });
});

describe('idempotency', () => {
  it('pending tx for the vault: skip even if it needs a defend', () => {
    expect(decide(base({ coll: collAt(12_000), pendingTxids: ['ab'.repeat(32)] }))).toMatchObject({ kind: 'skip', reason: 'pending-keeper-tx' });
  });
});
