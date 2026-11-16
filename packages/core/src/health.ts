/**
 * Loan health math. Integer-exact, matching the Paryon contracts and the Vault covenant:
 *   maxBorrow = ((coll * 10) / 11) * price / 1e8        (Borrowing.borrow, manage, liquidate; integer division)
 *   liquidatable  <=> debt > maxBorrow
 *   CR_bps = coll * price * 10000 / (debt * 1e8)          (display; floor)
 *   "CR >= X bps" is checked cross-multiplied: coll * price * 10000 >= X * debt * 1e8 (Vault covenant, no rounding)
 * Units: coll in sats, debt in PUSD cents, price in PUSD cents per BCH.
 */
import type { Health, LoanState, VaultPolicy } from './types.js';
import { ceilDiv, maxBig, minBig } from './util.js';
import { MIN_DEBT_CENTS, MIN_REPAY_CENTS } from './paryon/constants.js';

const COIN = 100_000_000n;
const BPS = 10_000n;

/** Paryon's maximum debt for a collateral at a price (exact contract formula). */
export function maxBorrowCents(collateralSats: bigint, priceCents: bigint): bigint {
  return (((collateralSats * 10n) / 11n) * priceCents) / COIN;
}

/** Paryon liquidation condition (liquidate.cash): debt > maxBorrow. */
export const isLiquidatable = (collateralSats: bigint, debtCents: bigint, priceCents: bigint): boolean =>
  debtCents > maxBorrowCents(collateralSats, priceCents);

/** Paryon's min-CR condition used by borrow/manage: newDebt <= maxBorrow(newCollateral). */
export const satisfiesParyonMinimum = (collateralSats: bigint, debtCents: bigint, priceCents: bigint): boolean =>
  debtCents <= maxBorrowCents(collateralSats, priceCents);

/** CR in bps, floored. Infinity when there is no debt. */
export function crBps(collateralSats: bigint, debtCents: bigint, priceCents: bigint): number {
  if (debtCents <= 0n) return Number.POSITIVE_INFINITY;
  return Number((collateralSats * priceCents * BPS) / (debtCents * COIN));
}

/** Exact cross-multiplied check: CR >= bps (same comparison the Vault covenant makes). */
export const crAtLeast = (collateralSats: bigint, debtCents: bigint, priceCents: bigint, bps: number | bigint): boolean =>
  collateralSats * priceCents * BPS >= BigInt(bps) * debtCents * COIN;

/** Exact cross-multiplied check: CR < bps. */
export const crBelow = (collateralSats: bigint, debtCents: bigint, priceCents: bigint, bps: number | bigint): boolean =>
  !crAtLeast(collateralSats, debtCents, priceCents, bps);

/** Exact cross-multiplied check: CR > bps. */
export const crAbove = (collateralSats: bigint, debtCents: bigint, priceCents: bigint, bps: number | bigint): boolean =>
  collateralSats * priceCents * BPS > BigInt(bps) * debtCents * COIN;

/**
 * Liquidation price: the highest price (cents/BCH) at which the loan can be liquidated (debt > maxBorrow).
 * At liquidationPrice + 1 the loan is safe. Returns 0 if there is no debt.
 */
export function liquidationPriceCents(collateralSats: bigint, debtCents: bigint): bigint {
  if (debtCents <= 0n) return 0n;
  const base = (collateralSats * 10n) / 11n;
  if (base === 0n) return BigInt(Number.MAX_SAFE_INTEGER);
  // safe <=> floor(base * p / 1e8) >= debt <=> base * p >= debt * 1e8 <=> p >= ceil(debt * 1e8 / base)
  return ceilDiv(debtCents * COIN, base) - 1n;
}

