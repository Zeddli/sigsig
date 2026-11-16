/**
 * Shared contract between all sigsig workstreams. Change it only with a note in the PR/commit,
 * because the web app, keeper, oracle and contracts teams all code against it.
 * Amount units: BCH in satoshis (bigint), PUSD in cents (bigint, 2 decimals), CR in basis points (15000 = 150.00%).
 */

export type NetworkName = 'chipnet' | 'mainnet' | 'mocknet';

/** Paryon deployment parameters (mainnet-v1 values in docs/01; chipnet written by packages/oracle deployer). */
export interface ParyonDeployment {
  name: string;
  network: NetworkName;
  tokenIds: {
    paryonTokenId: string; // hex, big-endian display order (as explorers show it)
    poolTokenId: string;
    redeemerTokenId: string;
    loanKeyFactoryTokenId: string;
    oracleMigrationKeyTokenId: string;
  };
  contractParams: {
    oraclePublicKey: string;
    protocolFeeLockingBytecode: string;
    startBlockHeight: bigint;
    periodLengthBlocks: bigint;
    timeLockRedemption: bigint;
  };
}

/** Vault covenant constructor params (see ARCHITECTURE.md §2.2). */
export interface VaultParams {
  paryonTokenId: string;
  loanKeyCategory: string;
  stateCategory: string;
  signerPubkeys: [string, string, string]; // hex compressed pubkeys; unused slot = a burn pubkey
  m: 1 | 2 | 3;
}

/** 52-byte state NFT commitment, decoded. */
export interface VaultPolicy {
  version: number;          // bytes1
  defendCrBps: number;      // bytes2
  targetCrBps: number;      // bytes2
  skimCrBps: number;        // bytes2
  keeperFeeMaxSats: number; // bytes3
  payeeRoot: string;        // bytes20 hex
  perPaymentMax: bigint;    // bytes6, sats
  dailyBudget: bigint;      // bytes6, sats
  dayIndex: number;         // bytes4
  spentToday: bigint;       // bytes6
}

export interface LoanState {
  borrowedAmount: bigint;      // PUSD cents
  amountBeingRedeemed: bigint; // PUSD cents
  status: number;
  lastPeriodInterestPaid: number;
  currentInterestRate: number;
  nextInterestRate: number;
  collateralSats: bigint;      // loan UTXO value
}

export interface Health {
  priceCentsPerBch: bigint;
  crBps: number;              // collateral ratio in bps
  liquidationPriceCents: bigint;
  maxBorrowCents: bigint;
  status: 'safe' | 'watch' | 'defend' | 'skim' | 'liquidatable';
}

export interface Payee { label: string; address: string; }

/** What every tx builder returns. Unsigned parts are signed by the wallet (WizardConnect/XO) or by a local key. */
export interface BuiltTx {
  /** libauth-encoded unsigned (or partially signed) transaction hex */
  txHex: string;
  /** source outputs for each input, as required by wallet signing (WizardConnect format) */
  sourceOutputs: unknown[];
  /** human summary shown in UI and logs */
  summary: string;
  /** labelled view used by the signer view */
  decoded: DecodedTx;
}

export type IoLabel =
  | 'paryon-price' | 'paryon-loan' | 'paryon-sidecar' | 'paryon-function' | 'paryon-borrowing'
  | 'vault-key' | 'vault-state' | 'vault-pusd' | 'payee' | 'burn' | 'fee' | 'change' | 'keeper' | 'unknown';

export interface DecodedIo {
  index: number;
  label: IoLabel;
  name: string;           // e.g. "Payroll — Ops", "Vault state"
  address?: string;
  sats: bigint;
  tokenCategory?: string;
  tokenAmount?: bigint;
  nftCommitment?: string;
}

export interface PolicyCheck { id: string; ok: boolean; text: string; }

export interface DecodedTx {
  title: string;          // "Pay 30.00 PUSD to Payroll — Ops"
  inputs: DecodedIo[];
  outputs: DecodedIo[];
  checks: PolicyCheck[];
  feeSats: bigint;
}

/** Read side used by web app + keeper. Implemented in packages/core over ElectrumNetworkProvider. */
export interface VaultReader {
  getPolicy(vault: VaultParams): Promise<VaultPolicy>;
  getLoan(vault: VaultParams): Promise<LoanState>;
  getPriceCents(): Promise<bigint>;
  getHealth(vault: VaultParams): Promise<Health>;
  getBuffer(vault: VaultParams): Promise<{ sats: bigint; pusdCents: bigint }>;
}
