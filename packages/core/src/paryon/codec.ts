/**
 * Paryon commitment codecs.
 *
 * Loan state (mutable NFT on the Loan contract, 27 bytes):
 *   0x01 | borrowedAmount6 | amountBeingRedeemed6 | status1 | lastPeriodInterestPaid4 | currentInterestRate2
 *        | nextInterestRate2 | interestManager1 | minRateManager2 | maxRateManager2
 * Price state (mutable NFT on the PriceContract, 9 bytes): 0x00 | sequence4 | price4 (PUSD cents per BCH)
 * All integers are VM script numbers (little-endian), as read by `int(bytesN)` in the contracts.
 */
import type { LoanState } from '../types.js';
import { binToHex, decodeScriptNum, encodeScriptNumPaddedHex, hexToBin } from '../util.js';

export const LOAN_COMMITMENT_LENGTH = 27;
export const PRICE_COMMITMENT_LENGTH = 9;

export interface LoanCommitment {
  borrowedAmount: bigint;
  amountBeingRedeemed: bigint;
  status: number;
  lastPeriodInterestPaid: number;
  currentInterestRate: number;
  nextInterestRate: number;
  interestManager: number;
  minRateManager: number;
  maxRateManager: number;
  /** last 5 bytes, hex: interestManager | minRateManager | maxRateManager */
  interestManagerConfiguration: string;
}

export function decodeLoanCommitment(commitment: string | Uint8Array): LoanCommitment {
  const b = typeof commitment === 'string' ? hexToBin(commitment) : commitment;
  if (b.length !== LOAN_COMMITMENT_LENGTH) throw new Error(`Loan commitment must be 27 bytes, got ${b.length}`);
  if (b[0] !== 0x01) throw new Error(`Loan commitment identifier must be 0x01, got 0x${b[0]!.toString(16)}`);
  const n = (from: number, to: number) => decodeScriptNum(b.slice(from, to));
  return {
    borrowedAmount: n(1, 7),
    amountBeingRedeemed: n(7, 13),
    status: Number(n(13, 14)),
    lastPeriodInterestPaid: Number(n(14, 18)),
    currentInterestRate: Number(n(18, 20)),
    nextInterestRate: Number(n(20, 22)),
    interestManager: b[22]!,
    minRateManager: Number(n(23, 25)),
    maxRateManager: Number(n(25, 27)),
    interestManagerConfiguration: binToHex(b.slice(22, 27)),
  };
}

export function encodeLoanCommitment(c: Omit<LoanCommitment, 'interestManager' | 'minRateManager' | 'maxRateManager'>): string {
  if (c.interestManagerConfiguration.length !== 10) throw new Error('interestManagerConfiguration must be 5 bytes');
  return (
    '01' +
    encodeScriptNumPaddedHex(c.borrowedAmount, 6) +
    encodeScriptNumPaddedHex(c.amountBeingRedeemed, 6) +
    encodeScriptNumPaddedHex(c.status, 1) +
    encodeScriptNumPaddedHex(c.lastPeriodInterestPaid, 4) +
    encodeScriptNumPaddedHex(c.currentInterestRate, 2) +
    encodeScriptNumPaddedHex(c.nextInterestRate, 2) +
    c.interestManagerConfiguration.toLowerCase()
  );
}

/** The commitment Borrowing.borrow requires on the new loan output. */
export function borrowLoanCommitment(params: {
  borrowedAmount: bigint;
  periodBorrowingHex: string; // 4 bytes, the Borrowing contract's commitment
  startingInterestRate: number;
  interestManagerConfiguration: string;
}): string {
  if (params.periodBorrowingHex.length !== 8) throw new Error('Borrowing commitment must be 4 bytes');
  const rate = encodeScriptNumPaddedHex(params.startingInterestRate, 2);
  return (
    '01' +
    encodeScriptNumPaddedHex(params.borrowedAmount, 6) +
    encodeScriptNumPaddedHex(0, 6) +
    '00' +
    params.periodBorrowingHex.toLowerCase() +
    rate +
    rate +
    params.interestManagerConfiguration.toLowerCase()
  );
}

/** The commitment manage requires on the recreated loan output. */
export function manageLoanCommitment(oldCommitmentHex: string, newBorrowAmount: bigint, interestManagerConfiguration: string): string {
  // 0x01 + newBorrow6 + bytes 7..22 of the old state (15 bytes) + new interestManagerConfiguration
  return '01' + encodeScriptNumPaddedHex(newBorrowAmount, 6) + oldCommitmentHex.slice(14, 44) + interestManagerConfiguration.toLowerCase();
}

/** The commitment changeInterest requires on the recreated loan output. */
export function changeInterestLoanCommitment(oldCommitmentHex: string, nextInterestRate: number): string {
  return oldCommitmentHex.slice(0, 40) + encodeScriptNumPaddedHex(nextInterestRate, 2) + oldCommitmentHex.slice(44, 54);
}

export function loanStateFromCommitment(commitment: string | Uint8Array, collateralSats: bigint): LoanState {
  const c = decodeLoanCommitment(commitment);
  return {
    borrowedAmount: c.borrowedAmount,
    amountBeingRedeemed: c.amountBeingRedeemed,
    status: c.status,
    lastPeriodInterestPaid: c.lastPeriodInterestPaid,
    currentInterestRate: c.currentInterestRate,
    nextInterestRate: c.nextInterestRate,
    collateralSats,
  };
}

export interface PriceState {
  sequence: number;
  priceCents: bigint;
}

export function decodePriceCommitment(commitment: string | Uint8Array): PriceState {
  const b = typeof commitment === 'string' ? hexToBin(commitment) : commitment;
  if (b.length < PRICE_COMMITMENT_LENGTH) throw new Error(`Price commitment must be at least 9 bytes, got ${b.length}`);
  if (b[0] !== 0x00) throw new Error('Price commitment identifier must be 0x00');
  return { sequence: Number(decodeScriptNum(b.slice(1, 5))), priceCents: decodeScriptNum(b.slice(5, 9)) };
}

export function encodePriceCommitment(p: PriceState): string {
  return '00' + encodeScriptNumPaddedHex(p.sequence, 4) + encodeScriptNumPaddedHex(p.priceCents, 4);
}

export const isPriceCommitment = (hex: string | undefined): boolean => !!hex && hex.length >= 18 && hex.startsWith('00');
export const isLoanCommitment = (hex: string | undefined): boolean => !!hex && hex.length === 54 && hex.startsWith('01');
