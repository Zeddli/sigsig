/**
 * Shared tx-building plumbing: wallets (local key or WizardConnect placeholder), Paryon context, BuiltTx assembly.
 */
import { encodeTransaction, binToHex } from '@bitauth/libauth';
import {
  placeholderP2PKHUnlocker,
  type NetworkProvider,
  type SignatureTemplate,
  TransactionBuilder,
  type Unlocker,
  type Utxo,
  type WcSourceOutput,
} from 'cashscript';
import type { BuiltTx, NetworkName, ParyonDeployment, DecodedTx } from '../types.js';
import { buildParyonContracts, type ParyonContracts } from '../paryon/contracts.js';
import { decodeTx, type DecodeContext } from '../decode.js';
import { addressToLockingBytecodeHex } from '../util.js';

/** Everything a Paryon builder needs: network, deployment, contract instances, provider. */
export interface ParyonContext {
  network: NetworkName;
  deployment: ParyonDeployment;
  contracts: ParyonContracts;
  provider: NetworkProvider;
}

export function createParyonContext(network: NetworkName, deployment: ParyonDeployment, provider: NetworkProvider): ParyonContext {
  return { network, deployment, contracts: buildParyonContracts(deployment, provider), provider };
}

/**
 * A P2PKH wallet that funds a tx. With `signer` the inputs are signed locally (tests, keeper bot); without it they
 * get a placeholder unlocker and the wallet (WizardConnect / XO) signs them from `sourceOutputs`.
 */
export interface FundingWallet {
  /** Token-aware CashAddress (also used for change). */
  address: string;
  /** Spendable UTXOs, in preference order. */
  utxos: Utxo[];
  signer?: SignatureTemplate;
}

export const walletUnlocker = (w: FundingWallet): Unlocker =>
  w.signer ? w.signer.unlockP2PKH() : placeholderP2PKHUnlocker(w.address);

/** An input together with how to unlock it (e.g. the loanKey in a vault: `vault.unlock.adminManage(...)`). */
export interface SpendableInput {
  utxo: Utxo;
  unlocker: Unlocker;
}

export const isPureBch = (u: Utxo) => !u.token;

/** Pure-BCH UTXOs from a wallet, largest first, until `amount` is covered. Throws if not enough. */
export function selectBch(utxos: Utxo[], amount: bigint, exclude: Utxo[] = []): Utxo[] {
  const used = new Set(exclude.map((u) => `${u.txid}:${u.vout}`));
  const pool = utxos.filter((u) => isPureBch(u) && !used.has(`${u.txid}:${u.vout}`)).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1));
  const picked: Utxo[] = [];
  let sum = 0n;
  for (const u of pool) {
    if (sum >= amount) break;
    picked.push(u);
    sum += u.satoshis;
  }
  if (sum < amount) throw new Error(`Insufficient BCH: need ${amount} sats, wallet has ${sum} spendable`);
  return picked;
}

/** Fungible UTXOs of `category` (no NFT), largest first, until `amount` is covered. */
export function selectTokens(utxos: Utxo[], category: string, amount: bigint): Utxo[] {
  const pool = utxos
    .filter((u) => u.token?.category === category && !u.token.nft && u.token.amount > 0n)
    .sort((a, b) => (b.token!.amount > a.token!.amount ? 1 : -1));
  const picked: Utxo[] = [];
  let sum = 0n;
  for (const u of pool) {
    if (sum >= amount) break;
    picked.push(u);
    sum += u.token!.amount;
  }
  if (sum < amount) throw new Error(`Insufficient tokens ${category}: need ${amount}, have ${sum}`);
  return picked;
}

/** Bytecode-or-address destination for outputs. */
export type Destination = string | Uint8Array;
export const destinationBytecodeHex = (d: Destination): string =>
  typeof d === 'string' ? addressToLockingBytecodeHex(d) : binToHex(d);

/** Extra BuiltTx fields: the builder (for `.debug()` / `.send()`) and the WC transaction object parts. */
export interface ParyonBuiltTx extends BuiltTx {
  builder: TransactionBuilder;
  sourceOutputs: WcSourceOutput[];
}

export const DEFAULT_FEE_RATE = 1.0;

/** Build the tx (placeholders stay unsigned), produce sourceOutputs (WizardConnect format) and the decoded view. */
export function finalizeBuiltTx(
  builder: TransactionBuilder,
  ctx: ParyonContext,
  summary: string,
  decodeCtx: Partial<DecodeContext> = {},
): ParyonBuiltTx {
  const wc = builder.generateWcTransactionObject();
  const txHex = binToHex(encodeTransaction(wc.transaction));
  const decoded: DecodedTx = decodeTx(wc.transaction, wc.sourceOutputs, {
    network: ctx.network,
    deployment: ctx.deployment,
    contracts: ctx.contracts,
    ...decodeCtx,
  });
  return { txHex, sourceOutputs: wc.sourceOutputs, summary, decoded, builder };
}

export const newBuilder = (ctx: ParyonContext) => new TransactionBuilder({ provider: ctx.provider });
