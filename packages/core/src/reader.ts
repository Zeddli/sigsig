/**
 * VaultReader over a cashscript NetworkProvider (ElectrumNetworkProvider / FallbackElectrumProvider in production,
 * MockNetworkProvider in tests).
 *
 * The vault covenant's address derivation and state codec live in src/vault (contracts workstream). They are
 * injected through `VaultAdapter` so this module does not depend on the Vault artifact.
 */
import type { NetworkProvider, Utxo } from 'cashscript';
import type { Health, LoanState, NetworkName, ParyonDeployment, VaultParams, VaultPolicy, VaultReader } from './types.js';
import { buildParyonContracts, type ParyonContracts } from './paryon/contracts.js';
import { findLoanPair, findPriceUtxo, type LoanPair } from './paryon/finders.js';
import { computeHealth } from './health.js';

export interface VaultAdapter {
  /** Vault covenant locking bytecode (hex) for these constructor params. */
  lockingBytecode(params: VaultParams): string;
  /** 52-byte state commitment (hex) -> policy. */
  decodePolicy(commitmentHex: string): VaultPolicy;
}

export interface VaultUtxos {
  state?: Utxo;
  key?: Utxo;
  pusd: Utxo[];
  other: Utxo[];
}

export interface ReaderOptions {
  network: NetworkName;
  deployment: ParyonDeployment;
  provider: NetworkProvider;
  vault: VaultAdapter;
  contracts?: ParyonContracts;
  /** Cache TTL for price/loan/vault reads in ms (default 10s; 0 disables). */
  cacheMs?: number;
}

export class ElectrumVaultReader implements VaultReader {
  readonly contracts: ParyonContracts;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private opts: ReaderOptions) {
    this.contracts = opts.contracts ?? buildParyonContracts(opts.deployment, opts.provider);
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const ttl = this.opts.cacheMs ?? 10_000;
    const hit = this.cache.get(key);
    if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
    const value = fn();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  /** Drop cached reads (call after broadcasting). */
  invalidate(): void {
    this.cache.clear();
  }

  /** All UTXOs at the vault covenant, sorted into state / key / PUSD buffer. */
  getVaultUtxos(vault: VaultParams): Promise<VaultUtxos> {
    const lb = this.opts.vault.lockingBytecode(vault);
    return this.cached(`vault:${lb}`, async () => {
      const utxos = await this.opts.provider.getUtxosForLockingBytecode(lb);
      const res: VaultUtxos = { pusd: [], other: [] };
      for (const u of utxos) {
        if (u.token?.category === vault.stateCategory && u.token.nft) res.state = u;
        else if (u.token?.category === vault.loanKeyCategory && u.token.nft?.capability === 'minting') res.key = u;
        else if (u.token?.category === vault.paryonTokenId && !u.token.nft) res.pusd.push(u);
        else res.other.push(u);
      }
      return res;
    });
  }

  async getPolicy(vault: VaultParams): Promise<VaultPolicy> {
    const { state } = await this.getVaultUtxos(vault);
    if (!state) throw new Error('Vault StateUTXO not found');
    return this.opts.vault.decodePolicy(state.token!.nft!.commitment);
  }

  getLoanPair(vault: VaultParams): Promise<LoanPair> {
    return this.cached(`loan:${vault.loanKeyCategory}`, () => findLoanPair(this.opts.provider, this.contracts, vault.loanKeyCategory));
  }

  async getLoan(vault: VaultParams): Promise<LoanState> {
    return (await this.getLoanPair(vault)).state;
  }

  async getPriceCents(): Promise<bigint> {
    const p = await this.cached('price', () => findPriceUtxo(this.opts.provider, this.contracts));
    return p.priceCents;
  }

  async getHealth(vault: VaultParams): Promise<Health> {
    const [loan, price, policy] = await Promise.all([
      this.getLoan(vault),
      this.getPriceCents(),
      this.getPolicy(vault).catch(() => undefined),
    ]);
    return computeHealth(loan, price, policy);
  }

  async getBuffer(vault: VaultParams): Promise<{ sats: bigint; pusdCents: bigint }> {
    const { state, pusd } = await this.getVaultUtxos(vault);
    return {
      sats: state?.satoshis ?? 0n,
      pusdCents: pusd.reduce((s, u) => s + u.token!.amount, 0n),
    };
  }
}
