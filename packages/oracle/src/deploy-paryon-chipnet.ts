/**
 * Deploy the full ParyonUSD system (26 contracts, 5 token categories) with OUR oracle key, mirroring mainnet-v1.
 *
 *   pnpm --filter @sigsig/oracle deploy:chipnet                 # generate keys, print funding address, deploy
 *   pnpm --filter @sigsig/oracle deploy:chipnet --dry-run       # build + size everything, broadcast nothing
 *   pnpm --filter @sigsig/oracle deploy:chipnet --profile lean  # fewer parallel threads (cheaper)
 *
 * Flow (every step is recorded in deployments/<network>.state.json BEFORE it is broadcast, so a crash or a failed
 * broadcast can be resumed by re-running the same command; recorded txs are re-sent byte-for-byte, never rebuilt):
 *   1. prep[0..4]: funder → vout0 (exact budget of genesis k) + vout1 change. The txid of prep[k] becomes token id k.
 *      Chained: prep[k] spends prep[k-1]:1, so nothing depends on wallet UTXO selection after prep[0].
 *   2. with all 5 token ids known, build the 26 contracts (constructor args as in verify_contract_deployment).
 *   3. genesis[k]: spends prep[k]:0 → out0 BCH change, out1.. the token outputs mainnet-v1 created.
 *   4. migrate each price thread PriceContract → PriceContractGuarded with the migration key (mainnet did this on
 *      2026-10-08, block 972003: in0 price [migrateContract], in1 migration key, in2 fee → out0 guarded, out1 key back).
 *   5. write deployments/<network>.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { TransactionBuilder, type NetworkProvider, type Output, type Utxo } from 'cashscript';
import type { NetworkName, ParyonDeployment } from '@sigsig/core';
import {
  CATEGORY_ORDER, CONTRACT_SATS, LEAN_COUNTS, MAINNET_COUNTS, TOKEN_ID_FIELD, buildContracts, contractList, genesisOutputs,
  type CategoryKey, type ContractParams, type GenesisCounts, type TokenIds,
} from './paryon.js';
import { loadKeys, type KeyPair } from './keys.js';
import { defaultDeploymentPath, defaultStatePath, type DeploymentFile, type GenesisTxIds } from './deployment.js';
import { broadcast, chipnetProvider, decodeTx, isMain, parseArgs, prefixFor, txidOf } from './util.js';

export interface TxRecord { txid: string; hex: string; broadcast: boolean }

export interface DeployState {
  version: 1;
  network: NetworkName;
  createdAt: string;
  funderLockingBytecode: string;
  oraclePublicKey: string;
  migrationPublicKey: string;
  params: { startBlockHeight: number; periodLengthBlocks: number; timeLockRedemption: number; protocolFeeLockingBytecode: string };
  counts: GenesisCounts;
  initialPrice: { seq: number; priceCents: number };
  budgets: Record<CategoryKey, string>; // sats on prep[k]:0, as decimal strings
  prep: TxRecord[];
  genesis: Partial<Record<CategoryKey, TxRecord>>;
  /** PriceContract → PriceContractGuarded migrations, one per price thread (mainnet did this at block 972003) */
  migrations?: TxRecord[];
  done: boolean;
}

export interface DeployOptions {
  provider: NetworkProvider;
  network: NetworkName;
  keys: { oracle: KeyPair; migration: KeyPair; funder: KeyPair };
  statePath: string;
  outPath: string;
  counts?: GenesisCounts;
  initialPriceCents?: number;
  periodLengthBlocks?: number;
  timeLockRedemption?: number;
  feeRate?: number; // sats per byte
  dryRun?: boolean;
  log?: (msg: string) => void;
}

const DUST = 800n;
const SAFETY = 1000n; // extra sats left as change on each genesis tx (also keeps change above dust)

function loadState(path: string): DeployState | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DeployState) : undefined;
}

function saveState(path: string, state: DeployState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path); // atomic replace
}

const fee = (size: bigint, rate: number): bigint => BigInt(Math.ceil(Number(size) * rate)) + 2n;

