# @sigsig/keeper

Permissionless keeper bot for sigsig vaults. Every 2 minutes it reads each vault's loan health and:

| Condition | Action |
|---|---|
| `CR < defendCR` | **defend**: repay with buffer PUSD first, top up with buffer BCH if PUSD is not enough, up to `targetCR` (capped by the buffer and by Paryon's 100 PUSD minimum debt) |
| `CR > skimCR` and no redemption pending | **skim**: withdraw collateral down to exactly `targetCR`, into the vault StateUTXO |
| otherwise | noop |

It pays the network fee from its own wallet and claims it back from the vault (at most `keeperFeeMax`). It holds no
vault keys; the covenant only accepts txs that make the vault safer (ARCHITECTURE §2.2, docs/01 §3.2–3.3).

## Commands

```bash
pnpm --filter @sigsig/keeper keeper once --dry-run   # one cycle, build but do not broadcast
pnpm --filter @sigsig/keeper keeper status           # health table (logs go to stderr)
pnpm --filter @sigsig/keeper keeper status --json
pnpm --filter @sigsig/keeper keeper run              # loop forever (SIGINT/SIGTERM stop after the current cycle)
# or from packages/keeper: npx tsx src/cli.ts <cmd> [flags]
```

Flags: `--dry-run`, `--fake` / `--core`, `--vaults FILE`, `--network chipnet|mainnet|mocknet`, `--interval SEC`, `--json`.
Exit codes: 0 ok, 1 a vault errored (`once`), 2 config error, 3 another cycle holds the lock.

**Today** the default backend is `fake`: six demo vaults (one per branch: PUSD defend, BCH defend, skim, skim during a
redemption, in band, empty buffer) on in-memory ports. Nothing touches a chain.

## Configuration (env)

| Var | Default | |
|---|---|---|
| `KEEPER_NETWORK` | `chipnet` | `chipnet` \| `mainnet` \| `mocknet` |
| `KEEPER_WIF` | — | fee wallet WIF; required for live `core` runs. Fund it with ~0.001 BCH of plain (token-free) UTXOs |
| `KEEPER_VAULTS_FILE` / `KEEPER_VAULTS` | — | vault list: `[{"id":"treasury","params":{VaultParams}}]` or `{"vaults":[...]}` |
| `KEEPER_INTERVAL_SEC` | `120` | measured from the end of a cycle, so cycles never pile up |
| `KEEPER_DRY_RUN` | off | `1` = decide + build, never broadcast |
| `KEEPER_BACKEND` | `fake` | switch to `core` once `@sigsig/core` is wired (see below) |
| `KEEPER_ELECTRUM_HOST` | cashscript default | Fulcrum host |
| `KEEPER_MAX_FEE_SATS` | — | operator fee ceiling on top of the vault's `keeperFeeMax` |
| `KEEPER_MIN_DEBT_CENTS` | `10000` | Paryon minimum debt; repay never goes below it |
| `KEEPER_STATE_MIN_SATS` | `1000` | sats the recreated StateUTXO keeps |
| `KEEPER_MIN_SKIM_SATS` | `10000` | smaller skims (after fee) are not worth a tx |
| `KEEPER_DEFEND_TX_BYTES` / `KEEPER_SKIM_TX_BYTES` | `2500` / `2300` | fee estimate = bytes × relay fee; **re-measure once core builders exist** |
| `KEEPER_STATE_FILE` / `KEEPER_LOCK_FILE` | `.keeper-state.json` / `.keeper.lock` | pending txids and the cross-process lock (Node) |
| `KEEPER_RETRY_ATTEMPTS` / `_BASE_MS` / `_MAX_MS` | `4` / `500` / `8000` | exponential backoff with jitter on every chain call |

## Safety properties

- **Idempotent.** A vault is skipped while any tx touching it is unconfirmed: the keeper's own broadcast txids
  (persisted, checked with `blockchain.transaction.get`; confirmed or dropped ones are pruned) and any mempool tx at the
  vault's addresses (`blockchain.address.get_mempool`), which also covers another keeper or a judge's "Run keeper".
- **No overlap.** `FileLock` (O_EXCL lock file, broken after 10 min if stale) plus the in-process loop design.
- **Fee guard.** Skip and log `fee-cap-below-network-fee` if the estimated fee, and again the built tx's real fee,
  exceeds `min(keeperFeeMax, KEEPER_MAX_FEE_SATS)`.
- **Logs** are JSON lines on stdout: `ts, level, msg, cycleId, vault, crBps, decision, txid, ...` (bigints as strings).

## Code map

| File | |
|---|---|
| `src/decide.ts` | pure decision logic (unit-tested, `test/decide.test.ts`) |
| `src/keeper.ts` | the loop: prune pending → read → decide → build → re-check fee → broadcast |
| `src/ports.ts` | interfaces the keeper needs: `KeeperBuilders` (from `@sigsig/core`), `KeeperChain` |
| `src/electrum.ts` | `KeeperChain` over cashscript's `ElectrumNetworkProvider` |
| `src/fake.ts` | in-memory `VaultReader` + builders + chain, with `mine()` / `drop()` for tests and demos |
| `src/wiring.ts` | picks fake vs core ports |
| `src/config.ts`, `src/cli.ts`, `src/store.ts`, `src/node-store.ts`, `src/log.ts`, `src/retry.ts` | plumbing |

### Wiring `@sigsig/core`

Implement `defaultLoadCore` in `src/wiring.ts` to return `{ reader: VaultReader, builders: KeeperBuilders }`. Builders get
the decided `DefendPlan` / `SkimPlan` (exact deltas) and a `KeeperFunding` (address, WIF, token-free UTXOs) and must
return a **fully signed** tx with its `txid`. Then set `KEEPER_BACKEND=core` (and make it the default in `config.ts`).

## Deployment

### A. systemd on a small VPS (recommended)

```ini
# /etc/systemd/system/sigsig-keeper.service
[Unit]
Description=sigsig keeper
After=network-online.target
Wants=network-online.target

[Service]
User=keeper
WorkingDirectory=/opt/sigsig/packages/keeper
EnvironmentFile=/etc/sigsig/keeper.env      # KEEPER_WIF=..., KEEPER_NETWORK=..., KEEPER_VAULTS_FILE=/etc/sigsig/vaults.json, KEEPER_BACKEND=core
Environment=KEEPER_STATE_FILE=/var/lib/sigsig-keeper/state.json
Environment=KEEPER_LOCK_FILE=/var/lib/sigsig-keeper/keeper.lock
StateDirectory=sigsig-keeper
ExecStart=/usr/bin/env npx tsx src/cli.ts run
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`chmod 600 /etc/sigsig/keeper.env`; `systemctl enable --now sigsig-keeper`; `journalctl -u sigsig-keeper -o cat | jq`.
Alternative: a `.timer` every 2 min running `keeper once` (the lock file stops overlaps; exit code 3 = skipped).

### B. Docker

```dockerfile
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
WORKDIR /app/packages/keeper
ENV KEEPER_STATE_FILE=/data/state.json KEEPER_LOCK_FILE=/data/keeper.lock
VOLUME /data
CMD ["npx", "tsx", "src/cli.ts", "run"]
```

`docker run -d --restart=always --env-file keeper.env -v keeper-data:/data -v $PWD/vaults.json:/vaults.json -e KEEPER_VAULTS_FILE=/vaults.json sigsig-keeper`

### C. Cloudflare Worker cron: does it work?

**Not as-is; use the VPS for the live keeper.** The loop itself (`keeper.ts`, `decide.ts`, `config.ts`, `store.ts`, `log.ts`)
has no `node:` imports and runs in Workers. Two blockers:

1. **Signing.** `@bitauth/libauth` (and so `cashscript`) compiles its secp256k1 WASM from embedded bytes at runtime
   (`WebAssembly.instantiate(bytes)` in `secp256k1-wasm.js`). Workers forbid runtime WASM compilation; WASM must be
   imported as a module at deploy time. Fix: patch libauth to take a precompiled `WebAssembly.Module`, or sign with
   a pure-JS secp256k1 (`@noble/curves`). Not done.
2. **Electrum transport.** `ElectrumNetworkProvider` uses `@electrum-cash/network` over WebSockets (`ws` /
   `isomorphic-ws`). Workers have an outbound `WebSocket` client, but this stack is untested there; `nodejs_compat` is
   needed at least. A Worker would more likely use a Fulcrum WSS endpoint with a small custom JSON-RPC client.

Also needed in a Worker: `PendingStore` and `CycleLock` over KV or (better, for a real lock) a Durable Object, the
vault list in `KEEPER_VAULTS`, and `KEEPER_WIF` as a secret. Sketch, once the blockers are solved:

```ts
// worker.ts (wrangler.toml: [triggers] crons = ["*/2 * * * *"], compatibility_flags = ["nodejs_compat"])
import { Keeper, loadConfig, createLogger } from '@sigsig/keeper';
export default {
  async scheduled(_ev: ScheduledEvent, env: Record<string, string>, ctx: ExecutionContext) {
    const config = loadConfig(env);                      // no readFile in Workers: use KEEPER_VAULTS
    const { reader, builders, chain, wallet } = await createWorkerPorts(config, env); // to write
    const keeper = new Keeper({ config, reader, builders, chain, wallet,
      store: new KvPendingStore(env.KEEPER_KV), lock: new DoLock(env.KEEPER_LOCK), logger: createLogger() });
    ctx.waitUntil(keeper.runCycle());
  },
};
```

Until then, keep the keeper on the VPS. The web app's "Run keeper" button is a second, independent path: judges can
trigger the same defend/skim from their own wallet, so the bot is not a single point of failure.
