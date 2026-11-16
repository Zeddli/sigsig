import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Banner } from './Banner';
import { DEMO_VAULT_ID, LINKS } from '../config/app';
import { useWallet } from '../wallet';
import { short } from '../data/format';

/** On the landing every link is a plain <a> (a full load, so the kit's scripts start clean); in the app, a router Link. */
export function Go({ to, landing, className, children, ...rest }: { to: string; landing?: boolean; className?: string; children: ReactNode; 'aria-current'?: 'page' }) {
  if (landing || /^https?:/.test(to)) {
    const ext = /^https?:/.test(to);
    return <a className={className} href={to} {...(ext ? { target: '_blank', rel: 'noreferrer' } : {})} {...rest}>{children}</a>;
  }
  return <Link className={className} to={to} {...rest}>{children}</Link>;
}

const Chev = () => (
  <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function NetworkChip() {
  const { network } = useWallet();
  return <span className={`s-net s-net--${network}`}>{network === 'mainnet' ? 'Mainnet' : 'Chipnet'}</span>;
}

/** nav-cards (DESIGN §4): wordmark with the arc mark; Vaults (menu cards) · Keeper · Docs; Connect wallet. */
export function Header({ landing = false }: { landing?: boolean }) {
  const { address, openSheet } = useWallet();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const cur = (p: string) => (!landing && pathname.startsWith(p) ? { 'aria-current': 'page' as const } : {});
  const vault = `/vaults/${DEMO_VAULT_ID}`;

  // On the landing, system.js owns the menu toggle (it swaps the icon and locks the page); in the app, React does.
  const toggleProps = landing ? {} : { onClick: () => setOpen((o) => !o) };

  return (
    <header className={`nav s-nav${open ? ' is-open' : ''}`}>
      <Banner />
      <div className="wrap nav__bar">
        <a className="skip-link" href="#top">Skip to content</a>
        <Go landing className="nav__logo" to={landing ? '#top' : '/'}><span className="mark" data-mark="arc" aria-hidden="true"></span>sigsig</Go>
        <nav className="nav__links" aria-label="Main" onClick={() => setOpen(false)}>
          <div className="nav__item">
            <Go landing={landing} className="nav__link" to={vault} {...cur('/vaults')}>Vaults <Chev /></Go>
            <div className="nav__menu">
              <div className="wrap grid">
                <Go landing={landing} className="menu-card span-4" to={vault}>
                  <div className="panel s-menu-panel" aria-hidden="true">
                    <div className="s-mini">
                      <div className="s-mini__row"><span>CR</span><b className="mono">164%</b><span className="s-chip s-chip--safe">Safe</span></div>
                      <div className="s-mini__bar"><i style={{ width: '58%' }} /></div>
                      <div className="s-mini__row muted"><span>defend 130</span><span>target 150</span><span>skim 200</span></div>
                    </div>
                  </div>
                  <span className="t-card">Vault health</span>
                  <span className="t-small muted">CR, debt, buffer and the liquidation price</span>
                </Go>
                <Go landing={landing} className="menu-card span-4" to={`${vault}/pay`}>
                  <div className="panel s-menu-panel" aria-hidden="true">
                    <div className="s-mini">
                      <div className="s-mini__row"><span>Payroll — Ops</span><b className="mono">30.00 PUSD</b></div>
                      <div className="s-mini__chips"><span className="s-chip s-chip--safe">Allowed payee</span><span className="s-chip s-chip--safe">≤ 50 PUSD</span></div>
                    </div>
                  </div>
                  <span className="t-card">Pay an approved payee</span>
                  <span className="t-small muted">Allowlist, per-payment limit and daily budget</span>
                </Go>
                <Go landing={landing} className="menu-card span-4" to="/sign/demo-payroll">
                  <div className="panel s-menu-panel" aria-hidden="true">
                    <div className="s-mini">
                      <div className="s-mini__row"><span>Out 0 · Payroll — Ops</span><span className="s-chip">allowlisted</span></div>
                      <div className="s-mini__row"><span>Out 1 · Vault state</span><span className="s-chip">returns</span></div>
                    </div>
                  </div>
                  <span className="t-card">Signer view</span>
                  <span className="t-small muted">Every input and output named before you sign</span>
                </Go>
              </div>
            </div>
          </div>
          <div className="nav__item"><Go landing={landing} className="nav__link" to="/keeper" {...cur('/keeper')}>Keeper</Go></div>
          <div className="nav__item"><Go className="nav__link" to={LINKS.docs}>Docs</Go></div>
        </nav>
        <div className="nav__actions">
          <NetworkChip />
          {landing ? (
            <>
              <button type="button" className="nav__link s-linkbtn" onClick={openSheet}>{address ? short(address, 4, 4) : 'Connect wallet'}</button>
              <a className="btn btn--primary" href={vault}>Open the demo vault</a>
            </>
          ) : (
            <button type="button" className="btn btn--secondary s-connect" onClick={openSheet}>
              {address ? <span className="mono">{short(address, 4, 4)}</span> : 'Connect wallet'}
            </button>
          )}
        </div>
        <button className="nav__toggle" type="button" aria-expanded={open} aria-label="Menu" {...toggleProps}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d={open ? 'M4 4l10 10M14 4L4 14' : 'M2 5h14M2 13h14'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>
    </header>
  );
}
