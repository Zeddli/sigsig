import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { usePayChecks, useVault } from '../data/queries';
import { getSource } from '../data/source';
import { PageHead, Skeleton, ErrorLine } from '../components/AppShell';
import { bch, parsePusd, pusd } from '../data/format';

type Unit = 'PUSD' | 'BCH';

/** BCH typed in → PUSD cents at the oracle price (the payment itself is always PUSD). */
function toCents(raw: string, unit: Unit, priceCents: bigint): bigint | null {
  if (unit === 'PUSD') return parsePusd(raw);
  const t = raw.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  const satsIn = BigInt(w) * 100_000_000n + BigInt((f + '00000000').slice(0, 8));
  return (satsIn * priceCents) / 100_000_000n;
}

export function Pay() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const q = useVault(id);
  const v = q.data;
  const [payee, setPayee] = useState(0);
  const [raw, setRaw] = useState('30.00');
  const [unit, setUnit] = useState<Unit>('PUSD');
  const fid = useId();

  const cents = v ? toCents(raw, unit, v.health.priceCentsPerBch) : null;
  const draft = { vaultId: id, payeeIndex: payee, amountCents: cents ?? 0n };
  const checks = usePayChecks(draft, !!v && cents !== null);
  const allOk = !!checks.data && checks.data.every((c) => c.ok) && cents !== null && cents > 0n;

  const create = useMutation({
    mutationFn: async () => (await getSource()).createPayRequest(draft),
    onSuccess: (req) => nav(`/sign/${req.id}`),
  });

  return (
    <div className="wrap s-page s-page--narrow">
      <PageHead
        title="Pay an approved payee"
        sub={v ? <p><Link className="link" to={`/vaults/${v.id}`}>{v.name}</Link> · {v.params.m} of {v.signers.length} signatures · the covenant checks every limit again</p> : <Skeleton h={20} w="50%" />}
      />
      <ErrorLine error={q.error} />
      {!v ? <Skeleton h={320} /> : (
        <form className="s-form s-box" onSubmit={(e) => { e.preventDefault(); if (allOk) create.mutate(); }} noValidate>
          <div className="field">
            <label htmlFor={`${fid}-payee`}>Payee</label>
            <select id={`${fid}-payee`} value={payee} onChange={(e) => setPayee(Number(e.target.value))}>
              {v.payees.map((p, i) => <option key={p.address} value={i}>{p.label}</option>)}
            </select>
            <p className="t-small muted">Only payees on the vault's allowlist. Changing the list takes {v.params.m} signatures.</p>
          </div>
          <div className="field">
            <label htmlFor={`${fid}-amt`}>Amount</label>
            <div className="s-amount">
              <input id={`${fid}-amt`} inputMode="decimal" autoComplete="off" value={raw} onChange={(e) => setRaw(e.target.value)}
                aria-invalid={cents === null} aria-describedby={`${fid}-amt-help`} className="mono" />
              <div className="s-unit" role="group" aria-label="Unit">
                {(['PUSD', 'BCH'] as Unit[]).map((u) => (
                  <button key={u} type="button" className={`s-seg${unit === u ? ' is-on' : ''}`} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u}</button>
                ))}
              </div>
            </div>
            <p id={`${fid}-amt-help`} className={cents === null ? 's-error' : 't-small muted'}>
              {cents === null ? 'Write the amount as a number, like 30.00' : unit === 'BCH' ? `Pays ${pusd(cents)} PUSD at $${pusd(v.health.priceCentsPerBch)} per BCH` : `≈ ${bch((cents * 100_000_000n) / v.health.priceCentsPerBch)} BCH at the oracle price`}
            </p>
          </div>
          <div className="s-checks-live" aria-live="polite">
            <p className="t-label muted">Live checks</p>
            <ul className="s-chips">
              {(checks.data ?? []).map((c) => (
                <li key={c.id} className={`s-chip s-chip--lg ${c.ok ? 's-chip--safe' : 's-chip--danger'}`}>
                  {c.text} <span aria-hidden="true">{c.ok ? '✓' : '✕'}</span><span className="s-sr">{c.ok ? ' passed' : ' failed'}</span>
                </li>
              ))}
            </ul>
          </div>
          <ErrorLine error={create.error} />
          <div className="btn-row">
            <button type="submit" className="btn btn--primary" disabled={!allOk || create.isPending}>
              {create.isPending ? 'Building…' : 'Create payment request'}
            </button>
            <Link className="link" to={`/vaults/${v.id}`}>Cancel</Link>
          </div>
        </form>
      )}
    </div>
  );
}
