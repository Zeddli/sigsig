/**
 * Vault covenant transaction builders: defend, skim, pay (BCH or PUSD), plus multisig signature collection.
 * Layouts mirror the header of contracts/Vault.cash; every miner fee is paid from the vault, within keeperFeeMax,
 * so defend/skim need no signature at all and pay needs only the signers' signatures.
 */
import { SignatureTemplate, TransactionBuilder, placeholderSignature, utils, type Output, type Utxo } from 'cashscript';
import {
  hexToBin, binToHex, decodeTransactionUnsafe, generateSigningSerializationBCH, hash256 as libauthHash256,
} from '@bitauth/libauth';
import type { VaultParams, VaultPolicy } from '../types.js';
import { createVaultContract, type VaultContract } from '../vault/contract.js';
import { decodePolicy, encodePolicyHex, paymentAmountSats, policyAfterPayment } from '../vault/state.js';
import { payeeProof, toLockingBytecode } from '../vault/payees.js';
import { fetchManageContext, findPriceUtxo, type LivePrice, type ManageLiveState } from '../paryon/finders.js';
import { addManageParyonInputs, manageParyonOutputs, planManage, pusdBurnOutput, recreateOutput } from './paryon.js';
import { finalizeBuiltTx, type ParyonBuiltTx, type ParyonContext } from './common.js';
import { NO_INTEREST_MANAGER } from '../paryon/constants.js';

/** Bytes the miner fee is computed from (1 sat/byte) plus a safety margin. */
const FEE_MARGIN = 20n;
/** Outputs below this are not created (BCH dust for a P2PKH/P2SH output). */
const DUST = 546n;
/** Fee used only to measure a tx's size (Paryon manage txs are ~8 KB). */
const PROBE_FEE = 30_000n;

export interface VaultUtxoSet {
  state: Utxo;
  key?: Utxo;
  pusd: Utxo[];
}

export interface VaultTxContext extends ParyonContext {
  params: VaultParams;
  vault: VaultContract;
}

export function createVaultTxContext(ctx: ParyonContext, params: VaultParams): VaultTxContext {
  return { ...ctx, params, vault: createVaultContract(params, ctx.provider) };
}

export async function fetchVaultUtxos(ctx: VaultTxContext): Promise<VaultUtxoSet> {
  const utxos = await ctx.provider.getUtxos(ctx.vault.address);
  const p = ctx.params;
  const state = utxos.find((u) => u.token?.category === p.stateCategory && u.token.nft?.capability === 'mutable');
  if (!state) throw new Error('Vault state UTXO not found');
  const key = utxos.find((u) => u.token?.category === p.loanKeyCategory && u.token.nft?.capability === 'minting');
  const pusd = utxos
    .filter((u) => u.token?.category === p.paryonTokenId && !u.token.nft)
    .sort((a, b) => (b.token!.amount > a.token!.amount ? 1 : -1));
  return { state, key, pusd };
}

const decodeCtxOf = (ctx: VaultTxContext) => ({
  vault: { params: ctx.params, lockingBytecode: ctx.vault.lockingBytecode, decodePolicy },
});

const vaultBytes = (ctx: VaultTxContext) => hexToBin(ctx.vault.lockingBytecode);

function stateOutput(ctx: VaultTxContext, sats: bigint, policy: VaultPolicy | string): Output {
  return {
    to: vaultBytes(ctx),
    amount: sats,
    token: {
      category: ctx.params.stateCategory,
      amount: 0n,
      nft: { capability: 'mutable', commitment: typeof policy === 'string' ? policy : encodePolicyHex(policy) },
    },
  };
}

const pusdOutput = (ctx: VaultTxContext, amount: bigint, to: Uint8Array = vaultBytes(ctx)): Output => ({
  to, amount: 1000n, token: { category: ctx.params.paryonTokenId, amount },
});

const sizeOf = (b: TransactionBuilder): bigint => BigInt(hexToBin(b.build()).length);

/**
 * Build twice: first with the fee left to the vault, then with the real miner fee deducted.
 * `assemble(minerFee)` must return a fresh builder.
 */
function withMinerFee(assemble: (minerFee: bigint) => TransactionBuilder, feeCap: bigint): { builder: TransactionBuilder; minerFee: bigint } {
  // size does not depend on the fee value (beyond a varint), so probe with a fee generous enough to pass validation
  const probe = assemble(PROBE_FEE > feeCap ? PROBE_FEE : feeCap);
  const minerFee = sizeOf(probe) + FEE_MARGIN;
  if (minerFee > feeCap) throw new Error(`Miner fee ${minerFee} sats exceeds the vault's keeperFeeMax ${feeCap}`);
  return { builder: assemble(minerFee), minerFee };
}

// ---------------------------------------------------------------------------------------------------------------
// defend / skim (anyone)
// ---------------------------------------------------------------------------------------------------------------

