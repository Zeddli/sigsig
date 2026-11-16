import type { BuiltTx, DecodedIo, IoLabel } from '@sigsig/core';
import { bch, pusd, sats } from '../data/format';
import { Addr, CopyButton } from './Copy';

const CHIP: Record<IoLabel, { in: string; out: string; tone?: 'danger' | 'accent' }> = {
  'paryon-price': { in: 'Paryon contract', out: 'Paryon contract' },
  'paryon-loan': { in: 'Paryon contract', out: 'Paryon contract' },
  'paryon-sidecar': { in: 'Paryon contract', out: 'Paryon contract' },
  'paryon-function': { in: 'Paryon contract', out: 'Paryon contract' },
  'paryon-borrowing': { in: 'Paryon contract', out: 'Paryon contract' },
  'vault-key': { in: 'vault', out: 'returns' },
  'vault-state': { in: 'vault', out: 'returns' },
  'vault-pusd': { in: 'vault', out: 'returns' },
  payee: { in: 'allowlisted', out: 'allowlisted', tone: 'accent' },
  burn: { in: 'burn', out: 'burn' },
  fee: { in: 'you', out: 'you' },
  change: { in: 'you', out: 'you' },
  keeper: { in: 'keeper', out: 'keeper' },
  unknown: { in: 'Unknown address', out: 'Unknown address', tone: 'danger' },
};

export const hasUnknownOutput = (tx: BuiltTx) => tx.decoded.outputs.some((o) => o.label === 'unknown');
export const allChecksPass = (tx: BuiltTx) => tx.decoded.checks.every((c) => c.ok);

function Amount({ io }: { io: DecodedIo }) {
  if (io.tokenAmount !== undefined) {
    return (
      <span className="s-io__amt">
        <b className="mono">{pusd(io.tokenAmount)} PUSD</b>
        <span className="mono muted">{sats(io.sats)}</span>
      </span>
    );
  }
  return (
    <span className="s-io__amt">
      <b className="mono">{bch(io.sats)} BCH</b>
      {io.nftCommitment && <span className="muted">+ state NFT</span>}
    </span>
  );
}

function IoList({ items, side, interactive }: { items: DecodedIo[]; side: 'in' | 'out'; interactive: boolean }) {
  return (
    <ol className="s-io__list">
      {items.map((io) => {
        const chip = CHIP[io.label];
        const danger = chip.tone === 'danger';
        return (
          <li key={io.index} className={`s-io${danger ? ' s-io--danger' : ''}`}>
            <span className="s-io__idx mono" aria-label={`${side === 'in' ? 'Input' : 'Output'} ${io.index}`}>{io.index}</span>
            <span className="s-io__main">
              <span className="s-io__name">{danger ? 'Unknown address' : io.name}</span>
              {io.address && (interactive ? <Addr value={io.address} /> : <span className="mono muted s-io__addr">{io.address.split(':')[1]?.slice(0, 8)}…{io.address.slice(-4)}</span>)}
            </span>
            <Amount io={io} />
            <span className={`s-chip${chip.tone ? ' s-chip--' + chip.tone : ''}`}>{chip[side]}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The decoded transaction: the same component in the signer view, the keeper drawer, the stepper and the landing. */
export function DecodedTxView({ tx, interactive = true, raw = true, checksLabel = 'Checks (re-run here, then enforced on-chain)' }: {
  tx: BuiltTx; interactive?: boolean; raw?: boolean; checksLabel?: string;
}) {
  const d = tx.decoded;
  return (
    <div className="s-decode">
      <div className="s-decode__cols">
        <section className="s-decode__col" aria-label="Inputs">
          <h3 className="s-decode__h">Inputs <span className="muted">{d.inputs.length}</span></h3>
          <IoList items={d.inputs} side="in" interactive={interactive} />
        </section>
        <span className="s-decode__arrow" aria-hidden="true">→</span>
        <section className="s-decode__col" aria-label="Outputs">
          <h3 className="s-decode__h">Outputs <span className="muted">{d.outputs.length}</span></h3>
          <IoList items={d.outputs} side="out" interactive={interactive} />
        </section>
      </div>
      <div className="s-decode__checks">
        <p className="t-label muted">{checksLabel}</p>
        <ul className="s-checks">
          {d.checks.map((c) => (
            <li key={c.id} className={`s-check ${c.ok ? 's-check--ok' : 's-check--fail'}`}>
              <span aria-hidden="true">{c.ok ? '✓' : '✕'}</span>
              <span className="s-sr">{c.ok ? 'Passed: ' : 'Failed: '}</span>{c.text}
            </li>
          ))}
          <li className="s-check s-check--plain"><span aria-hidden="true">·</span>Network fee {sats(d.feeSats)}</li>
        </ul>
      </div>
      {raw && (
        <details className="s-raw">
          <summary>Raw transaction hex</summary>
          <div className="s-raw__body">
            <code className="mono">{tx.txHex}</code>
            <CopyButton value={tx.txHex} label="Copy tx hex" text />
          </div>
        </details>
      )}
    </div>
  );
}
