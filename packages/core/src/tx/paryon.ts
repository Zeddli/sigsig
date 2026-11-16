/**
 * Paryon tx builders: LoanKeyFactory.create, Borrowing.borrow, manage, changeInterest.
 * Layouts follow the `// Inputs: / Outputs:` headers of the Paryon .cash sources; index constants in paryon/constants.ts.
 *
 * Composable helpers (`addManageParyonInputs`, `manageParyonOutputs`, `pusdBurnOutput`, ...) are exported for the
 * vault builders (defend / skim / admin), which put the Vault KeyUTXO at input 4 and their own inputs/outputs after.
 */
import { hexToBin } from '@bitauth/libauth';
import type { Output, TransactionBuilder, Utxo } from 'cashscript';
import {
  BURN_LOCKING_BYTECODE_HEX,
  MIN_DEBT_CENTS,
  NO_INTEREST_MANAGER,
  PARYON_DUST,
} from '../paryon/constants.js';
import {
  borrowLoanCommitment,
  changeInterestLoanCommitment,
  decodeLoanCommitment,
  manageLoanCommitment,
} from '../paryon/codec.js';
import {
  fetchManageContext,
  findBorrowingUtxo,
  findChangeInterestUtxo,
  findLoanKeyFactoryUtxo,
  findLoanKeyOrigin,
  findLoanPair,
  findPriceUtxo,
  type LiveBorrowing,
  type LivePrice,
  type LoanKeyOrigin,
  type LoanPair,
  type ManageLiveState,
} from '../paryon/finders.js';
import { borrowingFeeSats, checkRepay, crBps, maxBorrowCents, satisfiesParyonMinimum } from '../health.js';
import { encodeScriptNumPaddedHex, formatBch, formatBps, formatPusd } from '../util.js';
import {
  DEFAULT_FEE_RATE,
  finalizeBuiltTx,
  newBuilder,
  selectBch,
  selectTokens,
  walletUnlocker,
  type Destination,
  type FundingWallet,
  type ParyonBuiltTx,
  type ParyonContext,
  type SpendableInput,
} from './common.js';

/** Margin of wallet BCH reserved for the miner fee when selecting inputs (the exact fee is computed at the end). */
const FEE_MARGIN = 3000n;

const bin = (hex: string) => hexToBin(hex);

/** Output that recreates a UTXO exactly at the same locking bytecode (Paryon "recreate contract" rule). */
export function recreateOutput(utxo: Utxo, lockingBytecode: string | Uint8Array, overrides: Partial<Output> = {}): Output {
  const to = typeof lockingBytecode === 'string' ? bin(lockingBytecode) : lockingBytecode;
  return { to, amount: utxo.satoshis, token: utxo.token, ...overrides };
}

/** OP_RETURN output burning `amount` PUSD (manage repay / close). */
export const pusdBurnOutput = (paryonTokenId: string, amount: bigint): Output => ({
  to: bin(BURN_LOCKING_BYTECODE_HEX),
  amount: 0n,
  token: { category: paryonTokenId, amount },
});

/** OP_RETURN output burning the loan's mutable NFT (manage close). */
export const loanNftBurnOutput = (paryonTokenId: string, loanCommitment: string): Output => ({
  to: bin(BURN_LOCKING_BYTECODE_HEX),
  amount: 0n,
  token: { category: paryonTokenId, amount: 0n, nft: { capability: 'mutable', commitment: loanCommitment } },
});

/** Add the Paryon side of a manage tx: inputs 0 price, 1 loan, 2 sidecar, 3 manage function. */
export function addManageParyonInputs(
  builder: TransactionBuilder,
  ctx: ParyonContext,
  live: ManageLiveState,
  args: { repayCents: bigint; interestManagerConfiguration: string },
): TransactionBuilder {
  const c = ctx.contracts;
  return builder
    .addInput(live.price.utxo, live.price.contract.unlock.sharePrice())
    .addInput(live.loan.loan, c.loan.unlock.interact())
    .addInput(live.loan.sidecar, c.loanSidecar.unlock.attach())
    .addInput(live.manageFn, c.loanFunctions.manage.unlock.manage(args.repayCents, bin(args.interestManagerConfiguration)));
}