export interface DefendInput {
  /** PUSD to burn from the buffer (0, or >= 100.00 PUSD / the full debt: Paryon's rule) */
  repayCents: bigint;
  /** buffer BCH moved into the loan */
  addCollateralSats: bigint;
  /** total sats taken from the vault for miner fee + keeper reward (<= keeperFeeMax) */
  feeClaimSats: bigint;
  /** where the keeper reward (feeClaim - miner fee) goes; omitted = everything to the miner */
  rewardTo?: string;
}

export interface KeeperTxResult extends ParyonBuiltTx {
  txid: string;
  minerFee: bigint;
}

async function liveManage(ctx: VaultTxContext): Promise<{ live: ManageLiveState; utxos: VaultUtxoSet; policy: VaultPolicy }> {
  const [live, utxos] = await Promise.all([
    fetchManageContext(ctx.provider, ctx.contracts, ctx.params.loanKeyCategory),
    fetchVaultUtxos(ctx),
  ]);
  if (!utxos.key) throw new Error('Vault key UTXO not found');
  return { live, utxos, policy: decodePolicy(utxos.state.token!.nft!.commitment) };
}

function finalizeKeeper(ctx: VaultTxContext, b: TransactionBuilder, summary: string, minerFee: bigint): KeeperTxResult {
  const built = finalizeBuiltTx(b, ctx, summary, decodeCtxOf(ctx));
  const txid = binToHex(utils.hash256(hexToBin(b.build())).reverse());
  return { ...built, txHex: b.build(), txid, minerFee };
}

export async function buildDefend(ctx: VaultTxContext, d: DefendInput): Promise<KeeperTxResult> {
  const { live, utxos, policy } = await liveManage(ctx);
  if (d.feeClaimSats > BigInt(policy.keeperFeeMaxSats)) throw new Error('feeClaimSats exceeds keeperFeeMax');
  const outcome = planManage(live, {
    repayCents: d.repayCents,
    collateralDeltaSats: d.addCollateralSats,
    interestManagerConfiguration: live.loan.state ? interestConfigOf(live) : NO_INTEREST_MANAGER,
  });
  if (outcome.close) throw new Error('defend cannot close the loan');
  const pusdIn = d.repayCents > 0n ? utxos.pusd[0] : undefined;
  if (d.repayCents > 0n && (!pusdIn || pusdIn.token!.amount < d.repayCents)) throw new Error('Not enough PUSD in the buffer');
  const freedPusdSats = pusdIn && pusdIn.token!.amount === d.repayCents ? pusdIn.satoshis : 0n;
  const stateAfter = utxos.state.satoshis + freedPusdSats - d.addCollateralSats - d.feeClaimSats;
  if (stateAfter < 1000n) throw new Error('Buffer BCH too low for this defend');

  const assemble = (minerFee: bigint) => {
    const unlock = ctx.vault.unlock.defend();
    const b = addManageParyonInputs(new TransactionBuilder({ provider: ctx.provider }), ctx, live, {
      repayCents: d.repayCents, interestManagerConfiguration: interestConfigOf(live),
    })
      .addInput(utxos.key!, unlock)
      .addInput(utxos.state, unlock);
    if (pusdIn) b.addInput(pusdIn, unlock);
    b.addOutputs(manageParyonOutputs(ctx, live, outcome));
    b.addOutput(recreateOutput(utxos.key!, ctx.vault.lockingBytecode));
    if (d.repayCents > 0n) b.addOutput(pusdBurnOutput(ctx.params.paryonTokenId, d.repayCents));
    b.addOutput(stateOutput(ctx, stateAfter, policy));
    if (pusdIn && pusdIn.token!.amount > d.repayCents) b.addOutput(pusdOutput(ctx, pusdIn.token!.amount - d.repayCents));
    const reward = d.feeClaimSats - minerFee;
    if (d.rewardTo && reward >= DUST) b.addOutput({ to: d.rewardTo, amount: reward });
    b.setLocktime(0);
    return b;
  };
  const { builder, minerFee } = withMinerFee(assemble, d.feeClaimSats);
  return finalizeKeeper(ctx, builder, `Defend vault: ${describeDefend(d)} (CR ${outcome.crBeforeBps / 100}% → ${outcome.crAfterBps / 100}%)`, minerFee);
}

export interface SkimInput {
  withdrawSats: bigint;
  feeClaimSats: bigint;
  rewardTo?: string;
}

