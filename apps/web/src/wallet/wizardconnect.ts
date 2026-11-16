/**
 * WizardConnect (dapp side), over @wizardconnect/dapp + @wizardconnect/core (gitlab.com/riftenlabs/lib/wizardconnect).
 *
 * Flow: the dapp opens an encrypted Nostr relay session and shows its URI as a QR; the wallet (Cashonize 0.9+,
 * other hdwalletv1 wallets) scans it, answers `wallet_ready` with its xpubs (receive m/44'/145'/0'/0, change …/1,
 * defi …/7). We derive the signer's pubkey and address locally from the receive xpub. A signature is a
 * `sign_transaction_request` carrying the BCH-WalletConnect transaction object ({ transaction, sourceOutputs,
 * userPrompt, broadcast }) plus `inputPaths` ([inputIndex, pathName, addressIndex]). Wallets sign with
 * SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID. Details and the covenant caveats: apps/web/WALLET.md.
 *
 * Everything is loaded on demand (dynamic import) so the landing page never ships the relay code.
 */
import type { BuiltTx } from '@sigsig/core';
import { defaultInputPaths, WalletError, type Pairing, type SignedTx, type SignOptions, type Wallet } from './types';

const DAPP_NAME = 'sigsig';
const DAPP_ICON = typeof location !== 'undefined' ? `${location.origin}/favicon.svg` : undefined;

type Manager = import('@wizardconnect/dapp').DappConnectionManager;
type Relay = ReturnType<typeof import('@wizardconnect/core').initiateDappRelay>;

export function createWizardConnect(network: 'chipnet' | 'mainnet'): Wallet {
  let manager: Manager | null = null;
  let relay: Relay | null = null;
  let pubkey: Uint8Array | null = null;

  async function loadPubkey() {
    if (!manager) return null;
    pubkey = manager.getPubkey(0, 0n) ?? null; // receive chain, index 0
    return pubkey;
  }

  return {
    id: 'wizardconnect',
    name: 'WizardConnect',
    available: true,

    async connect(): Promise<Pairing> {
      const [{ DappConnectionManager }, core] = await Promise.all([
        import('@wizardconnect/dapp'),
        import('@wizardconnect/core'),
      ]);
      manager = new DappConnectionManager(DAPP_NAME, DAPP_ICON);
      const m = manager;
      const stored = m.loadStoredSession();
      relay = core.initiateDappRelay(
        (payload) => m.updateConnection(payload.client, payload.status),
        stored?.privateKey && stored?.secret && stored?.walletPublicKey
          ? { existingCredentials: { privateKey: stored.privateKey, secret: stored.secret, walletPublicKey: stored.walletPublicKey } }
          : undefined,
      );
      m.attachRelay(relay);
      if (stored?.paths) m.restoreSessionPaths(stored.paths);

      let cancel = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        if (stored?.paths?.length) { void loadPubkey().then(() => resolve()); }
        m.on('walletready', () => { void loadPubkey().then(() => resolve()); });
        m.on('disconnect', (reason, message) => reject(new WalletError(message ?? `Wallet disconnected (${reason})`, 'failed')));
        cancel = () => { relay?.cleanup(); reject(new WalletError('Pairing cancelled', 'rejected')); };
      });
      return { uri: relay.uri, qrUri: relay.qrUri, ready, cancel };
    },

    async getPubkey() {
      const pk = pubkey ?? (await loadPubkey());
      if (!pk) return null;
      return [...pk].map((b) => b.toString(16).padStart(2, '0')).join('');
    },

    async getAddress() {
      const pk = pubkey ?? (await loadPubkey());
      if (!pk) return null;
      const { hash160, encodeCashAddress, CashAddressType } = await import('@bitauth/libauth');
      const res = encodeCashAddress({
        prefix: network === 'mainnet' ? 'bitcoincash' : 'bchtest',
        type: CashAddressType.p2pkhWithTokens,
        payload: hash160(pk),
      });
      return typeof res === 'string' ? res : res.address;
    },

    async signTransaction(tx: BuiltTx, opts: SignOptions = {}): Promise<SignedTx> {
      if (!manager) throw new WalletError('Connect a wallet first', 'not-connected');
      const transaction = {
        transaction: tx.txHex,
        // core's builders return sourceOutputs in the WcSourceOutput shape (Input & Output & { contract? })
        sourceOutputs: tx.sourceOutputs as never[],
        userPrompt: tx.summary,
        broadcast: opts.broadcast ?? false,
      };
      const res = await manager.signTransaction(
        { transaction, inputPaths: (opts.inputPaths ?? defaultInputPaths(tx)) as never },
        { signal: opts.signal },
      );
      if (res.error || !res.signedTransaction) {
        throw new WalletError(res.error || 'The wallet returned no signature', 'rejected');
      }
      return { signedTxHex: res.signedTransaction };
    },

    async disconnect() {
      if (!manager) return;
      manager.clearStoredSession();
      try { await manager.sendDisconnect('user_disconnect'); } catch { /* already gone */ }
      relay?.cleanup();
      manager = null; relay = null; pubkey = null;
    },
  };
}
