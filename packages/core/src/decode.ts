/**
 * Decode an (unsigned) tx into labelled inputs/outputs and run the policy checks locally.
 * Used by the signer view, the keeper preview and every builder's `BuiltTx.decoded`.
 * The checks are advisory (the covenant enforces); they show the signer what the tx does.
 */
import { binToHex, decodeTransaction, hexToBin, type TransactionCommon } from '@bitauth/libauth';
import { MockNetworkProvider } from 'cashscript';
import type { DecodedIo, DecodedTx, IoLabel, NetworkName, ParyonDeployment, Payee, PolicyCheck, VaultParams, VaultPolicy } from './types.js';
import { buildParyonContracts, paryonBytecodeNames, type ParyonContracts } from './paryon/contracts.js';
import { decodeLoanCommitment, decodePriceCommitment, isLoanCommitment, isPriceCommitment } from './paryon/codec.js';
import { BURN_LOCKING_BYTECODE_HEX, LOAN_FUNCTION_NAME } from './paryon/constants.js';
import { crAtLeast, crBps, isLiquidatable, satisfiesParyonMinimum } from './health.js';
import { addressToLockingBytecodeHex, formatBch, formatBps, formatPusd, lockingBytecodeToAddress } from './util.js';

/** Minimal libauth-style source output (what cashscript's WcSourceOutput and libauth's Output both satisfy). */
export interface SourceOutputLike {
  lockingBytecode: Uint8Array;
  valueSatoshis: bigint;
  token?: {
    amount: bigint;
    category: Uint8Array;
    nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: Uint8Array };
  };
}

export interface DecodeVaultContext {
  params: VaultParams;
  /** Vault covenant locking bytecode (hex); KeyUTXO, StateUTXO and PusdUTXO share it. */
  lockingBytecode: string;
  /** Policy before the tx. If absent and `decodePolicy` is given, it is decoded from the StateUTXO input. */
  policy?: VaultPolicy;
  /** State codec from src/vault (52-byte commitment -> VaultPolicy). */
  decodePolicy?: (commitmentHex: string) => VaultPolicy;
  /** Vault display name, e.g. "Treasury". */
  name?: string;
}

export interface DecodeContext {
  network: NetworkName;
  deployment: ParyonDeployment;
  contracts?: ParyonContracts;
  /** loanKey category of the loan concerned (defaults to vault.params.loanKeyCategory). */
  loanKeyCategory?: string;
  vault?: DecodeVaultContext;
  payees?: Payee[];
  /** Addresses (or locking bytecode hex) considered change of the party building the tx. */
  changeAddresses?: string[];
  /** Keeper wallet addresses (or locking bytecode hex). */
  keeperAddresses?: string[];
  /** Fallback price if the tx has no PriceContract input. */
  priceCents?: bigint;
  /** Fee above which the fee check fails. Default 20_000 sats. */
  maxFeeSats?: bigint;
}

interface IoView {
  index: number;
  lockingBytecode: string;
  sats: bigint;
  category?: string;
  capability?: 'none' | 'mutable' | 'minting';
  commitment?: string;
  tokenAmount: bigint;
}

const toView = (o: SourceOutputLike, index: number): IoView => ({
  index,
  lockingBytecode: binToHex(o.lockingBytecode),
  sats: o.valueSatoshis,
  category: o.token ? binToHex(o.token.category) : undefined,
  capability: o.token?.nft?.capability,
  commitment: o.token?.nft ? binToHex(o.token.nft.commitment) : undefined,
  tokenAmount: o.token?.amount ?? 0n,
});

const toBytecodeHex = (addrOrHex: string): string =>
  /^[0-9a-f]+$/i.test(addrOrHex) ? addrOrHex.toLowerCase() : addressToLockingBytecodeHex(addrOrHex);

let cachedContracts: { deployment: ParyonDeployment; contracts: ParyonContracts } | undefined;
function contractsFor(ctx: DecodeContext): ParyonContracts {
  if (ctx.contracts) return ctx.contracts;
  if (cachedContracts?.deployment === ctx.deployment) return cachedContracts.contracts;
  const contracts = buildParyonContracts(ctx.deployment, new MockNetworkProvider());
  cachedContracts = { deployment: ctx.deployment, contracts };
  return contracts;
}

