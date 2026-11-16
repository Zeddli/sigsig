import { describe, expect, it } from 'vitest';
import type { LoanState } from '../src/types.js';
import {
  computeHealth, crAtLeast, crBps, defendCollateralSats, defendRepayCents, isLiquidatable, liquidationPriceCents,
  maxBorrowCents, minCollateralParyon, planDefend, satisfiesParyonMinimum, skimAmountSats, borrowingFeeSats,
} from '../src/health.js';
import {
  borrowLoanCommitment, changeInterestLoanCommitment, decodeLoanCommitment, decodePriceCommitment, encodeLoanCommitment,
  encodePriceCommitment, manageLoanCommitment,
} from '../src/paryon/codec.js';
import { decodeScriptNum, encodeScriptNumPadded } from '../src/util.js';

const loan = (collateralSats: bigint, borrowedAmount: bigint, extra: Partial<LoanState> = {}): LoanState => ({
  borrowedAmount, amountBeingRedeemed: 0n, status: 2, lastPeriodInterestPaid: 0, currentInterestRate: 100,
  nextInterestRate: 100, collateralSats, ...extra,
});

describe('script numbers', () => {
  it('round-trips and matches OP_NUM2BIN padding', () => {
    expect(encodeScriptNumPadded(20_000n, 6)).toEqual(Uint8Array.from([0x20, 0x4e, 0, 0, 0, 0]));
    expect(decodeScriptNum(Uint8Array.from([0x20, 0x4e, 0, 0, 0, 0]))).toBe(20_000n);
    expect(decodeScriptNum(encodeScriptNumPadded(-5n, 2))).toBe(-5n);
    expect(() => encodeScriptNumPadded(0x8000, 2)).toThrow();
  });
});

describe('codec', () => {
  it('loan commitment encode/decode, and the borrow/manage/changeInterest transforms', () => {
    const c = borrowLoanCommitment({ borrowedAmount: 12_345n, periodBorrowingHex: '07000000', startingInterestRate: 150, interestManagerConfiguration: '0102000300' });
    expect(c).toHaveLength(54);
    const d = decodeLoanCommitment(c);
    expect(d).toMatchObject({ borrowedAmount: 12_345n, amountBeingRedeemed: 0n, status: 0, lastPeriodInterestPaid: 7, currentInterestRate: 150, nextInterestRate: 150, interestManager: 1, minRateManager: 2, maxRateManager: 3 });
    expect(encodeLoanCommitment(d)).toBe(c);
    const m = decodeLoanCommitment(manageLoanCommitment(c, 10_000n, '0000000000'));
    expect(m).toMatchObject({ borrowedAmount: 10_000n, lastPeriodInterestPaid: 7, currentInterestRate: 150, interestManager: 0 });
    const ci = decodeLoanCommitment(changeInterestLoanCommitment(c, 999));
    expect(ci).toMatchObject({ borrowedAmount: 12_345n, currentInterestRate: 150, nextInterestRate: 999, interestManagerConfiguration: '0102000300' });
  });
  it('price commitment', () => {
    const hex = encodePriceCommitment({ sequence: 7, priceCents: 45_133n });
    expect(hex).toBe('00' + '07000000' + '4db00000');
    expect(decodePriceCommitment(hex)).toEqual({ sequence: 7, priceCents: 45_133n });
  });
});

