/**
 * Mock Paryon + Vault environment for MockNetworkProvider tests.
 * Paryon UTXOs are locked by the real @paryonusd/contracts artifacts, with the categories and commitments the
 * Paryon scripts check, so every Paryon input must pass its own script too.
 */
import {
  Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder,
  type Artifact, type Output, type Unlocker, type Utxo,
} from 'cashscript';
import { paryonArtifacts } from '@paryonusd/contracts';
import {
  binToHex, encodeLockingBytecodeP2pkh, hash160, hexToBin, lockingBytecodeToCashAddress, secp256k1, sha256,
} from '@bitauth/libauth';
import * as vm26 from 'libauth-vm2026';
import { createVaultContract, vaultArtifact, type VaultContract } from '../src/vault/contract.js';
import { encodeFixedVmNumber, encodePolicyHex } from '../src/vault/state.js';
import { payeeRoot } from '../src/vault/payees.js';
import type { VaultParams, VaultPolicy } from '../src/types.js';

export const hex = binToHex;
const reverseHex = (h: string): string => binToHex(hexToBin(h).reverse());
const id = (label: string): string => binToHex(sha256.hash(new TextEncoder().encode(label)));
const n2hex = (v: bigint | number, len: number): string => binToHex(encodeFixedVmNumber(v, len));

export interface Key {
  priv: Uint8Array;
  pub: string;
  sig: SignatureTemplate;
  lockingBytecode: Uint8Array;
  address: string;
}
export function makeKey(label: string): Key {
  const priv = sha256.hash(new TextEncoder().encode(`sigsig-test-${label}`));
  const pubBin = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const lockingBytecode = encodeLockingBytecodeP2pkh(hash160(pubBin));
  const addr = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: 'bchtest' });
  if (typeof addr === 'string') throw new Error(addr);
  return { priv, pub: binToHex(pubBin), sig: new SignatureTemplate(priv), lockingBytecode, address: addr.address };
}

export const PRICE_SEQ = 100;
export const LOAN_SATS = 1000n;
export const MINER_FEE = 12_000n;
export const BURN_BYTECODE = hexToBin('6a'); // Paryon's new LockingBytecodeNullData([0x]) encodes to a bare OP_RETURN
export const IMC = '0000000000';

export const defaultPolicy = (root: string): VaultPolicy => ({
  version: 1,
  defendCrBps: 15000,
  targetCrBps: 17000,
  skimCrBps: 20000,
  keeperFeeMaxSats: 3000,
  payeeRoot: root,
  perPaymentMax: 5_000_000n,
  dailyBudget: 8_000_000n,
  dayIndex: 6000,
  spentToday: 0n,
});

export const loanCommitment = (debt: bigint, redeeming = 0n, imc = IMC): string =>
  `01${n2hex(debt, 6)}${n2hex(redeeming, 6)}02${n2hex(5, 4)}${n2hex(100, 2)}${n2hex(100, 2)}${imc}`;
export const priceCommitment = (priceCents: number): string => `00${n2hex(PRICE_SEQ, 4)}${n2hex(priceCents, 4)}`;

let txCounter = 0;
const nextTxid = (): string => id(`tx-${txCounter++}`);

export class Env {
  provider = new MockNetworkProvider();
  ids = { paryon: id('paryon'), loanKey: id('loanKey'), state: id('state'), migration: id('migration') };
  signers = [makeKey('s1'), makeKey('s2'), makeKey('s3')];
  stranger = makeKey('stranger');
  keeper = makeKey('keeper');
  payees = [makeKey('payee-a'), makeKey('payee-b'), makeKey('payee-c')];
  params: VaultParams;
  vault: VaultContract;
  price: Contract;
  loan: Contract;
  sidecar: Contract;
  manageFn: Contract;
  changeInterestFn: Contract;
  policy: VaultPolicy;

