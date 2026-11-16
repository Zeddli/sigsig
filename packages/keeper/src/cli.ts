#!/usr/bin/env -S npx tsx
/**
 * keeper run              loop every KEEPER_INTERVAL_SEC (default 120 s)
 * keeper once [--dry-run] one cycle, then exit (for cron / systemd timers)
 * keeper status [--json]  health table for every vault
 *
 * Flags: --dry-run  --fake | --core  --vaults <file>  --network <chipnet|mainnet|mocknet>  --interval <sec>
 * Exit codes: 0 ok, 1 a vault errored in `once`, 2 config error, 3 lock held.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig, type LoadConfigOptions } from './config.js';
import type { Decision } from './decide.js';
import { Keeper, type VaultEvaluation } from './keeper.js';
import { createLogger, jsonReplacer } from './log.js';
import { FileLock, FilePendingStore } from './node-store.js';
import { MemoryLock, MemoryPendingStore } from './store.js';
import { createRuntime } from './wiring.js';

const USAGE = `usage: keeper <run|once|status> [--dry-run] [--fake|--core] [--vaults FILE] [--network NET] [--interval SEC] [--json]`;

interface Args {
  cmd: string;
  overrides: NonNullable<LoadConfigOptions['overrides']>;
  json: boolean;
}

export function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const overrides: Args['overrides'] = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new ConfigError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--dry-run': overrides.dryRun = true; break;
      case '--fake': overrides.backend = 'fake'; break;
      case '--core': overrides.backend = 'core'; break;
      case '--vaults': overrides.vaultsFile = val(); break;
      case '--network': overrides.network = val() as never; break;
      case '--interval': overrides.intervalMs = Number(val()) * 1000; break;
      case '--json': json = true; break;
      default: throw new ConfigError(`unknown flag ${a}\n${USAGE}`);
    }
  }
  return { cmd, overrides, json };
}

const pct = (bps: number) => (bps >= Number.MAX_SAFE_INTEGER ? '∞' : `${(bps / 100).toFixed(2)}%`);
const bch = (sats: bigint) => (Number(sats) / 1e8).toFixed(8);
const usd = (cents: bigint) => (Number(cents) / 100).toFixed(2);

export function describeDecision(d: Decision): string {
  switch (d.kind) {
    case 'defend': {
      const legs = [d.repayCents > 0n ? `repay ${usd(d.repayCents)} PUSD` : '', d.addCollateralSats > 0n ? `add ${bch(d.addCollateralSats)} BCH` : '']
        .filter(Boolean).join(' + ');
      return `DEFEND ${legs} -> ${pct(d.expectedCrBps)}${d.reachesTarget ? '' : ' (short of target)'}`;
    }
    case 'skim': return `SKIM ${bch(d.withdrawSats)} BCH -> ${pct(d.expectedCrBps)}`;
    case 'noop': return `noop (${d.reason})`;
    case 'skip': return `skip (${d.reason})`;
  }
}

export function renderTable(rows: Array<VaultEvaluation | { vault: { id: string }; error: string }>): string {
  const head = ['vault', 'CR', 'defend/target/skim', 'health', 'price $', 'debt PUSD', 'coll BCH', 'buf BCH', 'buf PUSD', 'redeeming', 'pending', 'next'];
  const body = rows.map((r) => {
    if ('error' in r) return [r.vault.id, 'ERR', '', '', '', '', '', '', '', '', '', r.error];
    const { snap: s, decision } = r;
    return [
      r.vault.id,
      pct(decision.crBps),
      `${s.policy.defendCrBps / 100}/${s.policy.targetCrBps / 100}/${s.policy.skimCrBps / 100}`,
      s.health.status,
      usd(s.priceCents),
      usd(s.loan.borrowedAmount),
      bch(s.loan.collateralSats),
      bch(s.buffer.sats),
      usd(s.buffer.pusdCents),
      s.loan.amountBeingRedeemed > 0n ? usd(s.loan.amountBeingRedeemed) : '-',
      String(r.pendingTxids.length),
      describeDecision(decision),
    ];
  });
  const all = [head, ...body];
  const w = head.map((_, i) => Math.max(...all.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(w[i] ?? 0))).join('  ');
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (!['run', 'once', 'status'].includes(args.cmd)) {
    console.error(USAGE);
    return args.cmd === 'help' || args.cmd === '--help' ? 0 : 2;
  }

  let config;
  try {
    config = loadConfig(env, { overrides: args.overrides, readFile: (p) => readFileSync(p, 'utf8') });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`config error: ${e.message}`);
      return 2;
    }
    throw e;
  }

  const logger = createLogger((l) => (args.cmd === 'status' ? console.error(l) : console.log(l)), { svc: 'keeper', network: config.network });
  const rt = await createRuntime(config);
  if (rt.world) logger.log('warn', 'using FAKE backend: demo data, nothing touches a real chain', { vaults: rt.config.vaults.map((v) => v.id) });

  const fake = config.backend === 'fake';
  const keeper = new Keeper({
    config: rt.config,
    reader: rt.reader,
    builders: rt.builders,
    chain: rt.chain,
    wallet: rt.wallet,
    logger,
    // The fake backend keeps no state between processes, so it must not use (or pollute) the real state files.
    store: fake ? new MemoryPendingStore() : new FilePendingStore(config.stateFile),
    lock: fake ? new MemoryLock() : new FileLock(config.lockFile),
  });

  if (args.cmd === 'status') {
    const rows = await keeper.status();
    if (args.json) console.log(JSON.stringify(rows, jsonReplacer, 2));
    else console.log(renderTable(rows));
    return 0;
  }

  if (args.cmd === 'once') {
    const report = await keeper.runCycle();
    if (report.locked) return 3;
    return report.outcomes.some((o) => o.action === 'error') ? 1 : 0;
  }

  // run
  const stop = (sig: string) => {
    logger.log('info', 'signal, stopping after the current cycle', { sig });
    keeper.stop();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  logger.log('info', 'keeper starting', { intervalMs: config.intervalMs, dryRun: config.dryRun, wallet: rt.wallet?.address ?? null });
  await keeper.run();
  return 0;
}

const isEntry = !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'fatal', error: String(err?.stack ?? err) }));
      process.exit(1);
    },
  );
}
