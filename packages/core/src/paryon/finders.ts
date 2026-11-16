/**
 * Find live Paryon UTXOs by contract address + token category + commitment.
 * Works with any cashscript NetworkProvider (ElectrumNetworkProvider / FallbackElectrumProvider / MockNetworkProvider).
 */
import { decodeTransaction, hexToBin, binToHex } from '@bitauth/libauth';
import type { NetworkProvider, Utxo } from 'cashscript';
import type { LoanState } from '../types.js';
import { decodePriceCommitment, isLoanCommitment, isPriceCommitment, loanStateFromCommitment, type PriceState } from './codec.js';
import { LOAN_FUNCTION_ID, type LoanFunctionName } from './constants.js';
import { priceContracts, type AnyContract, type ParyonContracts } from './contracts.js';

export class ParyonNotFoundError extends Error {}

const utxosAt = (provider: NetworkProvider, lockingBytecode: string) => provider.getUtxosForLockingBytecode(lockingBytecode);

const pickRandom = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export interface LivePrice extends PriceState {
  utxo: Utxo;
  /** The contract (PriceContract or PriceContractGuarded) locking this UTXO: use it to unlock and recreate. */
  contract: AnyContract;
}

/**
 * A price thread UTXO: category paryonTokenId mutable NFT, commitment 0x00|seq|price, at the PriceContractGuarded
 * or PriceContract address. Highest sequence wins; ties are picked at random (spreads contention over threads).
 */
export async function findPriceUtxo(provider: NetworkProvider, c: ParyonContracts): Promise<LivePrice> {
  const paryon = c.deployment.tokenIds.paryonTokenId;
  const found: LivePrice[] = [];
  for (const contract of priceContracts(c)) {
    for (const utxo of await utxosAt(provider, contract.lockingBytecode)) {
      if (utxo.token?.category !== paryon || utxo.token.nft?.capability !== 'mutable') continue;
      if (!isPriceCommitment(utxo.token.nft.commitment)) continue;
      found.push({ utxo, contract, ...decodePriceCommitment(utxo.token.nft.commitment) });
    }
  }
  if (found.length === 0) throw new ParyonNotFoundError('PriceContract UTXO not found');
  const best = Math.max(...found.map((p) => p.sequence));
  return pickRandom(found.filter((p) => p.sequence === best));
}

export interface LiveBorrowing {
  utxo: Utxo;
  /** 4-byte periodBorrowing commitment, hex */
  periodBorrowingHex: string;
}

/** A Borrowing UTXO (paryonTokenId minting NFT holding the PUSD supply). Picks one at random among those with enough supply. */
export async function findBorrowingUtxo(provider: NetworkProvider, c: ParyonContracts, minSupply = 0n): Promise<LiveBorrowing> {
  const paryon = c.deployment.tokenIds.paryonTokenId;
  const candidates = (await utxosAt(provider, c.borrowing.lockingBytecode)).filter(
    (u) => u.token?.category === paryon && u.token.nft?.capability === 'minting' && u.token.amount >= minSupply,
  );
  if (candidates.length === 0) throw new ParyonNotFoundError('Borrowing UTXO not found');
  const utxo = pickRandom(candidates);
  return { utxo, periodBorrowingHex: utxo.token!.nft!.commitment };
}

/** A loan-function NFT UTXO (category paryonTokenId, immutable, 1-byte commitment). Random pick to spread contention. */
export async function findLoanFunctionUtxo(
  provider: NetworkProvider,
  c: ParyonContracts,
  fn: LoanFunctionName,
): Promise<Utxo> {
  const paryon = c.deployment.tokenIds.paryonTokenId;
  const commitment = LOAN_FUNCTION_ID[fn].toString(16).padStart(2, '0');
  const candidates = (await utxosAt(provider, c.loanFunctions[fn].lockingBytecode)).filter(
    (u) => u.token?.category === paryon && u.token.nft?.capability === 'none' && u.token.nft.commitment === commitment,
  );
  if (candidates.length === 0) throw new ParyonNotFoundError(`Loan function ${fn} UTXO not found`);
  return pickRandom(candidates);
}

export const findManageUtxo = (p: NetworkProvider, c: ParyonContracts) => findLoanFunctionUtxo(p, c, 'manage');
export const findChangeInterestUtxo = (p: NetworkProvider, c: ParyonContracts) => findLoanFunctionUtxo(p, c, 'changeInterest');

