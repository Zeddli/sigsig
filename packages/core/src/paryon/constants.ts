/**
 * Paryon fixed transaction layouts and constants, taken from the `// Inputs: / Outputs:` headers of the
 * Paryon .cash sources (@paryonusd/contracts@1.1.0). Vault builders compose on top of these indexes.
 */

/** Loan-function NFT identifiers (1-byte commitment of the function NFT, category = paryonTokenId, immutable). */
export const LOAN_FUNCTION_ID = {
  liquidate: 0x01,
  manage: 0x02,
  redeem: 0x03,
  startRedemption: 0x04,
  swapInRedemption: 0x05,
  swapOutRedemption: 0x06,
  payInterest: 0x07,
  changeInterest: 0x08,
} as const;
export type LoanFunctionName = keyof typeof LOAN_FUNCTION_ID;

export const LOAN_FUNCTION_NAME: Record<number, LoanFunctionName> = Object.fromEntries(
  Object.entries(LOAN_FUNCTION_ID).map(([k, v]) => [v, k as LoanFunctionName]),
);

/** Value every Paryon state/function/sidecar/key UTXO holds. */
export const PARYON_DUST = 1000n;
/** Minimum loan debt and minimum partial repay: 100.00 PUSD. */
export const MIN_DEBT_CENTS = 10_000n;
export const MIN_REPAY_CENTS = 10_000n;
/** Paryon burns repaid PUSD (and closed loan NFTs) to `new LockingBytecodeNullData([0x])`, which compiles to bare OP_RETURN. */
export const BURN_LOCKING_BYTECODE_HEX = '6a';
/** Default interestManagerConfiguration (no manager, min 0, max 0). */
export const NO_INTEREST_MANAGER = '0000000000';

/** LoanKeyFactory.create */
export const CREATE_LOAN_KEY = {
  in: { vout0: 0, factory: 1, fee: 2 },
  out: { authHead: 0, factory: 1, enforcer: 2, proof: 3, change: 4 },
} as const;

/** Borrowing.borrow */
export const BORROW = {
  in: { borrowing: 0, price: 1, enforcer: 2, proof: 3, collateral: 4 },
  out: { borrowing: 0, price: 1, loan: 2, sidecar: 3, fee: 4, loanKey: 5, pusd: 6, change: 7 },
  maxOutputs: 10,
} as const;

/**
 * manage (loan kept open). Index 4 is the loanKey (vault KeyUTXO for the vault), inputs >= 5 are free
 * (vault StateUTXO, keeper fee input, repay tokens...). Output 5 is the PUSD burn when repayAmount > 0.
 */
export const MANAGE = {
  in: { price: 0, loan: 1, sidecar: 2, fn: 3, loanKey: 4, firstFree: 5 },
  out: { price: 0, loan: 1, sidecar: 2, fn: 3, loanKey: 4, burn: 5 },
} as const;

/** manage when the loan is closed (full repay, no pending redemption). */
export const MANAGE_CLOSE = {
  in: MANAGE.in,
  out: { price: 0, fn: 1, burnPusd: 2, burnLoan: 3 },
} as const;

/** changeInterest (loanKey at input 3, recreated at output 3). */
export const CHANGE_INTEREST = {
  in: { loan: 0, sidecar: 1, fn: 2, loanKey: 3, firstFree: 4 },
  out: { loan: 0, sidecar: 1, fn: 2, loanKey: 3 },
} as const;
