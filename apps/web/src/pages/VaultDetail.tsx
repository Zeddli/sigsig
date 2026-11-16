import { Link, useParams } from 'react-router-dom';
import { useActivity, useVault } from '../data/queries';
import { PageHead, Skeleton, ErrorLine } from '../components/AppShell';
import { HealthPanel, Figure } from '../components/HealthPanel';
import { Addr } from '../components/Copy';
import { useWallet } from '../wallet';
import { bch, pct, pusd } from '../data/format';
import { EXPLORER } from '../config/app';
import type { ActivityItem, VaultView } from '../data/source';

function Actions({ v }: { v: VaultView }) {
  const { pubkey } = useWallet();
  const isSigner = !!pubkey && v.signers.some((s) => s.pubkey === pubkey);
  const needDefend = v.health.crBps < v.policy.defendCrBps;
  const canSkim = v.health.crBps > v.policy.skimCrBps;
  return (
    <section className="s-box s-actions" aria-labelledby="actions-h">
      <h2 id="actions-h" className="s-box__h">Actions</h2>
      <div className="s-actions__list">
        {needDefend
          ? <Link className="btn btn--primary s-actions__primary" to={`/keeper?vault=${v.id}`}>Defend vault</Link>
          : <p className="t-small muted">Defend opens when CR falls under {pct(v.policy.defendCrBps)}. Anyone can send it.</p>}
        {canSkim
          ? <Link className="link" to={`/keeper?vault=${v.id}`}>Skim excess</Link>
          : <span className="s-disabled" aria-disabled="true">Skim excess <span className="muted">(above {pct(v.policy.skimCrBps)})</span></span>}
        {!needDefend && isSigner
          ? <Link className="btn btn--primary s-actions__primary" to={`/vaults/${v.id}/pay`}>Pay a payee</Link>
          : <Link className="link" to={`/vaults/${v.id}/pay`}>Pay{isSigner ? '' : ' (signers sign)'}</Link>}
        <details className="s-admin">
          <summary>Admin</summary>
          <p className="t-small muted">Repay, withdraw, change interest, change policy and emergency exit each need {v.params.m} of {v.signers.length} signatures. Built in the next release.</p>
        </details>
      </div>
    </section>
  );
}

function Activity({ items, net }: { items: ActivityItem[] | undefined; net: VaultView['network'] }) {
  return (
    <section className="s-box s-span-12" aria-labelledby="activity-h">
      <h2 id="activity-h" className="s-box__h">Activity</h2>
      {!items ? <div className="s-stack"><Skeleton h={44} /><Skeleton h={44} /><Skeleton h={44} /></div> : (
        <table className="s-table">
          <thead><tr><th scope="col">Kind</th><th scope="col">What happened</th><th scope="col">State</th><th scope="col">Tx</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.txid}>
                <td data-label="Kind"><span className="s-chip">{a.kind}</span></td>
                <td data-label="What happened">{a.summary}</td>
                <td data-label="State">{a.height === null ? 'In mempool' : `Confirmed (${a.confirmations})`}</td>
                <td data-label="Tx"><Addr value={a.txid} href={EXPLORER[net].tx + a.txid} head={8} tail={4} copy={false} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function VaultDetail() {
  const { id = '' } = useParams();
  const q = useVault(id);
  const act = useActivity(id);
  const v = q.data;

  if (q.isSuccess && !v) {
    return (
      <div className="wrap s-page">
        <PageHead title="Vault not found" sub={<p>No vault with the id “{id}” on this network.</p>} />
        <Link className="btn btn--primary" to="/new">Open a vault</Link>
      </div>
    );
  }

  const left = v ? v.policy.dailyBudget - v.policy.spentToday : 0n;
  const usedPct = v ? Number((v.policy.spentToday * 100n) / (v.policy.dailyBudget || 1n)) : 0;

  return (
    <div className="wrap s-page">
      <PageHead
        title={v ? v.name : <Skeleton h={40} w="40%" />}
        sub={v ? (
          <p className="s-meta">
            <Addr value={v.address} href={EXPLORER[v.network].address + v.address} />
            <span className={`s-net s-net--${v.network}`}>{v.network === 'mainnet' ? 'Mainnet' : 'Chipnet'}</span>
            <span>Signers {v.params.m} of {v.signers.length}</span>
          </p>
        ) : <Skeleton h={20} w="60%" />}
      />
      <ErrorLine error={q.error} />
      <div className="s-grid">
        <section className="s-box s-span-7" aria-labelledby="health-h">
          <h2 id="health-h" className="s-box__h">Health</h2>
          <HealthPanel v={v} />
        </section>
        {v ? <Actions v={v} /> : <section className="s-box s-span-5"><Skeleton h={160} /></section>}

        <section className="s-box s-span-4" aria-labelledby="buffer-h">
          <h2 id="buffer-h" className="s-box__h">Buffer</h2>
          <div className="s-figs s-figs--stack">
            <Figure label="BCH for defend" value={v ? bch(v.buffer.sats) : null} unit="BCH" />
            <Figure label="PUSD for repay and pay" value={v ? pusd(v.buffer.pusdCents) : null} unit="PUSD" />
          </div>
        </section>
        <section className="s-box s-span-4" aria-labelledby="budget-h">
          <h2 id="budget-h" className="s-box__h">Today's budget</h2>
          <p className="s-big mono">{v ? `${pusd(v.policy.spentToday)} / ${pusd(v.policy.dailyBudget)}` : '—'} <span className="s-fig__unit">PUSD</span></p>
          <div className="s-meter" role="meter" aria-label="Daily budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPct}
            aria-valuetext={v ? `${pusd(v.policy.spentToday)} of ${pusd(v.policy.dailyBudget)} PUSD spent today, ${pusd(left)} left` : 'not read yet'}>
            <i style={{ width: `${usedPct}%` }} className={usedPct >= 80 ? 'is-watch' : ''} />
          </div>
          <p className="t-small muted">{v ? `${pusd(left)} PUSD left · resets at block ${v.budgetResetHeight.toLocaleString('en').replace(/,/g, ' ')}` : '—'}</p>
        </section>
        <section className="s-box s-span-4" aria-labelledby="interest-h">
          <h2 id="interest-h" className="s-box__h">Interest</h2>
          <p className="s-big mono">{v ? pct(v.interestBps, 1) : '—'}</p>
          <p className="t-small muted">Paid to Paryon each period · redemption risk: {v?.redemptionRisk ?? '—'}</p>
          <p className="t-small muted">Low-rate loans are redeemed first; admin sets the rate.</p>
        </section>
        <Activity items={act.data} net={v?.network ?? 'chipnet'} />
      </div>
    </div>
  );
}
