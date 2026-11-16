# 01 — ParyonUSD feasibility + vault covenant design

Status: draft, 2026-11-13. Sources: `github.com/ParyonUSD/contracts` (CashScript ^0.13, audited by Sighash Labs),
`github.com/ParyonUSD/verify_contract_deployment` (mainnet-v1 params), npm `@paryonusd/contracts@1.1.0`.

## 1. Verdict: our own code can open and manage ParyonUSD positions. No fallback needed.

| Operation | Paryon function | Can a covenant do it? |
|---|---|---|
| Open loan | `Borrowing.borrow` (after `LoanKeyFactory.create`) | **Yes.** The loanKey (output 5) and borrowed PUSD (output 6) have **no lockingBytecode constraint**, so both can go straight to our vault address. The collateral input (index 4) can be any UTXO. |
| Add collateral / remove collateral / repay / close | `manage` loan function | **Yes.** The loanKey must be at **input 4** and is recreated at **output 4 with the same lockingBytecode**, so the key can stay in our covenant permanently. |
| Read health | — | Loan NFT commitment (input 1) plus PriceContract commitment `slice(5,9)` (price, in PUSD cents per BCH). Liquidation happens when `debt > (collateral*10/11) * price / 1e8`, i.e. CR < 110%. |
| Interest | `payInterest` | Triggered by the Collector each period (144 blocks) and **paid out of the collateral**. No key is needed, but it slowly reduces collateral, so our keeper must account for it. |
| Savings yield | StabilityPool `AddLiquidity` / `WithdrawFromPool` | Possible: the vault stakes PUSD and holds the receipt. Rewards come per epoch (10 periods, about 10 days) and the stake **shrinks pro-rata on liquidations**. Treat this as a stretch goal; a plain PUSD/BCH buffer is the default. |

Mainnet-v1 IDs: paryonTokenId (PUSD) `2469acc5…2544`, loanKeyFactory `f07165f2…7405`, oracle = General Protocols
`02d09db0…2818`, startBlockHeight 948406, period 144 blocks.

### Gotchas that shape the plan
1. **The tx-building library (`@paryonusd/library`) is not open source.** We write the builders ourselves from the
   input/output layouts in the `.cash` headers. Reference: the hackathon project `Emediong-Etuk/Backstop`, which builds on
   `@paryonusd/contracts@1.1.0`.
2. **There is no public Chipnet deployment.** Plan: deploy the full 26-contract system on Chipnet ourselves from the
   artifacts, with **our own oracle key** (`PriceContract` takes `oraclePublicKey`) and a script that signs prices.
   This also lets us push the price down and demo a defend. Todo: read `PriceContract.cash` for the message format.
3. **Minimum debt is 100.00 PUSD (110% CR, so at least ~$110 of BCH collateral, more in practice).** That conflicts with
   "tiny amounts on mainnet" for judges. **Demo design:** we open **one** mainnet vault and fund it ourselves; judges make
   *permissionless keeper txs* against it (defend/skim/poke), plus a *small policy-checked payment* from a demo treasury.
   Judges never have to open a $150 loan.
4. **Redemptions:** PUSD holders redeem against the lowest-interest loans first, which swaps away collateral at the peg.
   A treasury loan should not sit at the bottom of the rate range. `changeInterest` stays an owner (multisig) action,
   and the UI warns about it. During a redemption `manage` cannot withdraw collateral (adding and repaying still work).
5. The loanKey NFT's commitment must stay `0x` and its value 1000 sats (enforced by `manage`), so **our vault state cannot
   live on the loanKey**. We use a separate state UTXO (see below).

## 2. Vault = one covenant script, two UTXOs (Cermin's EIP-1167 clone becomes a per-vault P2SH32)

Constructor params (fixed per vault; they make the address unique):
`loanKeyCategory`, `stateCategory`, `signerPubkeys[N]` (N ≤ 3 for v1), `M`, `paryonTokenId`.

- **KeyUTXO** — 1000 sats + the loanKey (minting cap, empty commitment). Spendable only when the StateUTXO is spent in
  the same tx (sibling check: some input has `stateCategory` mutable NFT and the same lockingBytecode).
- **StateUTXO** — buffer BCH + buffer PUSD (fungible) + a mutable NFT of `stateCategory` whose commitment is:

```
bytes1  version
bytes2  defendCR      (e.g. 13000 = 130.00%; keeper may defend below this)
bytes2  targetCR      (defend must bring CR to ≥ this, or use all available buffer)
bytes2  skimCR        (keeper may skim above this, down to targetCR)
bytes3  keeperFeeMax  (sats)
bytes20 payeeRoot     (hash160 of the sorted payee lockingBytecode list, or a merkle root)
bytes6  perPaymentMax (sats-equivalent; separate PUSD limit = v2)
bytes6  dailyBudget
bytes4  dayIndex      (locktime-height / 144)
bytes6  spentToday
= 52 bytes. OK: the May 2026 "Layla" upgrade raised the commitment limit 40 → 128 bytes, and a 52-byte mutable
  commitment spends fine in cashscript 0.13.3 MockNetworkProvider (checked 2026-11-13).
```

The state NFT category is created in the vault setup tx from a vout-0 UTXO, and the vault burns its minting capability
there, so exactly one mutable state NFT exists.

## 3. Transaction layouts

Paryon fixes indexes 0–4 (and the burn output at 5). Our inputs go after them.

