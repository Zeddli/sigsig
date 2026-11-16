import { describe, expect, it } from 'vitest';
import { buildManageTx, Env, evaluateInputs, verifyTx, type ManageScenario } from './vault-fixtures.js';

// 1 BCH collateral, 250.00 PUSD debt. At $360 the CR is 144% (< defendCR 150%).
const low: ManageScenario = { priceCents: 36000, debt: 25000n, coll: 100_000_000n, stateSats: 30_000_000n };

const expectVaultReject = (env: Env, b: ReturnType<typeof buildManageTx>, message: string, input = 5) => {
  const r = evaluateInputs(env, b);
  expect(r[input], JSON.stringify(r)).toMatchObject({ ok: false, message });
  expect(verifyTx(b)).not.toBe(true);
};

describe('Vault.defend', () => {
  it('adds BCH collateral from the buffer and pays the keeper fee (positive)', async () => {
    const env = new Env();
    // +0.2 BCH → CR 172.8% >= target 170%
    const b = buildManageTx(env, low, { fn: 'defend', addColl: 20_000_000n, vaultFee: 3000n });
    const r = evaluateInputs(env, b);
    expect(r.every((x) => x.ok), JSON.stringify(r)).toBe(true);
    expect(verifyTx(b)).toBe(true);
    await b.send();
  });

  it('repays with buffer PUSD (>= 100.00 PUSD, Paryon minimum) and burns it (positive)', async () => {
    const env = new Env();
    const s = { ...low, pusd: 20000n };
    const b = buildManageTx(env, s, { fn: 'defend', repay: 10000n, vaultFee: 2000n });
    expect(evaluateInputs(env, b).every((x) => x.ok)).toBe(true);
    expect(verifyTx(b)).toBe(true);
    await b.send();
  });

  it('PUSD repay below 100.00 PUSD is impossible (Paryon manage rejects it); small defends must add BCH', () => {
    const env = new Env();
    const s = { ...low, pusd: 20000n };
    const b = buildManageTx(env, s, { fn: 'defend', repay: 5000n, addColl: 20_000_000n });
    const r = evaluateInputs(env, b);
    expect(r[3]!.ok).toBe(false); // Paryon manage
    expect(verifyTx(b)).not.toBe(true);
  });

  it('allows ending below targetCR when the buffer is used up (positive)', async () => {
    const env = new Env();
    const s = { ...low, stateSats: 5_000_000n };
    // all but 2000 sats of the buffer into collateral: CR 151.2% < target, buffer exhausted
    const b = buildManageTx(env, s, { fn: 'defend', addColl: 5_000_000n - 2000n - 0n, vaultFee: 0n });
    expect(evaluateInputs(env, b).every((x) => x.ok)).toBe(true);
    await b.send();
  });

  it('rejects: CR after below target while buffer remains', () => {
    const env = new Env();
    const b = buildManageTx(env, low, { fn: 'defend', addColl: 5_000_000n });
    expectVaultReject(env, b, 'defend: CR after is below targetCR and the buffer is not used up');
  });

  it('rejects: buffer exhausted in BCH but >= 100 PUSD left on the PusdUTXO', () => {
    const env = new Env();
    const s = { ...low, stateSats: 5_000_000n, pusd: 30000n };
    const b = buildManageTx(env, s, { fn: 'defend', addColl: 5_000_000n - 2000n, repay: 10000n });
    // debt 150.00, coll 1.05 BCH → CR 252% → target reached, so this passes; make PUSD unused instead:
    const b2 = buildManageTx(env, s, { fn: 'defend', addColl: 5_000_000n - 2000n, pusdOut: 30000n });
    expect(evaluateInputs(env, b).every((x) => x.ok)).toBe(true);
    expectVaultReject(env, b2, 'defend: CR after is below targetCR and the buffer is not used up');
  });

  it('rejects: CR not below defendCR (no buffer griefing)', () => {
    const env = new Env();
    const b = buildManageTx(env, { ...low, priceCents: 40000 }, { fn: 'defend', addColl: 1_000_000n });
    expectVaultReject(env, b, 'defend: CR is not below defendCR');
  });

  it('rejects: debt up (Paryon rejects it too)', () => {
    const env = new Env();
    const b = buildManageTx(env, low, { fn: 'defend', addColl: 20_000_000n, newDebtOverride: 26000n });
    const r = evaluateInputs(env, b);
    expect(r[3]!.ok).toBe(false);
    expect(r[5]).toMatchObject({ ok: false, message: 'defend: debt must not increase' });
  });

  it('rejects: collateral down (repay + withdraw)', () => {
    const env = new Env();
    const s = { ...low, pusd: 20000n };
    const b = buildManageTx(env, s, { fn: 'defend', repay: 10000n, addColl: -1_000_000n });
    const r = evaluateInputs(env, b);
    expect(r[3]!.ok).toBe(true); // Paryon allows it
    expectVaultReject(env, b, 'defend: collateral must not decrease');
  });

  it('rejects: no improvement', () => {
    const env = new Env();
    const b = buildManageTx(env, low, { fn: 'defend' });
    expectVaultReject(env, b, 'defend: position must improve');
  });

  it('rejects: fee over cap', () => {
    const env = new Env();
    const b = buildManageTx(env, low, { fn: 'defend', addColl: 20_000_000n, vaultFee: 3001n });
    expectVaultReject(env, b, 'defend: buffer BCH spent beyond collateral + fee cap');
  });

  it('rejects: buffer BCH to a stranger', () => {
    const env = new Env();
    const b = buildManageTx(env, low, {
      fn: 'defend', addColl: 20_000_000n, vaultFee: 50_000n,
      extraOutputs: [{ to: env.stranger.lockingBytecode, amount: 50_000n }],
    });
    expectVaultReject(env, b, 'defend: buffer BCH spent beyond collateral + fee cap');
  });

  it('rejects: buffer PUSD to a stranger', () => {
    const env = new Env();
    const s = { ...low, pusd: 30000n };
    const b = buildManageTx(env, s, {
      fn: 'defend', repay: 10000n, pusdOut: 10000n,
      extraOutputs: [env.pusdOutput(10000n, env.stranger.lockingBytecode)],
    });
    // the PUSD output to the stranger is caught by the token rule on extra outputs
    expectVaultReject(env, b, 'defend: extra outputs must not carry tokens');
  });

  it('rejects: wrong Paryon function NFT at input 3', () => {
    const env = new Env();
    const b = buildManageTx(env, low, { fn: 'defend', addColl: 20_000_000n, fnAtInput3: 'changeInterest' });
    expectVaultReject(env, b, 'defend: input 3 must be the manage function');
  });

  it('rejects: changing the loan interest manager config', () => {
    const env = new Env();
    const b = buildManageTx(env, low, { fn: 'defend', addColl: 20_000_000n, imcOut: '0100000000' });
    expectVaultReject(env, b, 'defend: only the debt may change in the loan state');
  });
});
