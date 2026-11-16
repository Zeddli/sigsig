/**
 * The data layer. Every screen reads through `DataSource`; nothing in a page talks to Electrum or a
 * builder directly. Two implementations:
 *   - mock.ts  realistic fixed data (default until the chipnet deployment is published)
 *   - live.ts  @sigsig/core over Electrum: ElectrumVaultReader + the vault tx builders
 * Pick one with VITE_DATA_SOURCE (src/config/app.ts). Shapes follow packages/core/src/types.ts.
 */
import type {
  BuiltTx,
  Health,
  LoanState,
  NetworkName,
  Payee,
  VaultParams,
  VaultPolicy,
} from '@sigsig/core';
import { DATA_SOURCE } from '../config/app';

export type Net = Exclude<NetworkName, 'mocknet'>;

export interface Signer {
  label: string;     // "Treasurer"
  pubkey: string;    // hex compressed
}

/** Everything the vault page shows, read in one go. */
export interface VaultView {
  id: string;
  name: string;
  network: Net;
  /** the covenant's token-aware address (z…) */
  address: string;
  params: VaultParams;
  policy: VaultPolicy;
  loan: LoanState;
  health: Health;
  buffer: { sats: bigint; pusdCents: bigint };
  payees: Payee[];
  signers: Signer[];
  /** block height at which spentToday resets */
  budgetResetHeight: number;
  /** where each figure was read from (DESIGN §1.2: every number links to its UTXO) */
  sources: { loanUtxo: string; stateUtxo: string; priceUtxo: string };
  /** yearly rate in bps as Paryon reports it (loan.currentInterestRate is the raw field) */
  interestBps: number;
  redemptionRisk: 'low' | 'medium' | 'high';
}

export interface VaultSummary {
  id: string;
  name: string;
  network: Net;
  address: string;
  health: Health;
  policy: Pick<VaultPolicy, 'defendCrBps' | 'targetCrBps' | 'skimCrBps' | 'keeperFeeMaxSats'>;
  debtCents: bigint;
  collateralSats: bigint;
}

export type ActivityKind = 'defend' | 'skim' | 'pay' | 'admin' | 'borrow';
export interface ActivityItem {
  txid: string;
  kind: ActivityKind;
  summary: string;
  height: number | null; // null = in mempool
  confirmations: number;
  at: string;            // ISO time
}

export type KeeperAction = 'defend' | 'skim';

export interface SignatureSlot {
  signer: Signer;
  signed: boolean;
}

/** A payment waiting for M of N signatures (shared by link / QR; ARCHITECTURE §3.2). */
export interface SignRequest {
  id: string;
  vaultId: string;
  network: Net;
  built: BuiltTx;
  m: number;
  slots: SignatureSlot[];
  createdAt: string;
  status: 'collecting' | 'ready' | 'broadcast' | 'rejected';
  txid?: string;
}

export interface PayDraft {
  vaultId: string;
  payeeIndex: number;
  amountCents: bigint;
}

export interface PayCheck { id: string; ok: boolean; text: string; }

export interface NewVaultDraft {
  network: Net;
  signers: string[];   // pubkeys
  m: 1 | 2 | 3;
  defendCrBps: number;
  targetCrBps: number;
  skimCrBps: number;
  keeperFeeMaxSats: number;
  payees: Payee[];
  /** entered in PUSD; converted to sats of value at the current price when the policy is written (the covenant's unit) */
  perPaymentMaxCents: bigint;
  dailyBudgetCents: bigint;
  collateralSats: bigint;
  borrowCents: bigint;
}

export type SetupStep = 'loan-key' | 'policy' | 'borrow';

export interface BroadcastResult { txid: string; }

export interface DataSource {
  readonly kind: 'mock' | 'electrum';  // 'electrum' = live.ts
  listVaults(network: Net): Promise<VaultSummary[]>;
  getVault(id: string): Promise<VaultView | null>;
  getActivity(id: string): Promise<ActivityItem[]>;
  getPriceCents(network: Net): Promise<bigint>;

  /** Live policy checks for the pay form (the covenant re-checks all of them on-chain). */
  checkPay(draft: PayDraft): Promise<PayCheck[]>;
  /** Build the pay tx (unsigned) and register it as a request other signers can open. */
  createPayRequest(draft: PayDraft): Promise<SignRequest>;
  getSignRequest(id: string): Promise<SignRequest | null>;
  /** The tx one signer's wallet signs: the request with a placeholder in that signer's slot only (0-based). */
  prepareSignature(id: string, slotIndex: number): Promise<BuiltTx>;
  /** Store a signer's signed tx; returns the updated request (combines signatures per slot). */
  addSignature(id: string, slotIndex: number, signedTxHex: string): Promise<SignRequest>;
  rejectRequest(id: string): Promise<SignRequest>;

  /** Build a keeper tx; rejects with a covenant-rule message when the covenant would refuse it. */
  buildKeeperTx(vaultId: string, action: KeeperAction, rewardTo?: string): Promise<BuiltTx>;
  /** The three setup txs of a new vault, one per stepper step. */
  buildSetupTx(step: SetupStep, draft: NewVaultDraft): Promise<BuiltTx>;
  broadcast(txHex: string): Promise<BroadcastResult>;
}

let current: DataSource | null = null;

/** The one place the source is chosen. */
export async function getSource(): Promise<DataSource> {
  if (current) return current;
  if (DATA_SOURCE === 'live') {
    const { createLiveSource } = await import('./live');
    current = createLiveSource();
  } else {
    const { createMockSource } = await import('./mock');
    current = createMockSource();
  }
  return current;
}

/** Synchronous access for the prerender and hydration (mock only). */
export function setSource(source: DataSource) { current = source; }
