import { describe, expect, it } from 'vitest';
import { hexToBin } from '@bitauth/libauth';
import type { Utxo } from 'cashscript';
import { makeFixture, MOCK_DEPLOYMENT, PUSD_SUPPLY } from './paryon-fixture.js';
import {
  buildBorrow,
  buildChangeInterest,
  buildCreateLoanKey,
  buildManage,
  addManageParyonInputs,
  manageParyonOutputs,
  planManage,
} from '../src/tx/paryon.js';
import { newBuilder, walletUnlocker, type FundingWallet } from '../src/tx/common.js';
import { fetchManageContext, findLoanPair, findPriceUtxo } from '../src/paryon/finders.js';
import { decodeLoanCommitment } from '../src/paryon/codec.js';
import { borrowingFeeSats, crBps, maxBorrowCents } from '../src/health.js';
import { decodeTx } from '../src/decode.js';

const PARYON = MOCK_DEPLOYMENT.tokenIds.paryonTokenId;

async function sendBuilt(f: ReturnType<typeof makeFixture>, built: { builder: { debug(): unknown }; txHex: string }) {
  built.builder.debug(); // evaluates every input (Paryon scripts + P2PKH) in the BCH 2026 VM; throws on failure
  return f.provider.sendRawTransaction(built.txHex);
}

const keyOf = (w: FundingWallet, cat: string): Utxo => {
  const k = w.utxos.find((u) => u.token?.category === cat && u.token.nft?.capability === 'minting');
  if (!k) throw new Error('loan key not in wallet');
  return k;
};

/** create loan key + borrow 200 PUSD against 1 BCH at $400 */
async function openLoan(f: ReturnType<typeof makeFixture>) {
  const lk = await buildCreateLoanKey(f.ctx, { wallet: await f.wallet() });
  await sendBuilt(f, lk);
  const w = await f.wallet();
  const borrow = await buildBorrow(f.ctx, {
    loanKeyCategory: lk.loanKeyCategory,
    borrowCents: 20_000n,
    collateralSats: 100_000_000n,
    startingInterestRate: 100,
    wallet: w,
    loanKeyDestination: w.address,
    pusdDestination: w.address,
  });
  await sendBuilt(f, borrow);
  return { loanKeyCategory: lk.loanKeyCategory, lk, borrow };
}

