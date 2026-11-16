/**
 * End-to-end on MockNetworkProvider with the production builders (src/tx/vault.ts):
 * create loanKey -> borrow into the vault -> price crash -> defend -> price pump -> skim -> 2-of-3 pay (BCH, PUSD).
 * Every tx is evaluated by the 2026 VM through builder.debug() (Paryon scripts + Vault covenant) before broadcast.
 */
import { describe, expect, it } from 'vitest';
import { hexToBin } from '@bitauth/libauth';
import type { VaultPolicy } from '../src/types.js';
import { buildBorrow, buildCreateLoanKey } from '../src/tx/paryon.js';
import {
  buildCreateVaultState, buildDefend, buildPay, buildSkim, createPaymentRequest, createVaultTxContext, fetchVaultUtxos, signPayment,
  type VaultTxContext,
} from '../src/tx/vault.js';
import { payeeRoot } from '../src/vault/index.js';
import { findLoanPair } from '../src/paryon/finders.js';
import { makeFixture, makeKey, MOCK_DEPLOYMENT, type Fixture } from './paryon-fixture.js';

const signers = [makeKey('vs1'), makeKey('vs2'), makeKey('vs3')];
const payeeA = makeKey('payee-a');
const payeeB = makeKey('payee-b');
const stranger = makeKey('stranger');
const keeper = makeKey('keeper');
const PAYEES = [payeeA.lockingBytecode, payeeB.lockingBytecode];

const policy: VaultPolicy = {
  version: 1, defendCrBps: 15_000, targetCrBps: 17_000, skimCrBps: 25_000, keeperFeeMaxSats: 20_000,
  payeeRoot: payeeRoot(PAYEES), perPaymentMax: 1_000_000n, dailyBudget: 2_000_000n, dayIndex: 0, spentToday: 0n,
};

async function send(f: Fixture, built: { builder: { debug(): unknown }; txHex: string }) {
  built.builder.debug();
  return f.provider.sendRawTransaction(built.txHex);
}

/** $400/BCH: create loanKey -> mint the vault state (0.5 BCH buffer) -> borrow 200 PUSD against 1 BCH into the vault. */
async function openVault(): Promise<{ f: Fixture; v: VaultTxContext }> {
  const f = makeFixture({ priceCents: 40_000n });
  const lk = await buildCreateLoanKey(f.ctx, { wallet: await f.wallet() });
  await send(f, lk);
  const st = await buildCreateVaultState(f.ctx, {
    params: {
      paryonTokenId: MOCK_DEPLOYMENT.tokenIds.paryonTokenId,
      loanKeyCategory: lk.loanKeyCategory,
      signerPubkeys: [signers[0]!.pubHex, signers[1]!.pubHex, signers[2]!.pubHex],
      m: 2,
    },
    policy, bufferSats: 50_000_000n, wallet: await f.wallet(),
  });
  await send(f, st);
  const v = createVaultTxContext(f.ctx, st.params);
  expect(st.vaultTokenAddress).toBe(v.vault.tokenAddress);
  const borrow = await buildBorrow(f.ctx, {
    loanKeyCategory: lk.loanKeyCategory, borrowCents: 20_000n, collateralSats: 100_000_000n, startingInterestRate: 0,
    wallet: await f.wallet(), loanKeyDestination: v.vault.tokenAddress, pusdDestination: hexToBin(v.vault.lockingBytecode),
  });
  await send(f, borrow);
  return { f, v };
}

const collateral = async (f: Fixture, v: VaultTxContext) =>
  (await findLoanPair(f.provider, f.ctx.contracts, v.params.loanKeyCategory)).state;

