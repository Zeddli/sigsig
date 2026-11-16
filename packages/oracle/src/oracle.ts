/**
 * Chipnet mock oracle for our Paryon deployment.
 *
 *   tsx src/oracle.ts --status
 *   tsx src/oracle.ts --price 450.25         # set price (USD per BCH)
 *   tsx src/oracle.ts --crash 20             # price × 0.80
 *   tsx src/oracle.ts --pump 10              # price × 1.10
 *   tsx src/oracle.ts --loop [--interval 600] [--price <usd>]   # heartbeat forever (keeps the price fresh)
 *   options: --deployment <path> (default deployments/chipnet.json), --env <path>, --only <n> (update just one
 *            price-contract UTXO; default all of them)
 *
 * Message (16 bytes, all LE int32): timestamp | messageSeq | contentSeq | price (PUSD cents per BCH).
 * Signature: Schnorr over sha256(message) by ORACLE_WIF, i.e. what OP_CHECKDATASIG verifies.
 * PriceContract.updatePrice accepts it iff contentSeq > stored seq AND (contentSeq % 10 == 0 OR |Δprice| ≥ old/200).
 */
import { secp256k1, sha256 } from '@bitauth/libauth';
import { Contract, TransactionBuilder, type NetworkProvider, type Utxo } from 'cashscript';
import { buildParyonContracts, CONTRACT_SATS, int32le, parsePriceCommitment, priceCommitment } from './paryon.js';
import { loadKeys, type KeyPair } from './keys.js';
import { defaultDeploymentPath, loadDeploymentFile, toParyonDeployment, type DeploymentFile } from './deployment.js';
import { broadcast, chipnetProvider, isMain, parseArgs, prefixFor, sleep, txidOf } from './util.js';

export interface PriceMessage { timestamp: number; messageSeq: number; contentSeq: number; priceCents: number }

export function encodePriceMessage(m: PriceMessage): Uint8Array {
  return Buffer.from(int32le(m.timestamp) + int32le(m.messageSeq) + int32le(m.contentSeq) + int32le(m.priceCents), 'hex');
}

/** checkDataSig-compatible Schnorr signature: sign sha256(message). */
export function signPriceMessage(message: Uint8Array, oraclePrivateKey: Uint8Array): Uint8Array {
  const sig = secp256k1.signMessageHashSchnorr(oraclePrivateKey, sha256.hash(message));
  if (typeof sig === 'string') throw new Error(sig);
  return sig;
}

export const verifyPriceSignature = (message: Uint8Array, sig: Uint8Array, pubkey: Uint8Array): boolean =>
  secp256k1.verifySignatureSchnorr(sig, pubkey, sha256.hash(message));

/** Same integer rule as PriceContract: priceDiff >= oldPrice / 200 (truncating division). */
export const exceedsDeviation = (oldPrice: number, newPrice: number): boolean =>
  Math.abs(oldPrice - newPrice) >= Math.trunc(oldPrice / 200);

/** Next acceptable content sequence: seq+1 if the price moved enough, otherwise the next heartbeat (multiple of 10). */
export function nextContentSeq(current: { seq: number; priceCents: number }, newPriceCents: number): { seq: number; heartbeat: boolean } {
  if (exceedsDeviation(current.priceCents, newPriceCents)) {
    const seq = current.seq + 1;
    return { seq, heartbeat: seq % 10 === 0 };
  }
  return { seq: (Math.floor(current.seq / 10) + 1) * 10, heartbeat: true };
}

export interface PriceUtxo { utxo: Utxo; seq: number; priceCents: number }

export async function readPriceUtxos(priceContract: Contract, paryonTokenId: string): Promise<PriceUtxo[]> {
  const utxos = await priceContract.getUtxos();
  return utxos
    .filter((u) => u.token?.category === paryonTokenId && u.token.nft?.capability === 'mutable')
    .map((u) => ({ utxo: u, ...parsePriceCommitment(u.token!.nft!.commitment) }));
}

export interface UpdateResult { txids: string[]; message: PriceMessage; feeUtxo?: Utxo }

/**
 * Push `newPriceCents` to every live PriceContract UTXO (or just `only`). Fees come from `feeKey`'s P2PKH UTXOs;
 * the change of each tx funds the next, so it works with unconfirmed chains.
 */
