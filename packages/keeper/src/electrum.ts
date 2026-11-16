/** KeeperChain over Electrum/Fulcrum, via cashscript's ElectrumNetworkProvider. */
import { binToHex, hash256, hexToBin } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import type { NetworkName } from '@sigsig/core';
import type { KeeperChain, KeeperUtxo, TxStatus } from './ports.js';

const ALREADY_KNOWN = /already (known|in (the )?mempool|have transaction)|txn-already|transaction already in block chain/i;

export class ElectrumKeeperChain implements KeeperChain {
  readonly provider: ElectrumNetworkProvider;

  constructor(network: NetworkName, hostname?: string | null) {
    this.provider = new ElectrumNetworkProvider(network, hostname ? { hostname } : {});
  }

  async getUtxos(address: string): Promise<KeeperUtxo[]> {
    const utxos = await this.provider.getUtxos(address);
    // Fee inputs must be plain BCH: never spend token UTXOs that happen to sit in the fee wallet.
    return utxos.filter((u) => !u.token).map(({ txid, vout, satoshis }) => ({ txid, vout, satoshis }));
  }

  async getTxStatus(txid: string): Promise<TxStatus> {
    let res: unknown;
    try {
      res = await this.provider.performRequest('blockchain.transaction.get', txid, true);
    } catch {
      return 'unknown'; // "No such mempool or blockchain transaction"
    }
    if (res instanceof Error) return 'unknown';
    const conf = (res as { confirmations?: number } | null)?.confirmations;
    return typeof conf === 'number' && conf > 0 ? 'confirmed' : 'mempool';
  }

  async getMempoolTxids(address: string): Promise<string[]> {
    const res = await this.provider.performRequest('blockchain.address.get_mempool', address);
    if (res instanceof Error) throw res;
    return Array.isArray(res) ? res.map((e) => (e as { tx_hash: string }).tx_hash) : [];
  }

  async getFeeRateSatPerByte(): Promise<number> {
    const res = await this.provider.performRequest('blockchain.relayfee');
    if (res instanceof Error) throw res;
    const bchPerKb = Number(res);
    if (!Number.isFinite(bchPerKb) || bchPerKb <= 0) throw new Error(`bad relayfee ${String(res)}`);
    return Math.max(1, Math.ceil((bchPerKb * 1e8) / 1000));
  }

  async broadcast(txHex: string): Promise<string> {
    try {
      return await this.provider.sendRawTransaction(txHex);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (ALREADY_KNOWN.test(msg)) return txidOf(txHex);
      throw err;
    }
  }
}

/** txid = reversed double-sha256 of the raw tx. */
export function txidOf(txHex: string): string {
  return binToHex(hash256(hexToBin(txHex)).reverse());
}
