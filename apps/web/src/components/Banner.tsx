import { useState } from 'react';
import { BLAZE } from '../config/blaze';
import { short } from '../data/format';
import { CopyButton } from './Copy';
import { Sheet } from './Sheet';
import { QrCode } from './QrCode';

const voteReady = !BLAZE.voteAddress.includes('TODO');

const Ext = () => (
  <svg className="s-ext" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5h5.5V8M9.5 2.5 3 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

/** The BLAZE 2026 banner (DESIGN §3): on every page, at the top, not dismissible. Values: src/config/blaze.ts. */
export function Banner() {
  const [open, setOpen] = useState(false);
  return (
    <div className="s-banner" role="region" aria-label="BLAZE 2026">
      <div className="wrap s-banner__bar">
        <p className="s-banner__credit">
          <span className="mark" data-mark="arc" aria-hidden="true"></span>
          <span>Built for {BLAZE.event}</span>
          <span className="s-banner__sep" aria-hidden="true">·</span>
          <a className="s-banner__link" href={BLAZE.credit.url} target="_blank" rel="noreferrer">
            BCH re-implementation of {BLAZE.credit.name}<span className="s-hide-sm"> ({BLAZE.credit.note})</span><Ext />
          </a>
        </p>
        <p className="s-banner__links">
          <a className="s-banner__link" href={BLAZE.deckUrl} target="_blank" rel="noreferrer">Deck<Ext /></a>
          <a className="s-banner__link" href={BLAZE.repoUrl} target="_blank" rel="noreferrer">Code<Ext /></a>
          <span className="s-banner__vote">
            <span className="s-hide-md">Vote {BLAZE.voteToken}{voteReady ? ':' : ''}</span>
            {voteReady && <span className="mono s-hide-md" title={BLAZE.voteAddress}>{short(BLAZE.voteAddress, 4, 4)}</span>}
            {voteReady && <span className="s-hide-md"><CopyButton value={BLAZE.voteAddress} label="Copy vote address" tone="inverse" /></span>}
            <button type="button" className="s-banner__link s-banner__btn" onClick={() => setOpen(true)} aria-haspopup="dialog">
              <span className="s-show-md">Vote</span><span className="s-hide-md">{voteReady ? 'QR' : 'Address'}</span>
            </button>
          </span>
        </p>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Vote ${BLAZE.voteToken}`}>
        {voteReady ? (
          <div className="s-stack">
            <p>Send the {BLAZE.voteToken} vote token to this CashTokens address.</p>
            <QrCode value={BLAZE.voteAddress} label={`QR code of the ${BLAZE.voteToken} vote address`} />
            <p className="mono s-break">{BLAZE.voteAddress}</p>
            <CopyButton value={BLAZE.voteAddress} label="Copy address" text />
          </div>
        ) : (
          <div className="s-stack">
            <p>The team has not published its {BLAZE.voteToken} vote address yet. It will appear here, with its QR code, before voting opens.</p>
            <p className="t-small muted">Credit: sigsig re-implements <a className="link" href={BLAZE.credit.url} target="_blank" rel="noreferrer">{BLAZE.credit.name}</a> on Bitcoin Cash.</p>
          </div>
        )}
      </Sheet>
    </div>
  );
}
