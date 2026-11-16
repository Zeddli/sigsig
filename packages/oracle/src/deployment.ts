/**
 * The deployments/<network>.json file format: core's ParyonDeploymentJson (bigints as JSON numbers, read with
 * core's `parseDeployment`) plus genesis/migration txids and an address map.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDeployment, type NetworkName, type ParyonDeployment } from '@sigsig/core';
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
  /**
   * PriceContract → PriceContractGuarded migrations (migrateContract + migration key), one per price thread,
   * as mainnet did on 2026-10-08 (block 972003). The live price threads sit at contracts.priceContractGuarded.
   */
  priceMigrationTxIds: string[];
  /** which price contract code holds the live price threads */
  livePriceContract: 'priceContractGuarded' | 'priceContract';
  counts: GenesisCounts;
  initialPrice: { seq: number; priceCents: number };
  migrationKeyHolder: string;
  contracts: Record<string, ContractInfo>;
  deployedAt: string;
}

export const toParyonDeployment = (f: DeploymentFile): ParyonDeployment => parseDeployment(f);

export function loadDeploymentFile(path: string): DeploymentFile {
  return JSON.parse(readFileSync(path, 'utf8')) as DeploymentFile;
}