export async function buildSkim(ctx: VaultTxContext, s: SkimInput): Promise<KeeperTxResult> {
  const { live, utxos, policy } = await liveManage(ctx);
  if (s.feeClaimSats > BigInt(policy.keeperFeeMaxSats)) throw new Error('feeClaimSats exceeds keeperFeeMax');
  const outcome = planManage(live, {
    repayCents: 0n, collateralDeltaSats: -s.withdrawSats, interestManagerConfiguration: interestConfigOf(live),
  });
  const assemble = (minerFee: bigint) => {
    const unlock = ctx.vault.unlock.skim();
    const b = addManageParyonInputs(new TransactionBuilder({ provider: ctx.provider }), ctx, live, {
      repayCents: 0n, interestManagerConfiguration: interestConfigOf(live),
    })
      .addInput(utxos.key!, unlock)
      .addInput(utxos.state, unlock);
    b.addOutputs(manageParyonOutputs(ctx, live, outcome));
    b.addOutput(recreateOutput(utxos.key!, ctx.vault.lockingBytecode));
    b.addOutput(stateOutput(ctx, utxos.state.satoshis + s.withdrawSats - s.feeClaimSats, policy));
    const reward = s.feeClaimSats - minerFee;
    if (s.rewardTo && reward >= DUST) b.addOutput({ to: s.rewardTo, amount: reward });
    b.setLocktime(0);
    return b;
  };
  const { builder, minerFee } = withMinerFee(assemble, s.feeClaimSats);
  return finalizeKeeper(ctx, builder, `Skim ${s.withdrawSats} sats of excess collateral into the vault buffer (CR ${outcome.crBeforeBps / 100}% → ${outcome.crAfterBps / 100}%)`, minerFee);
}

function interestConfigOf(live: ManageLiveState): string {
  // the last 5 bytes of the 27-byte loan commitment (interestManager | minRate | maxRate); manage rewrites them
  return live.loan.commitment.slice(-10);
}

const describeDefend = (d: DefendInput) =>
  [d.repayCents > 0n ? `repay ${Number(d.repayCents) / 100} PUSD` : '', d.addCollateralSats > 0n ? `add ${d.addCollateralSats} sats collateral` : '']
    .filter(Boolean).join(' + ');

// ---------------------------------------------------------------------------------------------------------------
// pay (M of 3)
// ---------------------------------------------------------------------------------------------------------------

export type SigSlot = SignatureTemplate | Uint8Array | 'placeholder' | null;

/** Everything needed to rebuild the identical payment tx on every signer's device. */
export interface PaymentRequest {
  params: VaultParams;
  /** payee locking bytecode hex, or address */
  payee: string;
  /** full allowlist (labels are UI-only), needed for the merkle proof */
  payees: string[];
  asset: 'BCH' | 'PUSD';
  /** sats for BCH, cents for PUSD */
  amount: bigint;
  /** block height used as locktime (must be <= tip when broadcast) */
  locktime: number;
  /** which signer slots will sign (1-based) */
  signers: Array<1 | 2 | 3>;
  /** pinned outpoints so every signer builds the same tx */
  stateOutpoint: string;
  pusdOutpoint?: string;
  priceOutpoint?: string;
}

const outpoint = (u: Utxo) => `${u.txid}:${u.vout}`;

/** Create a request from the vault's current UTXOs. */
export async function createPaymentRequest(
  ctx: VaultTxContext,
  r: Omit<PaymentRequest, 'params' | 'stateOutpoint' | 'pusdOutpoint' | 'priceOutpoint' | 'locktime'> & { locktime?: number },
): Promise<PaymentRequest> {
  const utxos = await fetchVaultUtxos(ctx);
  const locktime = r.locktime ?? (await ctx.provider.getBlockHeight());
  const req: PaymentRequest = { ...r, params: ctx.params, locktime, stateOutpoint: outpoint(utxos.state) };
  if (r.asset === 'PUSD') {
    const p = utxos.pusd.find((u) => u.token!.amount >= r.amount);
    if (!p) throw new Error('Not enough PUSD in one buffer UTXO');
    req.pusdOutpoint = outpoint(p);
    req.priceOutpoint = outpoint((await findPriceUtxo(ctx.provider, ctx.contracts)).utxo);
  }
  return req;
}

export interface PaymentTx extends ParyonBuiltTx {
  minerFee: bigint;
  amountSats: bigint;
  policyAfter: VaultPolicy;
}

