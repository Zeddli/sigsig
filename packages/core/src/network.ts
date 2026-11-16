/**
 * Network profiles (mainnet / chipnet / mocknet): Electrum servers, CashScript network name and the Paryon deployment.
 *
 * - Mainnet uses Paryon's mainnet-v1 deployment (github.com/ParyonUSD/verify_contract_deployment, config.ts).
 * - Chipnet uses our own Paryon deployment, written by the packages/oracle deployer to `deployments/chipnet.json`.
 *   Node callers can load it with `loadChipnetDeployment()`; the browser fetches the JSON and calls `parseDeployment()`.
 */
import { ElectrumNetworkProvider, MockNetworkProvider, Network, type NetworkProvider, type Utxo } from 'cashscript';
import type { NetworkName, ParyonDeployment } from './types.js';

/** Paryon mainnet-v1 deployment (verified against verify_contract_deployment/config.ts). */
export const PARYON_MAINNET_V1: ParyonDeployment = {
  name: 'mainnet-v1',
  network: 'mainnet',
  tokenIds: {
    paryonTokenId: '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544',
    poolTokenId: '7708645a7f30e97003573d9322202960a560a87527bef3666a30044a0dfdfa81',
    redeemerTokenId: '649b2d862f01a904addf9095ae64860a59071544ee4a3695f14cbbc75571f930',
    loanKeyFactoryTokenId: 'f07165f2c3448ced3bf0b33f9048ceb7567a2c07adb60d8f11b301c42db97405',
    oracleMigrationKeyTokenId: '7776202e8f4eca51d5e634799c66c6a87076cc6efcc64c1322e7e880c71f6d30',
  },
  contractParams: {
    oraclePublicKey: '02d09db08af1ff4e8453919cc866a4be427d7bfe18f2c05e5444c196fcf6fd2818',
    protocolFeeLockingBytecode: 'aa207c7a248c794af2cdf1b1a66a2311347c45b177fcb3aad730a7823c9e32fc754087',
    startBlockHeight: 948406n,
    periodLengthBlocks: 144n,
    timeLockRedemption: 12n,
  },
};

export interface NetworkProfile {
  name: NetworkName;
  /** CashScript network name used for addresses and providers. */
  cashscriptNetwork: Network;
  /** Electrum/Fulcrum hostnames, in order of preference (first = primary, rest = fallbacks). */
  electrumServers: string[];
  /** Paryon deployment, if known for this network (chipnet: only after the deployer ran). */
  paryon?: ParyonDeployment;
  /** Block explorer tx URL prefix (append the txid). */
  explorerTxUrl: string;
}

export const MAINNET_ELECTRUM_SERVERS = [
  'bch.imaginary.cash',
  'electroncash.dk',
  'bch.loping.net',
  'electrum.imaginary.cash',
  'bch.cyberbits.eu',
];

export const CHIPNET_ELECTRUM_SERVERS = ['chipnet.bch.ninja', 'chipnet.imaginary.cash', 'chipnet.c3-soft.com'];

export const MAINNET: NetworkProfile = {
  name: 'mainnet',
  cashscriptNetwork: Network.MAINNET,
  electrumServers: MAINNET_ELECTRUM_SERVERS,
  paryon: PARYON_MAINNET_V1,
  explorerTxUrl: 'https://explorer.salemkode.com/tx/',
};

export const CHIPNET: NetworkProfile = {
  name: 'chipnet',
  cashscriptNetwork: Network.CHIPNET,
  electrumServers: CHIPNET_ELECTRUM_SERVERS,
  explorerTxUrl: 'https://chipnet.chaingraph.cash/tx/',
};

export const MOCKNET: NetworkProfile = {
  name: 'mocknet',
  cashscriptNetwork: Network.MOCKNET,
  electrumServers: [],
  explorerTxUrl: '',
};

/** JSON shape of deployments/<network>.json: like ParyonDeployment but bigints may be strings or numbers. */
export type ParyonDeploymentJson = Omit<ParyonDeployment, 'contractParams'> & {
  contractParams: Omit<ParyonDeployment['contractParams'], 'startBlockHeight' | 'periodLengthBlocks' | 'timeLockRedemption'> & {
    startBlockHeight: string | number | bigint;
    periodLengthBlocks: string | number | bigint;
    timeLockRedemption: string | number | bigint;
  };
};

const HEX32 = /^[0-9a-f]{64}$/;

/** Parse and validate a deployment JSON object (e.g. the contents of deployments/chipnet.json). */
export function parseDeployment(json: unknown): ParyonDeployment {
  const d = json as ParyonDeploymentJson;
  if (!d || typeof d !== 'object' || !d.tokenIds || !d.contractParams) {
    throw new Error('Invalid Paryon deployment JSON: missing tokenIds/contractParams');
  }
  for (const [k, v] of Object.entries(d.tokenIds)) {
    if (typeof v !== 'string' || !HEX32.test(v.toLowerCase())) throw new Error(`Invalid Paryon deployment: tokenIds.${k}`);
  }
  const cp = d.contractParams;
  return {
    name: d.name ?? 'unnamed',
    network: d.network,
    tokenIds: {
      paryonTokenId: d.tokenIds.paryonTokenId.toLowerCase(),
      poolTokenId: d.tokenIds.poolTokenId.toLowerCase(),
      redeemerTokenId: d.tokenIds.redeemerTokenId.toLowerCase(),
      loanKeyFactoryTokenId: d.tokenIds.loanKeyFactoryTokenId.toLowerCase(),
      oracleMigrationKeyTokenId: d.tokenIds.oracleMigrationKeyTokenId.toLowerCase(),
    },
    contractParams: {
      oraclePublicKey: cp.oraclePublicKey.toLowerCase(),
      protocolFeeLockingBytecode: cp.protocolFeeLockingBytecode.toLowerCase(),
      startBlockHeight: BigInt(cp.startBlockHeight),
      periodLengthBlocks: BigInt(cp.periodLengthBlocks),
      timeLockRedemption: BigInt(cp.timeLockRedemption),
    },
  };
}

