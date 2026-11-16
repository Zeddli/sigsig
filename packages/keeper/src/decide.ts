/**
 * Pure keeper decision logic: no I/O, no clocks. Given one vault's on-chain numbers, return what to do.
 *
 * CR math is Paryon's integer formula (ARCHITECTURE §2.2): CR_bps = coll * price * 10000 / (debt * 1e8),
 * with price in PUSD cents per BCH, coll in sats and debt in PUSD cents. Threshold checks are done by
 * cross-multiplication, exactly like the covenant, so there is no rounding at the boundary.
 */
import type { LoanState, VaultPolicy } from '@sigsig/core';
import type { DefendPlan, SkimPlan } from './ports.js';

const SATS_PER_BCH = 100_000_000n;
const BPS = 10_000n;

export interface DecideInput {
  policy: Pick<VaultPolicy, 'defendCrBps' | 'targetCrBps' | 'skimCrBps' | 'keeperFeeMaxSats'>;
  loan: Pick<LoanState, 'borrowedAmount' | 'amountBeingRedeemed' | 'collateralSats'>;
  priceCents: bigint;
  buffer: { sats: bigint; pusdCents: bigint };
  /** Unconfirmed txs already touching this vault (ours or anyone's). Non-empty means skip. */
  pendingTxids: readonly string[];
  /** Estimated network fee for each tx kind, sats. */
  networkFeeSats: { defend: bigint; skim: bigint };
}

export interface DecideOptions {
  /** The keeper operator's own fee ceiling (on top of the vault's keeperFeeMaxSats). */
  maxFeeSats?: bigint;
  /** Paryon minimum debt (100.00 PUSD on mainnet-v1). Repay never takes debt below this. */
  minDebtCents: bigint;
  /** Sats the recreated StateUTXO must keep (it carries the state NFT). */
  stateMinSats: bigint;
  /** Skims whose net amount (after fee) is below this are not worth a tx. */
  minSkimSats: bigint;
}

export const DEFAULT_DECIDE_OPTIONS: DecideOptions = {
  minDebtCents: 10_000n,
  stateMinSats: 1_000n,
  minSkimSats: 10_000n,
};

export type NoopReason = 'in-band' | 'no-debt' | 'redemption-pending' | 'skim-too-small';
export type SkipReason =
  | 'pending-keeper-tx'
  | 'fee-cap-below-network-fee'
  | 'buffer-empty'
  | 'invalid-policy'
  | 'invalid-price';

export type Decision =
  | ({ kind: 'defend'; crBps: number; feeSats: bigint } & DefendPlan & { reachesTarget: boolean })
  | ({ kind: 'skim'; crBps: number; feeSats: bigint } & SkimPlan)
  | { kind: 'noop'; reason: NoopReason; crBps: number }
  | { kind: 'skip'; reason: SkipReason; crBps: number; detail: string };

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Floor CR in bps; Number.MAX_SAFE_INTEGER when there is no debt. */
export function crBps(collSats: bigint, debtCents: bigint, priceCents: bigint): number {
  if (debtCents <= 0n) return Number.MAX_SAFE_INTEGER;
  const v = (collSats * priceCents * BPS) / (debtCents * SATS_PER_BCH);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}

