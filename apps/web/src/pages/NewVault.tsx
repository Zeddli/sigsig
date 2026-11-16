import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { BuiltTx } from '@sigsig/core';
import { getSource, type NewVaultDraft, type SetupStep } from '../data/source';
import { PageHead, ErrorLine } from '../components/AppShell';
import { DecodedTxView } from '../components/DecodedTxView';
import { Addr } from '../components/Copy';
import { useWallet } from '../wallet';
import { bch, crBps, maxBorrow, parsePusd, pct, pusd } from '../data/format';
import { EXPLORER } from '../config/app';

const STEPS: { id: SetupStep; label: string }[] = [
  { id: 'loan-key', label: 'Loan key' },
  { id: 'policy', label: 'Policy' },
  { id: 'borrow', label: 'Borrow' },
];
const PRICE = 54_012n; // shown until the reader is wired: the same oracle value the mock source uses

function CrSliders({ d, set }: { d: NewVaultDraft; set(p: Partial<NewVaultDraft>): void }) {
  const fid = useId();
  // three linked values: each stays between its neighbours (defend < target < skim), all above 110%
  const rows: { key: 'defendCrBps' | 'targetCrBps' | 'skimCrBps'; label: string; min: number; max: number }[] = [
    { key: 'defendCrBps', label: 'Defend below', min: 11_500, max: d.targetCrBps - 500 },
    { key: 'targetCrBps', label: 'Target', min: d.defendCrBps + 500, max: d.skimCrBps - 500 },
    { key: 'skimCrBps', label: 'Skim above', min: d.targetCrBps + 500, max: 40_000 },
  ];
  return (
    <fieldset className="s-fieldset">
      <legend>CR band</legend>
      {rows.map((r) => (
        <div className="s-slider" key={r.key}>
          <label htmlFor={`${fid}-${r.key}`}>{r.label}</label>
          <input id={`${fid}-${r.key}`} type="range" min={r.min} max={r.max} step={100} value={d[r.key]}
            onChange={(e) => set({ [r.key]: Number(e.target.value) } as Partial<NewVaultDraft>)} aria-valuetext={pct(d[r.key])} />
          <span className="s-num">
            <input type="number" inputMode="numeric" aria-label={`${r.label}, percent`} min={r.min / 100} max={r.max / 100} value={d[r.key] / 100}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value) * 100);
                if (Number.isFinite(n)) set({ [r.key]: Math.min(Math.max(n, r.min), r.max) } as Partial<NewVaultDraft>);
              }} />%
          </span>
        </div>
      ))}
    </fieldset>
  );
}

