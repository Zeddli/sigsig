import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { binToHex, decodeTransaction, hexToBin, sha256 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, type NetworkProvider } from 'cashscript';

export const txidOf = (hex: string): string => binToHex(sha256.hash(sha256.hash(hexToBin(hex))).reverse());

export function decodeTx(hex: string) {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(`cannot decode tx: ${tx}`);
  return tx;
}

/** True if the network already knows this tx (mempool or chain). Works for Electrum and MockNetworkProvider. */
export async function isKnownTx(provider: NetworkProvider, txid: string): Promise<boolean> {
  try {
    return Boolean(await provider.getRawTransaction(txid));
  } catch {
    return false;
  }
}

/** Broadcast, treating "already known" as success (so resumed runs can re-send recorded txs safely). */
export async function broadcast(provider: NetworkProvider, hex: string): Promise<string> {
  const txid = txidOf(hex);
  if (await isKnownTx(provider, txid)) return txid;
  try {
    const sent = await provider.sendRawTransaction(hex);
    return sent || txid;
  } catch (err) {
    if (await isKnownTx(provider, txid)) return txid;
    throw err;
  }
}

export function chipnetProvider(hostname = process.env.CHIPNET_ELECTRUM): ElectrumNetworkProvider {
  return hostname ? new ElectrumNetworkProvider('chipnet', { hostname }) : new ElectrumNetworkProvider('chipnet');
}

export const prefixFor = (network: string): 'bitcoincash' | 'bchtest' | 'bchreg' =>
  network === 'mainnet' ? 'bitcoincash' : network === 'regtest' ? 'bchreg' : 'bchtest';

/** Minimal `--flag value` / `--flag` parser. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    if (inline !== undefined) out[k] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out[k] = argv[++i]!;
    else out[k] = true;
  }
  return out;
}

export function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
