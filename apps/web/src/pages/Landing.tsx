import { useEffect } from 'react';
import { Header } from '../components/Header';
import { HealthPanel } from '../components/HealthPanel';
import { DecodedTxView } from '../components/DecodedTxView';
import { useActivity, useVault } from '../data/queries';
import { mockSnapshot } from '../data/mock';
import { bch, pct, pusd, short, usd, maxBorrow } from '../data/format';
import { BLAZE } from '../config/blaze';
import { DEMO_VAULT_ID, LINKS } from '../config/app';
import type { BuiltTx } from '@sigsig/core';

const VAULT = `/vaults/${DEMO_VAULT_ID}`;

/* the kit's scripts (system, motion, layout, diagrams) run once the landing has hydrated, from public/assets */
const KIT = ['/assets/system.js', '/assets/motion/motion.js', '/assets/layout/layout.js', '/assets/diagrams/mount.js'];
function useKit() {
  useEffect(() => {
    for (const src of KIT) {
      if (document.querySelector(`script[src="${src}"]`)) continue;
      const s = document.createElement('script');
      s.type = 'module';
      s.src = src;
      document.body.appendChild(s);
    }
  }, []);
}

const Arrow = () => (
  <svg className="m-arrow" viewBox="0 0 12 12" aria-hidden="true"><path className="m-arrow__stem" d="M1 6h8" /><path className="m-arrow__head" d="M4.5 2.5 8 6l-3.5 3.5" /></svg>
);

const KEEPER_DIAGRAM = JSON.stringify({
  layout: 'lanes',
  alt: 'A BCH price drop goes into the vault covenant, which accepts more collateral or a repayment from the buffer and refuses anything else.',
  curve: 'curve',
  input: { label: 'BCH price', icon: 'ui:trending-down', meta: '$540 → $412' },
  core: { label: 'Vault covenant', icon: 'ui:shield-check' },
  lanes: [
    { label: 'Add collateral', icon: 'ui:plus', meta: 'from buffer BCH', done: true },
    { label: 'Repay debt', icon: 'ui:minus', meta: 'burn buffer PUSD', done: true },
    { label: 'Refuse', icon: 'ui:x', meta: 'anything else' },
  ],
});

/** The pay request the signer section shows: the same decoded view as /sign. */
function signerExample(): BuiltTx {
  const v = mockSnapshot().vault;
  const amount = 3_000n;
  return {
    txHex: '', sourceOutputs: [], summary: 'Pay 30.00 PUSD to Payroll — Ops',
    decoded: {
      title: 'Pay 30.00 PUSD to Payroll — Ops',
      inputs: [
        { index: 0, label: 'vault-state', name: 'Vault state', address: v.address, sats: v.buffer.sats },
        { index: 1, label: 'paryon-price', name: 'Paryon price', sats: 1_000n },
        { index: 2, label: 'vault-pusd', name: 'Vault PUSD', address: v.address, sats: 1_000n, tokenAmount: v.buffer.pusdCents, tokenCategory: v.params.paryonTokenId },
      ],
      outputs: [
        { index: 0, label: 'payee', name: v.payees[0].label, address: v.payees[0].address, sats: 1_000n, tokenAmount: amount, tokenCategory: v.params.paryonTokenId },
        { index: 1, label: 'paryon-price', name: 'Paryon price', sats: 1_000n },
        { index: 2, label: 'vault-state', name: 'Vault state', address: v.address, sats: v.buffer.sats - 1_620n },
        { index: 3, label: 'vault-pusd', name: 'Vault PUSD', address: v.address, sats: 1_000n, tokenAmount: v.buffer.pusdCents - amount, tokenCategory: v.params.paryonTokenId },
      ],
      checks: [
        { id: 'a', ok: true, text: 'Payee in allowlist' },
        { id: 'b', ok: true, text: '≤ 50.00 PUSD' },
        { id: 'c', ok: true, text: 'Budget 60.00 → 30.00' },
        { id: 'd', ok: true, text: `CR unchanged ${pct(v.health.crBps)}` },
      ],
      feeSats: 1_620n,
    },
  };
}

