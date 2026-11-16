import type { NetworkName } from '@sigsig/core';

/**
 * App configuration. ONE flag picks the data source:
 *   VITE_DATA_SOURCE=mock      realistic fixed data, no network (the default; the demo and the prerender use it)
 *   VITE_DATA_SOURCE=electrum  the live reader from @sigsig/core (packages/core reader.ts, SDK team)
 */
export type DataSourceKind = 'mock' | 'electrum';

export const DATA_SOURCE: DataSourceKind =
  (import.meta.env?.VITE_DATA_SOURCE as DataSourceKind | undefined) === 'electrum' ? 'electrum' : 'mock';

export const DEFAULT_NETWORK: Exclude<NetworkName, 'mocknet'> =
  (import.meta.env?.VITE_NETWORK as 'chipnet' | 'mainnet' | undefined) ?? 'chipnet';

/** The vault the landing page and "Open the demo vault" point at. */
export const DEMO_VAULT_ID = 'ops-treasury';

export const EXPLORER: Record<'chipnet' | 'mainnet', { tx: string; address: string }> = {
  chipnet: { tx: 'https://chipnet.chaingraph.cash/tx/', address: 'https://chipnet.imaginary.cash/address/' },
  mainnet: { tx: 'https://explorer.bch.ninja/tx/', address: 'https://explorer.bch.ninja/address/' },
};

export const LINKS = {
  docs: 'https://github.com/TODO/sigsig/tree/main/docs', // TODO(blaze): follows the repo URL in config/blaze.ts
  chipnetFaucet: 'https://tbch.googol.cash/',
  wysiwys: 'https://github.com/chiwjieren/wysiwys',
  paryon: 'https://paryonusd.com/',
  cashscript: 'https://cashscript.org/',
  wizardconnect: 'https://wizardconnect-456f57.gitlab.io/',
  xo: 'https://xo.cash/',
};
