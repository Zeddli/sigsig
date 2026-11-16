/**
 * Keeper configuration from env (+ an optional vault list JSON file). No node: imports here except via the
 * injected `readFile`, so the same parser works in a Cloudflare Worker (pass env bindings and no file).
 */
import type { NetworkName, VaultParams } from '@sigsig/core';
import { DEFAULT_DECIDE_OPTIONS, type DecideOptions } from './decide.js';

export interface VaultEntry {
  /** Short stable name used in logs and the pending-tx store. */
  id: string;
  params: VaultParams;
}

export type Backend = 'fake' | 'core';

export interface KeeperConfig {
  network: NetworkName;
  /** Fee wallet WIF. Required unless dryRun or backend=fake. */
  wif: string | null;
  vaults: VaultEntry[];
  intervalMs: number;
  dryRun: boolean;
  /** 'fake' = in-memory demo data (fake.ts); 'core' = @sigsig/core + Electrum (wiring.ts). */
  backend: Backend;
  electrumHost: string | null;
  decide: DecideOptions;
  /** Estimated tx sizes, bytes; fee = size × relay fee rate. Tune once core builders exist. */
  txBytes: { defend: number; skim: number };
  /** Used when the server's relay fee cannot be read. */
  fallbackFeeRateSatPerByte: number;
  /** JSON file for the pending-txid store and the lock file (Node only). */
  stateFile: string;
  lockFile: string;
  retry: { attempts: number; baseMs: number; maxMs: number };
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

const NETWORKS: readonly NetworkName[] = ['chipnet', 'mainnet', 'mocknet'];
const HEX64 = /^[0-9a-f]{64}$/i;
const PUBKEY = /^0[23][0-9a-f]{64}$/i;

function bool(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function posInt(env: Env, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${key} must be a positive integer, got "${raw}"`);
  return n;
}

function bigintOr(env: Env, key: string, dflt: bigint): bigint {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a non-negative integer, got "${raw}"`);
  return BigInt(raw);
}

/** Validate one vault list entry. Accepts `{id, params}` or a bare VaultParams with an `id` field. */
export function parseVaultEntry(raw: unknown, idx: number): VaultEntry {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError(`vault[${idx}] is not an object`);
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id ? o.id : `vault-${idx}`;
  const p = (typeof o.params === 'object' && o.params !== null ? o.params : o) as Record<string, unknown>;
  for (const k of ['paryonTokenId', 'loanKeyCategory', 'stateCategory'] as const) {
    if (typeof p[k] !== 'string' || !HEX64.test(p[k] as string)) {
      throw new ConfigError(`vault "${id}": ${k} must be 32-byte hex`);
    }
  }
  const pks = p.signerPubkeys;
  if (!Array.isArray(pks) || pks.length !== 3 || !pks.every((k) => typeof k === 'string' && PUBKEY.test(k))) {
    throw new ConfigError(`vault "${id}": signerPubkeys must be 3 compressed pubkeys (hex)`);
  }
  if (p.m !== 1 && p.m !== 2 && p.m !== 3) throw new ConfigError(`vault "${id}": m must be 1, 2 or 3`);
  return {
    id,
    params: {
      paryonTokenId: p.paryonTokenId as string,
      loanKeyCategory: p.loanKeyCategory as string,
      stateCategory: p.stateCategory as string,
      signerPubkeys: pks as [string, string, string],
      m: p.m,
    },
  };
}

export function parseVaultList(json: string, source: string): VaultEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new ConfigError(`${source}: invalid JSON (${(e as Error).message})`);
  }
  const list = Array.isArray(data) ? data : (data as { vaults?: unknown })?.vaults;
  if (!Array.isArray(list)) throw new ConfigError(`${source}: expected an array or {"vaults": [...]}`);
  const vaults = list.map(parseVaultEntry);
  const ids = new Set<string>();
  for (const v of vaults) {
    if (ids.has(v.id)) throw new ConfigError(`${source}: duplicate vault id "${v.id}"`);
    ids.add(v.id);
  }
  return vaults;
}

export interface LoadConfigOptions {
  /** CLI overrides win over env. */
  overrides?: Partial<Pick<KeeperConfig, 'dryRun' | 'backend' | 'network' | 'intervalMs'>> & { vaultsFile?: string };
  /** Synchronous file reader (Node: fs.readFileSync(p, 'utf8')). Omit in Workers. */
  readFile?: (path: string) => string;
}