### 3.1 setup (owner, 3 txs)
1. `LoanKeyFactory.create` → loanKey category = txid of our vout-0 input. Now the vault address can be computed.
2. Genesis of the state category; mint the state NFT to the vault address; fund the buffer.
3. `Borrowing.borrow`: in 0 borrowing, 1 price, 2 enforcer, 3 proof, 4 collateral (owner wallet) → out 2 loan,
   3 sidecar, 4 fee, **5 loanKey → vault**, **6 PUSD → vault StateUTXO (separate output, merged later)**, 7 change.

### 3.2 defend (anyone; keeper; no signatures)
```
in : 0 price | 1 loan | 2 sidecar | 3 manageFn(commit 0x02) | 4 Vault.KeyUTXO [fn defend] | 5 Vault.StateUTXO [fn defend] | 6 keeper BCH (fee)
out: 0 price | 1 loan | 2 sidecar | 3 manageFn | 4 KeyUTXO | 5 OP_RETURN burn PUSD (if repay) | 5/6 StateUTXO | +1 keeper change
```
Covenant rules (enforced at index 4, the key UTXO; index 5 delegates to it):
- `tx.inputs[3].tokenCategory == paryonTokenId && nftCommitment == 0x02`, which pins the `manage` function
  (otherwise someone could pair our key with another Paryon function).
- `debt_out ≤ debt_in` and `collateral_out ≥ collateral_in`, with at least one strict, so **the position strictly improves**.
- Before: `CR_in < defendCR` (no buffer griefing). After: `CR_out ≥ targetCR`, OR the StateUTXO's BCH/PUSD is reduced to
  dust (all the buffer was used).
- StateUTXO recreated: same lockingBytecode/category, commitment unchanged,
  `bch_out ≥ bch_in − Δcollateral − keeperFeeMax`, `pusd_out ≥ pusd_in − repaid`.
- No other output carries vault value except the keeper fee (≤ `keeperFeeMax`). **Nothing leaves vault/loan custody.**

### 3.3 skim (anyone)
Same layout, no burn output. Rules: `debt_out == debt_in`, `CR_in > skimCR`, `CR_out ≥ targetCR`,
`collateral_in − collateral_out` goes **in full to the StateUTXO** (minus at most `keeperFeeMax`). Paryon forbids
withdrawals during a redemption, and so do we.

### 3.4 pay (M-of-N, Wysiwys rules)
```
in : 0 Vault.StateUTXO [fn pay(sigs…, payeeBytecode, proof)] | 1.. extra fee input (optional)
out: 0 payee | 1 StateUTXO (recreated, updated dayIndex/spentToday) | 2 change
```
- M valid signatures from `signerPubkeys`. Checked 2026-11-13: `checkMultiSig` in cashc 0.13.3 works, but **only with
  ECDSA signatures** (it emits legacy-mode OP_CHECKMULTISIG; Schnorr sigs are rejected). Wallets may sign Schnorr, so
  v1 uses **explicit `checkSig` per signer slot** (an empty sig `0x` marks an absent signer, and we count valid ones ≥ M),
  which accepts either algorithm.
- `outputs[0].lockingBytecode` ∈ payee set (proof against `payeeRoot`); `amount ≤ perPaymentMax`.
- `day = tx.locktime / 144` with `require(tx.time >= …)` (locktime enforced; ≤ current height, so it cannot be pushed into
  the future); `spentToday' = (day == dayIndex ? spentToday : 0) + amount ≤ dailyBudget`.
- Signer view: decode the unsigned tx, show the payee label, amount, remaining daily budget and the loan CR after the
  payment. The UI shows what it is checking; the covenant enforces it.

### 3.5 owner admin (M-of-N)
`manage` with arbitrary deltas (repay, withdraw beyond skim, close), `changeInterest`, update the policy commitment,
stake/unstake to the StabilityPool, sweep everything out (an emergency exit, also M-of-N). This is the only path that can
move funds out of vault custody to a non-allowlisted address.

## 4. Fallbacks (only if the Chipnet deployment of Paryon blocks us)
- Swap BCH→PUSD on a Cauldron/Fex pool and run the vault as a "PUSD treasury + BCH buffer" without a loan.
  Defend/skim then become rebalancing, which loses the Cermin parity.
- Moria/MUSD: not investigated; deprioritised now that Paryon works.

## 5. Next steps
1. ~~Commitment limit, multisig, PriceContract format~~ done (see §6).
2. Script that deploys Paryon on Chipnet with a mock oracle (artifacts + genesis order from `verify_contract_deployment`).
3. Write `Vault.cash`, then mocknet tests (`MockNetworkProvider`) for setup → borrow → price drop → defend → skim → pay.

## 6. Resolved checks (2026-11-13)
- **PriceContract message** (16 bytes, signed with `checkDataSig` by `oraclePublicKey`):
  `timestamp(4) | messageSeq(4) | contentSeq(4) | price(4)`, all LE ints; price is in PUSD cents per BCH.
  Accepted only if `contentSeq > stored seq` AND (`contentSeq % 10 == 0` heartbeat OR the price moved ≥ 0.5%).
  The state commitment is `0x00 | seq(4) | price(4)`. Our Chipnet mock oracle just signs this format; to demo a price
  crash we send one update that moves the price ≥ 0.5%.
- `changeInterest` takes the loanKey at **input 3** (not 4) and also recreates it at the same lockingBytecode. The Vault
  needs an owner-only function for that layout. Its header also mentions a "loanManagementToken" (delegated interest
  manager); we can read it later if we want the keeper to manage rates.
- Commitment limit is 128 bytes (Layla, May 2026). The `checkMultiSig` limitation is described in §3.4.
