import { describe, expect, it } from 'vitest';
import { binToHex } from '@bitauth/libauth';
import type { TransactionBuilder } from 'cashscript';
import { buildManageTx, Env, evaluateInputs, IMC, loanCommitment, verifyTx, type ManageScenario } from './vault-fixtures.js';
import { encodePolicyFields } from '../src/vault/state.js';
import { payeeProof } from '../src/vault/payees.js';

const loanS: ManageScenario = { priceCents: 40000, debt: 25000n, coll: 100_000_000n, stateSats: 5_000_000n };
const allOk = (env: Env, b: TransactionBuilder) => {
  const r = evaluateInputs(env, b);
  expect(r.every((x) => x.ok), JSON.stringify(r)).toBe(true);
  expect(verifyTx(b)).toBe(true);
};
const rejectAt = (env: Env, b: TransactionBuilder, input: number, message: string) => {
  const r = evaluateInputs(env, b);
  expect(r[input], JSON.stringify(r)).toMatchObject({ ok: false, message });
  expect(verifyTx(b)).not.toBe(true);
};
const change = (env: Env, b: TransactionBuilder, fee = 8000n) => {
  const inSum = b.inputs.reduce((t, i) => t + i.satoshis, 0n);
  const outSum = b.outputs.reduce((t, x) => t + x.amount, 0n);
  b.addOutput({ to: env.signers[0]!.lockingBytecode, amount: inSum - outSum - fee });
};

describe('Vault.adminManage', () => {
  it('withdraws collateral with 2 of 3 signatures (positive)', async () => {
    const env = new Env();
    const b = buildManageTx(env, loanS, { fn: 'adminManage', addColl: -10_000_000n, stateOutSats: loanS.stateSats });
    allOk(env, b);
    await b.send();
  });
  it('rejects: too few signatures', () => {
    const env = new Env();
    const b = buildManageTx(env, loanS, {
      fn: 'adminManage', addColl: -10_000_000n, stateOutSats: loanS.stateSats, sigs: env.sigs([env.signers[0]!, null, null]),
    });
    rejectAt(env, b, 5, 'adminManage: not enough signatures');
  });
  it('rejects: wrong Paryon function NFT', () => {
    const env = new Env();
    const b = buildManageTx(env, loanS, { fn: 'adminManage', addColl: -1n * 1_000_000n, stateOutSats: loanS.stateSats, fnAtInput3: 'changeInterest' });
    rejectAt(env, b, 5, 'adminManage: input 3 must be the manage function');
  });
});

function buildInterest(env: Env, sigs = env.sigs([env.signers[0]!, null, env.signers[2]!])): TransactionBuilder {
  const { loan, sidecar } = env.loanUtxos(25000n, 100_000_000n);
  const fn = env.fnUtxo(env.changeInterestFn, '08');
  const key = env.keyUtxo();
  const state = env.stateUtxo(5_000_000n);
  const feeIn = env.p2pkhUtxo(env.signers[0]!, 100_000n);
  const unlock = env.vault.unlock.adminInterest(sigs[0]!, sigs[1]!, sigs[2]!);
  const nextRate = '2c01'; // 300
  const newLoan = loanCommitment(25000n).slice(0, 40) + nextRate + IMC;
  const b = env.builder()
    .addInput(loan, env.loan.unlock.interact!())
    .addInput(sidecar, env.sidecar.unlock.attach!())
    .addInput(fn, env.changeInterestFn.unlock.changeInterest!(nextRate))
    .addInput(key, unlock)
    .addInput(state, unlock)
    .addInput(feeIn, env.signers[0]!.sig.unlockP2PKH())
    .addOutput(env.same(loan, env.loan.lockingBytecode, {
      token: { category: env.ids.paryon, amount: 0n, nft: { capability: 'mutable', commitment: newLoan } },
    }))
    .addOutput(env.same(sidecar, env.sidecar.lockingBytecode))
    .addOutput(env.same(fn, env.changeInterestFn.lockingBytecode))
    .addOutput(env.keyOutput())
    .addOutput(env.stateOutput(5_000_000n, env.policy));
  change(env, b);
  return b;
}

describe('Vault.adminInterest', () => {
  it('changes the next interest rate through Paryon changeInterest (positive)', async () => {
    const env = new Env();
    const b = buildInterest(env);
    allOk(env, b);
    await b.send();
  });
  it('rejects: too few signatures', () => {
    const env = new Env();
    const b = buildInterest(env, env.sigs([null, null, env.signers[2]!]));
    rejectAt(env, b, 4, 'adminInterest: not enough signatures');
  });
});