describe('health math matches the Paryon formulas exactly', () => {
  const price = 40_000n; // $400.00 / BCH

  it('maxBorrow = (coll*10/11)*price/1e8 with integer division', () => {
    expect(maxBorrowCents(100_000_000n, price)).toBe(36_363n); // 90909090 * 40000 / 1e8 = 36363.636
    expect(maxBorrowCents(11n, 100_000_000n)).toBe(10n);
  });

  it('liquidation price is the exact boundary', () => {
    const coll = 100_000_000n, debt = 20_000n;
    const lp = liquidationPriceCents(coll, debt);
    expect(isLiquidatable(coll, debt, lp)).toBe(true);
    expect(isLiquidatable(coll, debt, lp + 1n)).toBe(false);
  });

  it('min collateral (Paryon 110%) is the exact boundary', () => {
    for (const debt of [10_000n, 12_345n, 99_999n]) {
      const c = minCollateralParyon(debt, price);
      expect(satisfiesParyonMinimum(c, debt, price)).toBe(true);
      expect(satisfiesParyonMinimum(c - 1n, debt, price)).toBe(false);
    }
  });

  it('defend with BCH reaches target exactly (cross-multiplied)', () => {
    const l = loan(50_000_000n, 15_000n); // CR 133.33%
    const add = defendCollateralSats(l, price, 15_000);
    expect(crAtLeast(l.collateralSats + add, l.borrowedAmount, price, 15_000)).toBe(true);
    expect(crAtLeast(l.collateralSats + add - 1n, l.borrowedAmount, price, 15_000)).toBe(false);
  });

  it('defend with PUSD respects the 100 PUSD minimum repay and minimum debt', () => {
    const l = loan(50_000_000n, 15_000n);
    const r = defendRepayCents(l, price, 15_000);
    expect(r.feasible).toBe(false); // would leave < 100 PUSD of debt
    const big = loan(500_000_000n, 150_000n); // CR 133.33%
    const r2 = defendRepayCents(big, price, 15_000);
    expect(r2.feasible).toBe(true);
    expect(crAtLeast(big.collateralSats, big.borrowedAmount - r2.repayCents, price, 15_000)).toBe(true);
    expect(crAtLeast(big.collateralSats, big.borrowedAmount - r2.repayCents + 1n, price, 15_000)).toBe(false);
  });

  it('planDefend prefers PUSD, falls back to BCH, then best effort', () => {
    const big = loan(500_000_000n, 150_000n);
    expect(planDefend(big, price, 15_000, { sats: 10n ** 9n, pusdCents: 10n ** 6n })).toMatchObject({ addCollateralSats: 0n, reachesTarget: true });
    const p2 = planDefend(big, price, 15_000, { sats: 10n ** 9n, pusdCents: 0n });
    expect(p2.repayCents).toBe(0n);
    expect(p2.reachesTarget).toBe(true);
    const p3 = planDefend(big, price, 15_000, { sats: 1_000_000n, pusdCents: 0n });
    expect(p3).toMatchObject({ addCollateralSats: 1_000_000n, repayCents: 0n, reachesTarget: false });
  });

  it('skim leaves CR exactly at/above target and is 0 during redemptions', () => {
    const l = loan(200_000_000n, 20_000n); // CR 400%
    const s = skimAmountSats(l, price, 15_000);
    expect(crAtLeast(l.collateralSats - s, l.borrowedAmount, price, 15_000)).toBe(true);
    expect(crAtLeast(l.collateralSats - s - 1n, l.borrowedAmount, price, 15_000)).toBe(false);
    expect(skimAmountSats({ ...l, amountBeingRedeemed: 1n }, price, 15_000)).toBe(0n);
  });

  it('health status', () => {
    const policy = { defendCrBps: 13_000, targetCrBps: 15_000, skimCrBps: 20_000 };
    expect(computeHealth(loan(100_000_000n, 20_000n), price, policy)).toMatchObject({ crBps: 20_000, status: 'safe' });
    expect(computeHealth(loan(100_000_000n, 19_999n), price, policy).status).toBe('skim');
    expect(computeHealth(loan(100_000_000n, 28_000n), price, policy).status).toBe('watch');
    expect(computeHealth(loan(100_000_000n, 32_000n), price, policy).status).toBe('defend');
    expect(computeHealth(loan(100_000_000n, 36_364n), price, policy).status).toBe('liquidatable');
    expect(crBps(1n, 0n, price)).toBe(Number.POSITIVE_INFINITY);
  });

  it('borrowing fee = max(0.25% of BCH value, 1000 sats)', () => {
    expect(borrowingFeeSats(20_000n, 40_000n)).toBe(125_000n);
    expect(borrowingFeeSats(10_000n, 10_000_000n)).toBe(1000n);
  });
});