export function Landing() {
  useKit();
  const { data: v } = useVault(DEMO_VAULT_ID);
  const { data: act } = useActivity(DEMO_VAULT_ID);
  const lastKeeper = act?.find((a) => a.kind === 'defend');
  const max = v ? maxBorrow(v.loan.collateralSats, v.health.priceCentsPerBch) : 0n;

  return (
    <>
      <Header landing />
      <main id="top">
        {/* 1. HERO: split with the app window (the live vault page) */}
        <section className="hero hero--split" data-enter aria-labelledby="hero-h">
          <div className="wrap">
            <div className="hero-text grid hero__grid">
              <div className="hero__text span-5">
                <h1 id="hero-h">Treasury vaults that borrow PUSD against BCH</h1>
                <p className="hero__lead">Your BCH stays in a covenant that borrows ParyonUSD and pays only the payees your signers approved. Liquidation at 110%. Keeper can only add safety.</p>
                <div className="btn-row">
                  <a className="btn btn--primary" href={VAULT}>Open the demo vault<Arrow /></a>
                  <a className="btn btn--secondary" href="/keeper">Run the keeper</a>
                </div>
              </div>
              <div className="hero__media span-6 start-7 s-hero-media">
                <div className="ui s-window" role="img"
                  aria-label={v ? `The ${v.name} vault page on Chipnet: CR ${pct(v.health.crBps)}, safe; debt ${pusd(v.loan.borrowedAmount)} PUSD against ${bch(v.loan.collateralSats)} BCH; buffer ${bch(v.buffer.sats)} BCH` : 'The demo vault page'}>
                  <div className="s-window__bar">
                    <span className="s-window__title">{v?.name ?? 'Ops treasury'}</span>
                    <span className="mono muted">{v ? short(v.address, 5, 4) : '—'}</span>
                    <span className="s-net s-net--chipnet">Chipnet</span>
                    <span className="muted s-hide-sm">2 of 3</span>
                  </div>
                  <div className="s-window__body">
                    <HealthPanel v={v} compact links={false} />
                    <div className="s-window__row">
                      <span className="muted">Buffer</span>
                      <b className="mono">{v ? `${bch(v.buffer.sats)} BCH · ${pusd(v.buffer.pusdCents)} PUSD` : '—'}</b>
                    </div>
                    <div className="s-window__row">
                      <span className="muted">Last keeper tx</span>
                      <b>{lastKeeper ? lastKeeper.summary.replace('Defend: ', '') : '—'}</b>
                    </div>
                  </div>
                </div>
                <div className="ly-float s-loop" data-m-loop>
                  <div className="ly-float__row"><span className="ly-live">Keeper</span><span className="mono">block 960 288</span></div>
                  <ol className="s-loop__steps">
                    <li className="s-loop__step s-loop__step--1"><span className="s-loop__dot" />Price drops to $412.40 · CR 126%</li>
                    <li className="s-loop__step s-loop__step--2"><span className="s-loop__dot" />Defend tx adds 0.1230 BCH</li>
                    <li className="s-loop__step s-loop__step--3"><span className="s-loop__dot" />CR back to 150%, the target</li>
                  </ol>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 2. LOAN: split-text-left, the borrow form */}
        <section className="section" id="loan" aria-labelledby="loan-h">
          <div className="wrap">
            <div className="grid fill s-split">
              <div className="span-5 split-col">
                <h2 id="loan-h">PUSD loans on Paryon's audited contracts</h2>
                <p className="t-lead">The vault holds a Paryon loan key, so the loan is an ordinary ParyonUSD loan with the same oracle, interest and 110% line.</p>
                <ul className="s-facts">
                  <li>Price from the Paryon oracle, read on-chain</li>
                  <li>PUSD lands in the vault, not in a wallet</li>
                  <li>Contracts from @paryonusd/contracts 1.1.0</li>
                </ul>
                <a className="link split-col__end" href="/new">See the borrow step</a>
              </div>
              <div className="frame frame--split frame--lit frame--fill span-6 start-7">
                <div className="stage stage--fade-br">
                  <div className="at-corner to-edge" style={{ ['--ax' as string]: '56px', ['--ay' as string]: '56px' }}>
                    <div className="ui s-window s-window--form" role="img" aria-label="The borrow form: 0.7600 BCH collateral, 250.00 PUSD to borrow, price $540.12, max borrow 373.16 PUSD">
                      <div className="s-window__bar"><span className="s-window__title">Borrow</span><span className="muted">step 3 of 3</span></div>
                      <div className="s-window__body s-form-mock">
                        <div className="s-mockfield"><span>Collateral</span><b className="mono">{v ? bch(v.loan.collateralSats) : '—'} BCH</b></div>
                        <div className="s-mockfield s-mockfield--on"><span>Borrow</span><b className="mono">{v ? pusd(v.loan.borrowedAmount) : '—'} PUSD</b></div>
                        <div className="s-window__row"><span className="muted">Price</span><b className="mono">{v ? usd(v.health.priceCentsPerBch) : '—'}</b></div>
                        <div className="s-window__row"><span className="muted">Max borrow</span><b className="mono">{pusd(max)} PUSD</b></div>
                        <div className="s-window__row"><span className="muted">Opening CR</span><b className="mono">{v ? pct(v.health.crBps) : '—'}</b></div>
                        <span className="s-mockbtn">Sign and send step 3</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 3. KEEPER: the dark band, the lanes diagram */}
        <section className="section ground-inverse" id="keeper" aria-labelledby="keeper-h">
          <div className="wrap">
            <div className="section-head">
              <h2 id="keeper-h">Keepers anyone can run. <span className="muted">The covenant refuses everything else.</span></h2>
            </div>
            <div className="frame s-diagram-frame fill">
              <div className="dg" data-diagram={KEEPER_DIAGRAM}></div>
            </div>
          </div>
        </section>

        {/* 4. SPENDING RULES: split-text-left, the pay screen with its budget bar */}
        <section className="section" id="rules" aria-labelledby="rules-h">
          <div className="wrap">
            <div className="grid fill s-split">
              <div className="span-5 split-col">
                <h2 id="rules-h">Spending rules the chain enforces</h2>
                <p className="t-lead">Signers pay from the vault's PUSD, and the covenant checks every payment against the policy stored in its state NFT.</p>
                <ul className="s-facts">
                  <li>Allowlist of up to 8 payees</li>
                  <li>Per-payment limit and a daily budget</li>
                  <li>2 of 3 signatures, or any M of N up to 3</li>
                </ul>
                <a className="link split-col__end" href={`${VAULT}/pay`}>See the pay screen</a>
              </div>
              <div className="frame frame--split frame--lit frame--fill span-6 start-7">
                <div className="stage stage--fade-br">
                  <div className="at-corner to-edge" style={{ ['--ax' as string]: '56px', ['--ay' as string]: '56px' }}>
                    <div className="ui s-window s-window--form" role="img" aria-label="The pay screen: Payroll — Ops, 30.00 PUSD, all four checks passed, 40 of 100 PUSD of today's budget spent">
                      <div className="s-window__bar"><span className="s-window__title">Pay</span><span className="muted">Ops treasury</span></div>
                      <div className="s-window__body s-form-mock">
                        <div className="s-mockfield"><span>Payee</span><b>Payroll — Ops</b></div>
                        <div className="s-mockfield s-mockfield--on"><span>Amount</span><b className="mono">30.00 PUSD</b></div>
                        <div className="s-mini__chips">
                          <span className="s-chip s-chip--safe">Allowed payee ✓</span>
                          <span className="s-chip s-chip--safe">≤ 50.00 PUSD ✓</span>
                          <span className="s-chip s-chip--safe">Budget 60.00 → 30.00 ✓</span>
                        </div>
                        <div className="s-window__row"><span className="muted">Today's budget</span><b className="mono">40.00 / 100.00 PUSD</b></div>
                        <div className="s-meter"><i style={{ width: '40%' }} /></div>
                        <span className="s-mockbtn">Create payment request</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 5. SIGNER VIEW: the dealt moment, iris-opens, on the surface ground */}
        <section className="section ground-surface" id="signer" aria-labelledby="signer-h" data-moment="iris-opens" data-moment-opts='{"from": "base"}'>
          <div className="wrap">
            <div className="section-head s-head-row">
              <h2 id="signer-h">Read the transaction, not the button</h2>
              <p className="s-head-row__p">Every input and output gets a name from the vault, the allowlist or Paryon. An unknown address blocks signing.</p>
            </div>
            <div className="ui s-window s-window--sign" role="img" aria-label="The signer view: pay 30.00 PUSD to Payroll — Ops; three inputs from the vault and Paryon's price contract, four outputs to the payee, the price contract and back to the vault; four checks passed">
              <div className="s-window__bar">
                <span className="s-window__title">You are signing: Pay 30.00 PUSD to “Payroll — Ops”</span>
                <span className="muted s-hide-sm">2 of 3 signatures needed · 1 collected (Treasurer)</span>
              </div>
              <div className="s-window__body">
                <DecodedTxView tx={signerExample()} interactive={false} raw={false} checksLabel="Checks, run again on-chain" />
              </div>
            </div>
          </div>
        </section>

        {/* 6. CREDIT AND PARTS */}
        <section className="section" id="parts" aria-labelledby="parts-h">
          <div className="wrap">
            <div className="section-head">
              <h2 id="parts-h">Built on Cermin, Wysiwys and Paryon. <span className="muted">Open source, MIT.</span></h2>
            </div>
            <ul className="grid s-parts">
              {[
                { name: 'Cermin', line: 'Vault, keeper and buffer, first built on Mezo', href: BLAZE.credit.url, img: '/assets/icons/cermin.png', tile: 'paper' },
                { name: 'Wysiwys', line: 'The decoding signer view', href: LINKS.wysiwys, img: '/assets/icons/wysiwys-mark.webp', tile: 'ink' },
                { name: 'ParyonUSD', line: 'The BCH stablecoin and its loans', href: LINKS.paryon, img: '/assets/icons/paryon.svg', tile: 'paper' },
                { name: 'CashScript', line: 'The covenant language, 0.13', href: LINKS.cashscript, img: '/assets/icons/cashscript.png', tile: 'paper' },
                { name: 'WizardConnect', line: 'Wallet pairing and signing', href: LINKS.wizardconnect, img: '/assets/icons/wizardconnect.png', tile: 'paper' },
                { name: 'Bitcoin Cash', line: 'CashTokens and 2026 VM limits', href: 'https://bitcoincash.org/', img: '/assets/icons/bitcoincash.svg', tile: 'paper' },
              ].map((p) => (
                <li key={p.name} className="span-4">
                  <a className="s-part" href={p.href} target="_blank" rel="noreferrer">
                    <span className={`s-part__tile s-part__tile--${p.tile}`}><img src={p.img} alt="" width="40" height="40" loading="lazy" /></span>
                    <span className="s-part__text"><span className="t-card">{p.name}</span><span className="s-part__line">{p.line}</span></span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="s-parts__links">
              <a className="link" href={BLAZE.credit.url} target="_blank" rel="noreferrer">Read the Cermin code</a>
              <a className="link" href={LINKS.docs} target="_blank" rel="noreferrer">Read the architecture</a>
              <a className="link" href={LINKS.chipnetFaucet} target="_blank" rel="noreferrer">Get Chipnet coins</a>
            </p>
          </div>
        </section>
      </main>

      {/* 7. CLOSE (close-word) + FOOTER (footer-dark), one screen */}
      <footer className="footer closing footer--dark ground-inverse" id="contact" aria-labelledby="close-h">
        <div className="wrap">
          <div className="closing__cta close--word">
            <div className="section-head--split">
              <div>
                <h2 id="close-h">Try the demo vault on Chipnet</h2>
                <p className="t-lead">Four vaults, a mock oracle and a keeper you can run from this browser.</p>
              </div>
              <a className="btn btn--primary" href={VAULT}>Open the demo vault<Arrow /></a>
            </div>
            <p className="close__word" aria-hidden="true">Defend.</p>
          </div>
          <div className="closing__links">
            <div className="grid">
              <div className="span-4 stack-4">
                <a className="nav__logo" href="#top"><span className="mark" data-mark="arc" aria-hidden="true"></span>sigsig</a>
                <p className="footer__lede">BCH treasury vaults with a keeper and spending rules.</p>
              </div>
              <div className="span-2 footer__col"><h3>Product</h3><ul><li><a href={VAULT}>Vaults</a></li><li><a href="/keeper">Keeper</a></li><li><a href="/new">New vault</a></li></ul></div>
              <div className="span-2 footer__col"><h3>Build</h3><ul><li><a href={BLAZE.repoUrl}>Code</a></li><li><a href={LINKS.docs}>Docs</a></li><li><a href={BLAZE.deckUrl}>Deck</a></li></ul></div>
              <div className="span-2 footer__col"><h3>Chipnet</h3><ul><li><a href={LINKS.chipnetFaucet}>Faucet</a></li><li><a href="/sign/demo-payroll">Signer view</a></li></ul></div>
              <div className="span-2 footer__col"><h3>Credit</h3><ul><li><a href={BLAZE.credit.url}>Cermin</a></li><li><a href={LINKS.wysiwys}>Wysiwys</a></li></ul></div>
            </div>
            <div className="footer__legal">
              <span>© 2026 sigsig · MIT licence</span>
              <span>Product names and logos are trademarks of their owners</span>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
