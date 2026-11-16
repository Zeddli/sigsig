/**
 * Live data source over @sigsig/core: Electrum reads (ElectrumVaultReader + vaultAdapter) and the vault
 * builders (buildDefend, buildSkim, createPaymentRequest, buildPay). Chosen with VITE_DATA_SOURCE=live.
 *
 * Inputs it fetches from the static site (no backend):
 *   /deployments/<network>.json   Paryon deployment (chipnet: written by packages/oracle; mainnet: built in)
 *   /vaults/<network>.json        known vaults: [{ id, name, params, payees: [{label,address}], signers: [label×3] }]
 * Sign requests travel in the URL: /sign/p#r=<PaymentRequest as base64url JSON>&s1=<sig hex>&s3=<sig hex>.
 * A signer's signature is added to the fragment, so "Copy request link" hands the next signer everything.
 */
import {
  ElectrumVaultReader, vaultAdapter, getNetworkProfile, createProvider, parseDeployment, createParyonContext,
  createVaultTxContext, createPaymentRequest, buildPay, buildDefend, buildSkim, planDefend, skimAmountSats,
  vaultAddresses, PARYON_MAINNET_V1,
  type BuiltTx, type Payee, type VaultParams, type ParyonDeployment, type PaymentRequest, type VaultTxContext,
} from '@sigsig/core';
import { decodeTransactionUnsafe, hexToBin, binToHex, decodeAuthenticationInstructions } from '@bitauth/libauth';
import type { DataSource, Net, PayCheck, PayDraft, SignRequest, VaultSummary, VaultView, KeeperAction } from './source';
import { pusd } from './format';
import { DEFAULT_NETWORK } from '../config/app';

interface RegistryVault { id: string; name: string; params: VaultParams; payees: Payee[]; signers: string[] }

