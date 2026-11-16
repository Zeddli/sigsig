import type { ReactNode } from 'react';
import { Header } from './Header';
import { BLAZE } from '../config/blaze';
import { LINKS } from '../config/app';
import { useQuery } from '@tanstack/react-query';
import { getSource } from '../data/source';
import { DEFAULT_NETWORK } from '../config/app';

/** Electrum offline: a banner under the BLAZE banner with a retry (DESIGN §6). */
function OfflineBanner() {
  const q = useQuery({ queryKey: ['price', DEFAULT_NETWORK], queryFn: async () => (await getSource()).getPriceCents(DEFAULT_NETWORK), retry: 0 });
  if (!q.isError) return null;
  return (
    <div className="s-offline" role="alert">
      <div className="wrap s-offline__bar">
        <span>Can't reach the Electrum server: {(q.error as Error).message}</span>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => void q.refetch()}>Retry</button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <Header />
      <main id="top" className="s-app">
        <OfflineBanner />
        {children}
      </main>
      <footer className="s-footer ground-inverse">
        <div className="wrap s-footer__bar">
          <span className="nav__logo"><span className="mark" data-mark="arc" aria-hidden="true"></span>sigsig</span>
          <ul className="s-footer__links">
            <li><a href={BLAZE.repoUrl} target="_blank" rel="noreferrer">Code</a></li>
            <li><a href={BLAZE.deckUrl} target="_blank" rel="noreferrer">Deck</a></li>
            <li><a href={LINKS.docs} target="_blank" rel="noreferrer">Docs</a></li>
            <li><a href={LINKS.chipnetFaucet} target="_blank" rel="noreferrer">Chipnet faucet</a></li>
            <li><a href={BLAZE.credit.url} target="_blank" rel="noreferrer">Cermin</a></li>
          </ul>
          <span className="t-small s-footer__legal">MIT licence · not audited, small amounts only</span>
        </div>
      </footer>
    </>
  );
}

/** Page head: title row with an optional right side (DESIGN §5.2 header). */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="s-head">
      <div className="s-head__main">
        <h1 className="s-h1">{title}</h1>
        {sub && <div className="s-head__sub">{sub}</div>}
      </div>
      {children && <div className="s-head__side">{children}</div>}
    </div>
  );
}

export function Skeleton({ h = 20, w = '100%' }: { h?: number; w?: string }) {
  return <span className="s-skel" style={{ height: h, width: w }} aria-hidden="true" />;
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="s-error" role="alert">{error instanceof Error ? error.message : String(error)}</p>;
}