/** Smallest collateral that satisfies Paryon's 110% rule for a debt. */
export function minCollateralParyon(debtCents: bigint, priceCents: bigint): bigint {
  if (debtCents <= 0n) return 0n;
  // need floor(floor(c*10/11) * p / 1e8) >= debt  <=>  floor(c*10/11) >= ceil(debt*1e8/p) =: B
  // floor(c*10/11) >= B  <=>  c*10 >= 11*B  <=>  c >= ceil(11*B/10)
  const b = ceilDiv(debtCents * COIN, priceCents);
  return ceilDiv(11n * b, 10n);
}

/** Smallest collateral with CR >= bps (cross-multiplied), also respecting Paryon's minimum. */
export function minCollateralForCr(debtCents: bigint, priceCents: bigint, bps: number | bigint): bigint {
  if (debtCents <= 0n) return 0n;
  const forCr = ceilDiv(BigInt(bps) * debtCents * COIN, priceCents * BPS);
  return maxBig(forCr, minCollateralParyon(debtCents, priceCents));
}

/** Largest debt with CR >= bps at a collateral (cross-multiplied), also respecting Paryon's maximum. */
export function maxDebtForCr(collateralSats: bigint, priceCents: bigint, bps: number | bigint): bigint {
  const forCr = (collateralSats * priceCents * BPS) / (BigInt(bps) * COIN);
  return minBig(forCr, maxBorrowCents(collateralSats, priceCents));
}

/** BCH to add as collateral to reach target CR (0 if already there). */
export function defendCollateralSats(loan: LoanState, priceCents: bigint, targetCrBps: number): bigint {
  const need = minCollateralForCr(loan.borrowedAmount, priceCents, targetCrBps);
  return need > loan.collateralSats ? need - loan.collateralSats : 0n;
}

export interface RepayPlan {
  /** PUSD cents to repay (0 if none needed). */
  repayCents: bigint;
  /** Whether Paryon accepts the repay (>= 100 PUSD or full redeemable debt, new debt >= 100 PUSD). */
  feasible: boolean;
  reason?: string;
}

/**
 * PUSD to repay to reach target CR, rounded up to Paryon's minimum repay (100.00 PUSD).
 * A repay that would leave less than 100 PUSD of debt is not feasible without closing the loan.
 */
export function defendRepayCents(loan: LoanState, priceCents: bigint, targetCrBps: number): RepayPlan {
  const maxDebt = maxDebtForCr(loan.collateralSats, priceCents, targetCrBps);
  if (loan.borrowedAmount <= maxDebt) return { repayCents: 0n, feasible: true };
  let repay = loan.borrowedAmount - maxDebt;
  if (repay < MIN_REPAY_CENTS) repay = MIN_REPAY_CENTS;
  return checkRepay(loan, repay);
}

/** Paryon manage() rules for a partial repay. */
export function checkRepay(loan: LoanState, repayCents: bigint): RepayPlan {
  const redeemable = loan.borrowedAmount - loan.amountBeingRedeemed;
  if (repayCents === 0n) return { repayCents, feasible: true };
  if (repayCents > redeemable) return { repayCents, feasible: false, reason: 'repay exceeds redeemable debt' };
  if (repayCents < MIN_REPAY_CENTS && repayCents !== redeemable) {
    return { repayCents, feasible: false, reason: 'repay below 100.00 PUSD minimum' };
  }
  const closes = repayCents === redeemable && loan.amountBeingRedeemed === 0n;
  if (!closes && loan.borrowedAmount - repayCents < MIN_DEBT_CENTS) {
    return { repayCents, feasible: false, reason: 'remaining debt below 100.00 PUSD minimum' };
  }
  return { repayCents, feasible: true };
}

export interface DefendPlan {
  addCollateralSats: bigint;
  repayCents: bigint;
  /** True if the result reaches targetCR; false = best effort with the whole buffer. */
  reachesTarget: boolean;
  crAfterBps: number;
}

/**
 * Plan a defend with a limited buffer. Preference: repay with buffer PUSD if that alone reaches target
 * (it also lowers interest), else add BCH, else add all available BCH and repay what PUSD allows.
 * `buffer.sats` must already exclude what the caller keeps back (keeper fee, StateUTXO dust).
 */