/** coll*price*1e4 vs thresholdBps*debt*1e8, i.e. sign(CR - threshold) without division. */
export function compareCr(collSats: bigint, debtCents: bigint, priceCents: bigint, thresholdBps: number): -1 | 0 | 1 {
  const lhs = collSats * priceCents * BPS;
  const rhs = BigInt(thresholdBps) * debtCents * SATS_PER_BCH;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

/** Largest debt (cents) that keeps CR ≥ targetBps at this collateral. */
export function maxDebtAt(targetBps: number, collSats: bigint, priceCents: bigint): bigint {
  return (collSats * priceCents * BPS) / (BigInt(targetBps) * SATS_PER_BCH);
}

/** Smallest collateral (sats) that gives CR ≥ targetBps at this debt. */
export function minCollateralAt(targetBps: number, debtCents: bigint, priceCents: bigint): bigint {
  return ceilDiv(BigInt(targetBps) * debtCents * SATS_PER_BCH, priceCents * BPS);
}

export function decide(input: DecideInput, opts: DecideOptions = DEFAULT_DECIDE_OPTIONS): Decision {
  const { policy, loan, priceCents, buffer } = input;
  const coll = loan.collateralSats;
  const debt = loan.borrowedAmount;

  if (debt <= 0n) return { kind: 'noop', reason: 'no-debt', crBps: Number.MAX_SAFE_INTEGER };
  if (priceCents <= 0n) {
    return { kind: 'skip', reason: 'invalid-price', crBps: 0, detail: `price ${priceCents} cents/BCH` };
  }
  const cr = crBps(coll, debt, priceCents);

  const { defendCrBps: d, targetCrBps: t, skimCrBps: s } = policy;
  if (!(d < t && t <= s)) {
    return { kind: 'skip', reason: 'invalid-policy', crBps: cr, detail: `need defend<target<=skim, got ${d}/${t}/${s}` };
  }

  if (input.pendingTxids.length > 0) {
    return { kind: 'skip', reason: 'pending-keeper-tx', crBps: cr, detail: input.pendingTxids.join(',') };
  }

  const feeCap = opts.maxFeeSats === undefined
    ? BigInt(policy.keeperFeeMaxSats)
    : min(BigInt(policy.keeperFeeMaxSats), opts.maxFeeSats);
  const feeTooHigh = (fee: bigint): Decision | null =>
    fee > feeCap
      ? { kind: 'skip', reason: 'fee-cap-below-network-fee', crBps: cr, detail: `network fee ${fee} > cap ${feeCap} sats` }
      : null;

  // ---- defend: CR strictly below defendCR ----
  if (compareCr(coll, debt, priceCents, d) < 0) {
    const fee = input.networkFeeSats.defend;
    const capped = feeTooHigh(fee);
    if (capped) return capped;

    // The keeper takes its fee back from the BCH buffer if it can; it never takes the StateUTXO below stateMinSats.
    const bchSpendable = max(0n, buffer.sats - opts.stateMinSats);
    const feeClaimSats = min(fee, bchSpendable);
    const bchForCollateral = bchSpendable - feeClaimSats;

    // 1) Prefer repaying with buffer PUSD.
    const repayNeeded = debt - maxDebtAt(t, coll, priceCents);
    const repayRoom = max(0n, debt - opts.minDebtCents);
    const repayCents = max(0n, min(repayNeeded, min(buffer.pusdCents, repayRoom)));
    const debtAfter = debt - repayCents;

    // 2) Top up with BCH collateral if repay alone does not reach target.
    let addCollateralSats = 0n;
    if (compareCr(coll, debtAfter, priceCents, t) < 0) {
      addCollateralSats = min(minCollateralAt(t, debtAfter, priceCents) - coll, bchForCollateral);
    }

    if (repayCents === 0n && addCollateralSats === 0n) {
      return {
        kind: 'skip', reason: 'buffer-empty', crBps: cr,
        detail: `buffer ${buffer.sats} sats / ${buffer.pusdCents} cents; nothing usable to defend with`,
      };
    }

    const collAfter = coll + addCollateralSats;
    const reachesTarget = compareCr(collAfter, debtAfter, priceCents, t) >= 0;
    const exhaustsBuffer = !reachesTarget
      && addCollateralSats === bchForCollateral
      && repayCents === min(buffer.pusdCents, repayRoom);
    return {
      kind: 'defend',
      crBps: cr,
      feeSats: fee,
      repayCents,
      addCollateralSats,
      feeClaimSats,
      expectedCrBps: crBps(collAfter, debtAfter, priceCents),
      exhaustsBuffer,
      reachesTarget,
    };
  }

  // ---- skim: CR strictly above skimCR ----
  if (compareCr(coll, debt, priceCents, s) > 0) {
    if (loan.amountBeingRedeemed > 0n) return { kind: 'noop', reason: 'redemption-pending', crBps: cr };
    const fee = input.networkFeeSats.skim;
    const capped = feeTooHigh(fee);
    if (capped) return capped;

    const withdrawSats = coll - minCollateralAt(t, debt, priceCents);
    if (withdrawSats - fee < opts.minSkimSats) return { kind: 'noop', reason: 'skim-too-small', crBps: cr };
    return {
      kind: 'skim',
      crBps: cr,
      feeSats: fee,
      withdrawSats,
      feeClaimSats: fee,
      expectedCrBps: crBps(coll - withdrawSats, debt, priceCents),
    };
  }

  return { kind: 'noop', reason: 'in-band', crBps: cr };
}
