/**
 * The 26 ParyonUSD contracts, built from the audited @paryonusd/contracts@1.1.0 artifacts with constructor
 * arguments that mirror ParyonUSD/verify_contract_deployment (contractAddresses.ts), plus the genesis-output plan
 * that mirrors the mainnet-v1 genesis transactions (one tx per token category).
 */
import { Contract, type Artifact, type ConstructorArgument, type NetworkProvider, type Output } from 'cashscript';
import { hexToBin } from '@bitauth/libauth';
import { paryonArtifacts } from '@paryonusd/contracts';
import type { ParyonDeployment } from '@sigsig/core';

export const reverseHex = (hex: string): string => (hex.match(/../g) ?? []).reverse().join('');

/** int64 max: the full PUSD supply minted in the paryonTokenId genesis (split over the Borrowing threads). */
export const MAX_TOKEN_SUPPLY = 9223372036854775807n;

/** Loan function NFT commitments, same order as `loanFunctions` below (01 liquidate … 08 changeInterest). */
export const LOAN_FUNCTION_COMMITMENTS = ['01', '02', '03', '04', '05', '06', '07', '08'] as const;
export const LOAN_FUNCTION_NAMES = [
  'liquidate', 'manage', 'redeem', 'startRedemption', 'swapInRedemption', 'swapOutRedemption', 'payInterest', 'changeInterest',
] as const;
/** Pool function NFT commitments: 01 AddLiquidity, 02 LiquidateLoan, 03 NewPeriodPool, 04 WithdrawFromPool. */
export const POOL_FUNCTION_COMMITMENTS = ['01', '02', '03', '04'] as const;
export const POOL_FUNCTION_NAMES = ['addLiquidity', 'liquidateLoan', 'newPeriodPool', 'withdrawFromPool'] as const;

/** How many parallel UTXOs ("threads") of each contract the genesis txs create. */
export interface GenesisCounts {
  borrowing: number;
  priceContracts: number;
  loanFunctionCopies: number; // per loan function
  redeemer: number;
  loanKeyFactory: number;
}

/** Exactly what mainnet-v1 minted (checked against the 5 mainnet genesis txs on 2026-11-16). */
export const MAINNET_COUNTS: GenesisCounts = {
  borrowing: 10, priceContracts: 5, loanFunctionCopies: 25, redeemer: 25, loanKeyFactory: 5,
};
/** Same shapes, fewer parallel threads (cheap chipnet / tests). */
export const LEAN_COUNTS: GenesisCounts = {
  borrowing: 2, priceContracts: 1, loanFunctionCopies: 2, redeemer: 2, loanKeyFactory: 2,
};

export const CONTRACT_SATS = 1000n;
export const STABILITY_POOL_SATS = 10_000n;

export type TokenIds = ParyonDeployment['tokenIds'];
export type ContractParams = ParyonDeployment['contractParams'];

export interface ParyonContracts {
  loan: Contract;
  loanSidecar: Contract;
  loanKeyOriginEnforcer: Contract;
  borrowing: Contract;
  priceContract: Contract;
  loanFunctions: Contract[]; // order = LOAN_FUNCTION_NAMES
  stabilityPool: Contract;
  stabilityPoolSidecar: Contract;
  payout: Contract;
  collector: Contract;
  poolFunctions: Contract[]; // order = POOL_FUNCTION_NAMES
  redemption: Contract;
  redemptionSidecar: Contract;
  redeemer: Contract;
  loanKeyOriginProof: Contract;
  loanKeyFactory: Contract;
}

const mk = (artifact: unknown, args: ConstructorArgument[], provider: NetworkProvider): Contract =>
  new Contract(artifact as Artifact, args, { provider });