export async function updatePrice(args: {
  provider: NetworkProvider;
  priceContract: Contract;
  paryonTokenId: string;
  oracleKey: KeyPair;
  feeKey: KeyPair;
  feeAddress: string;
  newPriceCents: number;
  only?: number;
  timestamp?: number;
  feeRate?: number;
  log?: (m: string) => void;
}): Promise<UpdateResult> {
  const { provider, priceContract, paryonTokenId, oracleKey, feeKey } = args;
  const log = args.log ?? ((m: string) => console.log(m));
  if (!Number.isInteger(args.newPriceCents) || args.newPriceCents <= 0 || args.newPriceCents > 0x7fffffff) {
    throw new Error(`price out of range: ${args.newPriceCents} cents`);
  }
  let priceUtxos = await readPriceUtxos(priceContract, paryonTokenId);
  if (!priceUtxos.length) throw new Error(`no PriceContract UTXOs at ${priceContract.address}`);
  if (args.only !== undefined) priceUtxos = [priceUtxos[args.only]!].filter(Boolean);

  // One message for all threads: its seq must beat the highest stored seq, and the deviation rule is checked
  // against each thread's own stored price (threads that cannot accept it are skipped with a warning).
  const maxSeq = Math.max(...priceUtxos.map((p) => p.seq));
  const ref = priceUtxos.find((p) => p.seq === maxSeq)!;
  let { seq } = nextContentSeq({ seq: maxSeq, priceCents: ref.priceCents }, args.newPriceCents);
  if (priceUtxos.some((p) => !exceedsDeviation(p.priceCents, args.newPriceCents)) && seq % 10 !== 0) {
    seq = (Math.floor(maxSeq / 10) + 1) * 10; // heartbeat so lagging/unchanged threads accept it too
  }
  const message: PriceMessage = {
    timestamp: args.timestamp ?? Math.floor(Date.now() / 1000), messageSeq: seq, contentSeq: seq, priceCents: args.newPriceCents,
  };
  const msg = encodePriceMessage(message);
  const sig = signPriceMessage(msg, oracleKey.privateKey);
  if (!verifyPriceSignature(msg, sig, oracleKey.publicKey)) throw new Error('self-check of the data signature failed');

  const feeUtxos = (await provider.getUtxos(args.feeAddress)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
  let feeUtxo: Utxo | undefined = feeUtxos[0];
  const txids: string[] = [];
  for (const p of priceUtxos) {
    if (!feeUtxo || feeUtxo.satoshis < 2000n) throw new Error(`fee wallet ${args.feeAddress} needs BCH (≥ 2000 sats)`);
    const make = (change: bigint) => new TransactionBuilder({ provider })
      .addInput(p.utxo, priceContract.unlock.updatePrice!(msg, sig))
      .addInput(feeUtxo!, feeKey.signer.unlockP2PKH())
      .addOutput({
        to: priceContract.tokenAddress, amount: CONTRACT_SATS,
        token: { category: paryonTokenId, amount: 0n, nft: { capability: 'mutable', commitment: priceCommitment(seq, args.newPriceCents) } },
      })
      .addOutput({ to: feeKey.lockingBytecode, amount: change });
    const inTotal: bigint = p.utxo.satoshis + feeUtxo.satoshis;
    const size = make(1000n).getTransactionSize();
    const change: bigint = inTotal - CONTRACT_SATS - BigInt(Math.ceil(Number(size) * (args.feeRate ?? 1))) - 2n;
    const builder = make(change);
    builder.debug(); // throws with the failing require() message if the contract would reject it
    const hex = builder.build();
    const txid = await broadcast(provider, hex);
    txids.push(txid);
    log(`price ${p.priceCents} → ${args.newPriceCents} cents (seq ${p.seq} → ${seq}) tx ${txid}`);
    feeUtxo = { txid: txidOf(hex), vout: 1, satoshis: change };
  }
  return { txids, message, feeUtxo };
}

/** Contract handle from a deployment file. */
export function priceContractFor(file: DeploymentFile, provider: NetworkProvider): Contract {
  const dep = toParyonDeployment(file);
  return buildParyonContracts(dep.tokenIds, dep.contractParams, provider).priceContract;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const depPath = typeof a.deployment === 'string' ? a.deployment : defaultDeploymentPath('chipnet');
  const file = loadDeploymentFile(depPath);
  const keys = loadKeys({ envPath: typeof a.env === 'string' ? a.env : undefined });
  const oracleKey = keys.ORACLE_WIF;
  if (oracleKey.publicKeyHex !== file.contractParams.oraclePublicKey) {
    throw new Error(`ORACLE_WIF pubkey ${oracleKey.publicKeyHex} != deployment oraclePublicKey ${file.contractParams.oraclePublicKey}`);
  }
  const feeKey = keys.FUNDER_WIF;
  const provider = chipnetProvider();
  const priceContract = priceContractFor(file, provider);
  const feeAddress = feeKey.address(prefixFor(file.network));
  const current = async () => {
    const ps = await readPriceUtxos(priceContract, file.tokenIds.paryonTokenId);
    if (!ps.length) throw new Error('no price contract UTXOs found');
    return ps.reduce((best, p) => (p.seq > best.seq ? p : best));
  };
  const cur = await current();
  console.log(`current: $${(cur.priceCents / 100).toFixed(2)} (seq ${cur.seq}) at ${priceContract.address}`);
  if (a.status) {
    for (const p of await readPriceUtxos(priceContract, file.tokenIds.paryonTokenId)) {
      console.log(`  ${p.utxo.txid}:${p.utxo.vout} seq=${p.seq} price=${p.priceCents}`);
    }
    console.log(`fee wallet ${feeAddress}: ${(await provider.getUtxos(feeAddress)).reduce((s, u) => s + u.satoshis, 0n)} sats`);
    return;
  }
  const only = typeof a.only === 'string' ? Number(a.only) : undefined;
  let target: number | undefined;
  if (typeof a.price === 'string') target = Math.round(Number(a.price) * 100);
  else if (typeof a.crash === 'string') target = Math.round(cur.priceCents * (1 - Number(a.crash) / 100));
  else if (typeof a.pump === 'string') target = Math.round(cur.priceCents * (1 + Number(a.pump) / 100));
  const push = (cents: number) => updatePrice({
    provider, priceContract, paryonTokenId: file.tokenIds.paryonTokenId, oracleKey, feeKey, feeAddress, newPriceCents: cents, only,
  });
  if (target !== undefined) await push(target);
  if (a.loop) {
    const intervalMs = (typeof a.interval === 'string' ? Number(a.interval) : 600) * 1000;
    const loopPrice = target ?? cur.priceCents;
    console.log(`heartbeat loop at $${(loopPrice / 100).toFixed(2)} every ${intervalMs / 1000}s (ctrl-c to stop)`);
    for (;;) {
      await sleep(intervalMs);
      try { await push(loopPrice); } catch (err) { console.error('heartbeat failed:', err instanceof Error ? err.message : err); }
    }
  }
  if (target === undefined && !a.loop) console.log('nothing to do: pass --price, --crash, --pump, --loop or --status');
}

if (isMain(import.meta.url)) {
  main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}