describe('vault builders, full cycle on the mock network', () => {
  it('defend after a crash, skim after a pump, then 2-of-3 BCH and PUSD payments', async () => {
    const { f, v } = await openVault();
    expect((await fetchVaultUtxos(v)).pusd[0]!.token!.amount).toBe(20_000n);

    // crash to $280: CR 140% < defend 150% -> add 0.215 BCH to reach 170%
    f.setPrice(28_000n, 20);
    const defend = await buildDefend(v, { repayCents: 0n, addCollateralSats: 21_500_000n, feeClaimSats: 15_000n, rewardTo: keeper.address });
    expect(defend.decoded.title.length).toBeGreaterThan(0);
    await send(f, defend);
    expect((await collateral(f, v)).collateralSats).toBe(121_500_000n);
    const stateAfterDefend = (await fetchVaultUtxos(v)).state.satoshis;
    expect(stateAfterDefend).toBe(50_000_000n - 21_500_000n - 15_000n);
    expect((await f.provider.getUtxos(keeper.address)).length).toBe(1); // keeper reward = fee claim - miner fee

    // pump to $600: CR 364% > skim 250% -> withdraw down to >= 170%
    f.setPrice(60_000n, 30);
    const skim = await buildSkim(v, { withdrawSats: 64_000_000n, feeClaimSats: 15_000n, rewardTo: keeper.address });
    await send(f, skim);
    expect((await collateral(f, v)).collateralSats).toBe(57_500_000n);
    expect((await fetchVaultUtxos(v)).state.satoshis).toBe(stateAfterDefend + 64_000_000n - 15_000n);

    // 2-of-3 BCH payment, signatures collected separately
    const req = await createPaymentRequest(v, { payee: payeeA.lockingBytecode, payees: PAYEES, asset: 'BCH', amount: 100_000n, signers: [1, 3] });
    const unsigned = await buildPay(v, req);
    const s1 = signPayment(v, unsigned, signers[0]!.signer);
    const s3 = signPayment(v, unsigned, signers[2]!.signer);
    const paid = await buildPay(v, req, { 1: s1, 3: s3 });
    await send(f, paid);
    const got = await f.provider.getUtxos(payeeA.address);
    expect(got.some((u) => u.satoshis === 100_000n)).toBe(true);
    expect(paid.policyAfter.spentToday).toBe(paid.amountSats);

    // 5 PUSD payment: valued at the price ($600) against the same limits
    const reqP = await createPaymentRequest(v, { payee: payeeB.lockingBytecode, payees: PAYEES, asset: 'PUSD', amount: 500n, signers: [1, 2] });
    const unsignedP = await buildPay(v, reqP);
    const paidP = await buildPay(v, reqP, {
      1: signPayment(v, unsignedP, signers[0]!.signer), 2: signPayment(v, unsignedP, signers[1]!.signer),
    });
    await send(f, paidP);
    expect((await f.provider.getUtxos(payeeB.address)).some((u) => u.token?.amount === 500n)).toBe(true);
    expect((await fetchVaultUtxos(v)).pusd[0]!.token!.amount).toBe(19_500n);
  });

  it('defend by repaying 100 PUSD from the buffer', async () => {
    const { f, v } = await openVault();
    f.setPrice(28_000n, 20); // CR 140%; repaying 100 PUSD -> debt 100, CR 280%
    const defend = await buildDefend(v, { repayCents: 10_000n, addCollateralSats: 0n, feeClaimSats: 15_000n });
    await send(f, defend);
    expect((await collateral(f, v)).borrowedAmount).toBe(10_000n);
    expect((await fetchVaultUtxos(v)).pusd[0]!.token!.amount).toBe(10_000n);
  });

  it('refuses what the covenant would refuse', async () => {
    const { f, v } = await openVault();
    // healthy loan: defend is not allowed (covenant: CR not below defendCR)
    const d = await buildDefend(v, { repayCents: 0n, addCollateralSats: 1_000_000n, feeClaimSats: 15_000n });
    expect(() => d.builder.debug()).toThrow(/defend: CR is not below defendCR/);
    // fee claim over the policy cap
    f.setPrice(28_000n, 20);
    await expect(buildDefend(v, { repayCents: 0n, addCollateralSats: 21_500_000n, feeClaimSats: 30_000n })).rejects.toThrow(/keeperFeeMax/);
    // payee not on the allowlist
    await expect(async () => {
      const r = await createPaymentRequest(v, { payee: stranger.lockingBytecode, payees: PAYEES, asset: 'BCH', amount: 1_000n, signers: [1, 2] });
      await buildPay(v, r);
    }).rejects.toThrow();
    // over the per-payment limit
    const big = await createPaymentRequest(v, { payee: payeeA.lockingBytecode, payees: PAYEES, asset: 'BCH', amount: 1_500_000n, signers: [1, 2] });
    await expect(buildPay(v, big)).rejects.toThrow(/per-payment/);
    // one signature is not enough for m = 2
    const r1 = await createPaymentRequest(v, { payee: payeeA.lockingBytecode, payees: PAYEES, asset: 'BCH', amount: 1_000n, signers: [1] });
    const u1 = await buildPay(v, r1);
    const p1 = await buildPay(v, r1, { 1: signPayment(v, u1, signers[0]!.signer) });
    expect(() => p1.builder.debug()).toThrow(/not enough signatures/);
  });
});