const enc = (o: unknown) => btoa(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = <T,>(s: string): T => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (_k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path} is not published yet (${r.status})`);
  return r.json() as Promise<T>;
}

/** 65-byte Schnorr signature pushed in input 0 of a wallet-signed payment (the slot that held the placeholder). */
export function extractSignature(signedTxHex: string): Uint8Array {
  const tx = decodeTransactionUnsafe(hexToBin(signedTxHex));
  const pushes = decodeAuthenticationInstructions(tx.inputs[0].unlockingBytecode)
    .map((i) => ('data' in i ? (i as { data: Uint8Array }).data : undefined))
    .filter((d): d is Uint8Array => !!d && d.length === 65 && d.some((b) => b !== 0));
  if (pushes.length !== 1) throw new Error('Could not find exactly one signature in the wallet’s transaction');
  return pushes[0];
}

export function createLiveSource(): DataSource {
  const nets = new Map<Net, Promise<{ ctx: ReturnType<typeof createParyonContext>; reader: ElectrumVaultReader; vaults: RegistryVault[] }>>();

  function net(n: Net) {
    if (!nets.has(n)) {
      nets.set(n, (async () => {
        const deployment: ParyonDeployment = n === 'mainnet' ? PARYON_MAINNET_V1 : parseDeployment(await fetchJson(`/deployments/${n}.json`));
        const provider = createProvider(getNetworkProfile(n, deployment));
        const ctx = createParyonContext(n, deployment, provider);
        const reader = new ElectrumVaultReader({ network: n, deployment, provider, vault: vaultAdapter, contracts: ctx.contracts });
        const vaults = await fetchJson<RegistryVault[]>(`/vaults/${n}.json`);
        return { ctx, reader, vaults };
      })());
      nets.get(n)!.catch(() => nets.delete(n));
    }
    return nets.get(n)!;
  }

  async function find(id: string) {
    for (const n of ['chipnet', 'mainnet'] as Net[]) {
      try {
        const x = await net(n);
        const v = x.vaults.find((r) => r.id === id);
        if (v) return { ...x, n, v, vctx: createVaultTxContext(x.ctx, v.params) as VaultTxContext };
      } catch { /* that network is not published */ }
    }
    return null;
  }

  async function view(id: string): Promise<VaultView | null> {
    const f = await find(id);
    if (!f) return null;
    const { reader, v, n } = f;
    const [policy, loan, health, buffer, utxos] = await Promise.all([
      reader.getPolicy(v.params), reader.getLoan(v.params), reader.getHealth(v.params), reader.getBuffer(v.params), reader.getVaultUtxos(v.params),
    ]);
    const pair = await reader.getLoanPair(v.params);
    const op = (u?: { txid: string; vout: number }) => (u ? `${u.txid}:${u.vout}` : '');
    return {
      id, name: v.name, network: n,
      address: vaultAddresses(v.params, f.ctx.provider).tokenAddress,
      params: v.params, policy, loan, health, buffer, payees: v.payees,
      signers: v.params.signerPubkeys.map((pubkey, i) => ({ pubkey, label: v.signers[i] ?? `Signer ${i + 1}` })),
      budgetResetHeight: (policy.dayIndex + 1) * 144,
      sources: { loanUtxo: op((pair as unknown as { loan?: { utxo?: { txid: string; vout: number } } }).loan?.utxo), stateUtxo: op(utxos.state), priceUtxo: '' },
      interestBps: loan.currentInterestRate,
      redemptionRisk: loan.amountBeingRedeemed > 0n ? 'high' : 'low',
    };
  }

  function readHash(): { req: PaymentRequest; sigs: Partial<Record<1 | 2 | 3, string>>; rejected: boolean } | null {
    const h = new URLSearchParams(location.hash.slice(1));
    const r = h.get('r');
    if (!r) return null;
    const sigs: Partial<Record<1 | 2 | 3, string>> = {};
    for (const i of [1, 2, 3] as const) { const s = h.get(`s${i}`); if (s) sigs[i] = s; }
    return { req: dec<PaymentRequest>(r), sigs, rejected: h.get('x') === '1' };
  }
  function writeHash(req: PaymentRequest, sigs: Partial<Record<1 | 2 | 3, string>>, rejected = false) {
    const h = new URLSearchParams({ r: enc(req) });
    for (const [k, v] of Object.entries(sigs)) h.set(`s${k}`, v!);
    if (rejected) h.set('x', '1');
    history.replaceState(null, '', `/sign/p#${h.toString()}`);
  }

  async function requestView(): Promise<SignRequest | null> {
    const parsed = readHash();
    if (!parsed) return null;
    const { req, sigs, rejected } = parsed;
    const id = (await find((await vaultIdFor(req.params)) ?? ''))!;
    const vctx = createVaultTxContext(id.ctx, req.params);
    const got = Object.keys(sigs).length;
    const ready = got >= req.params.m;
    const built = ready
      ? await buildPay(vctx, req, { 1: sigs[1] ? hexToBin(sigs[1]) : null, 2: sigs[2] ? hexToBin(sigs[2]) : null, 3: sigs[3] ? hexToBin(sigs[3]) : null })
      : await buildPay(vctx, req);
    const payee = id.v.payees.find((p) => p.address === req.payee);
    if (payee) built.decoded.title = `Pay ${pusd(req.amount)} PUSD to ${payee.label}`;
    return {
      id: 'p', vaultId: id.v.id, network: id.n, built, m: req.params.m,
      slots: req.params.signerPubkeys.map((pubkey, i) => ({ signer: { pubkey, label: id.v.signers[i] ?? `Signer ${i + 1}` }, signed: !!sigs[(i + 1) as 1 | 2 | 3] })),
      createdAt: new Date().toISOString(),
      status: rejected ? 'rejected' : ready ? 'ready' : 'collecting',
    };
  }

  async function vaultIdFor(params: VaultParams): Promise<string | null> {
    for (const n of ['chipnet', 'mainnet'] as Net[]) {
      try {
        const v = (await net(n)).vaults.find((r) => r.params.stateCategory === params.stateCategory);
        if (v) return v.id;
      } catch { /* not published */ }
    }
    return null;
  }

  async function checkPay(d: PayDraft): Promise<PayCheck[]> {
    const v = await view(d.vaultId);
    if (!v) return [];
    const left = v.policy.dailyBudget - v.policy.spentToday;
    // the covenant counts payments in sats of value; PUSD converts at the oracle price (rounded up)
    const sats = (d.amountCents * 100_000_000n + v.health.priceCentsPerBch - 1n) / v.health.priceCentsPerBch;
    return [
      { id: 'allowlist', ok: !!v.payees[d.payeeIndex], text: 'Allowed payee' },
      { id: 'per-payment', ok: sats <= v.policy.perPaymentMax, text: `≤ per payment ${v.policy.perPaymentMax} sats (${sats} sats)` },
      { id: 'budget', ok: sats <= left, text: `Budget left today ${left} → ${left - sats} sats` },
      { id: 'buffer', ok: d.amountCents <= v.buffer.pusdCents, text: `Vault PUSD ${pusd(v.buffer.pusdCents)}` },
    ];
  }

  return {
    kind: 'electrum',
    async listVaults(n) {
      const { vaults, reader } = await net(n);
      return Promise.all(vaults.map(async (v): Promise<VaultSummary> => {
        const [health, policy, loan] = await Promise.all([reader.getHealth(v.params), reader.getPolicy(v.params), reader.getLoan(v.params)]);
        return {
          id: v.id, name: v.name, network: n, address: vaultAddresses(v.params, (await net(n)).ctx.provider).tokenAddress, health,
          policy: { defendCrBps: policy.defendCrBps, targetCrBps: policy.targetCrBps, skimCrBps: policy.skimCrBps, keeperFeeMaxSats: policy.keeperFeeMaxSats },
          debtCents: loan.borrowedAmount, collateralSats: loan.collateralSats,
        };
      }));
    },
    getVault: view,
    async getActivity() { return []; }, // TODO(sdk): address history via Electrum get_history + decodeTx
    async getPriceCents(n) { return (await net(n)).reader.getPriceCents(); },
    checkPay,
    async createPayRequest(d) {
      const f = await find(d.vaultId);
      if (!f) throw new Error('Vault not found');
      const req = await createPaymentRequest(f.vctx, {
        payee: f.v.payees[d.payeeIndex].address, payees: f.v.payees.map((p) => p.address), asset: 'PUSD', amount: d.amountCents,
        signers: [1, 2, 3],
      });
      writeHash(req, {});
      return (await requestView())!;
    },
    async getSignRequest() { return requestView(); },
    async prepareSignature(_id, slot) {
      const parsed = readHash();
      if (!parsed) throw new Error('No request in this link');
      const f = await find((await vaultIdFor(parsed.req.params)) ?? '');
      const others = { 1: null, 2: null, 3: null } as Record<1 | 2 | 3, 'placeholder' | null>;
      others[(slot + 1) as 1 | 2 | 3] = 'placeholder';
      // one placeholder, in this signer's slot only: a wallet fills the first placeholder it finds (WALLET.md)
      return buildPay(createVaultTxContext(f!.ctx, parsed.req.params), parsed.req, others);
    },
    async addSignature(_id, slot, signedTxHex) {
      const parsed = readHash();
      if (!parsed) throw new Error('No request in this link');
      writeHash(parsed.req, { ...parsed.sigs, [slot + 1]: binToHex(extractSignature(signedTxHex)) });
      return (await requestView())!;
    },
    async rejectRequest() {
      const parsed = readHash();
      if (!parsed) throw new Error('No request in this link');
      writeHash(parsed.req, parsed.sigs, true);
      return (await requestView())!;
    },
    async buildKeeperTx(vaultId: string, action: KeeperAction, rewardTo?: string): Promise<BuiltTx> {
      const f = await find(vaultId);
      if (!f) throw new Error('Vault not found');
      const [policy, loan, price, buffer] = await Promise.all([
        f.reader.getPolicy(f.v.params), f.reader.getLoan(f.v.params), f.reader.getPriceCents(), f.reader.getBuffer(f.v.params),
      ]);
      const feeClaimSats = BigInt(policy.keeperFeeMaxSats);
      if (action === 'defend') {
        const plan = planDefend(loan, price, policy.targetCrBps, { sats: buffer.sats - feeClaimSats - 2_000n, pusdCents: buffer.pusdCents });
        return buildDefend(f.vctx, { repayCents: plan.repayCents, addCollateralSats: plan.addCollateralSats, feeClaimSats, rewardTo });
      }
      const withdrawSats = skimAmountSats(loan, price, policy.targetCrBps);
      if (withdrawSats <= 0n) throw new Error('Refused: nothing to skim above the target CR');
      return buildSkim(f.vctx, { withdrawSats, feeClaimSats, rewardTo });
    },
    async buildSetupTx() { throw new Error('Vault setup is not wired to the live source yet (packages/core tx/paryon.ts builders).'); },
    async broadcast(txHex) {
      return { txid: await (await net(DEFAULT_NETWORK)).ctx.provider.sendRawTransaction(txHex) };
    },
  };
}