export function planDefend(
  loan: LoanState,
  priceCents: bigint,
  targetCrBps: number,
  buffer: { sats: bigint; pusdCents: bigint },
): DefendPlan {
  const result = (add: bigint, repay: bigint): DefendPlan => {
    const coll = loan.collateralSats + add;
    const debt = loan.borrowedAmount - repay;
    return { addCollateralSats: add, repayCents: repay, reachesTarget: crAtLeast(coll, debt, priceCents, targetCrBps), crAfterBps: crBps(coll, debt, priceCents) };
  };
  const repayOnly = defendRepayCents(loan, priceCents, targetCrBps);
  if (repayOnly.feasible && repayOnly.repayCents <= buffer.pusdCents) return result(0n, repayOnly.repayCents);

  const addOnly = defendCollateralSats(loan, priceCents, targetCrBps);
  if (addOnly <= buffer.sats) return result(addOnly, 0n);

  // Not enough of either alone: put all BCH in, then repay what is still needed (if PUSD allows).
  const add = buffer.sats > 0n ? buffer.sats : 0n;
  const after: LoanState = { ...loan, collateralSats: loan.collateralSats + add };
  const rest = defendRepayCents(after, priceCents, targetCrBps);
  if (rest.feasible && rest.repayCents <= buffer.pusdCents) return result(add, rest.repayCents);
  // Best effort: repay as much PUSD as Paryon allows.
  const maxRepay = minBig(buffer.pusdCents, loan.borrowedAmount - loan.amountBeingRedeemed, loan.borrowedAmount - MIN_DEBT_CENTS);
  const repay = maxRepay >= MIN_REPAY_CENTS ? maxRepay : 0n;
  return result(add, repay);
}

/**
 * BCH that can be withdrawn while keeping CR >= target (and Paryon's 110%). 0 during a pending redemption,
 * since manage forbids withdrawals then.
 */
export function skimAmountSats(loan: LoanState, priceCents: bigint, targetCrBps: number): bigint {
  if (loan.amountBeingRedeemed > 0n) return 0n;
  const need = minCollateralForCr(loan.borrowedAmount, priceCents, targetCrBps);
  return loan.collateralSats > need ? loan.collateralSats - need : 0n;
}

/**
 * Health summary. Status thresholds (with a policy): liquidatable (debt > maxBorrow), defend (CR < defendCR),
 * skim (CR > skimCR), watch (CR < targetCR), safe otherwise. Without a policy: 130/150/200%.
 */
export function computeHealth(loan: LoanState, priceCents: bigint, policy?: Pick<VaultPolicy, 'defendCrBps' | 'targetCrBps' | 'skimCrBps'>): Health {
  const coll = loan.collateralSats;
  const debt = loan.borrowedAmount;
  const defend = policy?.defendCrBps ?? 13_000;
  const target = policy?.targetCrBps ?? 15_000;
  const skim = policy?.skimCrBps ?? 20_000;
  let status: Health['status'];
  if (isLiquidatable(coll, debt, priceCents)) status = 'liquidatable';
  else if (crBelow(coll, debt, priceCents, defend)) status = 'defend';
  else if (crAbove(coll, debt, priceCents, skim)) status = 'skim';
  else if (crBelow(coll, debt, priceCents, target)) status = 'watch';
  else status = 'safe';
  return {
    priceCentsPerBch: priceCents,
    crBps: crBps(coll, debt, priceCents),
    liquidationPriceCents: liquidationPriceCents(coll, debt),
    maxBorrowCents: maxBorrowCents(coll, priceCents),
    status,
  };
}

/** Borrowing fee (BCH sats) that Borrowing.borrow requires at output 4. */
export function borrowingFeeSats(borrowCents: bigint, priceCents: bigint): bigint {
  const bchValue = (borrowCents * COIN) / priceCents;
  const fee = (bchValue * 25n) / 10_000n;
  return fee > 1000n ? fee : 1000n;
}