describe('Paryon tx builders pass the real Paryon scripts (MockNetworkProvider)', () => {
  it('buildCreateLoanKey: LoanKeyFactory.create layout', async () => {
    const f = makeFixture();
    const lk = await buildCreateLoanKey(f.ctx, { wallet: await f.wallet() });
    expect(() => lk.builder.debug()).not.toThrow();
    expect(lk.sourceOutputs).toHaveLength(lk.decoded.inputs.length);
    expect(lk.decoded.title).toBe('Create Paryon loan key');
    await f.provider.sendRawTransaction(lk.txHex);
    const enforcers = await f.provider.getUtxosForLockingBytecode(f.ctx.contracts.loanKeyOriginEnforcer.lockingBytecode);
    expect(enforcers.some((u) => u.token?.category === lk.loanKeyCategory && u.token.nft?.capability === 'minting')).toBe(true);
  });

  it('buildBorrow: loan, sidecar, fee, loanKey and PUSD outputs; loanKey + PUSD to arbitrary destinations', async () => {
    const f = makeFixture();
    const { loanKeyCategory, borrow } = await openLoan(f);
    const d = borrow.decoded;
    expect(d.inputs.map((i) => i.label).slice(0, 4)).toEqual(['paryon-borrowing', 'paryon-price', 'unknown', 'unknown']);
    expect(d.outputs.map((o) => o.label).slice(0, 7)).toEqual([
      'paryon-borrowing', 'paryon-price', 'paryon-loan', 'paryon-sidecar', 'fee', 'change', 'change',
    ]);
    expect(d.outputs[4]!.sats).toBe(borrowingFeeSats(20_000n, 40_000n));
    expect(d.title).toContain('Borrow 200.00 PUSD');
    expect(d.checks.find((c) => c.id === 'cr-after-paryon')?.ok).toBe(true);

    const pair = await findLoanPair(f.provider, f.ctx.contracts, loanKeyCategory);
    expect(pair.state.borrowedAmount).toBe(20_000n);
    expect(pair.state.collateralSats).toBe(100_000_000n);
    expect(pair.state.currentInterestRate).toBe(100);
    expect(decodeLoanCommitment(pair.commitment).lastPeriodInterestPaid).toBe(5);
    const w = await f.wallet();
    expect(w.utxos.find((u) => u.token?.category === PARYON)?.token?.amount).toBe(20_000n);
    const borrowingUtxo = (await f.provider.getUtxosForLockingBytecode(f.ctx.contracts.borrowing.lockingBytecode))[0]!;
    expect(borrowingUtxo.token!.amount).toBe(PUSD_SUPPLY - 20_000n);
  });

  it('buildBorrow sends the loanKey and PUSD to a different address (e.g. a vault)', async () => {
    const f = makeFixture();
    const lk = await buildCreateLoanKey(f.ctx, { wallet: await f.wallet() });
    await sendBuilt(f, lk);
    const vault = f.ctx.contracts.loanKeyOriginProof.tokenAddress; // any token-aware P2SH destination
    const borrow = await buildBorrow(f.ctx, {
      loanKeyCategory: lk.loanKeyCategory, borrowCents: 15_000n, collateralSats: 60_000_000n, startingInterestRate: 0,
      wallet: await f.wallet(), loanKeyDestination: vault, pusdDestination: hexToBin(f.ctx.contracts.loanKeyOriginProof.lockingBytecode),
    });
    expect(() => borrow.builder.debug()).not.toThrow();
  });

  it('rejects a borrow above maxBorrow before building', async () => {
    const f = makeFixture();
    const lk = await buildCreateLoanKey(f.ctx, { wallet: await f.wallet() });
    await sendBuilt(f, lk);
    const max = maxBorrowCents(30_000_000n, 40_000n);
    const w = await f.wallet();
    await expect(
      buildBorrow(f.ctx, {
        loanKeyCategory: lk.loanKeyCategory, borrowCents: max + 1n, collateralSats: 30_000_000n, startingInterestRate: 0,
        wallet: w, loanKeyDestination: w.address, pusdDestination: w.address,
      }),
    ).rejects.toThrow(/exceeds max/);
  });

  it('buildManage: add collateral, then repay + withdraw, then changeInterest, then close', async () => {
    const f = makeFixture();
    const { loanKeyCategory } = await openLoan(f);

    // 1. add 0.1 BCH
    let w = await f.wallet();
    const add = await buildManage(f.ctx, {
      loanKeyCategory, loanKey: { utxo: keyOf(w, loanKeyCategory), unlocker: walletUnlocker(w) },
      collateralDeltaSats: 10_000_000n, wallet: w,
    });
    expect(add.decoded.inputs.slice(0, 4).map((i) => i.label)).toEqual(['paryon-price', 'paryon-loan', 'paryon-sidecar', 'paryon-function']);
    expect(add.decoded.title).toContain('add 0.10000000 BCH');
    await sendBuilt(f, add);
    let pair = await findLoanPair(f.provider, f.ctx.contracts, loanKeyCategory);
    expect(pair.state.collateralSats).toBe(110_000_000n);

    // 2. repay 100 PUSD and withdraw 0.05 BCH
    w = await f.wallet();
    const repay = await buildManage(f.ctx, {
      loanKeyCategory, loanKey: { utxo: keyOf(w, loanKeyCategory), unlocker: walletUnlocker(w) },
      repayCents: 10_000n, collateralDeltaSats: -5_000_000n, wallet: w,
    });
    expect(repay.decoded.outputs[5]!.label).toBe('burn');
    expect(repay.decoded.outputs[5]!.tokenAmount).toBe(10_000n);
    await sendBuilt(f, repay);
    pair = await findLoanPair(f.provider, f.ctx.contracts, loanKeyCategory);
    expect(pair.state.borrowedAmount).toBe(10_000n);
    expect(pair.state.collateralSats).toBe(105_000_000n);

    // 3. changeInterest
    w = await f.wallet();
    const ci = await buildChangeInterest(f.ctx, {
      loanKeyCategory, loanKey: { utxo: keyOf(w, loanKeyCategory), unlocker: walletUnlocker(w) }, nextInterestRate: 250, wallet: w,
    });
    expect(ci.decoded.title).toBe('Change next interest rate to 250');
    await sendBuilt(f, ci);
    pair = await findLoanPair(f.provider, f.ctx.contracts, loanKeyCategory);
    expect(pair.state.nextInterestRate).toBe(250);
    expect(pair.state.currentInterestRate).toBe(100);

    // 4. close: repay the remaining 100 PUSD
    w = await f.wallet();
    const close = await buildManage(f.ctx, {
      loanKeyCategory, loanKey: { utxo: keyOf(w, loanKeyCategory), unlocker: walletUnlocker(w) }, repayCents: 10_000n, wallet: w,
    });
    expect(close.decoded.title).toContain('Close loan');
    expect(close.decoded.outputs.slice(0, 4).map((o) => o.label)).toEqual(['paryon-price', 'paryon-function', 'burn', 'burn']);
    await sendBuilt(f, close);
    await expect(findLoanPair(f.provider, f.ctx.contracts, loanKeyCategory)).rejects.toThrow(/not found/);
  });

  it('manage outputs with a wrong loan commitment are rejected by the Paryon manage script', async () => {
    const f = makeFixture();
    const { loanKeyCategory } = await openLoan(f);
    const w = await f.wallet();
    const live = await fetchManageContext(f.provider, f.ctx.contracts, loanKeyCategory);
    const outcome = planManage(live, { repayCents: 0n, collateralDeltaSats: 1_000_000n, interestManagerConfiguration: '0000000000' });
    const outs = manageParyonOutputs(f.ctx, live, { ...outcome, newLoanCommitment: outcome.newLoanCommitment!.replace(/^01(..)/, '01ff') });
    const key = keyOf(w, loanKeyCategory);
    const fund = w.utxos.find((u) => !u.token)!;
    const b = addManageParyonInputs(newBuilder(f.ctx), f.ctx, live, { repayCents: 0n, interestManagerConfiguration: '0000000000' })
      .addInput(key, walletUnlocker(w))
      .addInput(fund, walletUnlocker(w))
      .addOutputs(outs)
      .addOutput({ to: w.address, amount: key.satoshis, token: key.token })
      .addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 });
    expect(() => b.debug()).toThrow(/wrong nftCommitment/);
  });

  it('planManage refuses withdrawals below 110% and repay below the minimum', async () => {
    const f = makeFixture();
    const { loanKeyCategory } = await openLoan(f);
    const live = await fetchManageContext(f.provider, f.ctx.contracts, loanKeyCategory);
    expect(() => planManage(live, { repayCents: 0n, collateralDeltaSats: -95_000_000n, interestManagerConfiguration: '0000000000' })).toThrow(/110%/);
    expect(() => planManage(live, { repayCents: 5_000n, collateralDeltaSats: 0n, interestManagerConfiguration: '0000000000' })).toThrow(/minimum/);
  });

  it('builds unsigned txs for wallet signing (placeholder unlockers, sourceOutputs for every input)', async () => {
    const f = makeFixture();
    const signed = await f.wallet();
    const unsigned: FundingWallet = { address: signed.address, utxos: signed.utxos };
    const lk = await buildCreateLoanKey(f.ctx, { wallet: unsigned });
    expect(lk.sourceOutputs).toHaveLength(2); // vout-0 UTXO covers the fee
    // factory input carries contract info for the wallet; wallet inputs have empty unlocking bytecode
    expect((lk.sourceOutputs[1] as { contract?: unknown }).contract).toBeDefined();
    expect(lk.sourceOutputs[0]!.unlockingBytecode.length).toBe(0);
    // decode round trip from hex
    const again = decodeTx(lk.txHex, lk.sourceOutputs, { network: 'mocknet', deployment: MOCK_DEPLOYMENT });
    expect(again.title).toBe(lk.decoded.title);
    expect(again.feeSats).toBe(lk.decoded.feeSats);
  });

  it('works with PriceContractGuarded (mainnet price threads since block 972,003): borrow burns the origin proof', async () => {
    const f = makeFixture({ guardedPrice: true });
    const { loanKeyCategory, borrow } = await openLoan(f);
    expect(borrow.decoded.inputs[1]!.label).toBe('paryon-price');
    const w = await f.wallet();
    const m = await buildManage(f.ctx, {
      loanKeyCategory, loanKey: { utxo: keyOf(w, loanKeyCategory), unlocker: walletUnlocker(w) }, repayCents: 10_000n, wallet: w,
    });
    await sendBuilt(f, m);
    const price = await findPriceUtxo(f.provider, f.ctx.contracts);
    expect(price.contract.lockingBytecode).toBe(f.ctx.contracts.priceGuarded.lockingBytecode);
  });

  it('finders read price and loan state', async () => {
    const f = makeFixture({ priceCents: 45_133n });
    const p = await findPriceUtxo(f.provider, f.ctx.contracts);
    expect(p.priceCents).toBe(45_133n);
    const { loanKeyCategory } = await openLoan(f);
    const pair = await findLoanPair(f.provider, f.ctx.contracts, loanKeyCategory);
    expect(crBps(pair.state.collateralSats, pair.state.borrowedAmount, 45_133n)).toBe(22566);
  });
});
