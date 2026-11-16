/**
 * Demo vault on chipnet: open one sigsig vault against our Paryon deployment and make payments from it.
 *
 *   pnpm demo:vault open [--borrow 100] [--collateral-bch 0.004] [--buffer-bch 0.002]
 *   pnpm demo:vault status
 *   pnpm demo:vault pay --payee 0 --sats 10000 [--signers 1,2]
 *   pnpm demo:vault pay --payee 1 --pusd 1.50 [--signers 1,3]
 *
 * Keys: the funder (FUNDER_WIF in .env) pays for everything; three demo signer keys are generated into vault.env.
 * The vault record (params, policy, payees) goes to deployments/chipnet-vault.json for the keeper and the web app.
 * Defend/skim are run by the keeper: KEEPER_BACKEND=core KEEPER_NETWORK=chipnet KEEPER_VAULTS_FILE=deployments/chipnet-keeper.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TransactionBuilder, type Utxo } from 'cashscript';
import {
  buildBorrow, buildCreateLoanKey, buildCreateVaultState, buildPay, createParyonContext, createPaymentRequest,
  createVaultTxContext, fetchVaultUtxos, findLoanPair, findPriceUtxo, payeeRoot, signPayment, crBps,
  type FundingWallet, type ParyonContext, type VaultParams, type VaultPolicy,
} from '@sigsig/core';
import { keyFromWif, loadKeys, newKey, ORACLE_PKG_DIR, type KeyPair } from './keys.js';
import { defaultDeploymentPath, DEPLOYMENTS_DIR, loadDeploymentFile, toParyonDeployment } from './deployment.js';
import { chipnetProvider, isMain, parseArgs } from './util.js';

const VAULT_ENV = join(ORACLE_PKG_DIR, 'vault.env');
const VAULT_FILE = join(DEPLOYMENTS_DIR, 'chipnet-vault.json');
const KEEPER_FILE = join(DEPLOYMENTS_DIR, 'chipnet-keeper.json');

export const DEMO_POLICY = (root: string): VaultPolicy => ({
  version: 1,
  defendCrBps: 15_000, // keeper may defend below 150%
  targetCrBps: 17_000, // and must bring it to >= 170%
  skimCrBps: 25_000, // keeper may skim above 250%, down to 170%
  keeperFeeMaxSats: 20_000, // defend/skim txs are ~8 KB
  payeeRoot: root,
  perPaymentMax: 50_000n,
  dailyBudget: 200_000n,
  dayIndex: 0,
  spentToday: 0n,
});

function loadSigners(): [KeyPair, KeyPair, KeyPair] {
  const text = existsSync(VAULT_ENV) ? readFileSync(VAULT_ENV, 'utf8') : '';
  const wifs = [...text.matchAll(/^SIGNER_(\d)_WIF=(\S+)$/gm)].sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[2]!);
  if (wifs.length === 3) return wifs.map(keyFromWif) as [KeyPair, KeyPair, KeyPair];
  const keys = [newKey(), newKey(), newKey()] as [KeyPair, KeyPair, KeyPair];
  writeFileSync(VAULT_ENV, `# demo vault signer keys (chipnet). NEVER COMMIT.\n${keys.map((k, i) => `SIGNER_${i + 1}_WIF=${k.wif}`).join('\n')}\n`, { mode: 0o600 });
  console.log(`generated 3 demo signer keys into ${VAULT_ENV}`);
  return keys;
}

interface VaultRecord {
  name: string;
  network: 'chipnet';
  params: VaultParams;
  payees: { label: string; lockingBytecode: string; address: string }[];
  txids: { loanKey: string; state: string; borrow: string };
}

const jsonBig = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function wallet(ctx: ParyonContext, funder: KeyPair): Promise<FundingWallet> {
  const address = funder.tokenAddress('bchtest');
  return { address, utxos: (await ctx.provider.getUtxos(address)).filter((u) => !u.token), signer: funder.signer };
}

/** Self-send so the wallet has a pure-BCH UTXO at output index 0 (token genesis needs one). */
async function ensureVout0(ctx: ParyonContext, funder: KeyPair, sats: bigint): Promise<void> {
  const w = await wallet(ctx, funder);
  if (w.utxos.some((u) => u.vout === 0 && u.satoshis >= sats)) return;
  const inputs: Utxo[] = [];
  let sum = 0n;
  for (const u of [...w.utxos].sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))) { inputs.push(u); sum += u.satoshis; if (sum >= sats + 2_000n) break; }
  if (sum < sats + 2_000n) throw new Error(`funder needs ${sats + 2_000n} sats, has ${sum}`);
  const b = new TransactionBuilder({ provider: ctx.provider })
    .addInputs(inputs, funder.signer.unlockP2PKH())
    .addOutput({ to: w.address, amount: sats })
    .addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 });
  const txid = await ctx.provider.sendRawTransaction(b.build());
  console.log(`prep vout-0 ${txid}`);
}

async function send(ctx: ParyonContext, label: string, built: { builder: { debug(): unknown }; txHex: string }): Promise<string> {
  built.builder.debug(); // full local VM evaluation before broadcasting
  const txid = await ctx.provider.sendRawTransaction(built.txHex);
  console.log(`${label}: ${txid}`);
  return txid;
}

