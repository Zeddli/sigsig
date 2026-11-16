import { describe, expect, it } from 'vitest';
import { MockNetworkProvider } from 'cashscript';
import { makeFixture, makeKey, id32, MOCK_DEPLOYMENT } from './paryon-fixture.js';
import { buildBorrow, buildCreateLoanKey, buildManage } from '../src/tx/paryon.js';
import { walletUnlocker } from '../src/tx/common.js';
import { ElectrumVaultReader, type VaultAdapter } from '../src/reader.js';
import { decodeTx } from '../src/decode.js';
import { buildParyonContracts } from '../src/paryon/contracts.js';
import { PARYON_MAINNET_V1, parseDeployment, serializeDeployment, getNetworkProfile } from '../src/network.js';
import type { VaultParams, VaultPolicy } from '../src/types.js';

const POLICY: VaultPolicy = {
  version: 1, defendCrBps: 13_000, targetCrBps: 15_000, skimCrBps: 20_000, keeperFeeMaxSats: 5_000,
  payeeRoot: '00'.repeat(20), perPaymentMax: 5_000n, dailyBudget: 8_000n, dayIndex: 900, spentToday: 1_000n,
};

/** Set up a loan whose key + PUSD sit at a fake "vault" P2PKH, plus a state NFT there. */
async function vaultSetup() {
  const f = makeFixture();
  const vaultKey = makeKey('vault');
  const lk = await buildCreateLoanKey(f.ctx, { wallet: await f.wallet() });
  await f.provider.sendRawTransaction(lk.txHex);
  const borrow = await buildBorrow(f.ctx, {
    loanKeyCategory: lk.loanKeyCategory, borrowCents: 20_000n, collateralSats: 100_000_000n, startingInterestRate: 50,
    wallet: await f.wallet(), loanKeyDestination: vaultKey.address, pusdDestination: vaultKey.address,
  });
  borrow.builder.debug();
  await f.provider.sendRawTransaction(borrow.txHex);
  const stateCategory = id32('state');
  f.provider.addUtxo(vaultKey.lockingBytecode, {
    txid: id32('state-tx'), vout: 0, satoshis: 50_000_000n,
    token: { category: stateCategory, amount: 0n, nft: { capability: 'mutable', commitment: 'aa'.repeat(52) } },
  });
  const params: VaultParams = {
    paryonTokenId: MOCK_DEPLOYMENT.tokenIds.paryonTokenId, loanKeyCategory: lk.loanKeyCategory, stateCategory,
    signerPubkeys: [makeKey('s1').pubHex, makeKey('s2').pubHex, makeKey('s3').pubHex], m: 2,
  };
  const adapter: VaultAdapter = { lockingBytecode: () => vaultKey.lockingBytecode, decodePolicy: () => POLICY };
  return { f, vaultKey, params, adapter };
}

describe('ElectrumVaultReader (over MockNetworkProvider)', () => {
  it('reads policy, loan, price, health and buffer', async () => {
    const { f, params, adapter } = await vaultSetup();
    const r = new ElectrumVaultReader({ network: 'mocknet', deployment: MOCK_DEPLOYMENT, provider: f.provider, vault: adapter, contracts: f.ctx.contracts });
    expect(await r.getPriceCents()).toBe(40_000n);
    expect(await r.getPolicy(params)).toEqual(POLICY);
    expect((await r.getLoan(params)).borrowedAmount).toBe(20_000n);
    expect(await r.getBuffer(params)).toEqual({ sats: 50_000_000n, pusdCents: 20_000n });
    const h = await r.getHealth(params);
    expect(h).toMatchObject({ crBps: 20_000, status: 'safe', maxBorrowCents: 36_363n });
  });
});