/** Build all 26 contracts. Argument order and byte order copied from verify_contract_deployment/contractAddresses.ts. */
export function buildParyonContracts(
  tokenIds: TokenIds, params: ContractParams, provider: NetworkProvider,
): ParyonContracts {
  const { oraclePublicKey, protocolFeeLockingBytecode, startBlockHeight, periodLengthBlocks, timeLockRedemption } = params;
  const { paryonTokenId, poolTokenId, redeemerTokenId, loanKeyFactoryTokenId, oracleMigrationKeyTokenId } = tokenIds;
  const A = paryonArtifacts;
  const LF = A.loanContractFunctions;
  const SP = A.stabilityPool;
  const PF = SP.poolContractFunctions;

  // 1. paryonTokenId genesis contracts
  const loan = mk(A.artifactLoan, [], provider);
  const loanSidecar = mk(A.artifactLoanSidecar, [], provider);
  const loanKeyOriginEnforcer = mk(A.loanKey.artifactLoanKeyOriginEnforcer,
    [reverseHex(loanKeyFactoryTokenId), reverseHex(paryonTokenId)], provider);
  const borrowing = mk(A.artifactBorrowing, [
    loan.lockingBytecode, loanSidecar.lockingBytecode, protocolFeeLockingBytecode,
    loanKeyOriginEnforcer.lockingBytecode, startBlockHeight, periodLengthBlocks,
  ], provider);
  const priceContract = mk(A.artifactPriceContract, [oraclePublicKey, reverseHex(oracleMigrationKeyTokenId)], provider);
  const loanFunctions = [
    mk(LF.artifactFunctionLiquidate, [reverseHex(poolTokenId)], provider),
    mk(LF.artifactFunctionManage, [], provider),
    mk(LF.artifactFunctionRedeem, [reverseHex(redeemerTokenId), timeLockRedemption, startBlockHeight, periodLengthBlocks], provider),
    mk(LF.artifactFunctionStartRedemption, [reverseHex(redeemerTokenId)], provider),
    mk(LF.artifactFunctionSwapInRedemption, [reverseHex(redeemerTokenId)], provider),
    mk(LF.artifactFunctionSwapOutRedemption, [reverseHex(redeemerTokenId)], provider),
    mk(LF.artifactFunctionPayInterest, [reverseHex(poolTokenId)], provider),
    mk(LF.artifactFunctionChangeInterest, [], provider),
  ];

  // 2. poolTokenId genesis contracts
  const stabilityPool = mk(SP.artifactStabilityPool, [], provider);
  const stabilityPoolSidecar = mk(SP.artifactStabilityPoolSidecar, [reverseHex(paryonTokenId)], provider);
  const payout = mk(SP.artifactPayout, [], provider);
  const collector = mk(SP.artifactCollector, [reverseHex(paryonTokenId), protocolFeeLockingBytecode], provider);
  const poolFunctions = [
    mk(PF.artifactFunctionAddLiquidity, [reverseHex(paryonTokenId)], provider),
    mk(PF.artifactFunctionLiquidateLoan, [reverseHex(paryonTokenId)], provider),
    mk(PF.artifactFunctionNewPeriodPool, [payout.lockingBytecode, collector.lockingBytecode, startBlockHeight, periodLengthBlocks], provider),
    mk(PF.artifactFunctionWithdrawFromPool, [], provider),
  ];

  // 3. redeemerTokenId genesis contract
  const redemptionSidecar = mk(A.redeemer.artifactRedemptionSidecar, [], provider);
  const redemption = mk(A.redeemer.artifactRedemption, [reverseHex(paryonTokenId)], provider);
  const redeemer = mk(A.redeemer.artifactRedeemer,
    [reverseHex(paryonTokenId), redemption.lockingBytecode, redemptionSidecar.lockingBytecode], provider);

  // 4. loanKeyFactoryTokenId genesis contract
  const loanKeyOriginProof = mk(A.loanKey.artifactLoanKeyOriginProof, [], provider);
  const loanKeyFactory = mk(A.loanKey.artifactLoanKeyFactory,
    [loanKeyOriginEnforcer.lockingBytecode, loanKeyOriginProof.lockingBytecode], provider);

  return {
    loan, loanSidecar, loanKeyOriginEnforcer, borrowing, priceContract, loanFunctions,
    stabilityPool, stabilityPoolSidecar, payout, collector, poolFunctions,
    redemption, redemptionSidecar, redeemer, loanKeyOriginProof, loanKeyFactory,
  };
}

/** Flat name → contract map (26 entries), used for chipnet.json and for the verifier. */
export function contractList(c: ParyonContracts): Array<[string, Contract]> {
  return [
    ['borrowing', c.borrowing], ['priceContract', c.priceContract], ['loan', c.loan], ['loanSidecar', c.loanSidecar],
    ['loanKeyOriginEnforcer', c.loanKeyOriginEnforcer],
    ...LOAN_FUNCTION_NAMES.map((n, i): [string, Contract] => [`loanFunction.${n}`, c.loanFunctions[i]!]),
    ['stabilityPool', c.stabilityPool], ['stabilityPoolSidecar', c.stabilityPoolSidecar], ['payout', c.payout],
    ['collector', c.collector],
    ...POOL_FUNCTION_NAMES.map((n, i): [string, Contract] => [`poolFunction.${n}`, c.poolFunctions[i]!]),
    ['redeemer', c.redeemer], ['redemption', c.redemption], ['redemptionSidecar', c.redemptionSidecar],
    ['loanKeyFactory', c.loanKeyFactory], ['loanKeyOriginProof', c.loanKeyOriginProof],
  ];
}

