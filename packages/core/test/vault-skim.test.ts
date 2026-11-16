import { describe, expect, it } from 'vitest';
import { buildManageTx, Env, evaluateInputs, verifyTx, type ManageScenario } from './vault-fixtures.js';

// 1 BCH collateral, 250.00 PUSD debt. At $600 the CR is 240% (> skimCR 200%).
const high: ManageScenario = { priceCents: 60000, debt: 25000n, coll: 100_000_000n, stateSats: 5_000_000n };

const expectVaultReject = (env: Env, b: ReturnType<typeof buildManageTx>, message: string, input = 5) => {
  const r = evaluateInputs(env, b);
  expect(r[input], JSON.stringify(r)).toMatchObject({ ok: false, message });
  expect(verifyTx(b)).not.toBe(true);
};

describe('Vault.skim', () => {
  it('withdraws excess collateral into the StateUTXO minus the keeper fee (positive)', async () => {
    const env = new Env();
    // -0.25 BCH → CR 180% >= target 170%
    const b = buildManageTx(env, high, { fn: 'skim', addColl: -25_000_000n, vaultFee: 3000n });
    const r = evaluateInputs(env, b);
    expect(r.every((x) => x.ok), JSON.stringify(r)).toBe(true);
    expect(verifyTx(b)).toBe(true);
    await b.send();
  });

  it('rejects: CR not above skimCR', () => {
    const env = new Env();
    const b = buildManageTx(env, { ...high, priceCents: 45000 }, { fn: 'skim', addColl: -1_000_000n });
    expectVaultReject(env, b, 'skim: CR is not above skimCR');
  });

  it('rejects: CR after below targetCR (Paryon would allow it)', () => {
    const env = new Env();
    const b = buildManageTx(env, high, { fn: 'skim', addColl: -35_000_000n });
    expect(evaluateInputs(env, b)[3]!.ok).toBe(true);
    expectVaultReject(env, b, 'skim: CR after is below targetCR');
  });

  it('rejects: withdrawn collateral to a stranger', () => {
    const env = new Env();
    const b = buildManageTx(env, high, {
      fn: 'skim', addColl: -25_000_000n, stateOutSats: high.stateSats + 20_000_000n,
      extraOutputs: [{ to: env.stranger.lockingBytecode, amount: 5_000_000n }],
    });
    expectVaultReject(env, b, 'skim: withdrawn collateral must go to the buffer (fee over cap)');
  });

  it('rejects: fee over cap', () => {
    const env = new Env();
    const b = buildManageTx(env, high, { fn: 'skim', addColl: -25_000_000n, vaultFee: 3001n });
    expectVaultReject(env, b, 'skim: withdrawn collateral must go to the buffer (fee over cap)');
  });

  it('rejects: redemption pending', () => {
    const env = new Env();
    const b = buildManageTx(env, { ...high, redeeming: 1000n }, { fn: 'skim', addColl: -25_000_000n });
    expectVaultReject(env, b, 'skim: redemption pending');
  });

  it('rejects: debt change (repay during skim)', () => {
    const env = new Env();
    const b = buildManageTx(env, { ...high, pusd: 20000n }, { fn: 'skim', addColl: -1_000_000n, repay: 10000n });
    expectVaultReject(env, b, 'skim: loan state (debt) must not change');
  });

  it('rejects: no withdrawal', () => {
    const env = new Env();
    const b = buildManageTx(env, high, { fn: 'skim', addColl: 1000n, stateOutSats: high.stateSats - 1000n });
    expectVaultReject(env, b, 'skim: must withdraw collateral');
  });

  it('rejects: wrong Paryon function NFT at input 3', () => {
    const env = new Env();
    const b = buildManageTx(env, high, { fn: 'skim', addColl: -25_000_000n, fnAtInput3: 'changeInterest' });
    expectVaultReject(env, b, 'skim: input 3 must be the manage function');
  });
});
