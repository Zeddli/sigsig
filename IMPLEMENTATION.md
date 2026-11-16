# Implementation plan

Today is Fri 13 Nov 2026; the deadline is **Sun 22 Nov 2026, 14:00 UTC** (9 days). We build on Chipnet first and use
small amounts on mainnet. Each day ends with something that can be demoed; if a day slips, the stretch items go first.

## 0. Fixed dates and admin
- [ ] **Sat 14 Nov:** attend the BLAZE kickoff stream (roll call) and check in on the BCH BLAZE Telegram.
- [ ] Register the project on DoraHacks (name, repo, short pitch); create the EMBER2026 vote CashTokens address.
- [ ] Start the Widget Factory deck early (day 2) so the link exists for the banner.

## 1. Milestones

| Day | Date | Goal | Done when |
|---|---|---|---|
| 1 | Fri 13 | Research + design docs | ✅ docs/01, OVERVIEW, ARCHITECTURE, DESIGN, this file |
| 2 | Sat 14 | Repo scaffold; **Paryon on Chipnet** with the mock oracle | `pnpm deploy:chipnet` creates all 26 contracts; `oracle --price 500` updates the price |
| 3 | Sun 15 | `@sigsig/core` Paryon builders: loan key, borrow, manage | Opens a loan on Chipnet from a script; adds/removes collateral and repays |
| 4 | Mon 16 | **`Vault.cash`** v1 + mock tests | `defend`, `skim`, `pay` pass the positive and negative tests in `MockNetworkProvider` |
| 5 | Tue 17 | Vault end-to-end on Chipnet + keeper bot | Script: setup → borrow → `oracle --crash 20` → bot defends → `oracle --price up` → bot skims → 2-of-3 pay |
| 6 | Wed 18 | Web app I: wallet connect, vault detail, keeper page | A judge can run defend/skim from the browser on Chipnet |
| 7 | Thu 19 | Web app II: pay, signer view, new vault; landing; taste-skill gate | `gate.mjs` → PASS/OPEN; signer flow works with 2 wallets |
| 8 | Fri 20 | **Mainnet**: deploy the vault with small amounts against Paryon mainnet-v1; keeper bot live | Mainnet vault open; at least one keeper tx and one pay tx on mainnet |
| 9 | Sat 21 | Hardening, README, deck, video | Fresh-machine run of the README; deck final |
| 10 | Sun 22 | Buffer; submit by **12:00 UTC** (2 h early) | DoraHacks submission complete |

## 2. Work breakdown

### 2.1 Repo scaffold (day 2)
- pnpm workspace: `contracts/`, `packages/{core,keeper,oracle}`, `apps/web`; TypeScript strict, vitest, eslint.
- Pin `cashc@0.13.3`, `cashscript@0.13.x`, `@paryonusd/contracts@1.1.0`, `@bitauth/libauth@3`.
- `README.md` with the Cermin and Wysiwys credit, the licence (MIT), and a "Chipnet in 5 minutes" section.

### 2.2 Paryon on Chipnet (day 2)
1. Read `verify_contract_deployment/contractAddresses.ts` + `validationUtils.ts` for the genesis order and the expected
   NFTs.
2. `packages/oracle/deploy-paryon-chipnet.ts`: generate the oracle and migration keys; create the token categories
   (paryon, pool, redeemer, loanKeyFactory, migrationKey) from vout-0 UTXOs; mint the function NFTs and contract UTXOs
   with the right commitments; write `deployments/chipnet.json`.
3. `oracle.ts`: build `ts|msgSeq|contentSeq|price` (LE, 4 bytes each), sign it with a data signature, call `updatePrice`.
   Respect the rules: seq goes up, and either `seq%10==0` or the price moves ≥0.5%.
4. Self-check: run `verifySetup` from the verification repo pointed at `chipnet.json`.
- **Risk:** the genesis is fiddly (26 contracts). **Fallback:** if it is not done by the end of day 3, develop against
  `MockNetworkProvider` with the same layout and test on mainnet with one small real loan (≥ ~$150 of BCH) earlier
  (day 6).

### 2.3 Paryon builders in `@sigsig/core` (day 3)
- Finders: PriceContract (category `paryon+0x01`, commitment starts with `0x00`), Borrowing (minting), the `manage` NFT
  (commitment `0x02`), and the loan + sidecar pair by loanKey category.
- `buildCreateLoanKey`, `buildBorrow`, `buildManage(repay, Δcoll)`, `buildChangeInterest`.
- Each builder returns `{ tx, sourceOutputs, summary }`; unit tests compare them with the input/output index comments
  in the `.cash` sources.
- `health.ts` with the exact integer formulas, tested against values the contract accepts and refuses.

