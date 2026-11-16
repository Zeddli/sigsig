/**
 * Fabricated Paryon state in a MockNetworkProvider: price / borrowing / function / factory UTXOs with the right
 * categories and commitments, locked by the real @paryonusd/contracts artifacts (via core's buildParyonContracts).
 */
import {
  binToHex,
  encodeLockingBytecodeP2pkh,
  hash160,
  secp256k1,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, type Utxo } from 'cashscript';
import type { ParyonDeployment } from '../src/types.js';
import { createParyonContext, type FundingWallet, type ParyonContext } from '../src/tx/common.js';
import { encodePriceCommitment } from '../src/paryon/codec.js';
import { LOAN_FUNCTION_ID } from '../src/paryon/constants.js';
import { lockingBytecodeToAddress } from '../src/util.js';

export const id32 = (label: string) => binToHex(sha256.hash(utf8ToBin(label)));

export function makeKey(label: string) {
  const priv = sha256.hash(utf8ToBin(`key:${label}`));
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  const lockingBytecode = binToHex(encodeLockingBytecodeP2pkh(hash160(pub)));
  return {
    priv,
    pubHex: binToHex(pub),
    lockingBytecode,
    address: lockingBytecodeToAddress(lockingBytecode, 'mocknet', true)!,
    signer: new SignatureTemplate(priv),
  };
}

export const MOCK_DEPLOYMENT: ParyonDeployment = {
  name: 'mocknet-test',
  network: 'mocknet',
  tokenIds: {
    paryonTokenId: id32('paryon'),
    poolTokenId: id32('pool'),
    redeemerTokenId: id32('redeemer'),
    loanKeyFactoryTokenId: id32('loanKeyFactory'),
    oracleMigrationKeyTokenId: id32('migration'),
  },
  contractParams: {
    oraclePublicKey: makeKey('oracle').pubHex,
    protocolFeeLockingBytecode: makeKey('protocolFee').lockingBytecode,
    startBlockHeight: 100_000n,
    periodLengthBlocks: 144n,
    timeLockRedemption: 12n,
  },
};

export const PUSD_SUPPLY = 9_000_000_000_000_000n;

let txCounter = 0;
const fakeTxid = () => id32(`tx:${txCounter++}`);

export interface Fixture {
  provider: MockNetworkProvider;
  ctx: ParyonContext;
  user: ReturnType<typeof makeKey>;
  wallet(): Promise<FundingWallet>;
  setPrice(priceCents: bigint, sequence?: number): Utxo;
}

export function makeFixture(opts: { priceCents?: bigint; userSats?: bigint[]; guardedPrice?: boolean } = {}): Fixture {
  const provider = new MockNetworkProvider();
  const ctx = createParyonContext('mocknet', MOCK_DEPLOYMENT, provider);
  const c = ctx.contracts;
  const paryon = MOCK_DEPLOYMENT.tokenIds.paryonTokenId;

  let priceUtxo: Utxo | undefined;
  const setPrice = (priceCents: bigint, sequence = 10): Utxo => {
    // replace the price UTXO (MockNetworkProvider has no remove; use updateUtxoSet semantics via reset is too broad)
    const utxos = (provider as unknown as { utxoSet: [string, Utxo][] }).utxoSet;
    if (priceUtxo) {
      const i = utxos.findIndex(([, u]) => u === priceUtxo);
      if (i >= 0) utxos.splice(i, 1);
    }
    priceUtxo = provider.addUtxo((opts.guardedPrice ? c.priceGuarded : c.price).lockingBytecode, {
      txid: fakeTxid(),
      vout: 0,
      satoshis: 1000n,
      token: { category: paryon, amount: 0n, nft: { capability: 'mutable', commitment: encodePriceCommitment({ sequence, priceCents }) } },
    });
    return priceUtxo;
  };
  setPrice(opts.priceCents ?? 40_000n);

  provider.addUtxo(c.borrowing.lockingBytecode, {
    txid: fakeTxid(),
    vout: 0,
    satoshis: 1000n,
    token: { category: paryon, amount: PUSD_SUPPLY, nft: { capability: 'minting', commitment: '05000000' } },
  });
  for (const [name, fnId] of Object.entries(LOAN_FUNCTION_ID)) {
    provider.addUtxo(c.loanFunctions[name as keyof typeof LOAN_FUNCTION_ID].lockingBytecode, {
      txid: fakeTxid(),
      vout: 0,
      satoshis: 1000n,
      token: { category: paryon, amount: 0n, nft: { capability: 'none', commitment: fnId.toString(16).padStart(2, '0') } },
    });
  }
  provider.addUtxo(c.loanKeyFactory.lockingBytecode, {
    txid: fakeTxid(),
    vout: 1,
    satoshis: 1000n,
    token: { category: MOCK_DEPLOYMENT.tokenIds.loanKeyFactoryTokenId, amount: 0n, nft: { capability: 'minting', commitment: '' } },
  });

  const user = makeKey('user');
  for (const sats of opts.userSats ?? [500_000_000n, 300_000_000n]) {
    provider.addUtxo(user.lockingBytecode, { txid: fakeTxid(), vout: 0, satoshis: sats });
  }

  return {
    provider,
    ctx,
    user,
    setPrice,
    wallet: async () => ({ address: user.address, utxos: await provider.getUtxos(user.address), signer: user.signer }),
  };
}
