# 04 — Demo video script and judge walkthrough

Two parts: a 2–3 minute video (recorded on 21 Nov, IMPLEMENTATION.md day 9) and a written walkthrough for judges on
mainnet. Judges give each project about two minutes by default ([02](02-blaze-requirements.md), F), so the walkthrough
must get them to a mainnet transaction within the first minute.

Values in `TODO` are filled in once they exist. Do not show or say anything the app doesn't do.

## Part 1 — Video (target 2:30, hard limit 3:00)

Setup before recording:
- Chipnet: Paryon deployed with our mock oracle, one demo vault "Acme Treasury", 2-of-3 signers (Alice, Bob, Carol),
  CR band defend 130 / target 150 / skim 200, payees "Payroll — Ops" and "Hosting", 50 PUSD per payment, 100 PUSD a day.
- Two browser profiles with different WizardConnect wallets (Alice and Bob), plus a terminal with the oracle script.
- 1440×900 window, browser zoom at 110%, notifications off. The BLAZE banner stays visible in every shot.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Landing hero: the live vault in the app frame | "This is sigsig. It lets a treasury borrow dollars against its Bitcoin Cash, keeps the loan safe without anyone's permission, and pays only the people it approved. It's a Bitcoin Cash version of Cermin, the Mezo Hackathon 2 winner, with Wysiwys spending controls." |
| 0:15–0:35 | Vault detail: CR gauge, debt, collateral, buffer | "Acme Treasury borrowed PUSD, ParyonUSD's stablecoin, through Paryon's audited contracts. The loan key sits inside our covenant, so the vault owns the loan. Its CR is [N] percent. Below 110 percent, Paryon liquidates." |
| 0:35–0:55 | Terminal: `pnpm oracle --crash 20`; back to the app, the gauge drops into "Defend now" | "We're on Chipnet, where we run Paryon with our own price oracle. Let's crash BCH by 20 percent. The vault is now below its defend line." |
| 0:55–1:20 | `/keeper`: Run defend → decoded preview → sign → "Sent" → CR back above target | "Anyone can defend this vault: me, a bot, or you. The covenant accepts the transaction only if the loan gets strictly safer and no value leaves. My fee is capped and paid back by the vault. The CR is back above target." |
| 1:20–1:30 | Activity table: the keeper bot's own defend tx from earlier | "Our keeper bot does the same every two minutes, with no keys to the vault." |
| 1:30–1:55 | Pay: pick "Payroll — Ops", 30 PUSD, chips all green → Create request → signer view | "Paying a bill needs two of three signers. Before anyone signs, the signer view decodes the exact transaction: who gets paid, how much, what's left of today's budget, and the CR after the payment." |
| 1:55–2:10 | Alice signs; switch to Bob's profile; Bob signs; broadcast; txid | "Alice signs, Bob signs, and the payment goes out. The covenant checks the same rules again on-chain." |
| 2:10–2:25 | Try 80 PUSD: the chip "≤ per payment 50 PUSD" turns red; then a raw tx to an unknown address is refused by the node | "Over the limit? Refused. An address that isn't on the allowlist? Refused by the chain itself, even if two signers were tricked into signing." |
| 2:25–2:45 | Mainnet vault page, banner in view | "This all runs on BCH mainnet too. Open the link, connect with WizardConnect, and run the keeper or the demo payment yourself. Our covenant is unaudited, so the mainnet vault holds small amounts. Deck, code and our EMBER2026 vote address are in the banner. Thanks!" |

Recording notes:
- If the refused-tx shot (2:10) is too slow, show the node's error message text in the app instead ("Refused: payee
  not in allowlist"). Show only the real error the app produces.
- Upload to YouTube as unlisted or public. Put the banner items (deck, repo, EMBER2026 address, Cermin credit) in the
  video description too, since the rules accept a description in place of a banner.

## Part 2 — Judge walkthrough (mainnet)

This text goes in the DoraHacks submission and the README's "Mainnet demo" section.

**You need:** a BCH mainnet wallet that supports WizardConnect, (optional: defend/skim need no wallet funds; the vault pays the miner fee and the connected address receives the keeper reward).

1. **Open the app:** TODO (live URL). The first screen is the live mainnet vault: CR, debt, collateral, buffer, and the
   last keeper transaction. Each number links to the UTXO it came from.
2. **Connect:** click *Connect wallet* → WizardConnect → scan the QR or use the deep link. Check that the nav chip says
   **Mainnet**.
3. **Make a mainnet transaction (pick one):**
   - **Demo payment** (always available): TODO. Describe the flow once the "any judge" tip path is decided
     (IMPLEMENTATION.md §2.7). It must work for any wallet with no setup.
   - **Run the keeper:** open `/keeper`. If the vault's CR is outside its band (defend below TODO %, skim above TODO %),
     *Run defend* or *Run skim* is enabled. Read the decoded preview and send; the app shows the txid. No signature or fee is needed:
     the vault pays the miner fee and sends the keeper reward to the connected address. If the CR is inside the band, the button is disabled and
     says why; that refusal is the covenant's rule at work.
4. **Read before you sign:** every request opens the decoded view first. Each output is labelled (vault, allowlisted
   payee, Paryon contract, burn, fee). An unknown output would block signing.
5. **Check on-chain:** follow the txid link to the explorer. Vault address: TODO. Example txs: setup TODO, defend/skim
   TODO, pay TODO.
6. **Optional, Chipnet:** the README Quickstart runs the whole crash → defend → pay story on Chipnet with our mock
   oracle.

**What to look for**

| Claim | Where to see it |
|---|---|
| The vault owns the loan | The loan key NFT sits at the vault address (TODO explorer link) |
| Keepers need no permission and can only help | `/keeper` works from any wallet; the "disabled" reasons; `Vault.cash` `defend()` and `skim()` |
| Spending rules are on-chain | `Vault.cash` `pay()`; a refused over-limit payment in the activity table |
| What you see is what you sign | The signer view at `/sign/...` |
| Built on audited Paryon contracts | `@paryonusd/contracts@1.1.0` in `package.json`; the Paryon contract labels in the decoded view |

**Known limits:** the covenant is unaudited; the mainnet vault holds about the Paryon minimum (100 PUSD of debt); the
keeper actions apply only when the CR is outside the band; Paryon redemptions can take collateral from low-interest
loans.
