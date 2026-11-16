import { describe, expect, it } from 'vitest';
import { binToHex } from '@bitauth/libauth';
import { MockNetworkProvider } from 'cashscript';
import {
  decodeFixedVmNumber, decodePolicy, encodeFixedVmNumber, encodePolicy, encodePolicyFields, paymentAmountSats,
  policyAfterPayment, STATE_COMMITMENT_LENGTH,
} from '../src/vault/state.js';
import { EMPTY_PAYEE_ROOT, MAX_PAYEES, payeeProof, payeeRoot, sortPayees, verifyPayeeProof } from '../src/vault/payees.js';
import { createVaultContract, vaultAddresses, vaultConstructorArgs } from '../src/vault/contract.js';
import { vaultAdapter } from '../src/vault/index.js';
import { defaultPolicy, Env, makeKey } from './vault-fixtures.js';

describe('vault state codec', () => {
  const policy = defaultPolicy('11'.repeat(20));

  it('round-trips a 52-byte commitment', () => {
    const c = encodePolicy({ ...policy, spentToday: 123_456n, dayIndex: 6543 });
    expect(c.length).toBe(STATE_COMMITMENT_LENGTH);
    expect(decodePolicy(binToHex(c))).toEqual({ ...policy, spentToday: 123_456n, dayIndex: 6543 });
  });

  it('uses the covenant offsets', () => {
    const h = binToHex(encodePolicy(policy));
    expect(h.slice(0, 2)).toBe('01');
    expect(h.slice(2, 6)).toBe('983a'); // 15000 LE
    expect(h.slice(20, 60)).toBe('11'.repeat(20));
    expect(binToHex(encodePolicyFields(policy))).toBe(h.slice(0, 84));
  });

  it('fixed-width VM numbers match toPaddedBytes / int()', () => {
    expect(binToHex(encodeFixedVmNumber(128, 2))).toBe('8000');
    expect(binToHex(encodeFixedVmNumber(0, 4))).toBe('00000000');
    expect(decodeFixedVmNumber(encodeFixedVmNumber(2n ** 47n - 1n, 6))).toBe(2n ** 47n - 1n);
    expect(() => encodeFixedVmNumber(32768, 2)).toThrow(RangeError);
    expect(() => encodeFixedVmNumber(-1, 2)).toThrow(RangeError);
  });

  it('rejects inconsistent CR thresholds and bad lengths', () => {
    expect(() => encodePolicy({ ...policy, targetCrBps: 14000 })).toThrow();
    expect(() => decodePolicy('00')).toThrow();
  });

  it('mirrors pay day/budget rules', () => {
    const p = { ...policy, dayIndex: 10, spentToday: 7_000_000n };
    expect(policyAfterPayment(p, 4_000_000n, 11 * 144).spentToday).toBe(4_000_000n);
    expect(() => policyAfterPayment(p, 4_000_000n, 10 * 144 + 5)).toThrow('over daily budget');
    expect(() => policyAfterPayment(p, 1n, 9 * 144)).toThrow('backwards');
    expect(() => policyAfterPayment(p, 5_000_001n, 11 * 144)).toThrow('per-payment');
  });

  it('values PUSD payments in sats, rounded up', () => {
    expect(paymentAmountSats({ vaultBchIn: 2000n, vaultBchOut: 2000n, pusdIn: 5000n, pusdOut: 3500n, priceCents: 40000n }))
      .toBe(3_750_000n);
    expect(paymentAmountSats({ vaultBchIn: 2000n, vaultBchOut: 2000n, pusdIn: 1n, pusdOut: 0n, priceCents: 30000n }))
      .toBe(3334n);
    expect(paymentAmountSats({ vaultBchIn: 1000n, vaultBchOut: 5000n })).toBe(0n);
  });
});

describe('payee merkle tree', () => {
  const keys = Array.from({ length: 8 }, (_, i) => makeKey(`p${i}`));

  it('builds roots and proofs for 1..8 payees', () => {
    for (let n = 1; n <= MAX_PAYEES; n++) {
      const list = keys.slice(0, n).map((k) => k.lockingBytecode);
      const root = payeeRoot(list);
      for (const k of list) expect(verifyPayeeProof(root, k, payeeProof(list, k))).toBe(true);
      expect(verifyPayeeProof(root, makeKey('nope').lockingBytecode, payeeProof(list, list[0]!))).toBe(false);
    }
  });

  it('is order independent, accepts addresses, dedupes, caps at 8', () => {
    const list = keys.slice(0, 5);
    expect(payeeRoot(list.map((k) => k.address))).toBe(payeeRoot([...list].reverse().map((k) => k.lockingBytecode)));
    expect(sortPayees([keys[0]!.address, keys[0]!.lockingBytecode])).toHaveLength(1);
    expect(() => payeeRoot([...keys, makeKey('ninth')].map((k) => k.lockingBytecode))).toThrow();
    expect(payeeRoot([])).toBe(EMPTY_PAYEE_ROOT);
    expect(() => payeeProof(list.map((k) => k.address), makeKey('x').address)).toThrow();
  });
});

describe('vault contract', () => {
  it('derives a deterministic P2SH32 address from VaultParams', () => {
    const env = new Env();
    const a = vaultAddresses(env.params, new MockNetworkProvider());
    expect(a.address).toBe(env.vault.address);
    expect(a.tokenAddress).toMatch(/^bchtest:r/);
    expect(a.lockingBytecode).toMatch(/^aa20[0-9a-f]{64}87$/);
    expect(vaultAdapter.lockingBytecode(env.params)).toBe(a.lockingBytecode);
    expect(vaultAdapter.decodePolicy(binToHex(encodePolicy(env.policy)))).toEqual(env.policy);
  });

  it('reverses categories to VM order and validates params', () => {
    const env = new Env();
    const args = vaultConstructorArgs(env.params);
    expect(args[0]).toBe(binToHex(Uint8Array.from(Buffer.from(env.params.paryonTokenId, 'hex')).reverse()));
    expect(() => vaultConstructorArgs({ ...env.params, signerPubkeys: [env.params.signerPubkeys[0], env.params.signerPubkeys[0], env.params.signerPubkeys[2]] })).toThrow('distinct');
    expect(() => vaultConstructorArgs({ ...env.params, m: 4 as 3 })).toThrow();
  });

  it('fits the 2026 VM limits', () => {
    const env = new Env();
    const c = createVaultContract(env.params, env.provider);
    // redeem script must fit one push (10,000 bytes) and the standard unlocking-bytecode limit (10,000 bytes, 2026)
    expect(c.bytesize).toBeLessThan(2500);
  });
});