export function NewVault() {
  const fid = useId();
  const { pubkey, openSheet, wallet, network } = useWallet();
  const [step, setStep] = useState(0);
  const [done, setDone] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<BuiltTx | null>(null);
  const [d, setD] = useState<NewVaultDraft>({
    network, signers: ['', '', ''], m: 2,
    defendCrBps: 13_000, targetCrBps: 15_000, skimCrBps: 20_000, keeperFeeMaxSats: 2_000,
    payees: [{ label: 'Payroll — Ops', address: '' }],
    perPaymentMaxCents: 5_000n, dailyBudgetCents: 10_000n,
    collateralSats: 76_000_000n, borrowCents: 25_000n,
  });
  const set = (p: Partial<NewVaultDraft>) => { setD((x) => ({ ...x, ...p })); setPreview(null); };
  const cur = STEPS[step];

  const build = useMutation({
    mutationFn: async () => (await getSource()).buildSetupTx(cur.id, d),
    onSuccess: setPreview,
  });
  const send = useMutation({
    mutationFn: async () => {
      const s = await getSource();
      let hex = preview!.txHex;
      if (wallet?.available) hex = (await wallet.signTransaction(preview!)).signedTxHex;
      else if (s.kind !== 'mock') throw new Error('Connect a wallet to sign this step');
      return s.broadcast(hex);
    },
    onSuccess: (r) => {
      setDone((m) => ({ ...m, [cur.id]: r.txid }));
      setPreview(null);
      if (step < STEPS.length - 1) setStep(step + 1);
    },
  });

  const cr = crBps(d.collateralSats, PRICE, d.borrowCents);
  const max = maxBorrow(d.collateralSats, PRICE);

  return (
    <div className="wrap s-page s-page--narrow">
      <PageHead title="Open a vault" sub={<p>Three transactions, one per step. Each one is decoded before you sign it.</p>} />
      <ol className="s-stepper" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i === step ? 'is-current' : done[s.id] ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
            <span className="s-stepper__n">{done[s.id] ? '✓' : i + 1}</span>{s.label}
          </li>
        ))}
      </ol>

      <form className="s-form s-box" onSubmit={(e) => { e.preventDefault(); build.mutate(); }} noValidate>
        {cur.id === 'loan-key' && (
          <p>Paryon's loan-key factory mints the NFT that controls a loan. This step mints it straight into the vault covenant, so no single wallet ever holds it.</p>
        )}

        {cur.id === 'policy' && (
          <>
            <fieldset className="s-fieldset">
              <legend>Signers</legend>
              {d.signers.map((s, i) => (
                <div className="field" key={i}>
                  <label htmlFor={`${fid}-s${i}`}>Signer {i + 1} public key</label>
                  <div className="s-inline">
                    <input id={`${fid}-s${i}`} className="mono" value={s} autoComplete="off" spellCheck={false}
                      onChange={(e) => set({ signers: d.signers.map((x, j) => (j === i ? e.target.value.trim() : x)) })} />
                    {i === 0 && (pubkey
                      ? <button type="button" className="btn btn--secondary btn--sm" onClick={() => set({ signers: [pubkey, ...d.signers.slice(1)] })}>Use connected wallet</button>
                      : <button type="button" className="btn btn--secondary btn--sm" onClick={openSheet}>Connect wallet</button>)}
                  </div>
                </div>
              ))}
              <div className="field">
                <label htmlFor={`${fid}-m`}>Signatures needed (M)</label>
                <select id={`${fid}-m`} value={d.m} onChange={(e) => set({ m: Number(e.target.value) as 1 | 2 | 3 })}>
                  <option value={1}>1 of 3</option><option value={2}>2 of 3</option><option value={3}>3 of 3</option>
                </select>
              </div>
            </fieldset>
            <CrSliders d={d} set={set} />
            <fieldset className="s-fieldset">
              <legend>Limits</legend>
              <div className="s-row3">
                <div className="field"><label htmlFor={`${fid}-fee`}>Keeper fee cap (sats)</label>
                  <input id={`${fid}-fee`} type="number" inputMode="numeric" value={d.keeperFeeMaxSats} onChange={(e) => set({ keeperFeeMaxSats: Math.max(0, Number(e.target.value)) })} /></div>
                <div className="field"><label htmlFor={`${fid}-pp`}>Per payment (PUSD)</label>
                  <input id={`${fid}-pp`} inputMode="decimal" defaultValue={pusd(d.perPaymentMaxCents)} onChange={(e) => { const c = parsePusd(e.target.value); if (c !== null) set({ perPaymentMaxCents: c }); }} /></div>
                <div className="field"><label htmlFor={`${fid}-db`}>Daily budget (PUSD)</label>
                  <input id={`${fid}-db`} inputMode="decimal" defaultValue={pusd(d.dailyBudgetCents)} onChange={(e) => { const c = parsePusd(e.target.value); if (c !== null) set({ dailyBudgetCents: c }); }} /></div>
              </div>
            </fieldset>
            <fieldset className="s-fieldset">
              <legend>Payees <span className="muted">{d.payees.length} of 8</span></legend>
              {d.payees.map((p, i) => (
                <div className="s-payee" key={i}>
                  <div className="field"><label htmlFor={`${fid}-pl${i}`}>Label</label>
                    <input id={`${fid}-pl${i}`} value={p.label} onChange={(e) => set({ payees: d.payees.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} /></div>
                  <div className="field"><label htmlFor={`${fid}-pa${i}`}>Address</label>
                    <input id={`${fid}-pa${i}`} className="mono" value={p.address} spellCheck={false} onChange={(e) => set({ payees: d.payees.map((x, j) => (j === i ? { ...x, address: e.target.value.trim() } : x)) })} /></div>
                  <button type="button" className="link s-linkbtn" onClick={() => set({ payees: d.payees.filter((_, j) => j !== i) })}>Remove</button>
                </div>
              ))}
              {d.payees.length < 8 && <button type="button" className="btn btn--secondary btn--sm" onClick={() => set({ payees: [...d.payees, { label: '', address: '' }] })}>Add payee</button>}
            </fieldset>
          </>
        )}

        {cur.id === 'borrow' && (
          <>
            <div className="s-row3">
              <div className="field"><label htmlFor={`${fid}-coll`}>Collateral (BCH)</label>
                <input id={`${fid}-coll`} inputMode="decimal" className="mono" defaultValue={bch(d.collateralSats, 8)}
                  onChange={(e) => { const t = e.target.value.trim(); if (/^\d+(\.\d{0,8})?$/.test(t)) { const [w, f = ''] = t.split('.'); set({ collateralSats: BigInt(w) * 100_000_000n + BigInt((f + '00000000').slice(0, 8)) }); } }} /></div>
              <div className="field"><label htmlFor={`${fid}-borrow`}>Borrow (PUSD)</label>
                <input id={`${fid}-borrow`} inputMode="decimal" className="mono" defaultValue={pusd(d.borrowCents)}
                  onChange={(e) => { const c = parsePusd(e.target.value); if (c !== null) set({ borrowCents: c }); }} /></div>
              <div className="field"><span className="s-fieldlabel">Opening CR</span>
                <p className={`s-big mono ${cr < d.targetCrBps ? 's-text-danger' : ''}`}>{pct(cr)}</p></div>
            </div>
            <p className="t-small muted">Price ${pusd(PRICE)} per BCH · max borrow {pusd(max)} PUSD · liquidation at 110%.</p>
          </>
        )}

        <ErrorLine error={build.error} />
        {!preview && <div className="btn-row"><button type="submit" className="btn btn--primary" disabled={build.isPending}>Preview step {step + 1} transaction</button></div>}
      </form>

      {preview && (
        <section className="s-box s-preview" aria-labelledby="pv-h">
          <h2 id="pv-h" className="s-box__h">{preview.decoded.title}</h2>
          <DecodedTxView tx={preview} />
          <ErrorLine error={send.error} />
          <div className="btn-row">
            <button type="button" className="btn btn--primary" disabled={send.isPending || !preview.decoded.checks.every((c) => c.ok)} onClick={() => send.mutate()}>
              {send.isPending ? 'Broadcasting…' : `Sign and send step ${step + 1}`}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setPreview(null)}>Edit</button>
          </div>
        </section>
      )}
      {Object.entries(done).map(([k, txid]) => (
        <p key={k} className="s-sent">{STEPS.find((s) => s.id === k)?.label}: sent · <Addr value={txid} href={EXPLORER[network].tx + txid} head={8} tail={4} copy={false} /></p>
      ))}
    </div>
  );
}