export interface ManageDeltas {
  repayCents: bigint;
  /** + adds collateral, - withdraws it */
  collateralDeltaSats: bigint;
  interestManagerConfiguration: string;
}

export interface ManageOutcome {
  close: boolean;
  newDebtCents: bigint;
  newCollateralSats: bigint;
  newLoanCommitment?: string;
  crBeforeBps: number;
  crAfterBps: number;
}

/** Validate deltas against Paryon's manage() rules and compute the resulting loan. Throws with a readable reason. */
export function planManage(live: ManageLiveState, d: ManageDeltas): ManageOutcome {
  const { state, commitment } = live.loan;
  const price = live.price.priceCents;
  const repay = checkRepay(state, d.repayCents);
  if (!repay.feasible) throw new Error(`Invalid repay: ${repay.reason}`);
  if (d.interestManagerConfiguration.length !== 10) throw new Error('interestManagerConfiguration must be 5 bytes');
  const redeemable = state.borrowedAmount - state.amountBeingRedeemed;
  const close = d.repayCents > 0n && d.repayCents === redeemable && state.amountBeingRedeemed === 0n;
  const crBeforeBps = crBps(state.collateralSats, state.borrowedAmount, price);
  if (close) {
    return { close, newDebtCents: 0n, newCollateralSats: 0n, crBeforeBps, crAfterBps: Number.POSITIVE_INFINITY };
  }
  const newDebtCents = state.borrowedAmount - d.repayCents;
  const newCollateralSats = state.collateralSats + d.collateralDeltaSats;
  if (newDebtCents < MIN_DEBT_CENTS) throw new Error('Remaining debt below the 100.00 PUSD minimum');
  if (newCollateralSats < PARYON_DUST) throw new Error('Collateral too low');
  if (!satisfiesParyonMinimum(newCollateralSats, newDebtCents, price)) {
    throw new Error(`Collateral ratio would fall below 110% (max debt ${formatPusd(maxBorrowCents(newCollateralSats, price))} PUSD)`);
  }
  if (state.amountBeingRedeemed > 0n && d.collateralDeltaSats < 0n) {
    throw new Error('Cannot withdraw collateral during a pending redemption');
  }
  return {
    close,
    newDebtCents,
    newCollateralSats,
    newLoanCommitment: manageLoanCommitment(commitment, newDebtCents, d.interestManagerConfiguration),
    crBeforeBps,
    crAfterBps: crBps(newCollateralSats, newDebtCents, price),
  };
}

/**
 * Paryon outputs 0..3 of a manage tx that keeps the loan open: price, loan (new value + commitment), sidecar, function.
 * The caller adds output 4 (loanKey recreated at its own locking bytecode) and output 5 (burn) if repaying.
 */
export function manageParyonOutputs(ctx: ParyonContext, live: ManageLiveState, outcome: ManageOutcome): Output[] {
  if (outcome.close || !outcome.newLoanCommitment) throw new Error('manageParyonOutputs is for the open-loan layout');
  const c = ctx.contracts;
  const loanToken = live.loan.loan.token!;
  return [
    recreateOutput(live.price.utxo, live.price.contract.lockingBytecode),
    {
      to: bin(c.loan.lockingBytecode),
      amount: outcome.newCollateralSats,
      token: { category: loanToken.category, amount: 0n, nft: { capability: 'mutable', commitment: outcome.newLoanCommitment } },
    },
    recreateOutput(live.loan.sidecar, c.loanSidecar.lockingBytecode, { amount: PARYON_DUST }),
    recreateOutput(live.manageFn, c.loanFunctions.manage.lockingBytecode, { amount: PARYON_DUST }),
  ];
}

