import type { VaultView } from '../data/source';
import { bch, pusd, usd } from '../data/format';
import { EXPLORER } from '../config/app';
import { CrGauge } from './CrGauge';

/** One figure with its unit; links to the UTXO it was read from (DESIGN §1.2). */
export function Figure({ label, value, unit, href, danger }: { label: string; value: string | null; unit?: string; href?: string; danger?: boolean }) {
  const body = (
    <>
      <span className="s-fig__label">{label}</span>
      <span className={`s-fig__value mono${danger ? ' s-fig__value--danger' : ''}`}>{value ?? '—'}{unit && value ? <span className="s-fig__unit"> {unit}</span> : null}</span>
    </>
  );
  return href
    ? <a className="s-fig s-fig--link" href={href} target="_blank" rel="noreferrer" title={`Read from ${href}`}>{body}</a>
    : <div className="s-fig">{body}</div>;
}

export function HealthPanel({ v, compact = false, links = true }: { v: VaultView | null | undefined; compact?: boolean; links?: boolean }) {
  const tx = (utxo?: string) => (links && v && utxo ? EXPLORER[v.network].tx + utxo.split(':')[0] : undefined);
  const policy = v?.policy ?? { defendCrBps: 13_000, targetCrBps: 15_000, skimCrBps: 20_000 };
  return (
    <div className="s-health">
      <CrGauge crBps={v ? v.health.crBps : null} status={v ? v.health.status : null} policy={policy} compact={compact} />
      <div className="s-figs">
        <Figure label="Debt" value={v ? pusd(v.loan.borrowedAmount) : null} unit="PUSD" href={tx(v?.sources.loanUtxo)} />
        <Figure label="Collateral" value={v ? bch(v.loan.collateralSats) : null} unit="BCH" href={tx(v?.sources.loanUtxo)} />
        <Figure label="Liquidation price" value={v ? usd(v.health.liquidationPriceCents) : null} href={tx(v?.sources.loanUtxo)} danger />
        <Figure label="BCH price" value={v ? usd(v.health.priceCentsPerBch) : null} href={tx(v?.sources.priceUtxo)} />
      </div>
    </div>
  );
}
