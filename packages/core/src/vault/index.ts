import { MockNetworkProvider } from 'cashscript';
import type { VaultParams, VaultPolicy } from '../types.js';
import type { VaultAdapter } from '../reader.js';
import { createVaultContract } from './contract.js';
import { decodePolicy } from './state.js';

export * from './state.js';
export * from './payees.js';
export * from './contract.js';

// Address derivation needs no network; a local provider avoids opening connections.
const offline = new MockNetworkProvider();

/** Vault locking bytecode (hex, P2SH32) for these constructor params. */
export const vaultLockingBytecode = (params: VaultParams): string => createVaultContract(params, offline).lockingBytecode;

/** The VaultAdapter that reader.ts / decode.ts expect. */
export const vaultAdapter: VaultAdapter = {
  lockingBytecode: vaultLockingBytecode,
  decodePolicy: (commitmentHex: string): VaultPolicy => decodePolicy(commitmentHex),
};
