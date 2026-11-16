import { describe, expect, it } from 'vitest';
import { HashType, SignatureAlgorithm, SignatureTemplate, type TransactionBuilder } from 'cashscript';
import { Env, evaluateInputs, verifyTx, type Key } from './vault-fixtures.js';
import { payeeProof } from '../src/vault/payees.js';
import type { VaultPolicy } from '../src/types.js';

const DAY = 6000;
const HEIGHT = DAY * 144 + 10;

interface PayOpts {
  mode?: 'bch' | 'pusd';
  amount: bigint; // sats (bch) or cents (pusd)
  payee?: Key;
  proofFor?: Key;
  sigs?: Array<SignatureTemplate | Uint8Array>;
  locktime?: number;
  statePolicy?: Partial<VaultPolicy>;
  /** policy written to the output (default: what the covenant expects) */
  outPolicy?: Partial<VaultPolicy>;
  /** extra sats taken from the vault on top of the payment (to a stranger) */
  leak?: bigint;
  /** sats from the vault that go to the miner fee */
  vaultFee?: bigint;
  pusdBuffer?: bigint;
  priceCents?: number;
}

function buildPay(env: Env, o: PayOpts): TransactionBuilder {
  const mode = o.mode ?? 'bch';
  const payee = o.payee ?? env.payees[1]!;
  const proof = payeeProof(env.payees.map((p) => p.lockingBytecode), (o.proofFor ?? payee).lockingBytecode);
  const policy: VaultPolicy = { ...env.policy, ...o.statePolicy };
  const locktime = o.locktime ?? HEIGHT;
  const day = Math.floor(locktime / 144);
  const stateSats = 20_000_000n;
  const state = env.stateUtxo(stateSats, policy);
  const funder = env.signers[0]!;
  const feeIn = env.p2pkhUtxo(funder, 100_000n);
  const [s1, s2, s3] = o.sigs ?? env.sigs([env.signers[0]!, env.signers[1]!, null]);
  const unlock = env.vault.unlock.pay(s1!, s2!, s3!, proof);
  const leak = o.leak ?? 0n;
  const vaultFee = o.vaultFee ?? 0n;
  const b = env.builder().setLocktime(locktime);
  let spent: bigint;
  if (mode === 'bch') {
    spent = o.amount + leak + vaultFee;
    const out = { ...policy, dayIndex: day, spentToday: (day === policy.dayIndex ? policy.spentToday : 0n) + spent, ...o.outPolicy };
    b.addInput(state, unlock).addInput(feeIn, funder.sig.unlockP2PKH())
      .addOutput({ to: payee.lockingBytecode, amount: o.amount })
      .addOutput(env.stateOutput(stateSats - spent, out));
  } else {
    const priceCents = o.priceCents ?? 40000;
    const price = env.priceUtxo(priceCents);
    const buffer = o.pusdBuffer ?? 50_000n;
    const pusd = env.pusdUtxo(buffer);
    spent = (o.amount * 100_000_000n + BigInt(priceCents) - 1n) / BigInt(priceCents) + leak + vaultFee;
    const out = { ...policy, dayIndex: day, spentToday: (day === policy.dayIndex ? policy.spentToday : 0n) + spent, ...o.outPolicy };
    b.addInput(state, unlock).addInput(price, env.price.unlock.sharePrice!()).addInput(pusd, unlock)
      .addInput(feeIn, funder.sig.unlockP2PKH())
      .addOutput(env.pusdOutput(o.amount, payee.lockingBytecode))
      .addOutput(env.same(price, env.price.lockingBytecode))
      .addOutput(env.stateOutput(stateSats - leak - vaultFee, out));
    if (buffer > o.amount) b.addOutput(env.pusdOutput(buffer - o.amount));
  }
  if (leak > 0n) b.addOutput({ to: env.stranger.lockingBytecode, amount: leak });
  const inSum = b.inputs.reduce((t, i) => t + i.satoshis, 0n);
  const outSum = b.outputs.reduce((t, x) => t + x.amount, 0n);
  b.addOutput({ to: funder.lockingBytecode, amount: inSum - outSum - 8000n });
  return b;
}

const expectReject = (env: Env, b: TransactionBuilder, message: string) => {
  const r = evaluateInputs(env, b);
  expect(r[0], JSON.stringify(r)).toMatchObject({ ok: false, message });
  expect(verifyTx(b)).not.toBe(true);
};