/** The LoanKeyFactory UTXO (loanKeyFactoryTokenId minting NFT). */
export async function findLoanKeyFactoryUtxo(provider: NetworkProvider, c: ParyonContracts): Promise<Utxo> {
  const cat = c.deployment.tokenIds.loanKeyFactoryTokenId;
  const candidates = (await utxosAt(provider, c.loanKeyFactory.lockingBytecode)).filter(
    (u) => u.token?.category === cat && u.token.nft?.capability === 'minting',
  );
  if (candidates.length === 0) throw new ParyonNotFoundError('LoanKeyFactory UTXO not found');
  return pickRandom(candidates);
}

export interface LoanKeyOrigin {
  enforcer: Utxo;
  proof: Utxo;
}

/** The enforcer (loanKeyCategory minting) + origin proof pair created by LoanKeyFactory.create, consumed by borrow. */
export async function findLoanKeyOrigin(
  provider: NetworkProvider,
  c: ParyonContracts,
  loanKeyCategory: string,
): Promise<LoanKeyOrigin> {
  const enforcer = (await utxosAt(provider, c.loanKeyOriginEnforcer.lockingBytecode)).find(
    (u) => u.token?.category === loanKeyCategory && u.token.nft?.capability === 'minting',
  );
  if (!enforcer) throw new ParyonNotFoundError(`LoanKeyOriginEnforcer for ${loanKeyCategory} not found`);
  const proof = (await utxosAt(provider, c.loanKeyOriginProof.lockingBytecode)).find(
    (u) => u.txid === enforcer.txid && u.vout === enforcer.vout + 1,
  );
  if (!proof) throw new ParyonNotFoundError(`LoanKeyOriginProof for ${loanKeyCategory} not found`);
  return { enforcer, proof };
}

export interface LoanPair {
  loan: Utxo;
  sidecar: Utxo;
  /** raw 27-byte commitment hex */
  commitment: string;
  state: LoanState;
}

/**
 * The loan + sidecar pair for a loanKey category. The sidecar holds an immutable NFT of the loanKey category at the
 * LoanSidecar address; the loan is the previous output of the same tx (Loan.interact requires that).
 * The loan output is read from the raw tx when the provider can serve it, otherwise from the Loan address listing.
 */
export async function findLoanPair(provider: NetworkProvider, c: ParyonContracts, loanKeyCategory: string): Promise<LoanPair> {
  const sidecar = (await utxosAt(provider, c.loanSidecar.lockingBytecode)).find(
    (u) => u.token?.category === loanKeyCategory && u.token.nft?.capability === 'none',
  );
  if (!sidecar) throw new ParyonNotFoundError(`Loan sidecar for ${loanKeyCategory} not found (loan closed or never opened)`);
  const loan = (await loanFromRawTx(provider, sidecar.txid, sidecar.vout - 1)) ??
    (await utxosAt(provider, c.loan.lockingBytecode)).find((u) => u.txid === sidecar.txid && u.vout === sidecar.vout - 1);
  const paryon = c.deployment.tokenIds.paryonTokenId;
  if (!loan || loan.token?.category !== paryon || !isLoanCommitment(loan.token.nft?.commitment)) {
    throw new ParyonNotFoundError(`Loan UTXO ${sidecar.txid}:${sidecar.vout - 1} not found or invalid`);
  }
  const commitment = loan.token.nft!.commitment;
  return { loan, sidecar, commitment, state: loanStateFromCommitment(commitment, loan.satoshis) };
}

async function loanFromRawTx(provider: NetworkProvider, txid: string, vout: number): Promise<Utxo | undefined> {
  let raw: string | undefined;
  try {
    raw = await provider.getRawTransaction(txid);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'string') return undefined;
  const tx = decodeTransaction(hexToBin(raw));
  if (typeof tx === 'string') return undefined;
  const out = tx.outputs[vout];
  if (!out) return undefined;
  return {
    txid,
    vout,
    satoshis: out.valueSatoshis,
    token: out.token && {
      amount: out.token.amount,
      category: binToHex(out.token.category),
      nft: out.token.nft && { capability: out.token.nft.capability, commitment: binToHex(out.token.nft.commitment) },
    },
  };
}

/** All live state needed for a manage tx, fetched in parallel. */
export async function fetchManageContext(provider: NetworkProvider, c: ParyonContracts, loanKeyCategory: string) {
  const [price, loan, manageFn] = await Promise.all([
    findPriceUtxo(provider, c),
    findLoanPair(provider, c, loanKeyCategory),
    findManageUtxo(provider, c),
  ]);
  return { price, loan, manageFn };
}
export type ManageLiveState = Awaited<ReturnType<typeof fetchManageContext>>;