export function decodeTx(
  txOrHex: TransactionCommon | string,
  sourceOutputs: SourceOutputLike[],
  ctx: DecodeContext,
): DecodedTx {
  const tx = typeof txOrHex === 'string' ? decodeTransaction(hexToBin(txOrHex)) : txOrHex;
  if (typeof tx === 'string') throw new Error(`Cannot decode transaction: ${tx}`);
  if (sourceOutputs.length !== tx.inputs.length) throw new Error('sourceOutputs must match the inputs');

  const contracts = contractsFor(ctx);
  const names = paryonBytecodeNames(contracts);
  const paryon = ctx.deployment.tokenIds.paryonTokenId;
  const loanKeyCategory = ctx.loanKeyCategory ?? ctx.vault?.params.loanKeyCategory;
  const vaultLb = ctx.vault?.lockingBytecode.toLowerCase();
  const payees = new Map((ctx.payees ?? []).map((p) => [addressToLockingBytecodeHex(p.address), p]));
  const change = new Set((ctx.changeAddresses ?? []).map(toBytecodeHex));
  const keepers = new Set((ctx.keeperAddresses ?? []).map(toBytecodeHex));

  const ins = sourceOutputs.map(toView);
  const outs = tx.outputs.map(toView);

  const classify = (v: IoView): { label: IoLabel; name: string } => {
    const lb = v.lockingBytecode;
    if (lb.startsWith(BURN_LOCKING_BYTECODE_HEX)) {
      if (v.category === paryon && v.capability === 'mutable') return { label: 'burn', name: 'Burn closed loan NFT' };
      if (v.category === paryon && v.tokenAmount > 0n) return { label: 'burn', name: `Burn ${formatPusd(v.tokenAmount)} PUSD (repay)` };
      return { label: 'burn', name: 'OP_RETURN' };
    }
    if (v.category === paryon) {
      if (v.capability === 'mutable' && isPriceCommitment(v.commitment) && (lb === contracts.price.lockingBytecode || lb === contracts.priceGuarded.lockingBytecode)) {
        const p = decodePriceCommitment(v.commitment!);
        return { label: 'paryon-price', name: `Paryon price ${formatPusd(p.priceCents)} PUSD/BCH` };
      }
      if (v.capability === 'mutable' && isLoanCommitment(v.commitment) && lb === contracts.loan.lockingBytecode) {
        const l = decodeLoanCommitment(v.commitment!);
        return { label: 'paryon-loan', name: `Paryon loan (debt ${formatPusd(l.borrowedAmount)} PUSD, ${formatBch(v.sats)})` };
      }
      if (v.capability === 'minting' && lb === contracts.borrowing.lockingBytecode) return { label: 'paryon-borrowing', name: 'Paryon Borrowing' };
      if (v.capability === 'none' && v.commitment?.length === 2) {
        const fn = LOAN_FUNCTION_NAME[parseInt(v.commitment, 16)];
        return { label: 'paryon-function', name: `Paryon ${fn ?? 'unknown'} function` };
      }
    }
    if (vaultLb && lb === vaultLb) {
      const vname = ctx.vault?.name ?? 'Vault';
      if (v.category === ctx.vault!.params.stateCategory) return { label: 'vault-state', name: `${vname} state` };
      if (v.category === loanKeyCategory && v.capability === 'minting') return { label: 'vault-key', name: `${vname} loan key` };
      if (v.category === paryon && !v.capability) return { label: 'vault-pusd', name: `${vname} PUSD buffer` };
      return { label: 'vault-state', name: `${vname} (other UTXO)` };
    }
    if (lb === contracts.loanSidecar.lockingBytecode) return { label: 'paryon-sidecar', name: 'Paryon loan sidecar' };
    if (lb === ctx.deployment.contractParams.protocolFeeLockingBytecode) return { label: 'fee', name: 'Paryon borrowing fee' };
    const payee = payees.get(lb);
    if (payee) return { label: 'payee', name: payee.label };
    if (keepers.has(lb)) return { label: 'keeper', name: 'Keeper' };
    if (change.has(lb)) {
      if (v.category === loanKeyCategory && v.capability === 'minting') return { label: 'change', name: 'Loan key (to wallet)' };
      return { label: 'change', name: v.category === paryon ? 'PUSD (to wallet)' : 'Change' };
    }
    const known = names.get(lb);
    if (known) return { label: 'unknown', name: known };
    if (v.category === loanKeyCategory && v.capability === 'minting') return { label: 'unknown', name: 'Loan key' };
    return { label: 'unknown', name: 'Unknown destination' };
  };

  const toIo = (v: IoView): DecodedIo => {
    const { label, name } = classify(v);
    const io: DecodedIo = { index: v.index, label, name, sats: v.sats };
    const address = lockingBytecodeToAddress(v.lockingBytecode, ctx.network, !!v.category);
    if (address) io.address = address;
    if (v.category) io.tokenCategory = v.category;
    if (v.category && v.tokenAmount > 0n) io.tokenAmount = v.tokenAmount;
    if (v.commitment !== undefined) io.nftCommitment = v.commitment;
    return io;
  };

  const inputs = ins.map(toIo);
  const outputs = outs.map(toIo);
  const feeSats = ins.reduce((s, v) => s + v.sats, 0n) - outs.reduce((s, v) => s + v.sats, 0n);
  const checks: PolicyCheck[] = [];

  // --- price + loan before/after ---
  const priceIn = ins.find((v, i) => inputs[i]!.label === 'paryon-price');
  const price = priceIn ? decodePriceCommitment(priceIn.commitment!).priceCents : ctx.priceCents;
  const loanIn = ins.find((v, i) => inputs[i]!.label === 'paryon-loan');
  const loanOut = outs.find((v, i) => outputs[i]!.label === 'paryon-loan');
  const fnIn = inputs.find((io) => io.label === 'paryon-function');
  const fnName = fnIn?.nftCommitment ? LOAN_FUNCTION_NAME[parseInt(fnIn.nftCommitment, 16)] : undefined;
  const debtIn = loanIn ? decodeLoanCommitment(loanIn.commitment!).borrowedAmount : undefined;
  const debtOut = loanOut ? decodeLoanCommitment(loanOut.commitment!).borrowedAmount : undefined;

  const policy = ctx.vault?.policy ?? decodeVaultPolicyFromInputs(ctx, ins, inputs);

  if (price !== undefined && loanOut && debtOut !== undefined) {
    const crAfter = crBps(loanOut.sats, debtOut, price);
    if (loanIn && debtIn !== undefined) {
      const crBefore = crBps(loanIn.sats, debtIn, price);
      checks.push({ id: 'cr-before', ok: !isLiquidatable(loanIn.sats, debtIn, price), text: `Loan CR before: ${formatBps(crBefore)}` });
    }
    checks.push({
      id: 'cr-after-paryon',
      ok: satisfiesParyonMinimum(loanOut.sats, debtOut, price),
      text: `Loan CR after: ${formatBps(crAfter)} (Paryon minimum 110%)`,
    });
    if (policy) {
      checks.push({
        id: 'cr-after-target',
        ok: crAtLeast(loanOut.sats, debtOut, price, policy.targetCrBps),
        text: `CR after ${formatBps(crAfter)} vs vault target ${formatBps(policy.targetCrBps)}`,
      });
    }
  } else if (loanIn && !loanOut && fnName === 'manage') {
    checks.push({ id: 'loan-closed', ok: true, text: 'Loan is closed by this tx (debt fully repaid)' });
  }

  // --- allowlist: every output must be recognised ---
  const unknownOuts = outputs.filter((o) => o.label === 'unknown');
  if (ctx.vault || ctx.payees) {
    checks.push({
      id: 'allowlist',
      ok: unknownOuts.length === 0,
      text:
        unknownOuts.length === 0
          ? 'All outputs go to Paryon, the vault, an allowed payee, a burn, or change'
          : `Outputs not on the allowlist: ${unknownOuts.map((o) => `#${o.index} ${o.name}`).join(', ')}`,
    });
  }

  // --- payments: per-payment limit and daily budget ---
  const payments = outputs.filter((o) => o.label === 'payee');
  const paymentAmount = (o: DecodedIo) => (o.tokenCategory === paryon && o.tokenAmount ? o.tokenAmount : o.sats);
  if (policy && payments.length > 0) {
    const total = payments.reduce((s, o) => s + paymentAmount(o), 0n);
    for (const o of payments) {
      const amt = paymentAmount(o);
      checks.push({
        id: `per-payment-${o.index}`,
        ok: amt <= policy.perPaymentMax,
        text: `Payment to ${o.name}: ${amt} ≤ per-payment max ${policy.perPaymentMax}`,
      });
    }
    const day = Math.floor(tx.locktime / 144);
    const spent = (day === policy.dayIndex ? policy.spentToday : 0n) + total;
    checks.push({
      id: 'daily-budget',
      ok: spent <= policy.dailyBudget,
      text: `Spent today after this payment: ${spent} of ${policy.dailyBudget} (day ${day})`,
    });
  }

  // --- vault custody summary ---
  if (vaultLb) {
    const sum = (vs: IoView[], pick: (v: IoView) => bigint) => vs.filter((v) => v.lockingBytecode === vaultLb).reduce((s, v) => s + pick(v), 0n);
    const pusdOf = (v: IoView) => (v.category === paryon && !v.capability ? v.tokenAmount : 0n);
    const bchIn = sum(ins, (v) => v.sats);
    const bchOut = sum(outs, (v) => v.sats);
    const pusdIn = sum(ins, pusdOf);
    const pusdOut = sum(outs, pusdOf);
    const keyIn = inputs.some((io) => io.label === 'vault-key');
    const keyOut = outputs.some((io) => io.label === 'vault-key');
    checks.push({
      id: 'vault-key-kept',
      ok: !keyIn || keyOut,
      text: keyIn ? (keyOut ? 'Loan key stays in the vault' : 'Loan key LEAVES the vault') : 'Loan key not used',
    });
    checks.push({
      id: 'vault-flows',
      ok: true,
      text: `Vault BCH ${formatBch(bchIn)} → ${formatBch(bchOut)}; PUSD ${formatPusd(pusdIn)} → ${formatPusd(pusdOut)}`,
    });
  }

  const maxFee = ctx.maxFeeSats ?? 20_000n;
  checks.push({ id: 'fee', ok: feeSats >= 0n && feeSats <= maxFee, text: `Miner fee ${feeSats} sats` });

  return { title: makeTitle(), inputs, outputs, checks, feeSats };

  function makeTitle(): string {
    if (inputs.some((io) => io.label === 'paryon-borrowing') && debtOut !== undefined) {
      return `Borrow ${formatPusd(debtOut)} PUSD against ${formatBch(loanOut!.sats)}`;
    }
    if (ins.some((v) => v.category === ctx.deployment.tokenIds.loanKeyFactoryTokenId && v.capability === 'minting')) {
      return 'Create Paryon loan key';
    }
    if (fnName === 'manage' && loanIn && debtIn !== undefined) {
      if (!loanOut) return `Close loan (repay ${formatPusd(debtIn)} PUSD)`;
      const parts: string[] = [];
      if (debtOut! < debtIn) parts.push(`repay ${formatPusd(debtIn - debtOut!)} PUSD`);
      if (loanOut.sats > loanIn.sats) parts.push(`add ${formatBch(loanOut.sats - loanIn.sats)}`);
      if (loanOut.sats < loanIn.sats) parts.push(`withdraw ${formatBch(loanIn.sats - loanOut.sats)}`);
      const who = inputs.some((io) => io.label === 'vault-key') ? 'Vault: ' : '';
      return `${who}Manage loan — ${parts.join(', ') || 'no change'}`;
    }
    if (fnName === 'changeInterest' && loanOut) {
      return `Change next interest rate to ${decodeLoanCommitment(loanOut.commitment!).nextInterestRate}`;
    }
    if (payments.length > 0) {
      const o = payments[0]!;
      const amt = o.tokenCategory === paryon && o.tokenAmount ? `${formatPusd(o.tokenAmount)} PUSD` : formatBch(o.sats);
      return `Pay ${amt} to ${o.name}${payments.length > 1 ? ` (+${payments.length - 1} more)` : ''}`;
    }
    return 'Transaction';
  }
}

function decodeVaultPolicyFromInputs(ctx: DecodeContext, ins: IoView[], inputs: DecodedIo[]): VaultPolicy | undefined {
  const decode = ctx.vault?.decodePolicy;
  if (!decode) return undefined;
  const i = inputs.findIndex((io) => io.label === 'vault-state' && io.tokenCategory === ctx.vault!.params.stateCategory);
  if (i < 0 || ins[i]!.commitment === undefined) return undefined;
  try {
    return decode(ins[i]!.commitment!);
  } catch {
    return undefined;
  }
}