/** Serialize a deployment to JSON-safe form (bigints as strings). */
export function serializeDeployment(d: ParyonDeployment): ParyonDeploymentJson {
  return {
    ...d,
    contractParams: {
      ...d.contractParams,
      startBlockHeight: d.contractParams.startBlockHeight.toString(),
      periodLengthBlocks: d.contractParams.periodLengthBlocks.toString(),
      timeLockRedemption: d.contractParams.timeLockRedemption.toString(),
    },
  };
}

/**
 * Node only: load deployments/chipnet.json. Looks at `path` if given, otherwise walks up from the cwd
 * looking for `deployments/chipnet.json`. Returns undefined when the file does not exist.
 */
export async function loadChipnetDeployment(path?: string): Promise<ParyonDeployment | undefined> {
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  const candidates: string[] = [];
  if (path) candidates.push(path);
  else {
    const proc = (globalThis as { process?: { cwd(): string } }).process;
    let dir = proc ? proc.cwd() : '.';
    for (let i = 0; i < 6; i++) {
      candidates.push(nodePath.join(dir, 'deployments', 'chipnet.json'));
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return parseDeployment(JSON.parse(raw));
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') continue;
      throw e;
    }
  }
  return undefined;
}

/** Profile for a network. For chipnet, pass the deployment (from loadChipnetDeployment / fetch). */
export function getNetworkProfile(name: NetworkName, paryon?: ParyonDeployment): NetworkProfile {
  const base = name === 'mainnet' ? MAINNET : name === 'chipnet' ? CHIPNET : MOCKNET;
  return paryon ? { ...base, paryon } : { ...base };
}

/** Node helper: chipnet profile with deployments/chipnet.json loaded if present. */
export async function loadNetworkProfile(name: NetworkName, chipnetDeploymentPath?: string): Promise<NetworkProfile> {
  if (name === 'chipnet') return getNetworkProfile('chipnet', await loadChipnetDeployment(chipnetDeploymentPath));
  return getNetworkProfile(name);
}

const CONNECTION_ERROR = /connect|timeout|timed out|socket|closed|ECONN|ENOTFOUND|EAI_AGAIN|network|unavailable|disconnect/i;

/**
 * NetworkProvider over a list of Electrum servers: requests go to the current server and move to the next one
 * when the error looks like a connection problem. Script/consensus rejections are returned as-is.
 */
export class FallbackElectrumProvider implements NetworkProvider {
  network: Network;
  private providers: (ElectrumNetworkProvider | undefined)[];
  private current = 0;

  constructor(
    network: Network,
    private servers: string[],
  ) {
    if (servers.length === 0) throw new Error('FallbackElectrumProvider needs at least one server');
    this.network = network;
    this.providers = servers.map(() => undefined);
  }

  get currentServer(): string {
    return this.servers[this.current]!;
  }

  private provider(i: number): ElectrumNetworkProvider {
    let p = this.providers[i];
    if (!p) {
      p = new ElectrumNetworkProvider(this.network, { hostname: this.servers[i]! });
      this.providers[i] = p;
    }
    return p;
  }

  private async withFallback<T>(fn: (p: ElectrumNetworkProvider) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.servers.length; attempt++) {
      const i = (this.current + attempt) % this.servers.length;
      try {
        const result = await fn(this.provider(i));
        this.current = i;
        return result;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!CONNECTION_ERROR.test(msg)) throw e;
      }
    }
    throw lastError;
  }

  getUtxos(address: string): Promise<Utxo[]> {
    return this.withFallback((p) => p.getUtxos(address));
  }
  getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<Utxo[]> {
    return this.withFallback((p) => p.getUtxosForLockingBytecode(lockingBytecode));
  }
  getBlockHeight(): Promise<number> {
    return this.withFallback((p) => p.getBlockHeight());
  }
  getRawTransaction(txid: string): Promise<string> {
    return this.withFallback((p) => p.getRawTransaction(txid));
  }
  sendRawTransaction(txHex: string): Promise<string> {
    return this.withFallback((p) => p.sendRawTransaction(txHex));
  }
  /** Raw Electrum request (e.g. 'blockchain.transaction.get'), with fallback. */
  performRequest(name: string, ...params: (string | number | boolean)[]): Promise<unknown> {
    return this.withFallback((p) => p.performRequest(name, ...params));
  }
}

/** Create the NetworkProvider for a profile (Electrum with fallbacks; MockNetworkProvider for mocknet). */
export function createProvider(profile: NetworkProfile): NetworkProvider {
  if (profile.name === 'mocknet') return new MockNetworkProvider();
  return new FallbackElectrumProvider(profile.cashscriptNetwork, profile.electrumServers);
}