describe('Vault.adminPolicy', () => {
  const build = (env: Env, opts: { sigs?: ReturnType<Env['sigs']>; keepDay?: boolean } = {}) => {
    const cur = { ...env.policy, spentToday: 1_234n };
    const state = env.stateUtxo(5_000_000n, cur);
    const next = { ...cur, perPaymentMax: 9_000_000n, dailyBudget: 20_000_000n };
    const sigs = opts.sigs ?? env.sigs([env.signers[0]!, env.signers[1]!, null]);
    const b = env.builder()
      .addInput(state, env.vault.unlock.adminPolicy(sigs[0]!, sigs[1]!, sigs[2]!, binToHex(encodePolicyFields(next))))
      .addInput(env.p2pkhUtxo(env.signers[0]!, 100_000n), env.signers[0]!.sig.unlockP2PKH())
      .addOutput(env.stateOutput(5_000_000n, opts.keepDay === false ? { ...next, spentToday: 0n } : next));
    change(env, b);
    return b;
  };
  it('rewrites the policy and keeps the day fields (positive)', async () => {
    const env = new Env();
    const b = build(env);
    allOk(env, b);
    await b.send();
  });
  it('rejects: resetting spentToday', () => {
    const env = new Env();
    rejectAt(env, build(env, { keepDay: false }), 0, 'adminPolicy: day fields must be kept');
  });
  it('rejects: too few signatures', () => {
    const env = new Env();
    rejectAt(env, build(env, { sigs: env.sigs([null, null, env.signers[2]!]) }), 0, 'adminPolicy: not enough signatures');
  });
});

describe('Vault.exit', () => {
  const build = (env: Env, sigs = env.sigs([null, env.signers[1]!, env.signers[2]!])) => {
    const state = env.stateUtxo(5_000_000n);
    const key = env.keyUtxo();
    const pusd = env.pusdUtxo(40_000n);
    const unlock = env.vault.unlock.exit(sigs[0]!, sigs[1]!, sigs[2]!);
    const to = env.signers[1]!.lockingBytecode;
    const b = env.builder()
      .addInput(state, unlock).addInput(key, unlock).addInput(pusd, unlock)
      .addOutput({ to, amount: 1000n, token: state.token })
      .addOutput({ to, amount: 1000n, token: key.token })
      .addOutput({ to, amount: 1000n, token: pusd.token });
    change(env, b);
    return b;
  };
  it('sweeps state, key and PUSD to a signer (positive)', async () => {
    const env = new Env();
    const b = build(env);
    allOk(env, b);
    await b.send();
  });
  it('rejects: too few signatures', () => {
    const env = new Env();
    rejectAt(env, build(env, env.sigs([null, env.signers[1]!, null])), 0, 'exit: not enough signatures');
  });
});

describe('cross-function and sibling rules', () => {
  it('rejects: the loanKey riding along a pay (key runs exit, state runs pay)', () => {
    const env = new Env();
    const payee = env.payees[0]!;
    const state = env.stateUtxo(20_000_000n);
    const key = env.keyUtxo();
    const proof = payeeProof(env.payees.map((p) => p.lockingBytecode), payee.lockingBytecode);
    const [a, b2, c] = env.sigs([env.signers[0]!, env.signers[1]!, null]);
    const day = Math.floor((6000 * 144 + 1) / 144);
    const b = env.builder().setLocktime(6000 * 144 + 1)
      .addInput(state, env.vault.unlock.pay(a!, b2!, c!, proof))
      .addInput(env.p2pkhUtxo(env.signers[0]!, 100_000n), env.signers[0]!.sig.unlockP2PKH())
      .addInput(key, env.vault.unlock.exit(a!, b2!, c!))
      .addOutput({ to: payee.lockingBytecode, amount: 1_000_000n })
      .addOutput(env.stateOutput(19_000_000n, { ...env.policy, dayIndex: day, spentToday: 1_000_000n }))
      .addOutput({ to: env.stranger.lockingBytecode, amount: 1000n, token: key.token });
    change(env, b);
    const r = evaluateInputs(env, b);
    expect(r[2]!.ok).toBe(true); // exit delegate alone is satisfied ...
    expect(r[0]).toMatchObject({ ok: false, message: 'pay: unexpected vault input' }); // ... but pay forbids it
    expect(verifyTx(b)).not.toBe(true);
  });

  it('rejects: KeyUTXO spent without the StateUTXO', () => {
    const env = new Env();
    const k = env.keeper;
    const key = env.keyUtxo();
    const b = env.builder();
    for (let i = 0; i < 4; i++) b.addInput(env.p2pkhUtxo(k, 10_000n), k.sig.unlockP2PKH());
    b.addInput(key, env.vault.unlock.skim())
      .addInput(env.p2pkhUtxo(k, 10_000n), k.sig.unlockP2PKH())
      .addOutput({ to: env.stranger.lockingBytecode, amount: 1000n, token: key.token });
    change(env, b);
    rejectAt(env, b, 4, 'skim: input 5 must be the vault state');
  });
});