/** Paryon outputs 0..3 of a manage tx that closes the loan: price, function, PUSD burn, loan NFT burn. */
export function manageCloseOutputs(ctx: ParyonContext, live: ManageLiveState, repayCents: bigint): Output[] {
  const c = ctx.contracts;
  const paryon = ctx.deployment.tokenIds.paryonTokenId;
  return [
    recreateOutput(live.price.utxo, live.price.contract.lockingBytecode),
    recreateOutput(live.manageFn, c.loanFunctions.manage.lockingBytecode, { amount: PARYON_DUST }),
    pusdBurnOutput(paryon, repayCents),
    loanNftBurnOutput(paryon, live.loan.commitment),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// LoanKeyFactory.create
// ---------------------------------------------------------------------------------------------------------------

export interface CreateLoanKeyParams {
  wallet: FundingWallet;
  /** Pre-fetched factory UTXO (otherwise fetched). */
  factory?: Utxo;
  /** Where the authhead (output 0, no tokens) goes; default the wallet. */
  authHeadDestination?: Destination;
  feeRate?: number;
}

export interface CreateLoanKeyResult extends ParyonBuiltTx {
  /** New loanKey category = txid of the wallet's vout-0 input. */
  loanKeyCategory: string;
}

/**
 * Inputs: 0 wallet vout-0 UTXO, 1 LoanKeyFactory, 2.. wallet BCH
 * Outputs: 0 authhead, 1 LoanKeyFactory, 2 LoanKeyOriginEnforcer (loanKey minting), 3 LoanKeyOriginProof, 4 change
 */
export async function buildCreateLoanKey(ctx: ParyonContext, p: CreateLoanKeyParams): Promise<CreateLoanKeyResult> {
  const c = ctx.contracts;
  const factory = p.factory ?? (await findLoanKeyFactoryUtxo(ctx.provider, c));
  const vout0 = p.wallet.utxos.find((u) => u.vout === 0 && !u.token);
  if (!vout0) throw new Error('Wallet needs a pure-BCH UTXO at output index 0 (send some BCH to yourself first)');
  const loanKeyCategory = vout0.txid;
  const unlocker = walletUnlocker(p.wallet);
  const outsValue = 1000n + PARYON_DUST * 3n;
  const extra = vout0.satoshis >= outsValue + FEE_MARGIN ? [] : selectBch(p.wallet.utxos, outsValue + FEE_MARGIN - vout0.satoshis, [vout0]);

  const builder = newBuilder(ctx)
    .addInput(vout0, unlocker)
    .addInput(factory, c.loanKeyFactory.unlock.create())
    .addInputs(extra, unlocker)
    .addOutput({ to: p.authHeadDestination ?? p.wallet.address, amount: 1000n })
    .addOutput(recreateOutput(factory, c.loanKeyFactory.lockingBytecode, { amount: PARYON_DUST }))
    .addOutput({
      to: bin(c.loanKeyOriginEnforcer.lockingBytecode),
      amount: PARYON_DUST,
      token: { category: loanKeyCategory, amount: 0n, nft: { capability: 'minting', commitment: '' } },
    })
    .addOutput({
      to: bin(c.loanKeyOriginProof.lockingBytecode),
      amount: PARYON_DUST,
      token: { category: ctx.deployment.tokenIds.loanKeyFactoryTokenId, amount: 0n, nft: { capability: 'none', commitment: '' } },
    })
    .addBchChangeOutputIfNeeded({ to: p.wallet.address, feeRate: p.feeRate ?? DEFAULT_FEE_RATE });

  const built = finalizeBuiltTx(builder, ctx, `Create Paryon loan key ${loanKeyCategory.slice(0, 8)}…`, {
    loanKeyCategory,
    changeAddresses: [p.wallet.address],
  });
  return { ...built, loanKeyCategory };
}

// ---------------------------------------------------------------------------------------------------------------
// Borrowing.borrow
// ---------------------------------------------------------------------------------------------------------------

export interface BorrowParams {
  loanKeyCategory: string;
  borrowCents: bigint;
  collateralSats: bigint;
  /** Starting interest rate as Paryon encodes it (bytes2 script number). */
  startingInterestRate: number;
  interestManagerConfiguration?: string;
  /** Funds collateral + fees; receives change. */
  wallet: FundingWallet;
  /** Output 5: the loanKey (minting NFT). For a vault: the vault address. */
  loanKeyDestination: Destination;
  /** Output 6: the borrowed PUSD. */
  pusdDestination: Destination;
  live?: { price?: LivePrice; borrowing?: LiveBorrowing; origin?: LoanKeyOrigin };
  feeRate?: number;
}

/**
 * Inputs: 0 Borrowing, 1 PriceContract, 2 LoanKeyOriginEnforcer, 3 LoanKeyOriginProof, 4.. wallet BCH (collateral)
 * Outputs: 0 Borrowing, 1 PriceContract, 2 Loan, 3 LoanSidecar, 4 borrowing fee, 5 loanKey, 6 PUSD, 7 change
 */
export async function buildBorrow(ctx: ParyonContext, p: BorrowParams): Promise<ParyonBuiltTx> {
  const c = ctx.contracts;
  const paryon = ctx.deployment.tokenIds.paryonTokenId;
  const imc = p.interestManagerConfiguration ?? NO_INTEREST_MANAGER;
  const [price, borrowing, origin] = await Promise.all([
    p.live?.price ?? findPriceUtxo(ctx.provider, c),
    p.live?.borrowing ?? findBorrowingUtxo(ctx.provider, c, p.borrowCents),
    p.live?.origin ?? findLoanKeyOrigin(ctx.provider, c, p.loanKeyCategory),
  ]);
  if (p.borrowCents < MIN_DEBT_CENTS) throw new Error('Minimum borrow is 100.00 PUSD');
  const maxBorrow = maxBorrowCents(p.collateralSats, price.priceCents);
  if (p.borrowCents > maxBorrow) {
    throw new Error(`Borrow ${formatPusd(p.borrowCents)} PUSD exceeds max ${formatPusd(maxBorrow)} PUSD for this collateral`);
  }
  const fee = borrowingFeeSats(p.borrowCents, price.priceCents);
  const supply = borrowing.utxo.token!.amount;
  const loanCommitment = borrowLoanCommitment({
    borrowedAmount: p.borrowCents,
    periodBorrowingHex: borrowing.periodBorrowingHex,
    startingInterestRate: p.startingInterestRate,
    interestManagerConfiguration: imc,
  });

  // Paryon outputs need collateral + fee + 2 x 1000 (key, PUSD) + 1000 (sidecar); enforcer+proof bring 2000.
  const walletNeed = p.collateralSats + fee + PARYON_DUST + FEE_MARGIN;
  const funding = selectBch(p.wallet.utxos, walletNeed);
  const unlocker = walletUnlocker(p.wallet);

  const builder = newBuilder(ctx)
    .addInput(borrowing.utxo, c.borrowing.unlock.borrow(bin(encodeScriptNumPaddedHex(p.startingInterestRate, 2)), bin(imc)))
    .addInput(price.utxo, price.contract.unlock.sharePrice())
    .addInput(origin.enforcer, c.loanKeyOriginEnforcer.unlock.enforce())
    .addInput(origin.proof, c.loanKeyOriginProof.unlock.attach())
    .addInputs(funding, unlocker)
    .addOutput(
      recreateOutput(borrowing.utxo, c.borrowing.lockingBytecode, {
        amount: PARYON_DUST,
        token: { ...borrowing.utxo.token!, amount: supply - p.borrowCents },
      }),
    )
    .addOutput(recreateOutput(price.utxo, price.contract.lockingBytecode))
    .addOutput({
      to: bin(c.loan.lockingBytecode),
      amount: p.collateralSats,
      token: { category: paryon, amount: 0n, nft: { capability: 'mutable', commitment: loanCommitment } },
    })
    .addOutput({
      to: bin(c.loanSidecar.lockingBytecode),
      amount: PARYON_DUST,
      token: { category: p.loanKeyCategory, amount: 0n, nft: { capability: 'none', commitment: '01' } },
    })
    .addOutput({ to: bin(ctx.deployment.contractParams.protocolFeeLockingBytecode), amount: fee })
    .addOutput({
      to: p.loanKeyDestination,
      amount: PARYON_DUST,
      token: { category: p.loanKeyCategory, amount: 0n, nft: { capability: 'minting', commitment: '' } },
    })
    .addOutput({ to: p.pusdDestination, amount: PARYON_DUST, token: { category: paryon, amount: p.borrowCents } })
    .addBchChangeOutputIfNeeded({ to: p.wallet.address, feeRate: p.feeRate ?? DEFAULT_FEE_RATE });

  const cr = crBps(p.collateralSats, p.borrowCents, price.priceCents);
  return finalizeBuiltTx(
    builder,
    ctx,
    `Borrow ${formatPusd(p.borrowCents)} PUSD against ${formatBch(p.collateralSats)} (CR ${formatBps(cr)}, fee ${fee} sats)`,
    { loanKeyCategory: p.loanKeyCategory, changeAddresses: [p.wallet.address] },
  );
}

// ---------------------------------------------------------------------------------------------------------------
// manage
// ---------------------------------------------------------------------------------------------------------------

export interface ManageParams {
  loanKeyCategory: string;
  /** Input 4. A wallet-held key: `{ utxo, unlocker: walletUnlocker(wallet) }`; a vault key: the vault unlocker. */
  loanKey: SpendableInput;
  repayCents?: bigint;
  /** + adds collateral from the wallet, - withdraws collateral to the wallet's change. */
  collateralDeltaSats?: bigint;
  /** Default: keep the loan's current configuration. */
  interestManagerConfiguration?: string;
  /** Pays fees, provides added collateral and repay PUSD, receives change. */
  wallet: FundingWallet;
  live?: ManageLiveState;
  feeRate?: number;
}

/**
 * Open loan — Inputs: 0 price, 1 loan, 2 sidecar, 3 manage, 4 loanKey, 5.. wallet BCH, then wallet PUSD
 *             Outputs: 0 price, 1 loan, 2 sidecar, 3 manage, 4 loanKey, 5 PUSD burn (if repay), token change, BCH change
 * Close     — Outputs: 0 price, 1 manage, 2 PUSD burn, 3 loan NFT burn, 4 loanKey (back to its script), token change, BCH change
 */
export async function buildManage(ctx: ParyonContext, p: ManageParams): Promise<ParyonBuiltTx> {
  const live = p.live ?? (await fetchManageContext(ctx.provider, ctx.contracts, p.loanKeyCategory));
  const paryon = ctx.deployment.tokenIds.paryonTokenId;
  const repayCents = p.repayCents ?? 0n;
  const delta = p.collateralDeltaSats ?? 0n;
  const imc = p.interestManagerConfiguration ?? decodeLoanCommitment(live.loan.commitment).interestManagerConfiguration;
  const outcome = planManage(live, { repayCents, collateralDeltaSats: delta, interestManagerConfiguration: imc });

  const keyUtxo = p.loanKey.utxo;
  if (keyUtxo.token?.category !== p.loanKeyCategory || keyUtxo.token.nft?.capability !== 'minting') {
    throw new Error('loanKey input must be the minting NFT of the loanKey category');
  }
  const keyBytecode = p.loanKey.unlocker.generateLockingBytecode();

  const tokenInputs = repayCents > 0n ? selectTokens(p.wallet.utxos, paryon, repayCents) : [];
  const tokenChange = tokenInputs.reduce((s, u) => s + u.token!.amount, 0n) > repayCents;
  const tokenInputSats = tokenInputs.reduce((s, u) => s + u.satoshis, 0n);
  // delta is signed: a withdrawal (negative) pays for the fee itself.
  const bchNeed = delta + (tokenChange ? PARYON_DUST : 0n) + FEE_MARGIN - tokenInputSats;
  const bchInputs = bchNeed > 0n ? selectBch(p.wallet.utxos, bchNeed) : [];
  const unlocker = walletUnlocker(p.wallet);

  const builder = addManageParyonInputs(newBuilder(ctx), ctx, live, { repayCents, interestManagerConfiguration: imc })
    .addInput(keyUtxo, p.loanKey.unlocker)
    .addInputs(bchInputs, unlocker)
    .addInputs(tokenInputs, unlocker);

  if (outcome.close) {
    builder.addOutputs(manageCloseOutputs(ctx, live, repayCents));
    builder.addOutput(recreateOutput(keyUtxo, keyBytecode));
  } else {
    builder.addOutputs(manageParyonOutputs(ctx, live, outcome));
    builder.addOutput(recreateOutput(keyUtxo, keyBytecode));
    if (repayCents > 0n) builder.addOutput(pusdBurnOutput(paryon, repayCents));
  }
  if (tokenChange) builder.addTokenChangeOutputIfNeeded({ category: paryon, to: p.wallet.address });
  builder.addBchChangeOutputIfNeeded({ to: p.wallet.address, feeRate: p.feeRate ?? DEFAULT_FEE_RATE });

  const parts: string[] = [];
  if (repayCents > 0n) parts.push(`repay ${formatPusd(repayCents)} PUSD`);
  if (delta > 0n) parts.push(`add ${formatBch(delta)}`);
  if (delta < 0n) parts.push(`withdraw ${formatBch(-delta)}`);
  const summary = outcome.close
    ? `Close loan: repay ${formatPusd(repayCents)} PUSD, collateral ${formatBch(live.loan.state.collateralSats)} returned`
    : `Manage loan: ${parts.join(', ') || 'no change'} (CR ${formatBps(outcome.crBeforeBps)} → ${formatBps(outcome.crAfterBps)})`;
  return finalizeBuiltTx(builder, ctx, summary, {
    loanKeyCategory: p.loanKeyCategory,
    changeAddresses: [p.wallet.address],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// changeInterest
// ---------------------------------------------------------------------------------------------------------------

/** Add the Paryon side of a changeInterest tx: inputs 0 loan, 1 sidecar, 2 changeInterest function. */
export function addChangeInterestParyonInputs(
  builder: TransactionBuilder,
  ctx: ParyonContext,
  live: { loan: LoanPair; fn: Utxo },
  nextInterestRate: number,
): TransactionBuilder {
  const c = ctx.contracts;
  return builder
    .addInput(live.loan.loan, c.loan.unlock.interact())
    .addInput(live.loan.sidecar, c.loanSidecar.unlock.attach())
    .addInput(live.fn, c.loanFunctions.changeInterest.unlock.changeInterest(bin(encodeScriptNumPaddedHex(nextInterestRate, 2))));
}

/** Paryon outputs 0..2 of a changeInterest tx (the caller adds output 3: the loanKey recreated). */
export function changeInterestParyonOutputs(ctx: ParyonContext, live: { loan: LoanPair; fn: Utxo }, nextInterestRate: number): Output[] {
  const c = ctx.contracts;
  const loanToken = live.loan.loan.token!;
  return [
    {
      to: bin(c.loan.lockingBytecode),
      amount: live.loan.loan.satoshis,
      token: {
        category: loanToken.category,
        amount: 0n,
        nft: { capability: 'mutable', commitment: changeInterestLoanCommitment(live.loan.commitment, nextInterestRate) },
      },
    },
    recreateOutput(live.loan.sidecar, c.loanSidecar.lockingBytecode, { amount: PARYON_DUST }),
    recreateOutput(live.fn, c.loanFunctions.changeInterest.lockingBytecode, { amount: PARYON_DUST }),
  ];
}

export interface ChangeInterestParams {
  loanKeyCategory: string;
  loanKey: SpendableInput;
  nextInterestRate: number;
  wallet: FundingWallet;
  live?: { loan: LoanPair; fn: Utxo };
  feeRate?: number;
}

/**
 * Inputs: 0 loan, 1 sidecar, 2 changeInterest, 3 loanKey, 4.. wallet BCH
 * Outputs: 0 loan, 1 sidecar, 2 changeInterest, 3 loanKey, 4 change
 */
export async function buildChangeInterest(ctx: ParyonContext, p: ChangeInterestParams): Promise<ParyonBuiltTx> {
  if (!Number.isInteger(p.nextInterestRate) || p.nextInterestRate < 0 || p.nextInterestRate > 0x7fff) {
    throw new Error('nextInterestRate must be an integer in 0..32767');
  }
  const live =
    p.live ??
    {
      loan: await findLoanPair(ctx.provider, ctx.contracts, p.loanKeyCategory),
      fn: await findChangeInterestUtxo(ctx.provider, ctx.contracts),
    };
  const keyBytecode = p.loanKey.unlocker.generateLockingBytecode();
  const builder = addChangeInterestParyonInputs(newBuilder(ctx), ctx, live, p.nextInterestRate)
    .addInput(p.loanKey.utxo, p.loanKey.unlocker)
    .addInputs(selectBch(p.wallet.utxos, FEE_MARGIN), walletUnlocker(p.wallet))
    .addOutputs(changeInterestParyonOutputs(ctx, live, p.nextInterestRate))
    .addOutput(recreateOutput(p.loanKey.utxo, keyBytecode))
    .addBchChangeOutputIfNeeded({ to: p.wallet.address, feeRate: p.feeRate ?? DEFAULT_FEE_RATE });
  return finalizeBuiltTx(
    builder,
    ctx,
    `Change next interest rate ${live.loan.state.nextInterestRate} → ${p.nextInterestRate}`,
    { loanKeyCategory: p.loanKeyCategory, changeAddresses: [p.wallet.address] },
  );
}