/** 4-byte LE, as Paryon's toPaddedBytes(x, 4) / the price message fields. */
export function int32le(n: number | bigint): string {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0x7fffffff) throw new Error(`int32 out of range: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return Buffer.from(b).toString('hex');
}

/** PriceContract state commitment: 0x00 | seq(4 LE) | price(4 LE). */
export const priceCommitment = (seq: number, priceCents: number): string => `00${int32le(seq)}${int32le(priceCents)}`;

export function parsePriceCommitment(hex: string): { seq: number; priceCents: number } {
  if (hex.length !== 18 || !hex.startsWith('00')) throw new Error(`not a price commitment: ${hex}`);
  const b = Buffer.from(hex, 'hex');
  return { seq: b.readInt32LE(1), priceCents: b.readInt32LE(5) };
}

const lb = (c: Contract): Uint8Array => hexToBin(c.lockingBytecode);

export type CategoryKey = 'paryon' | 'pool' | 'redeemer' | 'loanKeyFactory' | 'oracleMigrationKey';
export const CATEGORY_ORDER: CategoryKey[] = ['paryon', 'pool', 'redeemer', 'loanKeyFactory', 'oracleMigrationKey'];
export const TOKEN_ID_FIELD: Record<CategoryKey, keyof TokenIds> = {
  paryon: 'paryonTokenId',
  pool: 'poolTokenId',
  redeemer: 'redeemerTokenId',
  loanKeyFactory: 'loanKeyFactoryTokenId',
  oracleMigrationKey: 'oracleMigrationKeyTokenId',
};

export interface GenesisPlanInput {
  contracts: ParyonContracts;
  tokenIds: TokenIds;
  counts: GenesisCounts;
  initialPrice: { seq: number; priceCents: number };
  migrationKeyHolderLockingBytecode: Uint8Array;
}

/**
 * The token/contract outputs of each genesis tx, in mainnet-v1 order (BCH change is added by the caller at index 0,
 * as in mainnet's redeemer/loanKeyFactory/migrationKey genesis txs). The BCMR OP_RETURN of mainnet is omitted.
 */
export function genesisOutputs(key: CategoryKey, p: GenesisPlanInput): Output[] {
  const { contracts: c, tokenIds, counts } = p;
  const cat = tokenIds[TOKEN_ID_FIELD[key]];
  switch (key) {
    case 'paryon': {
      const outs: Output[] = [];
      // Borrowing threads: minting NFT, commitment = period 0 (4 bytes), FT supply split evenly, remainder on the last.
      const per = MAX_TOKEN_SUPPLY / BigInt(counts.borrowing);
      for (let i = 0; i < counts.borrowing; i++) {
        const amount = i === counts.borrowing - 1 ? MAX_TOKEN_SUPPLY - per * BigInt(counts.borrowing - 1) : per;
        outs.push({ to: lb(c.borrowing), amount: CONTRACT_SATS, token: { category: cat, amount, nft: { capability: 'minting', commitment: '00000000' } } });
      }
      for (let i = 0; i < counts.priceContracts; i++) {
        outs.push({ to: lb(c.priceContract), amount: CONTRACT_SATS, token: { category: cat, amount: 0n, nft: { capability: 'mutable', commitment: priceCommitment(p.initialPrice.seq, p.initialPrice.priceCents) } } });
      }
      c.loanFunctions.forEach((fn, idx) => {
        for (let i = 0; i < counts.loanFunctionCopies; i++) {
          outs.push({ to: lb(fn), amount: CONTRACT_SATS, token: { category: cat, amount: 0n, nft: { capability: 'none', commitment: LOAN_FUNCTION_COMMITMENTS[idx]! } } });
        }
      });
      return outs;
    }
    case 'pool': {
      const outs: Output[] = [
        // StabilityPool: minting, period(4)=0 + totalStakedEpoch(6)=0; its sidecar must be the very next output, no token.
        { to: lb(c.stabilityPool), amount: STABILITY_POOL_SATS, token: { category: cat, amount: 0n, nft: { capability: 'minting', commitment: '00000000000000000000' } } },
        { to: lb(c.stabilityPoolSidecar), amount: CONTRACT_SATS },
      ];
      c.poolFunctions.forEach((fn, idx) => {
        outs.push({ to: lb(fn), amount: CONTRACT_SATS, token: { category: cat, amount: 0n, nft: { capability: 'none', commitment: POOL_FUNCTION_COMMITMENTS[idx]! } } });
      });
      outs.push({ to: lb(c.collector), amount: CONTRACT_SATS, token: { category: cat, amount: 0n, nft: { capability: 'mutable', commitment: '00000000' } } });
      return outs;
    }
    case 'redeemer':
      return Array.from({ length: counts.redeemer }, (): Output => (
        { to: lb(c.redeemer), amount: CONTRACT_SATS, token: { category: cat, amount: 0n, nft: { capability: 'minting', commitment: '' } } }));
    case 'loanKeyFactory':
      return Array.from({ length: counts.loanKeyFactory }, (): Output => (
        { to: lb(c.loanKeyFactory), amount: CONTRACT_SATS, token: { category: cat, amount: 0n, nft: { capability: 'minting', commitment: '' } } }));
    case 'oracleMigrationKey':
      return [{ to: p.migrationKeyHolderLockingBytecode, amount: CONTRACT_SATS, token: { category: cat, amount: 0n, nft: { capability: 'minting', commitment: '' } } }];
  }
}
