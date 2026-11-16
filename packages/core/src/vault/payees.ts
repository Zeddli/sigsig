/**
 * Payee allowlist: a hash160 merkle tree over the payees' locking bytecodes (v1: at most 8 payees, so depth <= 3).
 * Must match `pay` in contracts/Vault.cash:
 *
 *   leaf   = hash160(0x00 | lockingBytecode)
 *   parent = hash160(0x01 | left | right)
 *   - leaves are sorted by lockingBytecode (hex, ascending) and deduplicated
 *   - a level with an odd count promotes its last node unchanged to the next level
 *   - proof = concatenation of 21-byte entries (dir1 | sibling20), from the leaf up;
 *     dir 0x00 = sibling on the right (parent = H(01|node|sibling)), 0x01 = sibling on the left
 *
 * An empty allowlist has root = 20 zero bytes, which no proof can reach.
 */
import { binToHex, cashAddressToLockingBytecode, hash160, hexToBin } from '@bitauth/libauth';

export const MAX_PAYEES = 8;
export const EMPTY_PAYEE_ROOT = '00'.repeat(20);

type BytecodeInput = string | Uint8Array;

/** Accepts a CashAddress (any prefix, token-aware or not) or a hex locking bytecode. */
export function toLockingBytecode(payee: BytecodeInput): Uint8Array {
  if (payee instanceof Uint8Array) return payee;
  if (payee.includes(':') || /^(q|p|z|r)[0-9a-z]{40,}$/.test(payee)) {
    const decoded = cashAddressToLockingBytecode(payee);
    if (typeof decoded === 'string') throw new Error(`invalid payee address ${payee}: ${decoded}`);
    return decoded.bytecode;
  }
  return hexToBin(payee);
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const payeeLeaf = (lockingBytecode: Uint8Array): Uint8Array => hash160(cat(Uint8Array.of(0), lockingBytecode));
const parent = (left: Uint8Array, right: Uint8Array): Uint8Array => hash160(cat(Uint8Array.of(1), left, right));

/** Sorted, deduplicated hex locking bytecodes (the canonical leaf order). */
export function sortPayees(payees: BytecodeInput[]): string[] {
  const hexes = [...new Set(payees.map((p) => binToHex(toLockingBytecode(p))))].sort();
  if (hexes.length > MAX_PAYEES) throw new RangeError(`at most ${MAX_PAYEES} payees in v1, got ${hexes.length}`);
  return hexes;
}

function levels(sorted: string[]): Uint8Array[][] {
  const out: Uint8Array[][] = [sorted.map((h) => payeeLeaf(hexToBin(h)))];
  while (out[out.length - 1]!.length > 1) {
    const prev = out[out.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? parent(prev[i]!, prev[i + 1]!) : prev[i]!);
    }
    out.push(next);
  }
  return out;
}

/** 20-byte root (hex) for the state commitment. */
export function payeeRoot(payees: BytecodeInput[]): string {
  const sorted = sortPayees(payees);
  if (sorted.length === 0) return EMPTY_PAYEE_ROOT;
  const lv = levels(sorted);
  return binToHex(lv[lv.length - 1]![0]!);
}

/** Proof (hex) for one payee, as passed to `pay(..., proof)`. */
export function payeeProof(payees: BytecodeInput[], payee: BytecodeInput): string {
  const sorted = sortPayees(payees);
  const target = binToHex(toLockingBytecode(payee));
  let index = sorted.indexOf(target);
  if (index < 0) throw new Error('payee is not in the allowlist');
  const lv = levels(sorted);
  const entries: Uint8Array[] = [];
  for (let d = 0; d < lv.length - 1; d++) {
    const level = lv[d]!;
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    if (siblingIndex < level.length) {
      entries.push(cat(Uint8Array.of(isRight ? 1 : 0), level[siblingIndex]!));
    }
    index = Math.floor(index / 2);
  }
  return binToHex(cat(...entries));
}

/** Off-chain mirror of the covenant check. */
export function verifyPayeeProof(root: string, payee: BytecodeInput, proof: string): boolean {
  const p = hexToBin(proof);
  if (p.length % 21 !== 0 || p.length > 63) return false;
  let node = payeeLeaf(toLockingBytecode(payee));
  for (let o = 0; o < p.length; o += 21) {
    const sibling = p.slice(o + 1, o + 21);
    node = p[o] === 0 ? parent(node, sibling) : parent(sibling, node);
  }
  return binToHex(node) === root.toLowerCase();
}