describe('decodeTx', () => {
  it('labels a vault-key manage tx and runs CR / allowlist / key checks', async () => {
    const { f, vaultKey, params } = await vaultSetup();
    const vaultUtxos = await f.provider.getUtxosForLockingBytecode(vaultKey.lockingBytecode);
    const key = vaultUtxos.find((u) => u.token?.category === params.loanKeyCategory)!;
    // Unsigned build (placeholder unlockers): the vault's PUSD repays, an extra BCH UTXO pays the fee.
    const unsignedBuilt = await buildManage(f.ctx, {
      loanKeyCategory: params.loanKeyCategory, loanKey: { utxo: key, unlocker: walletUnlocker({ address: vaultKey.address, utxos: [] }) },
      repayCents: 10_000n, wallet: { address: vaultKey.address, utxos: [...vaultUtxos.filter((u) => !u.token?.nft), { txid: id32('fund'), vout: 3, satoshis: 1_000_000n }] },
    });
    const d = decodeTx(unsignedBuilt.txHex, unsignedBuilt.sourceOutputs, {
      network: 'mocknet', deployment: MOCK_DEPLOYMENT, contracts: f.ctx.contracts,
      vault: { params, lockingBytecode: vaultKey.lockingBytecode, policy: POLICY, name: 'Treasury' },
      payees: [],
    });
    expect(d.title).toBe('Vault: Manage loan — repay 100.00 PUSD');
    expect(d.inputs.map((i) => i.label)).toEqual(['paryon-price', 'paryon-loan', 'paryon-sidecar', 'paryon-function', 'vault-key', 'vault-state', 'vault-pusd']);
    expect(d.outputs.slice(0, 6).map((o) => o.label)).toEqual(['paryon-price', 'paryon-loan', 'paryon-sidecar', 'paryon-function', 'vault-key', 'burn']);
    const checks = Object.fromEntries(d.checks.map((c) => [c.id, c.ok]));
    expect(checks).toMatchObject({ 'cr-before': true, 'cr-after-paryon': true, 'cr-after-target': true, allowlist: true, 'vault-key-kept': true, fee: true });
  });

  it('flags non-allowlisted outputs and checks payment limits / daily budget', async () => {
    const f = makeFixture();
    const vaultKey = makeKey('vault');
    const payee = makeKey('payee');
    const stranger = makeKey('stranger');
    const stateCategory = id32('state');
    const params: VaultParams = {
      paryonTokenId: MOCK_DEPLOYMENT.tokenIds.paryonTokenId, loanKeyCategory: id32('lk'), stateCategory,
      signerPubkeys: [makeKey('s1').pubHex, makeKey('s2').pubHex, makeKey('s3').pubHex], m: 2,
    };
    const state = { txid: id32('st'), vout: 0, satoshis: 100_000n, token: { category: stateCategory, amount: 0n, nft: { capability: 'mutable' as const, commitment: '00' } } };
    f.provider.addUtxo(vaultKey.lockingBytecode, state);
    const { TransactionBuilder } = await import('cashscript');
    const b = new TransactionBuilder({ provider: f.provider })
      .addInput(state, vaultKey.signer.unlockP2PKH())
      .addOutput({ to: payee.address, amount: 4_000n })
      .addOutput({ to: stranger.address, amount: 6_000n })
      .addOutput({ to: vaultKey.address, amount: 89_000n, token: state.token })
      .setLocktime(900 * 144 + 5);
    const wc = b.generateWcTransactionObject();
    const d = decodeTx(wc.transaction, wc.sourceOutputs, {
      network: 'mocknet', deployment: MOCK_DEPLOYMENT,
      vault: { params, lockingBytecode: vaultKey.lockingBytecode, policy: POLICY },
      payees: [{ label: 'Payroll — Ops', address: payee.address }],
    });
    expect(d.title).toBe('Pay 0.00004000 BCH to Payroll — Ops');
    const checks = Object.fromEntries(d.checks.map((c) => [c.id, c.ok]));
    expect(checks.allowlist).toBe(false);
    expect(checks['per-payment-0']).toBe(true);
    expect(checks['daily-budget']).toBe(true); // 1000 + 4000 <= 8000 on day 900
    expect(d.outputs[1]!.label).toBe('unknown');
    expect(d.feeSats).toBe(1_000n);
  });
});

describe('network profiles and deployment', () => {
  it('mainnet profile carries Paryon mainnet-v1; chipnet takes a parsed deployment', () => {
    expect(getNetworkProfile('mainnet').paryon?.tokenIds.paryonTokenId).toBe('2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544');
    const json = JSON.parse(JSON.stringify({ ...serializeDeployment(MOCK_DEPLOYMENT), network: 'chipnet', genesisTxIds: {}, contracts: {} }));
    const parsed = parseDeployment({ ...json, contractParams: { ...json.contractParams, startBlockHeight: 123 } });
    expect(parsed.contractParams.startBlockHeight).toBe(123n);
    expect(getNetworkProfile('chipnet', parsed).paryon).toBe(parsed);
    expect(getNetworkProfile('chipnet').paryon).toBeUndefined();
  });

});
