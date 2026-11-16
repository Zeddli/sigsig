/**
 * Vault covenant instance from VaultParams (constructor args → P2SH32 address).
 *
 * Token categories in VaultParams are hex in display order (as explorers and cashscript `token.category` show
 * them, same as ParyonDeployment.tokenIds). The covenant compares against `OP_UTXOTOKENCATEGORY`, which yields
 * the internal (reversed) order, so the constructor gets the reversed bytes.
 */
import { binToHex, hexToBin } from '@bitauth/libauth';
import { Contract, type NetworkProvider } from 'cashscript';
import type { VaultParams } from '../types.js';
import vaultArtifact from './Vault.artifact.js';

export { vaultArtifact };
export type VaultContract = Contract<typeof vaultArtifact>;

/** Fixed input/output indexes per covenant function (see the header of contracts/Vault.cash). */
export const VAULT_LAYOUT = {
  defend: { inputs: { price: 0, loan: 1, sidecar: 2, manageFn: 3, key: 4, state: 5, pusd: 6 }, burnOutput: 5 },
  skim: { inputs: { price: 0, loan: 1, sidecar: 2, manageFn: 3, key: 4, state: 5 }, stateOutput: 5 },
  payBch: { inputs: { state: 0 }, outputs: { payee: 0, state: 1 } },
  payPusd: { inputs: { state: 0, price: 1, pusd: 2 }, outputs: { payee: 0, price: 1, state: 2, pusdChange: 3 } },
  adminManage: { inputs: { price: 0, loan: 1, sidecar: 2, manageFn: 3, key: 4, state: 5, pusd: 6 } },
  adminInterest: { inputs: { loan: 0, sidecar: 1, changeInterestFn: 2, key: 3, state: 4 } },
  adminPolicy: { inputs: { state: 0 }, outputs: { state: 0 } },
  exit: { inputs: { state: 0 } },
} as const;

/** Paryon function NFT commitments the covenant pins. */
export const PARYON_FN_MANAGE = '02';
export const PARYON_FN_CHANGE_INTEREST = '08';
/** `defend` treats the buffer as used up when the StateUTXO keeps at most this many sats and < 100.00 PUSD. */
export const DEFEND_EXHAUSTED_SATS = 2000n;
export const DEFEND_EXHAUSTED_PUSD = 10000n;

const reverseHex = (hex: string): string => binToHex(hexToBin(hex).reverse());

function assertCategory(name: string, hex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be 32 bytes hex`);
}

/** Constructor arguments in contract order. */
export function vaultConstructorArgs(params: VaultParams): [string, string, string, string, string, string, bigint] {
  assertCategory('paryonTokenId', params.paryonTokenId);
  assertCategory('loanKeyCategory', params.loanKeyCategory);
  assertCategory('stateCategory', params.stateCategory);
  const pks = params.signerPubkeys.map((pk) => pk.toLowerCase());
  for (const pk of pks) {
    if (!/^0[23][0-9a-f]{64}$/.test(pk)) throw new Error(`signer pubkey ${pk} must be a 33-byte compressed key`);
  }
  if (new Set(pks).size !== 3) throw new Error('signer pubkeys must be distinct (one signer would count twice)');
  if (![1, 2, 3].includes(params.m)) throw new Error('m must be 1, 2 or 3');
  return [
    reverseHex(params.paryonTokenId),
    reverseHex(params.loanKeyCategory),
    reverseHex(params.stateCategory),
    pks[0]!,
    pks[1]!,
    pks[2]!,
    BigInt(params.m),
  ];
}

export function createVaultContract(params: VaultParams, provider: NetworkProvider): VaultContract {
  return new Contract(vaultArtifact, vaultConstructorArgs(params), { provider, addressType: 'p2sh32' });
}

export interface VaultAddresses {
  address: string;
  tokenAddress: string;
  lockingBytecode: string;
  /** redeem script size in bytes (constructor args + compiled code) */
  bytesize: number;
}

export function vaultAddresses(params: VaultParams, provider: NetworkProvider): VaultAddresses {
  const c = createVaultContract(params, provider);
  return { address: c.address, tokenAddress: c.tokenAddress, lockingBytecode: c.lockingBytecode, bytesize: c.bytesize };
}
