import { useEffect, useRef, useState } from 'react';
import { short } from '../data/format';

/** Copy a value; confirms with "Copied" (DESIGN §3). */
export function CopyButton({ value, label, text = false, tone }: { value: string; label: string; text?: boolean; tone?: 'inverse' }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); } catch { /* clipboard blocked: the value stays selectable */ }
    setDone(true);
    clearTimeout(t.current);
    t.current = setTimeout(() => setDone(false), 1600);
  };
  return (
    <button type="button" className={`s-copy${text ? ' s-copy--text' : ''}${tone ? ' s-copy--' + tone : ''}`} onClick={copy} aria-label={done ? 'Copied' : label}>
      {text ? (done ? 'Copied' : label) : (
        done ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
             : <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M10.5 3.5V2.5h-8v8h1" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      )}
      <span className="s-sr" role="status">{done ? 'Copied' : ''}</span>
    </button>
  );
}

/** A middle-truncated address or txid with the full value as a tooltip, plus copy (DESIGN §5.5). */
export function Addr({ value, href, head = 6, tail = 4, copy = true }: { value: string; href?: string; head?: number; tail?: number; copy?: boolean }) {
  const shown = short(value, head, tail);
  return (
    <span className="s-addr">
      {href
        ? <a className="mono link" href={href} target="_blank" rel="noreferrer" title={value}>{shown}</a>
        : <span className="mono" title={value}>{shown}</span>}
      {copy && <CopyButton value={value} label="Copy full value" />}
    </span>
  );
}