async function main() {
  const [cmd = 'status', ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const file = loadDeploymentFile(typeof a.deployment === 'string' ? a.deployment : defaultDeploymentPath('chipnet'));
  const provider = chipnetProvider();
  const ctx = createParyonContext('chipnet', toParyonDeployment(file), provider);
  const funder = loadKeys().FUNDER_WIF;
  const signers = loadSigners();

  if (cmd === 'open') {
    if (existsSync(VAULT_FILE) && !a.force) throw new Error(`${VAULT_FILE} exists; pass --force to open another vault`);
    const borrowCents = BigInt(Math.round(Number(a.borrow ?? 100) * 100));
    const collateralSats = BigInt(Math.round(Number(a['collateral-bch'] ?? 0.004) * 1e8));
    const bufferSats = BigInt(Math.round(Number(a['buffer-bch'] ?? 0.002) * 1e8));
    const price = (await findPriceUtxo(provider, ctx.contracts)).priceCents;
    console.log(`price $${Number(price) / 100}; opening: borrow ${Number(borrowCents) / 100} PUSD against ${collateralSats} sats (CR ${crBps(collateralSats, borrowCents, price) / 100}%)`);

    await ensureVout0(ctx, funder, 10_000n);
    const lk = await buildCreateLoanKey(ctx, { wallet: await wallet(ctx, funder) });
    const lkTx = await send(ctx, 'loan key', lk);

    const payees = [
      { label: 'Ops wallet (funder)', lockingBytecode: funder.lockingBytecodeHex, address: funder.address('bchtest') },
      { label: 'Payroll (signer 1)', lockingBytecode: signers[0].lockingBytecodeHex, address: signers[0].address('bchtest') },
    ];
    await ensureVout0(ctx, funder, bufferSats + 5_000n);
    const st = await buildCreateVaultState(ctx, {
      params: {
        paryonTokenId: file.tokenIds.paryonTokenId, loanKeyCategory: lk.loanKeyCategory,
        signerPubkeys: [signers[0].publicKeyHex, signers[1].publicKeyHex, signers[2].publicKeyHex], m: 2,
      },
      policy: DEMO_POLICY(payeeRoot(payees.map((p) => p.lockingBytecode))),
      bufferSats, wallet: await wallet(ctx, funder),
    });
    const stTx = await send(ctx, 'vault state', st);
    const v = createVaultTxContext(ctx, st.params);

    const borrow = await buildBorrow(ctx, {
      loanKeyCategory: lk.loanKeyCategory, borrowCents, collateralSats, startingInterestRate: 0,
      wallet: await wallet(ctx, funder), loanKeyDestination: v.vault.tokenAddress,
      pusdDestination: v.vault.tokenAddress,
    });
    const bTx = await send(ctx, 'borrow into vault', borrow);
    const rec: VaultRecord = { name: 'Chipnet demo treasury', network: 'chipnet', params: st.params, payees, txids: { loanKey: lkTx, state: stTx, borrow: bTx } };
    writeFileSync(VAULT_FILE, jsonBig(rec) + '\n');
    writeFileSync(KEEPER_FILE, jsonBig({ vaults: [{ id: 'chipnet-demo', params: st.params }] }) + '\n');
    console.log(`vault ${v.vault.tokenAddress}\nrecord written to ${VAULT_FILE}`);
    return;
  }

  const rec = JSON.parse(readFileSync(VAULT_FILE, 'utf8')) as VaultRecord;
  rec.params.m = Number(rec.params.m) as 1 | 2 | 3;
  const v = createVaultTxContext(ctx, rec.params);

  if (cmd === 'status') {
    const [utxos, pair, price] = await Promise.all([fetchVaultUtxos(v), findLoanPair(provider, ctx.contracts, rec.params.loanKeyCategory), findPriceUtxo(provider, ctx.contracts)]);
    const s = pair.state;
    console.log(`vault ${v.vault.tokenAddress}`);
    console.log(`price $${Number(price.priceCents) / 100} · debt ${Number(s.borrowedAmount) / 100} PUSD · collateral ${s.collateralSats} sats · CR ${crBps(s.collateralSats, s.borrowedAmount, price.priceCents) / 100}%`);
    console.log(`buffer ${utxos.state.satoshis} sats + ${utxos.pusd.reduce((t, u) => t + u.token!.amount, 0n)} PUSD cents · key ${utxos.key ? 'present' : 'MISSING'}`);
    return;
  }

  if (cmd === 'pay') {
    const payee = rec.payees[Number(a.payee ?? 0)];
    if (!payee) throw new Error('unknown --payee index');
    const slots = String(a.signers ?? '1,2').split(',').map(Number) as Array<1 | 2 | 3>;
    const pusd = typeof a.pusd === 'string';
    const req = await createPaymentRequest(v, {
      payee: payee.lockingBytecode, payees: rec.payees.map((p) => p.lockingBytecode),
      asset: pusd ? 'PUSD' : 'BCH', amount: pusd ? BigInt(Math.round(Number(a.pusd) * 100)) : BigInt(String(a.sats ?? 10_000)),
      signers: slots,
    });
    const unsigned = await buildPay(v, req);
    const sigs = Object.fromEntries(slots.map((i) => [i, signPayment(v, unsigned, signers[i - 1]!.signer)]));
    const paid = await buildPay(v, req, sigs);
    for (const c of paid.decoded.checks) console.log(`  ${c.ok ? 'ok ' : 'NO '} ${c.text}`);
    await send(ctx, `pay ${payee.label}`, paid);
    return;
  }
  throw new Error(`unknown command ${cmd} (open | status | pay)`);
}

if (isMain(import.meta.url)) {
  main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
