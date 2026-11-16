import { encodePrivateKeyWif } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { txidOf } from '../src/electrum.js';
import { walletFromWif } from '../src/wallet.js';

describe('walletFromWif', () => {
  const wif = encodePrivateKeyWif(new Uint8Array(32).fill(1), 'testnet');

  it('derives a chipnet P2PKH address', () => {
    expect(walletFromWif(wif, 'chipnet').address).toMatch(/^bchtest:q/);
    expect(walletFromWif(wif, 'mainnet').address).toMatch(/^bitcoincash:q/);
  });

  it('rejects garbage without echoing it', () => {
    expect(() => walletFromWif('not-a-wif', 'chipnet')).toThrow('KEEPER_WIF is not a valid WIF');
  });
});

describe('txidOf', () => {
  it('is the reversed double sha256', () => {
    // Genesis coinbase tx of BTC/BCH.
    const genesis =
      '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';
    expect(txidOf(genesis)).toBe('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
  });
});