function tokenIdsFrom(prepTxids: string[]): TokenIds {
  const ids = {} as TokenIds;
  CATEGORY_ORDER.forEach((k, i) => { ids[TOKEN_ID_FIELD[k]] = prepTxids[i]!; });
  return ids;
}

function contractParamsFrom(state: DeployState): ContractParams {
  return {
    oraclePublicKey: state.oraclePublicKey,
    protocolFeeLockingBytecode: state.params.protocolFeeLockingBytecode,
    startBlockHeight: BigInt(state.params.startBlockHeight),
    periodLengthBlocks: BigInt(state.params.periodLengthBlocks),
    timeLockRedemption: BigInt(state.params.timeLockRedemption),
  };
}

function deploymentOf(state: DeployState, tokenIds: TokenIds): ParyonDeployment {
  return { name: `${state.network}-sigsig-v1`, network: state.network, tokenIds, contractParams: contractParamsFrom(state) };
}

/** Build genesis tx k spending `input` (= prep[k]:0); change at out0. */
function buildGenesis(
  key: CategoryKey, input: Utxo, outputs: Output[], funder: KeyPair, provider: NetworkProvider, feeRate: number,
): TransactionBuilder {
  const total = outputs.reduce((s, o) => s + o.amount, 0n);
  const make = (change: bigint) => new TransactionBuilder({ provider })
    .addInput(input, funder.signer.unlockP2PKH())
    .addOutputs([{ to: funder.lockingBytecode, amount: change }, ...outputs]);
  const probe = make(input.satoshis - total > DUST ? input.satoshis - total : DUST);
  const change = input.satoshis - total - fee(probe.getTransactionSize(), feeRate);
  if (change < DUST) throw new Error(`genesis ${key}: input ${input.satoshis} too small (change would be ${change})`);
  return make(change);
}

/** Size-based budget of each genesis tx, computed with dummy token ids (sizes do not depend on the ids). */
function computeBudgets(state: DeployState, keys: DeployOptions['keys'], provider: NetworkProvider, feeRate: number) {
  const dummyIds = tokenIdsFrom(CATEGORY_ORDER.map((_, i) => `${(i + 1).toString(16).padStart(2, '0')}`.repeat(32)));
  const contracts = buildContracts(deploymentOf(state, dummyIds), provider);
  const budgets = {} as Record<CategoryKey, string>;
  for (const key of CATEGORY_ORDER) {
    const outs = genesisOutputs(key, {
      contracts, tokenIds: dummyIds, counts: state.counts, initialPrice: state.initialPrice,
      migrationKeyHolderLockingBytecode: keys.migration.lockingBytecode,
    });
    const total = outs.reduce((s, o) => s + o.amount, 0n);
    const dummyInput: Utxo = { txid: dummyIds[TOKEN_ID_FIELD[key]], vout: 0, satoshis: total + 10_000_000n };
    const size = buildGenesis(key, dummyInput, outs, keys.funder, provider, feeRate).getTransactionSize();
    budgets[key] = (total + fee(size, feeRate) + SAFETY).toString();
  }
  return budgets;
}

