import { decodePrivateKeyWif, privateKeyToP2pkhCashAddress } from '@bitauth/libauth';
import type { NetworkName } from '@sigsig/core';
import type { KeeperWallet } from './keeper.js';

/** Derive the fee wallet's P2PKH cashaddr from its WIF. Throws on a bad WIF (message never includes the key). */
export function walletFromWif(wif: string, network: NetworkName): KeeperWallet {
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error('KEEPER_WIF is not a valid WIF');
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const { address } = privateKeyToP2pkhCashAddress({ privateKey: decoded.privateKey, prefix });
  return { address, wif };
}
