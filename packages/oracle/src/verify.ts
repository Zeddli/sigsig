/**
 * Verify a Paryon deployment file (deployments/chipnet.json) against the chain, adapted from
 * ParyonUSD/verify_contract_deployment (verifySetup.ts + validationUtils.ts). Differences:
 *   - works on raw tx hex (libauth decode) and lockingBytecode comparison, so it also runs on MockNetworkProvider;
 *   - the oracle key check compares with OUR ORACLE_WIF (if present) instead of General Protocols' key;
 *   - contract addresses are rebuilt from the file's tokenIds/params and compared with the file's `contracts` map;
 *   - additionally checks the PriceContract → PriceContractGuarded migrations and reports the live price state.
 *
 *   tsx src/verify.ts [--deployment deployments/chipnet.json]
 */
import { binToHex } from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import {
  buildContracts, contractList, LOAN_FUNCTION_COMMITMENTS, MAX_TOKEN_SUPPLY, POOL_FUNCTION_COMMITMENTS,
} from './paryon.js';
import { defaultDeploymentPath, loadDeploymentFile, toParyonDeployment, type DeploymentFile } from './deployment.js';
import { readPriceUtxos } from './oracle.js';
import { loadKeys } from './keys.js';
import { chipnetProvider, decodeTx, isMain, parseArgs } from './util.js';

type Cap = 'none' | 'mutable' | 'minting';
interface VOut {
  n: number;
  lockingBytecode: string;
  sats: bigint;
  token?: { category: string; amount: bigint; nft?: { capability: Cap; commitment: string } };
}
interface VTx { txid: string; inputs: Array<{ txid: string; vout: number }>; outputs: VOut[] }

const isOpReturn = (o: VOut) => o.lockingBytecode.startsWith('6a');

async function fetchTx(provider: NetworkProvider, txid: string): Promise<VTx> {
  const hex = await provider.getRawTransaction(txid);
  if (!hex) throw new Error(`tx ${txid} not found`);
  const tx = decodeTx(hex);
  return {
    txid,
    inputs: tx.inputs.map((i) => ({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex })),
    outputs: tx.outputs.map((o, n) => ({
      n,
      lockingBytecode: binToHex(o.lockingBytecode),
      sats: o.valueSatoshis,
      token: o.token && {
        category: binToHex(o.token.category),
        amount: o.token.amount,
        nft: o.token.nft && { capability: o.token.nft.capability as Cap, commitment: binToHex(o.token.nft.commitment) },
      },
    })),
  };
}

function fail(msg: string): never { throw new Error(msg); }

function expectNft(o: VOut, label: string, txid: string, capability: Cap, commitment?: string | ((c: string) => boolean)) {
  const nft = o.token?.nft ?? fail(`${label}: expected NFT on output ${o.n} of ${txid}`);
  if (nft.capability !== capability) fail(`${label}: expected ${capability} capability, got ${nft.capability} (output ${o.n} of ${txid})`);
  if (typeof commitment === 'string' && nft.commitment !== commitment) fail(`${label}: commitment ${nft.commitment}, expected ${commitment}`);
  if (typeof commitment === 'function' && !commitment(nft.commitment)) fail(`${label}: unexpected commitment ${nft.commitment}`);
}

export interface VerifyReport { ok: true; lines: string[] }