  constructor(m: 1 | 2 | 3 = 2) {
    this.params = {
      paryonTokenId: this.ids.paryon,
      loanKeyCategory: this.ids.loanKey,
      stateCategory: this.ids.state,
      signerPubkeys: [this.signers[0]!.pub, this.signers[1]!.pub, this.signers[2]!.pub],
      m,
    };
    this.vault = createVaultContract(this.params, this.provider);
    const A = paryonArtifacts;
    const mk = (a: unknown, args: Array<string | bigint>): Contract => new Contract(a as Artifact, args, { provider: this.provider });
    this.price = mk(A.artifactPriceContract, [makeKey('oracle').pub, reverseHex(this.ids.migration)]);
    this.loan = mk(A.artifactLoan, []);
    this.sidecar = mk(A.artifactLoanSidecar, []);
    this.manageFn = mk(A.loanContractFunctions.artifactFunctionManage, []);
    this.changeInterestFn = mk(A.loanContractFunctions.artifactFunctionChangeInterest, []);
    this.policy = defaultPolicy(payeeRoot(this.payees.map((p) => p.lockingBytecode)));
  }

  private add(lockingBytecode: string, utxo: Utxo): Utxo {
    this.provider.addUtxo(lockingBytecode, utxo);
    return utxo;
  }

  priceUtxo(priceCents: number): Utxo {
    return this.add(this.price.lockingBytecode, {
      txid: nextTxid(), vout: 0, satoshis: 1000n,
      token: { category: this.ids.paryon, amount: 0n, nft: { capability: 'mutable', commitment: priceCommitment(priceCents) } },
    });
  }
  /** loan (vout 0) and its sidecar (vout 1) from the same tx, as Loan.interact requires */
  loanUtxos(debt: bigint, coll: bigint, redeeming = 0n): { loan: Utxo; sidecar: Utxo } {
    const txid = nextTxid();
    const loan = this.add(this.loan.lockingBytecode, {
      txid, vout: 0, satoshis: coll,
      token: { category: this.ids.paryon, amount: 0n, nft: { capability: 'mutable', commitment: loanCommitment(debt, redeeming) } },
    });
    const sidecar = this.add(this.sidecar.lockingBytecode, {
      txid, vout: 1, satoshis: 1000n,
      token: { category: this.ids.loanKey, amount: 0n, nft: { capability: 'none', commitment: '01' } },
    });
    return { loan, sidecar };
  }
  fnUtxo(fn: Contract, commitment: string): Utxo {
    return this.add(fn.lockingBytecode, {
      txid: nextTxid(), vout: 0, satoshis: 1000n,
      token: { category: this.ids.paryon, amount: 0n, nft: { capability: 'none', commitment } },
    });
  }
  keyUtxo(): Utxo {
    return this.add(this.vault.lockingBytecode, {
      txid: nextTxid(), vout: 0, satoshis: 1000n,
      token: { category: this.ids.loanKey, amount: 0n, nft: { capability: 'minting', commitment: '' } },
    });
  }
  stateUtxo(sats: bigint, policy: VaultPolicy = this.policy): Utxo {
    return this.add(this.vault.lockingBytecode, {
      txid: nextTxid(), vout: 0, satoshis: sats,
      token: { category: this.ids.state, amount: 0n, nft: { capability: 'mutable', commitment: encodePolicyHex(policy) } },
    });
  }
  pusdUtxo(amount: bigint): Utxo {
    return this.add(this.vault.lockingBytecode, {
      txid: nextTxid(), vout: 0, satoshis: 1000n, token: { category: this.ids.paryon, amount },
    });
  }
  p2pkhUtxo(key: Key, sats: bigint): Utxo {
    return this.add(binToHex(key.lockingBytecode), { txid: nextTxid(), vout: 0, satoshis: sats });
  }

  stateOutput(sats: bigint, policy: VaultPolicy): Output {
    return {
      to: hexToBin(this.vault.lockingBytecode), amount: sats,
      token: { category: this.ids.state, amount: 0n, nft: { capability: 'mutable', commitment: encodePolicyHex(policy) } },
    };
  }
  keyOutput(): Output {
    return {
      to: hexToBin(this.vault.lockingBytecode), amount: 1000n,
      token: { category: this.ids.loanKey, amount: 0n, nft: { capability: 'minting', commitment: '' } },
    };
  }
  pusdOutput(amount: bigint, to: Uint8Array = hexToBin(this.vault.lockingBytecode)): Output {
    return { to, amount: 1000n, token: { category: this.ids.paryon, amount } };
  }
  /** an output identical to a UTXO, at the same locking bytecode (Paryon "recreate" rule) */
  same(utxo: Utxo, lockingBytecode: string, overrides: Partial<Output> = {}): Output {
    return { to: hexToBin(lockingBytecode), amount: utxo.satoshis, token: utxo.token, ...overrides };
  }

