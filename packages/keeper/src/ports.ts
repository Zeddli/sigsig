/**
 * Ports the keeper needs from the outside world. `@sigsig/core` (builders, reader) and an Electrum
 * adapter implement them; `fake.ts` implements them on in-memory data so the loop runs today.
 *
 * Units follow packages/core/src/types.ts: BCH in sats (bigint), PUSD in cents (bigint), CR in bps.
 */
import type { BuiltTx, Health, VaultParams } from '@sigsig/core';

/** A plain BCH UTXO owned by the keeper's fee wallet (no tokens). Same shape as cashscript's `Utxo`. */
export interface KeeperUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
}

/** Everything a builder needs to add, sign and change-back the keeper's fee input(s). */
export interface KeeperFunding {
  /** P2PKH cashaddr of the fee wallet; change goes back here. */
  address: string;
  /** WIF of the fee wallet. Builders sign the keeper inputs with it (e.g. cashscript `SignatureTemplate`). */
  wif: string;
  /** Spendable, token-free UTXOs of the fee wallet, largest first. */
  utxos: KeeperUtxo[];
}

/** What `decide()` chose for a defend. The builder must produce exactly these loan deltas. */
export interface DefendPlan {
  /** PUSD (cents) burned from the vault's PusdUTXO to repay debt. 0 = no repay leg. */
  repayCents: bigint;
  /** Sats moved from the vault StateUTXO into the loan as collateral. 0 = no collateral leg. */
  addCollateralSats: bigint;
  /** Sats the keeper takes back from the StateUTXO for the network fee (≤ policy.keeperFeeMaxSats). */
  feeClaimSats: bigint;
  /** Expected loan CR after the tx, bps (for logs and builder self-checks). */
  expectedCrBps: number;
  /** True if this defend uses the whole usable buffer without reaching targetCR (covenant's "buffer used up" path). */
  exhaustsBuffer: boolean;
}

/** What `decide()` chose for a skim. */
export interface SkimPlan {
  /** Sats withdrawn from the loan collateral; all of it lands in the StateUTXO minus `feeClaimSats`. */
  withdrawSats: bigint;
  /** Sats the keeper keeps out of the withdrawn amount for the network fee (≤ policy.keeperFeeMaxSats). */
  feeClaimSats: bigint;
  expectedCrBps: number;
}

/** A keeper tx ready for broadcast: `txHex` is fully signed (the keeper inputs signed with `funding.wif`). */
export interface KeeperTx extends BuiltTx {
  txid: string;
}

/**
 * Tx builders from `@sigsig/core` (ARCHITECTURE §3.1 `tx/`), in the keeper's shape.
 * Layouts: docs/01 §3.2 (defend) and §3.3 (skim).
 */
export interface KeeperBuilders {
  buildDefend(vault: VaultParams, health: Health, funding: KeeperFunding, plan: DefendPlan): Promise<KeeperTx>;
  buildSkim(vault: VaultParams, health: Health, funding: KeeperFunding, plan: SkimPlan): Promise<KeeperTx>;
  /**
   * Addresses whose mempool activity means "a tx touching this vault is in flight" (Vault covenant address;
   * optionally the loan address). Used so we never race another keeper or a judge's "Run keeper" click.
   */
  vaultAddresses(vault: VaultParams): Promise<string[]>;
}

export type TxStatus = 'mempool' | 'confirmed' | 'unknown';

/** Chain access the keeper needs beyond VaultReader. Implemented over Electrum/Fulcrum in `electrum.ts`. */
export interface KeeperChain {
  getUtxos(address: string): Promise<KeeperUtxo[]>;
  /** 'unknown' = not in mempool and not mined (dropped, or never seen). */
  getTxStatus(txid: string): Promise<TxStatus>;
  /** Txids of unconfirmed txs touching the address. */
  getMempoolTxids(address: string): Promise<string[]>;
  /** Minimum relay fee rate, sats per byte. */
  getFeeRateSatPerByte(): Promise<number>;
  /** Returns the txid. Must not throw if the tx is already known to the node (treat as success). */
  broadcast(txHex: string): Promise<string>;
}
