/**
 * Vault state NFT commitment codec (52 bytes, see ARCHITECTURE.md §2.2 and contracts/Vault.cash).
 *
 * ver1 | defendCR2 | targetCR2 | skimCR2 | keeperFeeMax3 | payeeRoot20 | perPaymentMax6 | dailyBudget6 | dayIndex4 | spentToday6
 *
 * Every integer is a fixed-width VM number (little endian, sign bit in the top bit of the last byte), the format
 * `toPaddedBytes(x, n)` / `int(bytes)` uses in the covenant. So a field of n bytes holds 0 .. 2^(8n-1)-1.
 */
import { binToHex, hexToBin } from '@bitauth/libauth';
import type { VaultPolicy } from '../types.js';

export const POLICY_VERSION = 1;
export const STATE_COMMITMENT_LENGTH = 52;
/** Bytes covered by adminPolicy (everything before dayIndex). */
export const POLICY_FIELDS_LENGTH = 42;

/** [name, offset, length] for every field, in commitment order. */
export const STATE_LAYOUT = {
  version: [0, 1],
  defendCrBps: [1, 2],
  targetCrBps: [3, 2],
  skimCrBps: [5, 2],
  keeperFeeMaxSats: [7, 3],
  payeeRoot: [10, 20],
  perPaymentMax: [30, 6],
  dailyBudget: [36, 6],
  dayIndex: [42, 4],
  spentToday: [46, 6],
} as const satisfies Record<keyof VaultPolicy, readonly [number, number]>;

