/**
 * Live data source: the seam where the SDK team plugs in @sigsig/core.
 *
 * What goes here (ARCHITECTURE §3.1):
 *   - reads: `VaultReader` from packages/core (reader.ts, over ElectrumNetworkProvider): getPolicy, getLoan,
 *     getPriceCents, getHealth, getBuffer. Map them to `VaultView` exactly as mock.ts builds it.
 *   - builders: buildPay / buildDefend / buildSkim / buildCreateLoanKey / buildSetupState / buildBorrow, each
 *     returning core's `BuiltTx` (txHex + sourceOutputs + decoded). The UI renders `decoded` unchanged.
 *   - known vaults: a list per network (config or Chaingraph), the same list the keeper bot reads.
 *   - sign requests: KV short links (ARCHITECTURE §3.2). Until then, encode the request in the URL.
 *
 * Until those exist every call rejects with a clear message, and the UI shows its error state.
 */
import type { DataSource } from './source';

const NOT_YET = 'The live Electrum source is not wired yet: set VITE_DATA_SOURCE=mock, or plug in @sigsig/core (src/data/electrum.ts).';

export function createElectrumSource(): DataSource {
  const fail = async (): Promise<never> => { throw new Error(NOT_YET); };
  return {
    kind: 'electrum',
    listVaults: fail,
    getVault: fail,
    getActivity: fail,
    getPriceCents: fail,
    checkPay: fail,
    createPayRequest: fail,
    getSignRequest: fail,
    addSignature: fail,
    rejectRequest: fail,
    buildKeeperTx: fail,
    buildSetupTx: fail,
    broadcast: fail,
  };
}
