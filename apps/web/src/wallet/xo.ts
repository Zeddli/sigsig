/**
 * XO wallet: documented stub.
 *
 * XO (xo.cash, General Protocols) is not a connect-and-sign wallet like WizardConnect. Its wallet
 * (web dev wallet at blaze.xo.cash) runs the XO engine (@xo-cash/engine, @xo-cash/templates, @xo-cash/state):
 * a transaction is built from a *template* (roles, actions, variables, locking scripts) that every party has
 * imported; one party creates an *invitation*, others add signed *commits*, and the engine executes it.
 * There is no dapp → wallet signing channel in the published packages (checked 16 Nov 2026), so "sign this
 * BuiltTx" cannot be sent to XO as such. Integration means writing an XO template for the Vault's `pay`
 * action and handing the serialized invitation to the XO wallet. See apps/web/WALLET.md, "XO".
 */
import { WalletError, type Wallet } from './types';

export function createXo(): Wallet {
  const unsupported = async (): Promise<never> => {
    throw new WalletError(
      'XO signs through templates and invitations, not raw transactions. This build cannot hand a vault payment to XO yet; use WizardConnect.',
      'unsupported',
    );
  };
  return {
    id: 'xo',
    name: 'XO wallet',
    available: false,
    connect: unsupported,
    getAddress: async () => null,
    getPubkey: async () => null,
    signTransaction: unsupported,
    disconnect: async () => {},
  };
}