/** Encode a non-negative integer as a fixed-width VM number (same as cashscript `toPaddedBytes`). */
export function encodeFixedVmNumber(value: bigint | number, length: number, field = 'value'): Uint8Array {
  const v = BigInt(value);
  const max = (1n << BigInt(8 * length - 1)) - 1n;
  if (v < 0n || v > max) throw new RangeError(`${field} ${v} out of range 0..${max} (${length} bytes)`);
  const out = new Uint8Array(length);
  let x = v;
  for (let i = 0; i < length; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Decode a fixed-width VM number (same as cashscript `int(bytes)` on padded bytes). */
export function decodeFixedVmNumber(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
  const signBit = 1n << BigInt(8 * bytes.length - 1);
  if (x & signBit) return -(x ^ signBit);
  return x;
}

const toBytes = (input: string | Uint8Array): Uint8Array => (typeof input === 'string' ? hexToBin(input) : input);

/** The first 42 bytes (policy fields), as passed to `adminPolicy(newPolicy)`. */
export function encodePolicyFields(policy: Omit<VaultPolicy, 'dayIndex' | 'spentToday'>): Uint8Array {
  const root = hexToBin(policy.payeeRoot);
  if (root.length !== 20) throw new RangeError('payeeRoot must be 20 bytes');
  if (policy.targetCrBps < policy.defendCrBps) throw new RangeError('targetCrBps must be >= defendCrBps');
  if (policy.skimCrBps < policy.targetCrBps) throw new RangeError('skimCrBps must be >= targetCrBps');
  const out = new Uint8Array(POLICY_FIELDS_LENGTH);
  out.set(encodeFixedVmNumber(policy.version, 1, 'version'), 0);
  out.set(encodeFixedVmNumber(policy.defendCrBps, 2, 'defendCrBps'), 1);
  out.set(encodeFixedVmNumber(policy.targetCrBps, 2, 'targetCrBps'), 3);
  out.set(encodeFixedVmNumber(policy.skimCrBps, 2, 'skimCrBps'), 5);
  out.set(encodeFixedVmNumber(policy.keeperFeeMaxSats, 3, 'keeperFeeMaxSats'), 7);
  out.set(root, 10);
  out.set(encodeFixedVmNumber(policy.perPaymentMax, 6, 'perPaymentMax'), 30);
  out.set(encodeFixedVmNumber(policy.dailyBudget, 6, 'dailyBudget'), 36);
  return out;
}

/** Full 52-byte commitment. */
export function encodePolicy(policy: VaultPolicy): Uint8Array {
  const out = new Uint8Array(STATE_COMMITMENT_LENGTH);
  out.set(encodePolicyFields(policy), 0);
  out.set(encodeFixedVmNumber(policy.dayIndex, 4, 'dayIndex'), 42);
  out.set(encodeFixedVmNumber(policy.spentToday, 6, 'spentToday'), 46);
  return out;
}

export const encodePolicyHex = (policy: VaultPolicy): string => binToHex(encodePolicy(policy));

export function decodePolicy(commitment: string | Uint8Array): VaultPolicy {
  const c = toBytes(commitment);
  if (c.length !== STATE_COMMITMENT_LENGTH) {
    throw new RangeError(`state commitment must be ${STATE_COMMITMENT_LENGTH} bytes, got ${c.length}`);
  }
  const num = ([o, l]: readonly [number, number]) => decodeFixedVmNumber(c.slice(o, o + l));
  return {
    version: Number(num(STATE_LAYOUT.version)),
    defendCrBps: Number(num(STATE_LAYOUT.defendCrBps)),
    targetCrBps: Number(num(STATE_LAYOUT.targetCrBps)),
    skimCrBps: Number(num(STATE_LAYOUT.skimCrBps)),
    keeperFeeMaxSats: Number(num(STATE_LAYOUT.keeperFeeMaxSats)),
    payeeRoot: binToHex(c.slice(10, 30)),
    perPaymentMax: num(STATE_LAYOUT.perPaymentMax),
    dailyBudget: num(STATE_LAYOUT.dailyBudget),
    dayIndex: Number(num(STATE_LAYOUT.dayIndex)),
    spentToday: num(STATE_LAYOUT.spentToday),
  };
}

/** Day number the covenant uses: tx.locktime / 144 (locktime = a block height). */
export const dayIndexForHeight = (height: number): number => Math.floor(height / 144);

/**
 * The amount `pay` charges against perPaymentMax / dailyBudget, in sats (one unit for both assets):
 *   max(vault BCH in - vault BCH out, 0) + ceil(PUSD that left the vault * 1e8 / price)
 * where price is the PriceContract price (PUSD cents per BCH) at input 1 of a PUSD payment.
 * (The covenant computes ceil as (pusd*1e8 + price - 1) / price, clamped at 0 before the division.)
 */
export function paymentAmountSats(a: {
  vaultBchIn: bigint; vaultBchOut: bigint; pusdIn?: bigint; pusdOut?: bigint; priceCents?: bigint;
}): bigint {
  const lost = a.vaultBchIn - a.vaultBchOut;
  const pusd = (a.pusdIn ?? 0n) - (a.pusdOut ?? 0n);
  let pusdSats = 0n;
  if (pusd !== 0n) {
    if (!a.priceCents || a.priceCents <= 0n) throw new Error('a PUSD payment needs the PriceContract price');
    const num = pusd * 100_000_000n + a.priceCents - 1n;
    pusdSats = num > 0n ? num / a.priceCents : 0n;
  }
  return (lost > 0n ? lost : 0n) + pusdSats;
}

/**
 * The state after a payment of `amountSats` at `locktime` (what `pay` requires on the recreated StateUTXO).
 * Throws when the covenant would reject it.
 */
export function policyAfterPayment(policy: VaultPolicy, amountSats: bigint, locktime: number): VaultPolicy {
  const day = dayIndexForHeight(locktime);
  if (day < policy.dayIndex) throw new RangeError('day must not go backwards');
  if (amountSats > policy.perPaymentMax) throw new RangeError('over per-payment limit');
  const spentToday = (day === policy.dayIndex ? policy.spentToday : 0n) + amountSats;
  if (spentToday > policy.dailyBudget) throw new RangeError('over daily budget');
  return { ...policy, dayIndex: day, spentToday };
}
