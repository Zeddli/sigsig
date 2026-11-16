/**
 * Build the Paryon `Contract` instances from a ParyonDeployment, in the same way as
 * ParyonUSD/verify_contract_deployment/contractAddresses.ts does (constructor args, reversed token ids).
 */
import { paryonArtifacts } from '@paryonusd/contracts';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';
import type { ParyonDeployment } from '../types.js';
import { reverseHex } from '../util.js';
import type { LoanFunctionName } from './constants.js';

/** Contract with an untyped unlock map (Paryon artifacts are `as const`; we call unlockers by name). */
export type AnyContract = Contract<Artifact, { constructorInputs: any[]; unlock: Record<string, any> }>;

export interface ParyonContracts {
  deployment: ParyonDeployment;
  borrowing: AnyContract;
  /** Original PriceContract (genesis code; our chipnet deployment may still use it). */
  price: AnyContract;
  /**
   * PriceContractGuarded: same constructor args, sharePrice also forces the origin-proof burn in borrow.
   * Mainnet's 5 price threads moved to it via migrateContract on 2026-10-08 (block 972,003).
   */
  priceGuarded: AnyContract;
  loan: AnyContract;
  loanSidecar: AnyContract;
  loanFunctions: Record<LoanFunctionName, AnyContract>;
  loanKeyFactory: AnyContract;
  loanKeyOriginEnforcer: AnyContract;
  loanKeyOriginProof: AnyContract;
  stabilityPool: AnyContract;
  stabilityPoolSidecar: AnyContract;
  payout: AnyContract;
  collector: AnyContract;
  redeemer: AnyContract;
  redemption: AnyContract;
  redemptionSidecar: AnyContract;
}

const make = (artifact: unknown, args: unknown[], provider: NetworkProvider): AnyContract =>
  new Contract(artifact as Artifact, args as any, { provider }) as unknown as AnyContract;

export function buildParyonContracts(deployment: ParyonDeployment, provider: NetworkProvider): ParyonContracts {
  const { oraclePublicKey, protocolFeeLockingBytecode, startBlockHeight, periodLengthBlocks, timeLockRedemption } =
    deployment.contractParams;
  const { paryonTokenId, poolTokenId, redeemerTokenId, loanKeyFactoryTokenId, oracleMigrationKeyTokenId } =
    deployment.tokenIds;
  const a = paryonArtifacts;
  const lf = a.loanContractFunctions;

  const loan = make(a.artifactLoan, [], provider);
  const loanSidecar = make(a.artifactLoanSidecar, [], provider);
  const loanKeyOriginEnforcer = make(
    a.loanKey.artifactLoanKeyOriginEnforcer,
    [reverseHex(loanKeyFactoryTokenId), reverseHex(paryonTokenId)],
    provider,
  );
  const borrowing = make(
    a.artifactBorrowing,
    [
      loan.lockingBytecode,
      loanSidecar.lockingBytecode,
      protocolFeeLockingBytecode,
      loanKeyOriginEnforcer.lockingBytecode,
      startBlockHeight,
      periodLengthBlocks,
    ],
    provider,
  );
  const price = make(a.artifactPriceContract, [oraclePublicKey, reverseHex(oracleMigrationKeyTokenId)], provider);
  const priceGuarded = make(a.artifactPriceContractGuarded, [oraclePublicKey, reverseHex(oracleMigrationKeyTokenId)], provider);

  const loanFunctions: Record<LoanFunctionName, AnyContract> = {
    liquidate: make(lf.artifactFunctionLiquidate, [reverseHex(poolTokenId)], provider),
    manage: make(lf.artifactFunctionManage, [], provider),
    redeem: make(
      lf.artifactFunctionRedeem,
      [reverseHex(redeemerTokenId), timeLockRedemption, startBlockHeight, periodLengthBlocks],
      provider,
    ),
    startRedemption: make(lf.artifactFunctionStartRedemption, [reverseHex(redeemerTokenId)], provider),
    swapInRedemption: make(lf.artifactFunctionSwapInRedemption, [reverseHex(redeemerTokenId)], provider),
    swapOutRedemption: make(lf.artifactFunctionSwapOutRedemption, [reverseHex(redeemerTokenId)], provider),
    payInterest: make(lf.artifactFunctionPayInterest, [reverseHex(poolTokenId)], provider),
    changeInterest: make(lf.artifactFunctionChangeInterest, [], provider),
  };

  const sp = a.stabilityPool;
  const stabilityPool = make(sp.artifactStabilityPool, [], provider);
  const stabilityPoolSidecar = make(sp.artifactStabilityPoolSidecar, [reverseHex(paryonTokenId)], provider);
  const payout = make(sp.artifactPayout, [], provider);
  const collector = make(sp.artifactCollector, [reverseHex(paryonTokenId), protocolFeeLockingBytecode], provider);

  const redemptionSidecar = make(a.redeemer.artifactRedemptionSidecar, [], provider);
  const redemption = make(a.redeemer.artifactRedemption, [reverseHex(paryonTokenId)], provider);
  const redeemer = make(
    a.redeemer.artifactRedeemer,
    [reverseHex(paryonTokenId), redemption.lockingBytecode, redemptionSidecar.lockingBytecode],
    provider,
  );

  const loanKeyOriginProof = make(a.loanKey.artifactLoanKeyOriginProof, [], provider);
  const loanKeyFactory = make(
    a.loanKey.artifactLoanKeyFactory,
    [loanKeyOriginEnforcer.lockingBytecode, loanKeyOriginProof.lockingBytecode],
    provider,
  );

  return {
    deployment,
    borrowing,
    price,
    priceGuarded,
    loan,
    loanSidecar,
    loanFunctions,
    loanKeyFactory,
    loanKeyOriginEnforcer,
    loanKeyOriginProof,
    stabilityPool,
    stabilityPoolSidecar,
    payout,
    collector,
    redeemer,
    redemption,
    redemptionSidecar,
  };
}