/** Build the payment. Slots not in `req.signers` get an empty signature; signer slots get `sigs[i]` or a placeholder. */
export async function buildPay(ctx: VaultTxContext, req: PaymentRequest, sigs: Partial<Record<1 | 2 | 3, SigSlot>> = {}): Promise<PaymentTx> {
  const all = await ctx.provider.getUtxos(ctx.vault.address);
  const pick = (op?: string) => {
    const u = op ? all.find((x) => outpoint(x) === op) : undefined;
    if (op && !u) throw new Error(`UTXO ${op} is spent or unknown; create a new request`);
    return u;
  };
  const state = pick(req.stateOutpoint)!;
  const pusd = pick(req.pusdOutpoint);
  let price: LivePrice | undefined;
  if (req.asset === 'PUSD') {
    const live = await findPriceUtxo(ctx.provider, ctx.contracts);
    if (outpoint(live.utxo) !== req.priceOutpoint) throw new Error('Price contract moved since the request; create a new request');
    price = live;
  }
  const policy = decodePolicy(state.token!.nft!.commitment);
  const payeeHex = binToHex(toLockingBytecode(req.payee));
  const proof = payeeProof(req.payees, req.payee);
  const fee = BigInt(policy.keeperFeeMaxSats);
  const priceCents = price ? BigInt(decodePriceCents(price.utxo)) : undefined;

  const slot = (i: 1 | 2 | 3): SignatureTemplate | Uint8Array => {
    if (!req.signers.includes(i)) return new Uint8Array();
    const s = sigs[i];
    if (s === undefined || s === 'placeholder') return placeholderSignature();
    if (s === null) return new Uint8Array();
    return s;
  };

  let policyAfter = policy;
  let amountSats = 0n;
  const assemble = (minerFee: bigint) => {
    const unlock = ctx.vault.unlock.pay(slot(1), slot(2), slot(3), hexToBin(proof));
    const b = new TransactionBuilder({ provider: ctx.provider }).addInput(state, unlock);
    let stateSats: bigint;
    if (req.asset === 'BCH') {
      stateSats = state.satoshis - req.amount - minerFee;
      amountSats = paymentAmountSats({ vaultBchIn: state.satoshis, vaultBchOut: stateSats });
      policyAfter = policyAfterPayment(policy, amountSats, req.locktime);
      b.addOutput({ to: hexToBin(payeeHex), amount: req.amount });
      b.addOutput(stateOutput(ctx, stateSats, policyAfter));
    } else {
      if (!pusd || !price) throw new Error('PUSD payment needs the PUSD buffer and the price contract');
      b.addInput(price.utxo, price.contract.unlock.sharePrice()).addInput(pusd, unlock);
      const left = pusd.token!.amount - req.amount;
      // payee output carries 1000 sats; it comes from the vault, so it counts as BCH that left
      const keepPusdSats = left > 0n ? pusd.satoshis : 0n;
      stateSats = state.satoshis + pusd.satoshis - keepPusdSats - 1000n - minerFee;
      amountSats = paymentAmountSats({
        vaultBchIn: state.satoshis + pusd.satoshis, vaultBchOut: stateSats + keepPusdSats,
        pusdIn: pusd.token!.amount, pusdOut: left, priceCents,
      });
      policyAfter = policyAfterPayment(policy, amountSats, req.locktime);
      b.addOutput(pusdOutput(ctx, req.amount, hexToBin(payeeHex)));
      b.addOutput(recreateOutput(price.utxo, price.contract.lockingBytecode));
      b.addOutput(stateOutput(ctx, stateSats, policyAfter));
      if (left > 0n) b.addOutput(pusdOutput(ctx, left));
    }
    b.setLocktime(req.locktime);
    return b;
  };
  const { builder, minerFee } = withMinerFee(assemble, fee);
  const label = req.asset === 'BCH' ? `${req.amount} sats` : `${Number(req.amount) / 100} PUSD`;
  const built = finalizeBuiltTx(builder, ctx, `Pay ${label} to an allowlisted payee`, decodeCtxOf(ctx));
  return { ...built, minerFee, amountSats, policyAfter };
}

const decodePriceCents = (u: Utxo): number => {
  const c = hexToBin(u.token!.nft!.commitment);
  return new DataView(c.buffer, c.byteOffset + 5, 4).getInt32(0, true);
};

/**
 * Signature hash a signer signs for the vault input 0 of an (unsigned or placeholder-signed) payment tx.
 * The hash covers all inputs' UTXOs and all outputs but no unlocking bytecode, so signers can sign in any order.
 */
export function paymentSighash(ctx: VaultTxContext, built: Pick<PaymentTx, 'txHex' | 'sourceOutputs'>, hashtype: number): Uint8Array {
  const transaction = decodeTransactionUnsafe(hexToBin(built.txHex));
  const preimage = generateSigningSerializationBCH(
    { inputIndex: 0, sourceOutputs: built.sourceOutputs as never, transaction },
    { coveredBytecode: hexToBin(ctx.vault.bytecode), signingSerializationType: Uint8Array.of(hashtype) },
  );
  return libauthHash256(preimage);
}

/** Sign a payment for one slot with a local key (demo signers, tests). Wallet signing produces the same bytes. */
export function signPayment(ctx: VaultTxContext, built: Pick<PaymentTx, 'txHex' | 'sourceOutputs'>, key: SignatureTemplate): Uint8Array {
  return key.generateSignature(paymentSighash(ctx, built, key.getHashType()));
}
