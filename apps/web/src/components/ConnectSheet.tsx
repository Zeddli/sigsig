import { useWallet } from '../wallet';
import { Sheet } from './Sheet';
import { QrCode } from './QrCode';
import { CopyButton } from './Copy';
import { LINKS } from '../config/app';
import { short } from '../data/format';

/** DESIGN §5.1: two choices with their real icons, the network switch in the footer. */
export function ConnectSheet() {
  const { sheetOpen, closeSheet, connect, pairing, error, network, setNetwork, address, wallet, disconnect } = useWallet();

  const footer = (
    <div className="s-netswitch" role="group" aria-label="Network">
      <span className="t-label muted">Network</span>
      {(['chipnet', 'mainnet'] as const).map((n) => (
        <button key={n} type="button" className={`s-seg${network === n ? ' is-on' : ''}`} aria-pressed={network === n}
          onClick={() => setNetwork(n)} disabled={!!wallet}>
          {n === 'chipnet' ? 'Chipnet' : 'Mainnet'}
        </button>
      ))}
    </div>
  );

  return (
    <Sheet open={sheetOpen} onClose={closeSheet} title={address ? 'Wallet' : 'Connect wallet'} footer={footer}>
      {address && wallet ? (
        <div className="s-stack">
          <p>Connected with {wallet.name}.</p>
          <p className="mono s-break">{address}</p>
          <div className="btn-row">
            <CopyButton value={address} label="Copy address" text />
            <button type="button" className="btn btn--secondary" onClick={() => void disconnect()}>Disconnect {short(address, 4, 4)}</button>
          </div>
        </div>
      ) : pairing?.qrUri ? (
        <div className="s-stack">
          <p>Scan with a WizardConnect wallet (Cashonize 0.9 or later), or open the link on this device.</p>
          <QrCode value={pairing.qrUri} label="WizardConnect pairing QR code" />
          <div className="btn-row">
            <a className="btn btn--primary" href={pairing.uri}>Open in wallet</a>
            {pairing.uri && <CopyButton value={pairing.uri} label="Copy link" text />}
          </div>
          <p className="t-small muted" role="status">Waiting for the wallet to answer…</p>
        </div>
      ) : (
        <div className="s-stack">
          <ul className="s-choices">
            <li>
              <button type="button" className="s-choice" onClick={() => void connect('wizardconnect')}>
                <img src="/assets/icons/wizardconnect.png" alt="" width="40" height="40" />
                <span><b>WizardConnect</b><span className="muted">QR code or deep link, any hdwalletv1 wallet</span></span>
              </button>
            </li>
            <li>
              <button type="button" className="s-choice" onClick={() => void connect('xo')}>
                <img src="/assets/icons/xo.svg" alt="" width="40" height="40" />
                <span><b>XO wallet</b><span className="muted">Template signing, not in this build yet</span></span>
              </button>
            </li>
          </ul>
          {error && <p className="s-error" role="alert">{error}</p>}
          <p className="t-small muted">
            How each one signs a covenant input: <a className="link" href={LINKS.wizardconnect} target="_blank" rel="noreferrer">WizardConnect docs</a> ·{' '}
            <a className="link" href={LINKS.xo} target="_blank" rel="noreferrer">XO</a>
          </p>
        </div>
      )}
    </Sheet>
  );
}