/** Map lockingBytecode hex -> human name for every Paryon contract (used by the decoder). */
export function paryonBytecodeNames(c: ParyonContracts): Map<string, string> {
  const m = new Map<string, string>();
  m.set(c.borrowing.lockingBytecode, 'Paryon Borrowing');
  m.set(c.price.lockingBytecode, 'Paryon PriceContract');
  m.set(c.priceGuarded.lockingBytecode, 'Paryon PriceContract (guarded)');
  m.set(c.loan.lockingBytecode, 'Paryon Loan');
  m.set(c.loanSidecar.lockingBytecode, 'Paryon LoanSidecar');
  for (const [name, fn] of Object.entries(c.loanFunctions)) m.set(fn.lockingBytecode, `Paryon ${name} function`);
  m.set(c.loanKeyFactory.lockingBytecode, 'Paryon LoanKeyFactory');
  m.set(c.loanKeyOriginEnforcer.lockingBytecode, 'Paryon LoanKeyOriginEnforcer');
  m.set(c.loanKeyOriginProof.lockingBytecode, 'Paryon LoanKeyOriginProof');
  m.set(c.stabilityPool.lockingBytecode, 'Paryon StabilityPool');
  m.set(c.stabilityPoolSidecar.lockingBytecode, 'Paryon StabilityPoolSidecar');
  m.set(c.payout.lockingBytecode, 'Paryon Payout');
  m.set(c.collector.lockingBytecode, 'Paryon Collector');
  m.set(c.redeemer.lockingBytecode, 'Paryon Redeemer');
  m.set(c.redemption.lockingBytecode, 'Paryon Redemption');
  m.set(c.redemptionSidecar.lockingBytecode, 'Paryon RedemptionSidecar');
  m.set(c.deployment.contractParams.protocolFeeLockingBytecode, 'Paryon protocol fee');
  return m;
}

/** Both price contract variants, guarded first (the mainnet one). */
export const priceContracts = (c: ParyonContracts): AnyContract[] => [c.priceGuarded, c.price];
