# Architecture

The research behind this design (Paryon layouts, checks we ran) is in
[docs/01-paryon-feasibility-and-covenant-design.md](docs/01-paryon-feasibility-and-covenant-design.md).

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Contracts | **CashScript 0.13.x** (`cashc` 0.13.3), BCH VM 2026 (Layla) | Same compiler line as Paryon (^0.13). Checked locally: multisig and 52-byte commitments work. |
| Paryon artifacts | **`@paryonusd/contracts@1.1.0`** (npm) | Audited bytecode; builds both mainnet and our Chipnet deployment |
| SDK | `cashscript` 0.13 `TransactionBuilder`, **`@bitauth/libauth`** v3 | tx building, signing, decoding, CashAddr, `MockNetworkProvider` for tests |
| Network | `ElectrumNetworkProvider` → Fulcrum (chipnet + mainnet public servers; fallback list in config) | One provider type for both networks |
| Indexing | Electrum `blockchain.address.listunspent` on fixed addresses + token-category lookups; optional Chaingraph (Paryon's fork) for loan lists | No backend DB needed for v1 |
| Wallet | **WizardConnect** + **XO** wallet (required by BLAZE); signing requests carry `sourceOutputs` for wallet-side display | The vault's signers use their normal wallets |
| Frontend | **Vite + React 18 + TypeScript**, plain CSS from the taste-skill system (`system.css`, tokens in DESIGN.md), TanStack Query for chain reads | Static build, no SSR needed |
| Keeper bot | Node 22, the same `@sigsig/core` builders, cron every 2 min, its own fee wallet | Defend/skim need no vault keys |
| Mock oracle (Chipnet only) | Node script signing the 16-byte price message with our key | Paryon's Chipnet `PriceContract` is deployed with our oracle pubkey |
| Hosting | Cloudflare Pages (app), small VPS or Cloudflare Worker cron (keeper, Chipnet oracle) | Free, fast, static |
| Tests | `vitest` + `MockNetworkProvider` (unit), Chipnet end-to-end scripts | — |

Repo layout (pnpm workspace):

```
contracts/          Vault.cash (+ compiled artifacts)
packages/core/      network config, Paryon deployment loader, readers, tx builders, decoder, policy
packages/keeper/    bot
packages/oracle/    chipnet mock oracle + Paryon chipnet deployer
apps/web/           React app
docs/               research notes
```

## 2. On-chain components

### 2.1 Paryon (not ours; used as is)
`PriceContract` (state `0x00|seq4|price4`, price = PUSD cents per BCH), `Borrowing`, `Loan` + `LoanSidecar` +
8 loan-function contracts (`manage` = commitment `0x02`), `LoanKeyFactory`/`OriginEnforcer`/`OriginProof`,
`StabilityPool` family, `Redeemer` family. Mainnet-v1 IDs: see the doc. On Chipnet we deploy the same 26 artifacts with
our own oracle key and migration key.

### 2.2 Vault covenant (ours) — one script, two UTXOs

Constructor (per vault): `paryonTokenId`, `loanKeyCategory`, `stateCategory`, `pk1, pk2, pk3`, `m`.

| UTXO | Holds | Spent by |
|---|---|---|
| **KeyUTXO** | 1000 sats + the loanKey (minting NFT, commitment `0x`) | `defend`, `skim`, `adminManage`, `adminInterest` (each needs the StateUTXO in the same tx) |
| **StateUTXO** | buffer BCH + state NFT (`stateCategory`, mutable) | `defend`, `skim`, `pay`, `admin*` |
| **PusdUTXO** | buffer PUSD (fungible, `paryonTokenId`) | with the StateUTXO only |

A UTXO carries one token category, so buffer PUSD needs its own UTXO (same locking script). Its PUSD may only go to the
burn output, the recreated PusdUTXO, or an allowed payee in `pay`. The doc's §3 layouts gain one input and one output
for it when PUSD moves.

State commitment (52 bytes; the limit is 128):

```
ver1 | defendCR2 | targetCR2 | skimCR2 | keeperFeeMax3 | payeeRoot20 | perPaymentMax6 | dailyBudget6 | dayIndex4 | spentToday6
```

Functions:

| Function | Signatures | Core rules |
|---|---|---|
| `defend()` | none | input 3 = Paryon `manage` NFT (`paryonTokenId`, commitment `0x02`); `debt'≤debt`, `coll'≥coll`, at least one strict; `CR<defendCR` before; `CR'≥targetCR` or the buffer is used up; buffer down by at most Δcoll + repaid + `keeperFeeMax`; state commitment unchanged |
| `skim()` | none | `debt'==debt`; `CR>skimCR`; `CR'≥targetCR`; Δcoll lands in the StateUTXO minus at most the fee; no redemption pending |
| `pay(s1,s2,s3, payee, proof)` | M of 3 (per-slot `checkSig`; empty sig = absent; works with Schnorr and ECDSA) | payee ∈ `payeeRoot`; `amount ≤ perPaymentMax`; day rollover from `tx.locktime/144` (timelock enforced); `spentToday'≤dailyBudget`; StateUTXO recreated with the new day fields |
| `adminManage(sigs)` | M | any `manage` deltas, including withdraw and close |
| `adminInterest(sigs)` | M | Paryon `changeInterest` layout (key at input 3) |
| `adminPolicy(sigs, newCommitment)` | M | rewrite the policy fields; must keep the day fields |
| `exit(sigs)` | M | free spend of everything (emergency) |

CR math matches Paryon's integer formula exactly: `maxDebt = (coll*10/11) * price / 1e8`, and
`CR_bps = coll * price * 10000 / (debt * 1e8)`. The covenant compares cross-multiplied values, so there is no division
rounding.

### 2.3 Transaction layouts
Setup (3 txs), defend, skim and pay layouts are specified in the doc (§3). The rule that matters: Paryon fixes inputs and
outputs 0–5, so the vault's own inputs and outputs always come after them, at fixed indexes that `@sigsig/core` encodes
as constants.

## 3. Off-chain components

### 3.1 `@sigsig/core`
- `network.ts`: chipnet and mainnet profiles (Paryon token IDs, contract params, Electrum URLs).
- `paryon/`: loads Paryon artifacts → `Contract` instances, finds the live PriceContract, loan, sidecar and `manage`
  function UTXOs by token category and commitment.
- `vault/`: Vault artifact, address derivation from the constructor, state codec (52-byte commitment ↔ object).
- `health.ts`: CR, liquidation price, max borrow, the amount to defend to reach the target, the amount to skim.
- `tx/`: `buildCreateLoanKey`, `buildSetupState`, `buildBorrow`, `buildDefend`, `buildSkim`, `buildPay`, `buildAdmin*`.
  Each returns an unsigned tx plus `sourceOutputs` (the WizardConnect signing format) and a human-readable summary.
- `decode.ts`: unsigned tx → a list of labelled inputs and outputs (Paryon contract, vault, payee from the allowlist,
  burn, fee), with the policy checks run locally (allowlist, limits, CR before and after). The signer view renders it.
- `payees.ts`: sorted payee list → `payeeRoot`; proof generation (a hash160 merkle tree; v1 has at most 8 payees).

### 3.2 Web app
Routes: `/` (landing + live vault), `/vaults/:id` (detail), `/vaults/:id/pay`, `/sign/:requestId`, `/keeper`, `/new`.
State: TanStack Query on Electrum subscriptions; nothing stored on a server. Multisig coordination: a partially signed
request is exported as a compact string or QR, or stored in a shared Cloudflare KV key with a short link. KV holds only
unsigned and partly signed txs, never keys.

### 3.3 Keeper bot
Every 2 minutes, for every known vault, it reads health. If `CR < defendCR` it builds `defend`; if `CR > skimCR` it builds
`skim`. It pays the fee from its own wallet and recovers it through `keeperFeeMax`. The web "Run keeper" button does the
same thing from the judge's wallet.

### 3.4 Chipnet oracle and deployer
`deploy-paryon-chipnet.ts` follows the genesis order in Paryon's `verify_contract_deployment`. `oracle.ts` signs
`ts|msgSeq|contentSeq|price` (4 bytes each, LE) with `checkDataSig`-compatible Schnorr and sends `updatePrice`. It has a
`--crash <pct>` flag for demos.

## 4. Security model
- Defend/skim are safe to run without permission: value can only move between the loan and the vault's own UTXOs, and
  the keeper fee is capped by the state.
- Pay is bounded by the allowlist, the per-payment limit and the daily budget, even if M signers are tricked; only
  `adminPolicy`/`exit` can lift the bounds.
- Known risks: Paryon redemptions take collateral from low-rate loans (the UI warns, and admin sets the rate); liquidation
  if the keeper and the buffer both fail; oracle trust (General Protocols on mainnet); our covenant is not audited
  (the demo uses small amounts).
- Each covenant function pins its input index and the other side's lockingBytecode or category, so its functions cannot
  be combined with an unexpected contract.
