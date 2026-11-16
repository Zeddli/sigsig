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
import { buildContracts, contractList } from '../src/paryon.js';
import { addressToLockingBytecodeHex, buildParyonContracts, parseDeployment, PARYON_MAINNET_V1 } from '@sigsig/core';

describe('contract scripts match mainnet-v1', () => {
  // addresses observed in the 5 mainnet-v1 genesis txs and the 2026-10-08 price migration (block 972003)
  const MAINNET: Record<string, string> = {
    borrowing: 'pvszuucxz7fn4pthapvfk3xy8gxjhpvcm9yjt2przz44v5z2ax7v6alt8qj02',
    priceContract: 'p023vgef20u202932zvv9plt28nsldsxfsrext4ccsvlfu7gyp4vun3d2rxy7',
    priceContractGuarded: 'pdws0e456rwhzuxahv5jduryn493prvjrmu6ksegq052m5g048jp2tl4l6chh',
    'loanFunction.liquidate': 'p06pkzj5w6jp5nf2836c7p7hj4curhy6t9nn6daj7zy7h5ana0w8uqt0f48ta',
    'loanFunction.manage': 'pww8vdvl9g295z6cv3p957tgst80wgctlx8z8zrw90cyz6llgy00w8pz4987a',
    'loanFunction.redeem': 'pwgy3z54632pqwcjt6emj2slcr3zx2ljdvucqtr4nmelpnt62cuuukvaw0m9e',
    'loanFunction.startRedemption': 'pdt5j37f7w7g8xzpqvukkezj3a7pujvthseye5q3hfm8475tz3v9wqedsu2jt',
    'loanFunction.swapInRedemption': 'pvmnlq0vh2f9fdqxj4k4qtnn0f2f9eh6keqrl8qgzu9kjffsnta7q858guw45',
    'loanFunction.swapOutRedemption': 'p09kf5hjxaf3t4je9lntec9d0v35fxmrkyv4m3mll3qvsqaf08g2u9723ckjq',
    'loanFunction.payInterest': 'p0vcl8sa6tpnwzaevs880gwud5utclyzml9rtpcprj6vhdntfenyygfgvcuuu',
    'loanFunction.changeInterest': 'p0lq576jvw3s5rp8g2xxec3xa8h9fdklv3my0ugjrtavc4y07mky5c6j8vthy',
    stabilityPool: 'pvhcyg25jgh9kglyhgx4x7zg0clctza4ctcw373halce03pnyshncxg796vdx',
    stabilityPoolSidecar: 'pdl8y563h887re3r8g4sv76y29jt6vhtpzy9fc8qshmc8x30zjunj7cqx5ee3',
    'poolFunction.addLiquidity': 'p0v6t3v2ft5cka62ewzp9wnw3ff8hve7yzrzqdvp20vf2wmykqqn5gu2w9q0n',
    'poolFunction.liquidateLoan': 'pdfsvt88m9rm9u0vxpc33tqgcs0hrl2nc0j6tj497x06l0k7qtu0kgl4fzysr',
    'poolFunction.newPeriodPool': 'pvm0l8pkmcqq3yck3l9tgzunnfahn87ppvdqtxtkf43t374edlqgy6kqh277s',
    'poolFunction.withdrawFromPool': 'pda60jxpfzvzjfdn3kkgyk352qm5dp9k43fj5dgplmsapw3zkvkmjayjnh7m0',
    collector: 'pwddtrsws6ppc4hwjccgvllmhhfnhdvh2ttzjjsc6a5q45punwezqup0ytups',
    redeemer: 'pv9nj3e8w9fh32jt6j95wp7tp0tmfnuj6w4mptmg6zcn3w5yaq3vzwnh5tdlp',
    loanKeyFactory: 'pw2yket7tfmat5asn70y73aq7epw7lwxyj44hu22swqa9cp9ep0fckf6n3h4w',
  };
  it('core buildParyonContracts + our pool functions reproduce every mainnet-v1 address', () => {
    const list = new Map(contractList(buildContracts(PARYON_MAINNET_V1, new MockNetworkProvider())));
    for (const [name, addr] of Object.entries(MAINNET)) {
      expect(list.get(name)?.lockingBytecode, name).toBe(addressToLockingBytecodeHex(`bitcoincash:${addr}`));
    }
  });
});

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

    expect(Object.keys(file.contracts)).toHaveLength(27); // 26 genesis contracts + PriceContractGuarded
    const state = JSON.parse(readFileSync(opts.statePath, 'utf8')) as DeployState;
    expect(state.done).toBe(true);
    expect(state.prep.every((p) => p.broadcast)).toBe(true);
    // token id == prep txid, and the genesis tx spends its vout 0
    expect(file.tokenIds.paryonTokenId).toBe(state.prep[0]!.txid);

    await verifyDeployment(file, provider, { expectedOraclePubkey: keys.oracle.publicKeyHex, log: quiet });

    // like mainnet since block 972003: all price threads live on PriceContractGuarded, none on PriceContract
    expect(file.livePriceContract).toBe('priceContractGuarded');
    expect(file.priceMigrationTxIds).toHaveLength(5);
    const priceContract = priceContractFor(file, provider);
    expect(priceContract.lockingBytecode).toBe(file.contracts.priceContractGuarded!.lockingBytecode);
    const legacy = buildParyonContracts(parseDeployment(file), provider).price;
    expect(await readPriceUtxos(legacy, file.tokenIds.paryonTokenId)).toHaveLength(0);
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

  it('guarded contract enforces seq/deviation rules (tiny move with a non-heartbeat seq is rejected)', async () => {
    const { keys, opts, provider } = await setup(LEAN_COUNTS);
    const file = await deployParyon(opts);
    const common = {
      provider, priceContract: priceContractFor(file, provider), paryonTokenId: file.tokenIds.paryonTokenId,
      oracleKey: keys.oracle, feeKey: keys.funder, feeAddress: keys.funder.address('bchtest'), log: quiet,
    };
    await expect(updatePrice({ ...common, newPriceCents: 45_010, forceSeq: 1 })).rejects.toThrow(/heartbeat|deviation/i);
    await expect(updatePrice({ ...common, newPriceCents: 40_000, forceSeq: 0 })).rejects.toThrow(/more recent/i);
    await expect(updatePrice({ ...common, newPriceCents: 45_010, forceSeq: 10 })).resolves.toBeTruthy();
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