/**
 * Env vars:
 *   KEEPER_NETWORK        chipnet | mainnet | mocknet (default chipnet)
 *   KEEPER_WIF            fee wallet WIF (required for live runs)
 *   KEEPER_VAULTS_FILE    path to JSON vault list   } one of these, unless backend=fake
 *   KEEPER_VAULTS         inline JSON vault list    }
 *   KEEPER_INTERVAL_SEC   loop interval (default 120)
 *   KEEPER_DRY_RUN        1 = decide and build, never broadcast
 *   KEEPER_BACKEND        fake | core (default fake until @sigsig/core lands)
 *   KEEPER_ELECTRUM_HOST  Fulcrum host override
 *   KEEPER_MAX_FEE_SATS   operator fee ceiling (vault's keeperFeeMax still applies)
 *   KEEPER_MIN_DEBT_CENTS, KEEPER_STATE_MIN_SATS, KEEPER_MIN_SKIM_SATS   decision tuning
 *   KEEPER_DEFEND_TX_BYTES (default 2500), KEEPER_SKIM_TX_BYTES (default 2300), KEEPER_FEE_RATE (default 1 sat/B)
 *   KEEPER_STATE_FILE (default .keeper-state.json), KEEPER_LOCK_FILE (default .keeper.lock)
 */
export function loadConfig(env: Env, opts: LoadConfigOptions = {}): KeeperConfig {
  const o = opts.overrides ?? {};
  const network = (o.network ?? env.KEEPER_NETWORK ?? 'chipnet') as NetworkName;
  if (!NETWORKS.includes(network)) throw new ConfigError(`KEEPER_NETWORK must be one of ${NETWORKS.join(', ')}`);

  const backend = (o.backend ?? env.KEEPER_BACKEND ?? 'fake') as Backend;
  if (backend !== 'fake' && backend !== 'core') throw new ConfigError('KEEPER_BACKEND must be fake or core');

  const dryRun = o.dryRun ?? bool(env.KEEPER_DRY_RUN);
  const wif = env.KEEPER_WIF?.trim() || null;
  if (!wif && !dryRun && backend !== 'fake') {
    throw new ConfigError('KEEPER_WIF is required for live runs (or use --dry-run)');
  }

  let vaults: VaultEntry[] = [];
  const file = o.vaultsFile ?? env.KEEPER_VAULTS_FILE;
  if (file) {
    if (!opts.readFile) throw new ConfigError('KEEPER_VAULTS_FILE is set but no file reader is available here');
    let text: string;
    try {
      text = opts.readFile(file);
    } catch (e) {
      throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
    }
    vaults = parseVaultList(text, file);
  } else if (env.KEEPER_VAULTS) {
    vaults = parseVaultList(env.KEEPER_VAULTS, 'KEEPER_VAULTS');
  }
  if (vaults.length === 0 && backend !== 'fake') {
    throw new ConfigError('no vaults configured: set KEEPER_VAULTS_FILE or KEEPER_VAULTS');
  }

  const maxFee = env.KEEPER_MAX_FEE_SATS;
  return {
    network,
    wif,
    vaults,
    intervalMs: o.intervalMs ?? posInt(env, 'KEEPER_INTERVAL_SEC', 120) * 1000,
    dryRun,
    backend,
    electrumHost: env.KEEPER_ELECTRUM_HOST || null,
    decide: {
      ...(maxFee ? { maxFeeSats: bigintOr(env, 'KEEPER_MAX_FEE_SATS', 0n) } : {}),
      minDebtCents: bigintOr(env, 'KEEPER_MIN_DEBT_CENTS', DEFAULT_DECIDE_OPTIONS.minDebtCents),
      stateMinSats: bigintOr(env, 'KEEPER_STATE_MIN_SATS', DEFAULT_DECIDE_OPTIONS.stateMinSats),
      minSkimSats: bigintOr(env, 'KEEPER_MIN_SKIM_SATS', DEFAULT_DECIDE_OPTIONS.minSkimSats),
    },
    txBytes: {
      defend: posInt(env, 'KEEPER_DEFEND_TX_BYTES', 2500),
      skim: posInt(env, 'KEEPER_SKIM_TX_BYTES', 2300),
    },
    fallbackFeeRateSatPerByte: posInt(env, 'KEEPER_FEE_RATE', 1),
    stateFile: env.KEEPER_STATE_FILE || '.keeper-state.json',
    lockFile: env.KEEPER_LOCK_FILE || '.keeper.lock',
    retry: {
      attempts: posInt(env, 'KEEPER_RETRY_ATTEMPTS', 4),
      baseMs: posInt(env, 'KEEPER_RETRY_BASE_MS', 500),
      maxMs: posInt(env, 'KEEPER_RETRY_MAX_MS', 8000),
    },
  };
}
