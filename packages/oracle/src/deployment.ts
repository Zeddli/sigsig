/** The deployments/<network>.json file format: a ParyonDeployment (bigints as JSON numbers) plus genesis txids. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NetworkName, ParyonDeployment } from '@sigsig/core';
import type { GenesisCounts } from './paryon.js';
import { REPO_ROOT } from './keys.js';

export const DEPLOYMENTS_DIR = join(REPO_ROOT, 'deployments');
export const defaultDeploymentPath = (network: string) => join(DEPLOYMENTS_DIR, `${network}.json`);
export const defaultStatePath = (network: string) => join(DEPLOYMENTS_DIR, `${network}.state.json`);

export interface GenesisTxIds {
  paryonTokenGenesisTxid: string;
  poolTokenGenesisTxid: string;
  redeemerTokenGenesisTxid: string;
  loanKeyFactoryTokenGenesisTxid: string;
  oracleMigrationKeyTokenGenesisTxid: string;
}

export interface ContractInfo { address: string; tokenAddress: string; lockingBytecode: string }

/** On-disk shape. contractParams numbers are plain JSON numbers (all well below 2^53). */
export interface DeploymentFile {
  name: string;
  network: NetworkName;
  tokenIds: ParyonDeployment['tokenIds'];
  contractParams: {
    oraclePublicKey: string;
    protocolFeeLockingBytecode: string;
    startBlockHeight: number;
    periodLengthBlocks: number;
    timeLockRedemption: number;
  };
  genesisTxIds: GenesisTxIds;
  /** txids of the 5 funding txs whose vout 0 created each category (txid == token id) */
  categoryPrepTxIds: string[];
  counts: GenesisCounts;
  initialPrice: { seq: number; priceCents: number };
  migrationKeyHolder: string;
  contracts: Record<string, ContractInfo>;
  deployedAt: string;
}

export function toParyonDeployment(f: DeploymentFile): ParyonDeployment {
  return {
    name: f.name,
    network: f.network,
    tokenIds: { ...f.tokenIds },
    contractParams: {
      oraclePublicKey: f.contractParams.oraclePublicKey,
      protocolFeeLockingBytecode: f.contractParams.protocolFeeLockingBytecode,
      startBlockHeight: BigInt(f.contractParams.startBlockHeight),
      periodLengthBlocks: BigInt(f.contractParams.periodLengthBlocks),
      timeLockRedemption: BigInt(f.contractParams.timeLockRedemption),
    },
  };
}

export function loadDeploymentFile(path: string): DeploymentFile {
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentFile;
}
