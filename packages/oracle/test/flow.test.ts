import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, randomUtxo, type NetworkProvider } from 'cashscript';
import { deployParyon, type DeployState } from '../src/deploy-paryon-chipnet.js';
import { newKey } from '../src/keys.js';
import { LEAN_COUNTS, MAINNET_COUNTS, parsePriceCommitment, type GenesisCounts } from '../src/paryon.js';
import {
  encodePriceMessage, exceedsDeviation, nextContentSeq, priceContractFor, readPriceUtxos, signPriceMessage, updatePrice,
  verifyPriceSignature,
} from '../src/oracle.js';
import { verifyDeployment } from '../src/verify.js';

const quiet = () => {};

async function setup(counts: GenesisCounts, provider: NetworkProvider = new MockNetworkProvider()) {
  const keys = { oracle: newKey(), migration: newKey(), funder: newKey() };
  const dir = mkdtempSync(join(tmpdir(), 'sigsig-deploy-'));
  const mock = provider as MockNetworkProvider;
  mock.addUtxo(keys.funder.address('bchtest'), randomUtxo({ satoshis: 2_000_000n }));
  mock.addUtxo(keys.funder.address('bchtest'), randomUtxo({ satoshis: 500_000n }));
  const opts = {
    provider, network: 'mocknet' as const, keys, counts, log: quiet,
    statePath: join(dir, 'state.json'), outPath: join(dir, 'mocknet.json'),
  };
  return { keys, dir, opts, provider: mock };
}

describe('price message', () => {
  it('encodes 16 bytes LE and signs a checkDataSig-compatible schnorr sig', () => {
    const k = newKey();
    const msg = encodePriceMessage({ timestamp: 0x01020304, messageSeq: 7, contentSeq: 7, priceCents: 45_133 });
    expect(Buffer.from(msg).toString('hex')).toBe('04030201' + '07000000' + '07000000' + '4db00000');
    const sig = signPriceMessage(msg, k.privateKey);
    expect(sig.length).toBe(64);
    expect(verifyPriceSignature(msg, sig, k.publicKey)).toBe(true);
  });
  it('picks seq per the contract rules', () => {
    expect(exceedsDeviation(45_000, 45_225)).toBe(true); // exactly 0.5%
    expect(exceedsDeviation(45_000, 45_224)).toBe(false);
    expect(nextContentSeq({ seq: 3, priceCents: 45_000 }, 40_000)).toEqual({ seq: 4, heartbeat: false });
    expect(nextContentSeq({ seq: 3, priceCents: 45_000 }, 45_001)).toEqual({ seq: 10, heartbeat: true });
    expect(nextContentSeq({ seq: 10, priceCents: 45_000 }, 45_000)).toEqual({ seq: 20, heartbeat: true });
  });
});

describe('deploy Paryon into MockNetworkProvider, verify, update price', () => {
  it('mainnet-v1 counts: deploy → verify → crash → pump → heartbeat', async () => {
    const { keys, opts, provider } = await setup(MAINNET_COUNTS);
    const file = await deployParyon(opts);

    expect(Object.keys(file.contracts)).toHaveLength(26);
    const state = JSON.parse(readFileSync(opts.statePath, 'utf8')) as DeployState;
    expect(state.done).toBe(true);
    expect(state.prep.every((p) => p.broadcast)).toBe(true);
    // token id == prep txid, and the genesis tx spends its vout 0
    expect(file.tokenIds.paryonTokenId).toBe(state.prep[0]!.txid);

    await verifyDeployment(file, provider, { expectedOraclePubkey: keys.oracle.publicKeyHex, log: quiet });

    const priceContract = priceContractFor(file, provider);
    const before = await readPriceUtxos(priceContract, file.tokenIds.paryonTokenId);
    expect(before).toHaveLength(5);
    expect(before.every((p) => p.priceCents === 45_000 && p.seq === 0)).toBe(true);

    const common = {
      provider, priceContract, paryonTokenId: file.tokenIds.paryonTokenId, oracleKey: keys.oracle,
      feeKey: keys.funder, feeAddress: keys.funder.address('bchtest'), log: quiet,
    };
    // crash 20%: deviation → seq 1
    const r1 = await updatePrice({ ...common, newPriceCents: 36_000 });
    expect(r1.txids).toHaveLength(5);
    let now = await readPriceUtxos(priceContract, file.tokenIds.paryonTokenId);
    expect(now.map((p) => [p.seq, p.priceCents])).toEqual(Array(5).fill([1, 36_000]));

    // pump 10%
    await updatePrice({ ...common, newPriceCents: 39_600 });
    // tiny move (<0.5%) → must become a heartbeat at seq 10
    await updatePrice({ ...common, newPriceCents: 39_610 });
    now = await readPriceUtxos(priceContract, file.tokenIds.paryonTokenId);
    expect(now.map((p) => [p.seq, p.priceCents])).toEqual(Array(5).fill([10, 39_610]));
    const commitment = now[0]!.utxo.token!.nft!.commitment;
    expect(parsePriceCommitment(commitment)).toEqual({ seq: 10, priceCents: 39_610 });
  }, 120_000);

  it('rejects a price signed by a different key (contract enforces the oracle key)', async () => {
    const { keys, opts, provider } = await setup(LEAN_COUNTS);
    const file = await deployParyon(opts);
    const priceContract = priceContractFor(file, provider);
    await expect(updatePrice({
      provider, priceContract, paryonTokenId: file.tokenIds.paryonTokenId, oracleKey: newKey(),
      feeKey: keys.funder, feeAddress: keys.funder.address('bchtest'), newPriceCents: 30_000, log: quiet,
    })).rejects.toThrow(/checkDataSig|oracleSignature|PriceContract/i);
  }, 60_000);

  it('is resumable: a broadcast failure halfway leaves a state file that the next run completes', async () => {
    const inner = new MockNetworkProvider();
    let sends = 0;
    let failAt = 7; // fail on the 7th broadcast (genesis #2, after the 5 preps + paryon genesis)
    const flaky: NetworkProvider = {
      network: inner.network,
      getUtxos: (a) => inner.getUtxos(a),
      getUtxosForLockingBytecode: (l) => inner.getUtxosForLockingBytecode(l),
      getBlockHeight: () => inner.getBlockHeight(),
      getRawTransaction: (t) => inner.getRawTransaction(t),
      sendRawTransaction: async (hex) => {
        sends++;
        if (sends === failAt) throw new Error('simulated network failure');
        return inner.sendRawTransaction(hex);
      },
    };
    const { opts, keys } = await setup(LEAN_COUNTS, inner);
    await expect(deployParyon({ ...opts, provider: flaky })).rejects.toThrow('simulated network failure');
    const mid = JSON.parse(readFileSync(opts.statePath, 'utf8')) as DeployState;
    expect(mid.done).toBe(false);
    expect(mid.genesis.pool?.broadcast).toBe(false); // recorded before broadcast

    failAt = -1;
    const file = await deployParyon({ ...opts, provider: flaky });
    const done = JSON.parse(readFileSync(opts.statePath, 'utf8')) as DeployState;
    expect(done.done).toBe(true);
    expect(done.genesis.pool!.txid).toBe(mid.genesis.pool!.txid); // same tx re-sent, not rebuilt
    await verifyDeployment(file, inner, { expectedOraclePubkey: keys.oracle.publicKeyHex, log: quiet });
  }, 60_000);
});