export async function verifyDeployment(
  file: DeploymentFile, provider: NetworkProvider, opts: { expectedOraclePubkey?: string; log?: (m: string) => void } = {},
): Promise<VerifyReport> {
  const lines: string[] = [];
  const log = (m: string) => { lines.push(m); (opts.log ?? console.log)(m); };
  const dep = toParyonDeployment(file);
  const ids = dep.tokenIds;
  const c = buildContracts(dep, provider);
  const lb = (x: { lockingBytecode: string }) => x.lockingBytecode;

  // 0. oracle key and contract map
  if (opts.expectedOraclePubkey) {
    if (dep.contractParams.oraclePublicKey !== opts.expectedOraclePubkey) {
      fail(`oraclePublicKey ${dep.contractParams.oraclePublicKey} != our oracle key ${opts.expectedOraclePubkey}`);
    }
    log('OK oraclePublicKey matches our ORACLE_WIF');
  }
  for (const [name, contract] of contractList(c)) {
    const rec = file.contracts[name] ?? fail(`contract ${name} missing from deployment file`);
    if (rec.lockingBytecode !== contract.lockingBytecode) fail(`contract ${name}: file lockingBytecode differs from rebuilt one`);
  }
  log(`OK all ${contractList(c).length} contract addresses in the file match a rebuild from tokenIds + params`);

  // 1. genesis inputs: each genesis tx spends <tokenId>:0
  const order = [
    ['paryonTokenId', 'paryonTokenGenesisTxid'], ['poolTokenId', 'poolTokenGenesisTxid'],
    ['redeemerTokenId', 'redeemerTokenGenesisTxid'], ['loanKeyFactoryTokenId', 'loanKeyFactoryTokenGenesisTxid'],
    ['oracleMigrationKeyTokenId', 'oracleMigrationKeyTokenGenesisTxid'],
  ] as const;
  const txs = await Promise.all(order.map(([, g]) => fetchTx(provider, file.genesisTxIds[g])));
  order.forEach(([idKey], i) => {
    if (!txs[i]!.inputs.some((inp) => inp.txid === ids[idKey] && inp.vout === 0)) {
      fail(`genesis tx ${txs[i]!.txid} does not spend ${ids[idKey]}:0`);
    }
  });
  log('OK the 5 genesis txs spend <tokenId>:0 (they are the genesis txs of the 5 token ids)');
  const [paryonTx, poolTx, redeemerTx, lkfTx, migTx] = txs as [VTx, VTx, VTx, VTx, VTx];

  // 2. paryonTokenId genesis
  const loanFnLbs = c.loanFunctionList.map(lb);
  const allowedParyon = [lb(c.borrowing), lb(c.price), ...loanFnLbs];
  const counts = { borrowing: 0, price: 0, loanFunctions: 0 };
  const seenLoanFns = new Set<string>();
  let supply = 0n;
  for (const o of paryonTx.outputs) {
    if (isOpReturn(o)) continue;
    if (o.token && !allowedParyon.includes(o.lockingBytecode)) fail(`paryon genesis: token output ${o.n} at an unexpected script`);
    if (o.token && o.token.category !== ids.paryonTokenId) fail(`paryon genesis: output ${o.n} has foreign category`);
    if (o.lockingBytecode !== lb(c.borrowing) && o.token && o.token.amount > 0n) fail(`paryon genesis: fungible tokens outside Borrowing (output ${o.n})`);
    if (o.lockingBytecode === lb(c.borrowing)) {
      expectNft(o, 'Borrowing', paryonTx.txid, 'minting', '00000000');
      supply += o.token!.amount;
      counts.borrowing++;
    }
    if (o.lockingBytecode === lb(c.price)) {
      expectNft(o, 'PriceContract', paryonTx.txid, 'mutable', (cm) => cm.length === 18 && cm.startsWith('00'));
      counts.price++;
    }
    const fi = loanFnLbs.indexOf(o.lockingBytecode);
    if (fi >= 0) {
      expectNft(o, `loan function ${fi + 1}`, paryonTx.txid, 'none', LOAN_FUNCTION_COMMITMENTS[fi]);
      counts.loanFunctions++;
      seenLoanFns.add(o.lockingBytecode);
    }
  }
  if (supply !== MAX_TOKEN_SUPPLY) fail(`PUSD supply ${supply} != ${MAX_TOKEN_SUPPLY}`);
  if (!counts.borrowing) fail('no Borrowing outputs');
  if (!counts.price) fail('no PriceContract outputs');
  if (seenLoanFns.size !== loanFnLbs.length) fail(`expected ${loanFnLbs.length} loan functions, saw ${seenLoanFns.size}`);
  log(`OK paryonTokenId genesis: ${JSON.stringify(counts)}, supply = MAX (${supply})`);

  // 3. poolTokenId genesis
  const poolFnLbs = c.poolFunctions.map(lb);
  const allowedPool = [lb(c.stabilityPool), lb(c.collector), ...poolFnLbs];
  const pcounts = { stabilityPool: 0, collector: 0, poolFunctions: 0 };
  const seenPoolFns = new Set<string>();
  for (const o of poolTx.outputs) {
    if (isOpReturn(o)) continue;
    if (o.token && !allowedPool.includes(o.lockingBytecode)) fail(`pool genesis: token output ${o.n} at an unexpected script`);
    if (o.token && o.token.amount > 0n) fail(`pool genesis: fungible tokens on output ${o.n}`);
    if (o.lockingBytecode === lb(c.stabilityPool)) {
      expectNft(o, 'StabilityPool', poolTx.txid, 'minting', '00000000000000000000');
      const side = poolTx.outputs[o.n + 1];
      if (!side || side.lockingBytecode !== lb(c.stabilityPoolSidecar)) fail('StabilityPool sidecar must be the next output');
      if (side.token) fail('StabilityPool sidecar must carry no tokens');
      pcounts.stabilityPool++;
    }
    if (o.lockingBytecode === lb(c.collector)) { expectNft(o, 'Collector', poolTx.txid, 'mutable', '00000000'); pcounts.collector++; }
    const fi = poolFnLbs.indexOf(o.lockingBytecode);
    if (fi >= 0) {
      expectNft(o, `pool function ${fi + 1}`, poolTx.txid, 'none', POOL_FUNCTION_COMMITMENTS[fi]);
      pcounts.poolFunctions++;
      seenPoolFns.add(o.lockingBytecode);
    }
  }
  if (!pcounts.stabilityPool) fail('no StabilityPool output');
  if (!pcounts.collector) fail('no Collector output');
  if (seenPoolFns.size !== poolFnLbs.length) fail(`expected ${poolFnLbs.length} pool functions, saw ${seenPoolFns.size}`);
  log(`OK poolTokenId genesis: ${JSON.stringify(pcounts)}, sidecar follows the pool, no fungible tokens`);

  // 4/5. redeemer + loanKeyFactory genesis
  const single = (tx: VTx, label: string, target: string) => {
    let n = 0;
    for (const o of tx.outputs) {
      if (isOpReturn(o)) continue;
      if (o.token && o.lockingBytecode !== target) fail(`${label} genesis: token output ${o.n} at an unexpected script`);
      if (o.token && o.token.amount > 0n) fail(`${label} genesis: fungible tokens`);
      if (o.lockingBytecode === target) { expectNft(o, label, tx.txid, 'minting', ''); n++; }
    }
    if (!n) fail(`${label} genesis: no outputs`);
    return n;
  };
  log(`OK redeemerTokenId genesis: ${single(redeemerTx, 'Redeemer', lb(c.redeemer))} Redeemer threads (minting, empty commitment)`);
  log(`OK loanKeyFactoryTokenId genesis: ${single(lkfTx, 'LoanKeyFactory', lb(c.loanKeyFactory))} LoanKeyFactory threads (minting, empty commitment)`);

  // 6. oracle migration key genesis (no fungible tokens; PriceContract address derives from this token id)
  if (migTx.outputs.some((o) => o.token && o.token.amount > 0n)) fail('migration key genesis: fungible tokens');
  const migOuts = migTx.outputs.filter((o) => o.token?.category === ids.oracleMigrationKeyTokenId);
  log(`OK oracleMigrationKeyTokenId genesis: ${migOuts.length} migration key NFT(s); PriceContract outputs exist at the address derived from it`);

  // 7. function-NFT base case over all 5 genesis txs
  const fnNfts = [
    ...loanFnLbs.map((l, i) => ({ category: ids.paryonTokenId, commitment: LOAN_FUNCTION_COMMITMENTS[i], lockingBytecode: l, label: `loan function ${i + 1}` })),
    ...poolFnLbs.map((l, i) => ({ category: ids.poolTokenId, commitment: POOL_FUNCTION_COMMITMENTS[i], lockingBytecode: l, label: `pool function ${i + 1}` })),
  ];
  for (const tx of txs) {
    for (const o of tx.outputs) {
      if (isOpReturn(o)) continue;
      const nft = o.token?.nft;
      const shape = nft?.capability === 'none'
        ? fnNfts.find((f) => f.category === o.token!.category && f.commitment === nft.commitment) : undefined;
      if (shape && o.lockingBytecode !== shape.lockingBytecode) fail(`stray ${shape.label} NFT in ${tx.txid}:${o.n}`);
      const owner = fnNfts.find((f) => f.lockingBytecode === o.lockingBytecode);
      if (owner && !shape) fail(`unexpected output on the ${owner.label} contract in ${tx.txid}:${o.n}`);
    }
  }
  log('OK function NFTs only sit on their own function contracts, and those contracts hold only their function NFT');

  // 8. PriceContract → PriceContractGuarded migrations (mainnet layout of 2026-10-08, block 972003)
  const migIds = file.priceMigrationTxIds ?? [];
  const genesisPriceOuts = paryonTx.outputs.filter((o) => o.lockingBytecode === lb(c.price));
  const migrated = new Set<number>();
  let keyOutpoint = `${migTx.txid}:${migTx.outputs.findIndex((o) => o.token?.category === ids.oracleMigrationKeyTokenId)}`;
  for (const id of migIds) {
    const tx = await fetchTx(provider, id);
    const in0 = tx.inputs[0]!;
    const src = in0.txid === paryonTx.txid ? genesisPriceOuts.find((o) => o.n === in0.vout) : undefined;
    if (!src) fail(`migration ${id}: input 0 is not a genesis PriceContract output`);
    if (`${tx.inputs[1]!.txid}:${tx.inputs[1]!.vout}` !== keyOutpoint) fail(`migration ${id}: input 1 is not the migration key`);
    const out0 = tx.outputs[0]!;
    if (out0.lockingBytecode !== lb(c.priceGuarded)) fail(`migration ${id}: output 0 is not PriceContractGuarded`);
    if (out0.sats !== 1000n || out0.token?.category !== ids.paryonTokenId) fail(`migration ${id}: output 0 value/category`);
    expectNft(out0, 'PriceContractGuarded', id, 'mutable', src.token!.nft!.commitment);
    const keyOut = tx.outputs[1]!;
    if (keyOut.token?.category !== ids.oracleMigrationKeyTokenId) fail(`migration ${id}: migration key not returned at output 1`);
    keyOutpoint = `${id}:1`;
    migrated.add(src.n);
  }
  if (migIds.length) {
    if (migrated.size !== genesisPriceOuts.length) fail(`only ${migrated.size}/${genesisPriceOuts.length} price threads migrated`);
    log(`OK all ${migrated.size} price threads migrated to PriceContractGuarded via migrateContract + migration key, state unchanged`);
  }

  // 9. live state: price threads only on the live contract
  const live = file.livePriceContract === 'priceContract' ? c.price : c.priceGuarded;
  const stale = file.livePriceContract === 'priceContract' ? c.priceGuarded : c.price;
  const prices = await readPriceUtxos(live, ids.paryonTokenId);
  const leftover = await readPriceUtxos(stale, ids.paryonTokenId);
  if (leftover.length) fail(`${leftover.length} price thread(s) still on the non-live price contract ${stale.address}`);
  if (prices.length !== genesisPriceOuts.length) fail(`expected ${genesisPriceOuts.length} live price threads at ${live.address}, found ${prices.length}`);
  log(`live: ${prices.length} price thread(s) at ${live.address}: ${prices.map((p) => `$${(p.priceCents / 100).toFixed(2)}@seq${p.seq}`).join(', ')}`);
  return { ok: true, lines };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = loadDeploymentFile(typeof a.deployment === 'string' ? a.deployment : defaultDeploymentPath('chipnet'));
  let expectedOraclePubkey: string | undefined;
  try { expectedOraclePubkey = loadKeys({ envPath: typeof a.env === 'string' ? a.env : undefined }).ORACLE_WIF.publicKeyHex; } catch { /* no .env: skip */ }
  console.log(`verifying ${file.name} on ${file.network}; tokenIds ${JSON.stringify(file.tokenIds, null, 2)}`);
  await verifyDeployment(file, chipnetProvider(), { expectedOraclePubkey });
  console.log('deployment verified');
}

if (isMain(import.meta.url)) {
  main().then(() => process.exit(0), (err) => { console.error('VERIFY FAILED:', err instanceof Error ? err.message : err); process.exit(1); });
}