export async function deployParyon(opts: DeployOptions): Promise<DeploymentFile> {
  const { provider, network, keys, statePath, outPath } = opts;
  const feeRate = opts.feeRate ?? 1;
  const log = opts.log ?? ((m: string) => console.log(m));
  const prefix = prefixFor(network);
  const funderAddr = keys.funder.address(prefix);

  // ---- 0. state (params are frozen on first run: they determine every contract address) ----
  let state = loadState(statePath);
  if (!state) {
    const height = await provider.getBlockHeight();
    state = {
      version: 1, network, createdAt: new Date().toISOString(),
      funderLockingBytecode: keys.funder.lockingBytecodeHex,
      oraclePublicKey: keys.oracle.publicKeyHex,
      migrationPublicKey: keys.migration.publicKeyHex,
      params: {
        startBlockHeight: height,
        periodLengthBlocks: opts.periodLengthBlocks ?? 144,
        timeLockRedemption: opts.timeLockRedemption ?? 12,
        protocolFeeLockingBytecode: keys.funder.lockingBytecodeHex,
      },
      counts: opts.counts ?? MAINNET_COUNTS,
      initialPrice: { seq: 0, priceCents: opts.initialPriceCents ?? 45_000 },
      budgets: {} as Record<CategoryKey, string>,
      prep: [], genesis: {}, done: false,
    };
    state.budgets = computeBudgets(state, keys, provider, feeRate);
    log(`new deployment state: startBlockHeight=${height}, counts=${JSON.stringify(state.counts)}`);
  } else {
    log(`resuming from ${statePath} (prep ${state.prep.length}/5, genesis ${Object.keys(state.genesis).length}/5)`);
    if (state.funderLockingBytecode !== keys.funder.lockingBytecodeHex
      || state.oraclePublicKey !== keys.oracle.publicKeyHex
      || state.migrationPublicKey !== keys.migration.publicKeyHex) {
      throw new Error(`keys in .env do not match ${statePath}; restore the original .env or move the state file away`);
    }
  }
  const budgets = CATEGORY_ORDER.map((k) => BigInt(state!.budgets[k]));
  const genesisTotal = budgets.reduce((a, b) => a + b, 0n);
  log(`genesis budgets (sats): ${CATEGORY_ORDER.map((k, i) => `${k}=${budgets[i]}`).join(', ')}; total ${genesisTotal}`);

  const persist = () => { if (!opts.dryRun) saveState(statePath, state!); };
  const send = async (rec: TxRecord, label: string) => {
    if (rec.broadcast || opts.dryRun) return;
    await broadcast(provider, rec.hex);
    rec.broadcast = true;
    persist();
    log(`  broadcast ${label}: ${rec.txid}`);
  };

  // ---- 1. prep txs (category creators) ----
  for (let k = 0; k < CATEGORY_ORDER.length; k++) {
    if (!state.prep[k]) {
      let inputs: Utxo[];
      if (k === 0) {
        const utxos = (await provider.getUtxos(funderAddr)).filter((u) => !u.token);
        inputs = utxos;
        const have = utxos.reduce((s, u) => s + u.satoshis, 0n);
        const need = genesisTotal + 5n * 400n + BigInt(utxos.length) * 150n + DUST
          + BigInt(state.counts.priceContracts) * 1000n; // migration tx fees
        if (have < need && opts.dryRun) {
          log(`dry run: funder ${funderAddr} has ${have} sats, needs ≥ ${need}; sizing with a synthetic input`);
          inputs = [{ txid: '00'.repeat(32), vout: 0, satoshis: need }];
        } else if (have < need) {
          throw new Error(`funder ${funderAddr} has ${have} sats, needs ≥ ${need}. Fund it (chipnet faucet: https://tbch.googol.cash/) and re-run.`);
        }
      } else {
        const prev = decodeTx(state.prep[k - 1]!.hex);
        inputs = [{ txid: state.prep[k - 1]!.txid, vout: 1, satoshis: prev.outputs[1]!.valueSatoshis }];
      }
      const inTotal = inputs.reduce((s, u) => s + u.satoshis, 0n);
      const make = (change: bigint) => new TransactionBuilder({ provider })
        .addInputs(inputs, keys.funder.signer.unlockP2PKH())
        .addOutput({ to: keys.funder.lockingBytecode, amount: budgets[k]! })
        .addOutput({ to: keys.funder.lockingBytecode, amount: change });
      const size = make(DUST).getTransactionSize();
      const change = inTotal - budgets[k]! - fee(size, feeRate);
      if (change < DUST) throw new Error(`prep ${k}: not enough funds (change ${change})`);
      const hex = make(change).build();
      state.prep[k] = { txid: txidOf(hex), hex, broadcast: false };
      persist();
      log(`prep ${k} (${CATEGORY_ORDER[k]} category) built: ${state.prep[k]!.txid}`);
    }
    await send(state.prep[k]!, `prep ${k}`);
  }

  // ---- 2. contracts ----
  const tokenIds = tokenIdsFrom(state.prep.map((p) => p.txid));
  const params = contractParamsFrom(state);
  const contracts = buildContracts(deploymentOf(state, tokenIds), provider);
  log(`token ids: ${JSON.stringify(tokenIds)}`);

  // ---- 3. genesis txs ----
  for (let k = 0; k < CATEGORY_ORDER.length; k++) {
    const key = CATEGORY_ORDER[k]!;
    if (!state.genesis[key]) {
      const outs = genesisOutputs(key, {
        contracts, tokenIds, counts: state.counts, initialPrice: state.initialPrice,
        migrationKeyHolderLockingBytecode: keys.migration.lockingBytecode,
      });
      const input: Utxo = { txid: state.prep[k]!.txid, vout: 0, satoshis: budgets[k]! };
      const builder = buildGenesis(key, input, outs, keys.funder, provider, feeRate);
      builder.debug(); // local VM evaluation (throws on any script/token error) before anything is recorded
      const hex = builder.build();
      state.genesis[key] = { txid: txidOf(hex), hex, broadcast: false };
      persist();
      log(`genesis ${key} built: ${state.genesis[key]!.txid} (${outs.length} token outputs, ${hex.length / 2} bytes)`);
    }
    await send(state.genesis[key]!, `genesis ${key}`);
  }

  // ---- 4. migrate every price thread PriceContract → PriceContractGuarded (as mainnet did at block 972003) ----
  // Mainnet layout: in0 PriceContract [migrateContract], in1 migration key NFT (P2PKH), in2 fee
  //                 → out0 PriceContractGuarded (same category/commitment, 1000 sats), out1 migration key back, out2 change.
  // Chained: the key and the fee change of migration k feed migration k+1.
  const g = state.genesis as Record<CategoryKey, TxRecord>;
  state.migrations ??= [];
  const paryonGenesis = decodeTx(g.paryon.hex);
  const migGenesis = decodeTx(g.oracleMigrationKey.hex);
  for (let k = 0; k < state.counts.priceContracts; k++) {
    if (!state.migrations[k]) {
      const priceVout = 1 + state.counts.borrowing + k; // genesis: change, borrowing×N, price×M, …
      const priceOut = paryonGenesis.outputs[priceVout]!;
      if (binToHex(priceOut.lockingBytecode) !== contracts.price.lockingBytecode) throw new Error(`paryon genesis vout ${priceVout} is not a PriceContract`);
      const commitment = binToHex(priceOut.token!.nft!.commitment);
      const priceUtxo: Utxo = {
        txid: g.paryon.txid, vout: priceVout, satoshis: priceOut.valueSatoshis,
        token: { category: tokenIds.paryonTokenId, amount: 0n, nft: { capability: 'mutable', commitment } },
      };
      const keyToken = { category: tokenIds.oracleMigrationKeyTokenId, amount: 0n, nft: { capability: 'minting' as const, commitment: '' } };
      const prevMig = k > 0 ? state.migrations[k - 1]! : undefined;
      const keyUtxo: Utxo = prevMig
        ? { txid: prevMig.txid, vout: 1, satoshis: CONTRACT_SATS, token: keyToken }
        : { txid: g.oracleMigrationKey.txid, vout: 1, satoshis: migGenesis.outputs[1]!.valueSatoshis, token: keyToken };
      const feeUtxo: Utxo = prevMig
        ? { txid: prevMig.txid, vout: 2, satoshis: decodeTx(prevMig.hex).outputs[2]!.valueSatoshis }
        : { txid: state.prep[4]!.txid, vout: 1, satoshis: decodeTx(state.prep[4]!.hex).outputs[1]!.valueSatoshis };
      const make = (change: bigint) => new TransactionBuilder({ provider })
        .addInput(priceUtxo, contracts.price.unlock.migrateContract())
        .addInput(keyUtxo, keys.migration.signer.unlockP2PKH())
        .addInput(feeUtxo, keys.funder.signer.unlockP2PKH())
        .addOutput({ to: hexToBin(contracts.priceGuarded.lockingBytecode), amount: CONTRACT_SATS, token: priceUtxo.token! })
        .addOutput({ to: keys.migration.lockingBytecode, amount: CONTRACT_SATS, token: keyToken })
        .addOutput({ to: keys.funder.lockingBytecode, amount: change });
      const inTotal = priceUtxo.satoshis + keyUtxo.satoshis + feeUtxo.satoshis;
      const change = inTotal - 2n * CONTRACT_SATS - fee(make(DUST).getTransactionSize(), feeRate);
      if (change < DUST) throw new Error(`migration ${k}: fee input too small (${feeUtxo.satoshis})`);
      const builder = make(change);
      builder.debug();
      const hex = builder.build();
      state.migrations[k] = { txid: txidOf(hex), hex, broadcast: false };
      persist();
      log(`price thread ${k} migration built: ${state.migrations[k]!.txid}`);
    }
    await send(state.migrations[k]!, `price migration ${k}`);
  }

  // ---- 5. deployment file ----
  const genesisTxIds: GenesisTxIds = {
    paryonTokenGenesisTxid: g.paryon.txid,
    poolTokenGenesisTxid: g.pool.txid,
    redeemerTokenGenesisTxid: g.redeemer.txid,
    loanKeyFactoryTokenGenesisTxid: g.loanKeyFactory.txid,
    oracleMigrationKeyTokenGenesisTxid: g.oracleMigrationKey.txid,
  };
  const file: DeploymentFile = {
    name: `${network}-sigsig-v1`,
    network,
    tokenIds,
    contractParams: {
      oraclePublicKey: params.oraclePublicKey,
      protocolFeeLockingBytecode: params.protocolFeeLockingBytecode,
      startBlockHeight: state.params.startBlockHeight,
      periodLengthBlocks: state.params.periodLengthBlocks,
      timeLockRedemption: state.params.timeLockRedemption,
    },
    genesisTxIds,
    categoryPrepTxIds: state.prep.map((p) => p.txid),
    priceMigrationTxIds: (state.migrations ?? []).map((m) => m.txid),
    livePriceContract: 'priceContractGuarded',
    counts: state.counts,
    initialPrice: state.initialPrice,
    migrationKeyHolder: keys.migration.tokenAddress(prefix),
    contracts: Object.fromEntries(contractList(contracts).map(([name, c]) => [name, {
      address: c.address, tokenAddress: c.tokenAddress, lockingBytecode: c.lockingBytecode,
    }])),
    deployedAt: new Date().toISOString(),
  };
  if (!opts.dryRun) {
    state.done = true;
    persist();
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);
    log(`wrote ${outPath}`);
  } else {
    log('dry run: nothing broadcast, no files written');
  }
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`usage: tsx src/deploy-paryon-chipnet.ts [--dry-run] [--profile mainnet|lean] [--price <usd>]
       [--period <blocks>] [--fee-rate <sat/B>] [--state <path>] [--out <path>] [--env <path>]`);
    return;
  }
  const network: NetworkName = 'chipnet';
  const keysByName = loadKeys({ envPath: typeof args.env === 'string' ? args.env : undefined, generate: true });
  const keys = { oracle: keysByName.ORACLE_WIF, migration: keysByName.MIGRATION_WIF, funder: keysByName.FUNDER_WIF };
  console.log(`funder (send tBCH here): ${keys.funder.address('bchtest')}`);
  console.log(`oracle pubkey:           ${keys.oracle.publicKeyHex}`);
  console.log(`migration key holder:    ${keys.migration.tokenAddress('bchtest')}`);
  const provider = chipnetProvider();
  const file = await deployParyon({
    provider, network, keys,
    statePath: typeof args.state === 'string' ? args.state : defaultStatePath(network),
    outPath: typeof args.out === 'string' ? args.out : defaultDeploymentPath(network),
    counts: args.profile === 'lean' ? LEAN_COUNTS : MAINNET_COUNTS,
    initialPriceCents: typeof args.price === 'string' ? Math.round(Number(args.price) * 100) : undefined,
    periodLengthBlocks: typeof args.period === 'string' ? Number(args.period) : undefined,
    feeRate: typeof args['fee-rate'] === 'string' ? Number(args['fee-rate']) : undefined,
    dryRun: args['dry-run'] === true,
  });
  console.log(`done. paryonTokenId=${file.tokenIds.paryonTokenId}`);
  console.log(`live price contract (guarded): ${file.contracts.priceContractGuarded?.address}`);
  console.log(`funder unused sats remain at ${keys.funder.address('bchtest')}; locking ${binToHex(keys.funder.lockingBytecode)}`);
}

if (isMain(import.meta.url)) {
  main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