describe('Vault.pay', () => {
  it('pays BCH to an allowlisted payee with 2 of 3 Schnorr signatures (positive)', async () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n });
    const r = evaluateInputs(env, b);
    expect(r.every((x) => x.ok), JSON.stringify(r)).toBe(true);
    expect(verifyTx(b)).toBe(true);
    await b.send();
  });

  it('accepts signers in any 2 slots, ECDSA too (positive)', () => {
    const env = new Env();
    const ecdsa = new SignatureTemplate(env.signers[2]!.priv, HashType.SIGHASH_ALL | HashType.SIGHASH_UTXOS, SignatureAlgorithm.ECDSA);
    const b = buildPay(env, { amount: 1_000_000n, sigs: env.sigs([null, env.signers[1]!, ecdsa]) });
    expect(evaluateInputs(env, b).every((x) => x.ok)).toBe(true);
    expect(verifyTx(b)).toBe(true);
  });

  it('pays PUSD, valued in sats at the PriceContract price (positive)', async () => {
    const env = new Env();
    const b = buildPay(env, { mode: 'pusd', amount: 1500n }); // $15 at $400 = 3.75M sats
    const r = evaluateInputs(env, b);
    expect(r.every((x) => x.ok), JSON.stringify(r)).toBe(true);
    expect(verifyTx(b)).toBe(true);
    await b.send();
  });

  it('allows the vault to pay the tx fee up to keeperFeeMax (positive)', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, vaultFee: 3000n });
    expect(evaluateInputs(env, b).every((x) => x.ok)).toBe(true);
  });

  it('resets the daily budget on a new day (positive)', () => {
    const env = new Env();
    const b = buildPay(env, {
      amount: 4_000_000n, statePolicy: { spentToday: 7_000_000n }, locktime: (DAY + 1) * 144 + 3,
    });
    expect(evaluateInputs(env, b).every((x) => x.ok)).toBe(true);
    expect(verifyTx(b)).toBe(true);
  });

  it('rejects: same-day spend over the budget (no reset)', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 4_000_000n, statePolicy: { spentToday: 7_000_000n } });
    expectReject(env, b, 'pay: over daily budget');
  });

  it('rejects: over the daily budget in PUSD', () => {
    const env = new Env();
    const b = buildPay(env, { mode: 'pusd', amount: 1500n, statePolicy: { spentToday: 5_000_000n } });
    expectReject(env, b, 'pay: over daily budget');
  });

  it('rejects: over the per-payment limit', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 5_000_001n });
    expectReject(env, b, 'pay: over per-payment limit');
  });

  it('rejects: over the per-payment limit in PUSD', () => {
    const env = new Env();
    const b = buildPay(env, { mode: 'pusd', amount: 2001n }); // 5,002,500 sats
    expectReject(env, b, 'pay: over per-payment limit');
  });

  it('rejects: payee not allowed', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, payee: env.stranger, proofFor: env.payees[1]! });
    expectReject(env, b, 'pay: payee not allowed');
  });

  it('rejects: BCH to a non-payee output beyond the fee cap', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, leak: 3001n });
    expectReject(env, b, 'pay: BCH leaves to a non-payee output (fee over cap)');
  });

  it('rejects: day going backwards (to reset the budget)', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, locktime: (DAY - 1) * 144 });
    expectReject(env, b, 'pay: day must not go backwards');
  });

  it('rejects: state not recording the spend', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, outPolicy: { spentToday: 0n } });
    expectReject(env, b, 'pay: state must record the new day and spend');
  });

  it('rejects: too few signatures', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, sigs: env.sigs([env.signers[0]!, null, null]) });
    expectReject(env, b, 'pay: not enough signatures');
  });

  it('rejects: signature from a wrong key (NULLFAIL)', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, sigs: env.sigs([env.stranger, env.signers[1]!, null]) });
    const r = evaluateInputs(env, b);
    expect(r[0]!.ok).toBe(false);
    expect(r[0]!.error).toMatch(/signature/i);
    expect(verifyTx(b)).not.toBe(true);
  });

  it('rejects: signer key in the wrong slot', () => {
    const env = new Env();
    const b = buildPay(env, { amount: 1_000_000n, sigs: env.sigs([env.signers[1]!, env.signers[0]!, null]) });
    expect(evaluateInputs(env, b)[0]!.ok).toBe(false);
  });

  it('1-of-3 vault accepts one signature (positive)', () => {
    const env = new Env(1);
    const b = buildPay(env, { amount: 1_000_000n, sigs: env.sigs([null, null, env.signers[2]!]) });
    expect(evaluateInputs(env, b).every((x) => x.ok)).toBe(true);
  });
});