  /** M signatures for slots, '' = absent signer */
  sigs(slots: Array<SignatureTemplate | Key | null>): Array<SignatureTemplate | Uint8Array> {
    return slots.map((s) => (s === null ? new Uint8Array() : s instanceof SignatureTemplate ? s : s.sig));
  }

  builder(): TransactionBuilder {
    return new TransactionBuilder({ provider: this.provider });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Paryon manage-based scenario (defend / skim / adminManage)

export interface ManageScenario {
  priceCents: number;
  debt: bigint;
  coll: bigint;
  redeeming?: bigint;
  stateSats: bigint;
  pusd?: bigint; // PusdUTXO amount (input 6), if present
}
export interface ManageAction {
  fn: 'defend' | 'skim' | 'adminManage';
  addColl?: bigint; // negative = withdraw
  repay?: bigint;
  /** sats the keeper takes from the vault (fee claim) */
  vaultFee?: bigint;
  /** override the state output value */
  stateOutSats?: bigint;
  /** PUSD left on the recreated PusdUTXO (default pusd - repay; 0 = not recreated) */
  pusdOut?: bigint;
  /** Paryon function NFT at input 3 (default manage) */
  fnAtInput3?: 'manage' | 'changeInterest';
  extraOutputs?: Output[];
  sigs?: Array<SignatureTemplate | Uint8Array>;
  /** debt written into the new loan commitment (default debt - repay); used to try a debt increase */
  newDebtOverride?: bigint;
  /** the loan commitment to keep, except the debt (default from scenario) */
  imcOut?: string;
}

export function buildManageTx(env: Env, s: ManageScenario, a: ManageAction): TransactionBuilder {
  const repay = a.repay ?? 0n;
  const addColl = a.addColl ?? 0n;
  const vaultFee = a.vaultFee ?? 0n;
  const price = env.priceUtxo(s.priceCents);
  const { loan, sidecar } = env.loanUtxos(s.debt, s.coll, s.redeeming ?? 0n);
  const fnContract = a.fnAtInput3 === 'changeInterest' ? env.changeInterestFn : env.manageFn;
  const fn = env.fnUtxo(fnContract, a.fnAtInput3 === 'changeInterest' ? '08' : '02');
  const key = env.keyUtxo();
  const state = env.stateUtxo(s.stateSats);
  const pusd = s.pusd !== undefined ? env.pusdUtxo(s.pusd) : undefined;
  const keeperIn = env.p2pkhUtxo(env.keeper, 200_000n);

  const vaultUnlock = (): Unlocker => {
    if (a.fn === 'adminManage') {
      const [x, y, z] = a.sigs ?? env.sigs([env.signers[0]!, env.signers[1]!, null]);
      return env.vault.unlock.adminManage(x!, y!, z!);
    }
    return a.fn === 'defend' ? env.vault.unlock.defend() : env.vault.unlock.skim();
  };
  const fnUnlock = a.fnAtInput3 === 'changeInterest'
    ? env.changeInterestFn.unlock.changeInterest!('0000')
    : env.manageFn.unlock.manage!(repay, IMC);

  const b = env.builder()
    .addInput(price, env.price.unlock.sharePrice!())
    .addInput(loan, env.loan.unlock.interact!())
    .addInput(sidecar, env.sidecar.unlock.attach!())
    .addInput(fn, fnUnlock)
    .addInput(key, vaultUnlock())
    .addInput(state, vaultUnlock());
  if (pusd) b.addInput(pusd, vaultUnlock());
  b.addInput(keeperIn, env.keeper.sig.unlockP2PKH());

  const newDebt = a.newDebtOverride ?? s.debt - repay;
  const loanOut: Output = {
    to: hexToBin(env.loan.lockingBytecode), amount: s.coll + addColl,
    token: { category: env.ids.paryon, amount: 0n, nft: { capability: 'mutable', commitment: loanCommitment(newDebt, s.redeeming ?? 0n, a.imcOut ?? IMC) } },
  };
  b.addOutput(env.same(price, env.price.lockingBytecode))
    .addOutput(loanOut)
    .addOutput(env.same(sidecar, env.sidecar.lockingBytecode))
    .addOutput(env.same(fn, fnContract.lockingBytecode))
    .addOutput(env.keyOutput());
  if (repay > 0n) b.addOutput({ to: BURN_BYTECODE, amount: 0n, token: { category: env.ids.paryon, amount: repay } });
  const stateOutSats = a.stateOutSats ?? s.stateSats - addColl - vaultFee;
  b.addOutput(env.stateOutput(stateOutSats, env.policy));
  const pusdLeft = a.pusdOut ?? (s.pusd !== undefined ? s.pusd - repay : 0n);
  let pusdSatsBack = 0n;
  if (pusd && pusdLeft > 0n) {
    b.addOutput(env.pusdOutput(pusdLeft));
    pusdSatsBack = 1000n;
  }
  for (const o of a.extraOutputs ?? []) b.addOutput(o);
  // keeper change: everything else minus the miner fee
  const inSum = b.inputs.reduce((t, i) => t + i.satoshis, 0n);
  const outSum = b.outputs.reduce((t, o) => t + o.amount, 0n);
  const change = inSum - outSum - MINER_FEE;
  void pusdSatsBack;
  if (change >= 1000n) b.addOutput({ to: env.keeper.lockingBytecode, amount: change });
  return b;
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation helpers (2026 VM)

const vm = vm26.createVirtualMachineBch2026(true);
const vmConsensus = vm26.createVirtualMachineBch2026(false);

export interface InputResult {
  ok: boolean;
  error?: string;
  /** require() message of the failing statement, when the input is a vault input */
  message?: string;
}

function sourceOutputsOf(b: TransactionBuilder): vm26.Output[] {
  return b.inputs.map((i) => ({
    lockingBytecode: i.unlocker.generateLockingBytecode(),
    valueSatoshis: i.satoshis,
    ...(i.token
      ? {
        token: {
          category: hexToBin(i.token.category),
          amount: i.token.amount,
          ...(i.token.nft ? { nft: { capability: i.token.nft.capability, commitment: hexToBin(i.token.nft.commitment) } } : {}),
        },
      }
      : {}),
  })) as vm26.Output[];
}

const requiresByIp = new Map<number, string>(
  (vaultArtifact.debug?.requires ?? []).map((r) => [r.ip, (r as { message?: string }).message ?? `line ${r.line}`]),
);

/** Evaluate every input separately (so a Paryon failure does not hide the vault's own verdict). */
export function evaluateInputs(env: Env, b: TransactionBuilder): InputResult[] {
  const transaction = vm26.decodeTransactionUnsafe(hexToBin(b.build()));
  const sourceOutputs = sourceOutputsOf(b);
  const vaultBytecode = env.vault.lockingBytecode;
  return b.inputs.map((input, inputIndex) => {
    const steps = vm.debug({ inputIndex, sourceOutputs, transaction });
    let start = 0;
    steps.forEach((st, i) => { if (st.ip === 0) start = i; });
    const executed = steps.slice(start).filter((st) => st.controlStack.every((x) => x !== false));
    const last = executed[executed.length - 1]!;
    const success = vm.stateSuccess(last);
    if (success === true) return { ok: true };
    const isVault = binToHex(input.unlocker.generateLockingBytecode()) === vaultBytecode;
    const error = last.error ?? String(success);
    let message: string | undefined;
    if (isVault) {
      if (last.error) {
        const ip = last.ip - 1;
        message = requiresByIp.get(ip) ?? requiresByIp.get(ip + 1);
      } else {
        // final require without OP_VERIFY: the last executed instruction
        message = requiresByIp.get(last.ip - 1) ?? requiresByIp.get(last.ip);
      }
    }
    return { ok: false, error, message };
  });
}

/** Full transaction verification with the 2026 VM (standard = also standardness rules). */
export function verifyTx(b: TransactionBuilder, standard = true): true | string {
  const transaction = vm26.decodeTransactionUnsafe(hexToBin(b.build()));
  const sourceOutputs = sourceOutputsOf(b);
  const r = (standard ? vm : vmConsensus).verify({ sourceOutputs, transaction });
  return r === true ? true : String(r);
}

export const sizeOf = (b: TransactionBuilder): number => hexToBin(b.build()).length;
