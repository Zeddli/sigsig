import type { BuiltTx } from '@sigsig/core';

export type WalletId = 'wizardconnect' | 'xo';

/** [inputIndex, pathName, addressIndex]: which HD key signs which input (WizardConnect hdwalletv1). */
export type InputPath = [number, string, number];

export interface SignOptions {
  /** Inputs the wallet must sign. Default: every input labelled fee/keeper, plus the vault-state input of a pay. */
  inputPaths?: InputPath[];
  /** Ask the wallet to broadcast (only when this signature completes the tx). */
  broadcast?: boolean;
  signal?: AbortSignal;
}

export interface SignedTx {
  signedTxHex: string;
}

/** What `connect()` hands the UI while pairing (WizardConnect shows a QR the wallet scans). */
export interface Pairing {
  /** human-readable URI (wiz://…), for the deep link and copy */
  uri?: string;
  /** QR-safe URI (WIZ://…) */
  qrUri?: string;
  /** resolves once the wallet has answered and keys are known */
  ready: Promise<void>;
  cancel(): void;
}

export interface Wallet {
  readonly id: WalletId;
  readonly name: string;
  /** True when this build can really use the wallet; false = documented stub (see WALLET.md). */
  readonly available: boolean;
  connect(): Promise<Pairing>;
  getAddress(): Promise<string | null>;
  /** The signer's compressed pubkey (hex), to match a vault signer slot. */
  getPubkey(): Promise<string | null>;
  signTransaction(tx: BuiltTx, opts?: SignOptions): Promise<SignedTx>;
  disconnect(): Promise<void>;
}

export class WalletError extends Error {
  constructor(message: string, readonly code: 'not-connected' | 'rejected' | 'unsupported' | 'failed') {
    super(message);
  }
}

/** Default signing map for a decoded tx: the signer's receive key #0 signs its own inputs and, for a pay, the
 *  vault-state input (a covenant input whose unlocking bytecode carries a 65-byte placeholder signature). */
export function defaultInputPaths(tx: BuiltTx): InputPath[] {
  const isPay = tx.decoded.outputs.some((o) => o.label === 'payee');
  return tx.decoded.inputs
    .filter((i) => i.label === 'fee' || i.label === 'keeper' || (isPay && i.label === 'vault-state'))
    .map((i) => [i.index, 'receive', 0] as InputPath);
}