### 2.4 Vault covenant (day 4)
- `contracts/Vault.cash`, functions as in ARCHITECTURE §2.2. Notes:
  - per-slot `checkSig` with empty-sig skipping (not `checkMultiSig`, which is ECDSA-only in 0.13);
  - pin `this.activeInputIndex` in every function; check the sibling UTXOs by lockingBytecode + category;
  - CR comparisons by cross-multiplication. Overflow is not a concern: since the May 2025 BigInt upgrade, VM integers
    are no longer limited to 64 bits. Add one test with the maximum values anyway;
  - `tx.locktime` day logic plus `require(tx.time >= 0)` to enforce timelocks (the same trick Paryon uses).
- Tests (vitest + `MockNetworkProvider`): for each function, one positive case and a negative case for each rule
  (debt up, collateral down, value to a stranger, fee too high, wrong function NFT, payee not allowed, over the limit,
  over the budget, budget reset on a new day, too few signatures, a signature from a wrong key).
- Size check: unlocking + locking bytecode within the 2026 limits; record the compiled sizes.

### 2.5 Keeper (day 5)
- `packages/keeper`: config (network, fee WIF from env, vault list), a loop every 120 s, idempotent (skips if a tx for
  the same vault is already in the mempool), structured logs.
- Deploy: a small VPS or a Cloudflare Worker cron (if the builders run in Workers; otherwise the VPS).

### 2.6 Web app (days 6–7)
- Vite + React + TS; the taste-skill kit copied into `apps/web/public/assets`; tokens from DESIGN.md §2.
- Wallet: WizardConnect + XO. **Day 6, first hour:** read their SDK docs and confirm the signing call accepts `sourceOutputs`
  for covenant inputs. If XO cannot sign transactions that include covenant inputs, the app pre-builds the covenant
  unlock and asks the wallet to sign only the fee/sig parts.
- Pages in DESIGN §4–5; the decode component is shared by the keeper preview and the signer view.
- Multisig requests: encode as a URL fragment (base64url, so nothing goes to a server); KV only if links get too long.
- Taste-skill checks on the landing: `copy-lint`, `consistency`, `check.mjs`, `perf`, then `gate.mjs` until PASS/OPEN.

### 2.7 Mainnet (day 8)
- Use Paryon mainnet-v1 (IDs in docs/01). Vault: the smallest loan Paryon allows (100 PUSD of debt, about 160% CR),
  funded by us. The buffer is small; the keeper fee cap is ≤ 2 000 sats.
- **Judges' useful mainnet tx:** "Run keeper" (defend/skim when it applies; they pay a ~600-sat fee that is refunded via
  `keeperFeeMax`), plus a demo **tip vault** whose payee allowlist includes an "any judge" path. Decide on day 6: either a
  1-of-1 vault the judge configures in the app, or a small faucet-style pay to the judge's address with a per-payment
  limit of 1 000 sats.
- Note: defend only applies when CR < defendCR. To make sure the button is usable during judging, the mainnet demo vault
  is set with a narrow band (defend 170 / target 175 / skim 185), so normal BCH price moves trigger one of them.

### 2.8 Submission (days 9–10)
- README: what, why, credits (Cermin, Wysiwys, Paryon), architecture image, Chipnet + mainnet addresses, how to run.
- Deck (Widget Factory template): problem, demo screenshots, covenant rules, why BCH, roadmap.
- 2–3 min video: crash the price on Chipnet → keeper defends → signer pays an allowlisted payee and is refused on a
  non-allowlisted one.
- Banner final: deck link, repo link, EMBER2026 address.

## 3. Definition of done (per feature)
Contract rule tested negative and positive · builder unit-tested · works on Chipnet from the UI · decoded correctly in the
signer view · documented in the README.

## 4. Top risks

| Risk | Impact | Mitigation |
|---|---|---|
| Paryon Chipnet deployment takes too long | Blocks end-to-end testing | Mock-first fallback; one early mainnet loan |
| WizardConnect/XO cannot sign covenant transactions | Blocks wallet-signed pay and the judges' tx | Check on the first hour of day 6; fallback: the wallet signs only P2PKH fee inputs, and signer sigs are produced by signing the sighash through the wallet's message or `signTransaction` API |
| Covenant bytecode too large | Can't deploy | Split into `VaultKeeper` and `VaultSpend` scripts sharing the state NFT |
| 100 PUSD minimum makes the mainnet demo cost ~$160 | Budget | One vault, reused by every judge; close it after judging |
| Redemption against our low-rate loan | Collateral swapped | Set a mid-range interest rate; warn in the UI |
| Our covenant is unaudited | User funds | Small amounts only; a "demo, unaudited" note in the banner tooltip and README |
