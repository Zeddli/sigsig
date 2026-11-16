import type { Health, VaultPolicy } from '@sigsig/core';
import { STATUS_WORD, tone } from '../data/format';

type Band = Pick<VaultPolicy, 'defendCrBps' | 'targetCrBps' | 'skimCrBps'>;

/**
 * The CR gauge (DESIGN §5.2): a bar with three ticks (defend, target, skim), the liquidation zone under 110%
 * hatched, the current CR as a triangle with its number, and the status word. role="meter" with a text
 * equivalent, so a screen reader hears "CR 164 percent, safe; defend below 130".
 */
export function CrGauge({ crBps, status, policy, compact = false }: { crBps: number | null; status: Health['status'] | null; policy: Band; compact?: boolean }) {
  const lo = 10_000;
  const hi = Math.max(policy.skimCrBps + 5_000, (crBps ?? 0) + 2_000);
  const at = (bps: number) => `${(Math.min(Math.max(bps, lo), hi) - lo) / (hi - lo) * 100}%`;
  const t = status ? tone(status) : 'safe';
  const cr = crBps === null ? null : Math.round(crBps / 100);
  const text = cr === null
    ? 'CR not read yet'
    : `CR ${cr} percent, ${STATUS_WORD[status!].toLowerCase()}; defend below ${policy.defendCrBps / 100}, target ${policy.targetCrBps / 100}, skim above ${policy.skimCrBps / 100}, liquidation at 110`;

  return (
    <div className={`s-gauge s-gauge--${t}${compact ? ' s-gauge--compact' : ''}`}>
      <div className="s-gauge__head">
        <span className="s-gauge__label">CR</span>
        <span className="s-gauge__value mono">{cr === null ? '—' : `${cr}%`}</span>
        {status && <span className={`s-chip s-chip--${t}`}>{STATUS_WORD[status]}</span>}
      </div>
      <div className="s-gauge__track" role="meter" aria-label="Collateral ratio" aria-valuemin={lo / 100} aria-valuemax={hi / 100}
        aria-valuenow={cr ?? undefined} aria-valuetext={text}>
        <div className="s-gauge__liq" style={{ width: at(11_000) }} />
        <div className="s-gauge__band s-gauge__band--watch" style={{ left: at(policy.defendCrBps), width: `calc(${at(policy.targetCrBps)} - ${at(policy.defendCrBps)})` }} />
        <div className="s-gauge__band s-gauge__band--danger" style={{ left: at(11_000), width: `calc(${at(policy.defendCrBps)} - ${at(11_000)})` }} />
        {crBps !== null && <div className="s-gauge__fill" style={{ width: at(crBps) }} />}
        {[policy.defendCrBps, policy.targetCrBps, policy.skimCrBps].map((b) => (
          <span key={b} className="s-gauge__tick" style={{ left: at(b) }} />
        ))}
        {crBps !== null && <span className="s-gauge__pin" style={{ left: at(crBps) }} aria-hidden="true" />}
      </div>
      <div className="s-gauge__scale" aria-hidden="true">
        <span style={{ left: at(11_000) }}>110</span>
        <span style={{ left: at(policy.defendCrBps) }}>defend {policy.defendCrBps / 100}</span>
        <span style={{ left: at(policy.targetCrBps) }}>target {policy.targetCrBps / 100}</span>
        <span style={{ left: at(policy.skimCrBps) }}>skim {policy.skimCrBps / 100}</span>
      </div>
    </div>
  );
}
