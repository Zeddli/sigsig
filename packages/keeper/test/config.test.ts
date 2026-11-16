import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseVaultList } from '../src/config.js';
import { fakeVaultParams } from '../src/fake.js';
import { parseArgs, renderTable } from '../src/cli.js';
import { withRetry } from '../src/retry.js';

const vaultJson = JSON.stringify([{ id: 'treasury', params: fakeVaultParams('treasury') }]);

describe('config', () => {
  it('defaults: chipnet, 120 s, fake backend, not dry run', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ network: 'chipnet', intervalMs: 120_000, backend: 'fake', dryRun: false, wif: null });
    expect(c.decide.maxFeeSats).toBeUndefined();
  });

  it('reads env', () => {
    const c = loadConfig({
      KEEPER_NETWORK: 'mainnet', KEEPER_BACKEND: 'core', KEEPER_WIF: 'Kx', KEEPER_VAULTS: vaultJson,
      KEEPER_INTERVAL_SEC: '30', KEEPER_DRY_RUN: 'true', KEEPER_MAX_FEE_SATS: '1500',
    });
    expect(c).toMatchObject({ network: 'mainnet', backend: 'core', wif: 'Kx', intervalMs: 30_000, dryRun: true });
    expect(c.decide.maxFeeSats).toBe(1500n);
    expect(c.vaults[0]?.id).toBe('treasury');
  });

  it('live core run requires a WIF and vaults', () => {
    expect(() => loadConfig({ KEEPER_BACKEND: 'core', KEEPER_VAULTS: vaultJson })).toThrow(/KEEPER_WIF/);
    expect(() => loadConfig({ KEEPER_BACKEND: 'core', KEEPER_WIF: 'x' })).toThrow(/no vaults/);
    expect(loadConfig({ KEEPER_BACKEND: 'core', KEEPER_VAULTS: vaultJson }, { overrides: { dryRun: true } }).wif).toBeNull();
  });

  it('reads the vault file through the injected reader; CLI overrides win', () => {
    const c = loadConfig({ KEEPER_NETWORK: 'mainnet' }, {
      overrides: { vaultsFile: 'v.json', network: 'chipnet' },
      readFile: (p) => (p === 'v.json' ? JSON.stringify({ vaults: JSON.parse(vaultJson) }) : ''),
    });
    expect(c.network).toBe('chipnet');
    expect(c.vaults).toHaveLength(1);
  });

  it('validates input', () => {
    expect(() => loadConfig({ KEEPER_INTERVAL_SEC: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ KEEPER_NETWORK: 'testnet3' })).toThrow(ConfigError);
    expect(() => parseVaultList('[{"id":"a","params":{}}]', 'x')).toThrow(/paryonTokenId/);
    expect(() => parseVaultList('{', 'x')).toThrow(/invalid JSON/);
    const dup = JSON.stringify([{ id: 'a', params: fakeVaultParams('a') }, { id: 'a', params: fakeVaultParams('b') }]);
    expect(() => parseVaultList(dup, 'x')).toThrow(/duplicate/);
  });
});

describe('cli helpers', () => {
  it('parses flags', () => {
    expect(parseArgs(['once', '--dry-run', '--network', 'mainnet'])).toMatchObject({ cmd: 'once', overrides: { dryRun: true, network: 'mainnet' } });
    expect(() => parseArgs(['run', '--bogus'])).toThrow(/unknown flag/);
  });

  it('renders an error row', () => {
    expect(renderTable([{ vault: { id: 'x' }, error: 'boom' }])).toContain('boom');
  });
});

describe('withRetry', () => {
  it('backs off exponentially and gives up after N attempts', async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error('nope'); }, {
      attempts: 4, baseMs: 100, maxMs: 300, random: () => 1, sleep: async (ms) => { delays.push(ms); },
    })).rejects.toThrow('nope');
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 300]);
  });
});
