/**
 * Small byte / number helpers shared by the Paryon codecs, builders and decoder.
 * All hex strings are lowercase, without 0x prefix.
 */
import {
  binToHex,
  cashAddressToLockingBytecode,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import type { NetworkName } from './types.js';

export { binToHex, hexToBin };

/** Reverse the byte order of a hex string (display order <-> VM/internal order for txids and token ids). */
export const reverseHex = (hex: string): string => binToHex(hexToBin(hex).reverse());

/**
 * Decode a BCH VM script number (little-endian, sign bit in the most significant bit of the last byte),
 * exactly as `int(bytesN)` does in CashScript (OP_BIN2NUM).
 */
export function decodeScriptNum(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n;
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    let byte = bytes[i]!;
    if (i === bytes.length - 1) byte &= 0x7f;
    result |= BigInt(byte) << BigInt(8 * i);
  }
  const negative = (bytes[bytes.length - 1]! & 0x80) !== 0;
  return negative ? -result : result;
}

/**
 * Encode a number as a fixed-length VM script number, exactly as `toPaddedBytes(n, length)` (OP_NUM2BIN).
 * Throws if the value does not fit.
 */
export function encodeScriptNumPadded(value: bigint | number, length: number): Uint8Array {
  let n = BigInt(value);
  const negative = n < 0n;
  if (negative) n = -n;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n || (out[length - 1]! & 0x80) !== 0) {
    throw new Error(`Value ${value} does not fit in a ${length}-byte script number`);
  }
  if (negative) out[length - 1]! |= 0x80;
  return out;
}

export const encodeScriptNumPaddedHex = (value: bigint | number, length: number): string =>
  binToHex(encodeScriptNumPadded(value, length));

export const toBin = (value: string | Uint8Array): Uint8Array =>
  typeof value === 'string' ? hexToBin(value) : value;

export const toHex = (value: string | Uint8Array): string =>
  typeof value === 'string' ? value.toLowerCase() : binToHex(value);

/** CashAddress prefix (cashscript uses bchtest for chipnet and mocknet). */
export function addressPrefix(network: NetworkName): 'bitcoincash' | 'bchtest' {
  return network === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

/** CashAddress -> locking bytecode hex. Throws on invalid input. */
export function addressToLockingBytecodeHex(address: string): string {
  const res = cashAddressToLockingBytecode(address);
  if (typeof res === 'string') throw new Error(`Invalid address ${address}: ${res}`);
  return binToHex(res.bytecode);
}

/** Locking bytecode -> CashAddress (token-aware if requested), or undefined for non-standard scripts. */
export function lockingBytecodeToAddress(
  bytecode: string | Uint8Array,
  network: NetworkName,
  tokenSupport = false,
): string | undefined {
  const res = lockingBytecodeToCashAddress({ bytecode: toBin(bytecode), prefix: addressPrefix(network), tokenSupport });
  return typeof res === 'string' ? undefined : res.address;
}

/** Ceiling division for non-negative bigints. */
export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export const maxBig = (...values: bigint[]): bigint => values.reduce((a, b) => (a > b ? a : b));
export const minBig = (...values: bigint[]): bigint => values.reduce((a, b) => (a < b ? a : b));

/** Format PUSD cents as "123.45". */
export function formatPusd(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const s = `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/** Format satoshis as "0.00012345 BCH". */
export function formatBch(sats: bigint): string {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const s = `${abs / 100_000_000n}.${(abs % 100_000_000n).toString().padStart(8, '0')}`;
  return `${neg ? '-' : ''}${s} BCH`;
}

/** Format basis points as "150.00%". */
export const formatBps = (bps: number): string =>
  Number.isFinite(bps) ? `${(bps / 100).toFixed(2)}%` : '∞';
