# 03 — Deck outline (Widget Factory template)

## The template, and where the deck lives

- The mainnet track asks for "a short presentation based on the BCH Blaze 'Widget Factory' template" (see
  [02-blaze-requirements.md](02-blaze-requirements.md), B5 and D).
- The template is the public Google Slides deck **"BLAZE 2026 Project Template"**:
  <https://docs.google.com/presentation/d/1Yfuk9CJkf4U9M_WukcELhumWgj3Ak6345Ewy8hSp-Hk/edit?usp=sharing>.
  It is a sample pitch for a made-up "Widget Factory" in seven slides: title · one-line pitch + GitHub · story ·
  benefits · BCH usage · vision · thank you.
- **Where it lives:** the rules give no location. We make a copy in Google Slides (File → Make a copy), share it as
  "anyone with the link can view", and link it from the site banner, the README, and the DoraHacks submission. We also
  export a PDF into the repo later (`docs/deck.pdf`) as a backup, in case the Slides link breaks.
- Keep it short: the template's seven slides plus two inserted ones (marked *added*). Use the template's theme; put
  our real screenshots and our wordmark in the image slots. Numbers in IBM Plex Mono if the theme allows a custom font.

Word budget: at most 40 words a slide outside screenshots. Copy below is final unless the facts change. Items in
`TODO` are filled in once they exist; do not make them up.

---

### Slide 1 — Title *(template: "Widget Factory" title slide)*

- **sigsig**
- BCH treasury vaults that borrow PUSD and pay only who you approved
- Website: TODO (live app URL) · X: TODO · Telegram: TODO
- Team: TODO (names or handles)
- Small line at the bottom: "Built for BCH BLAZE 2026 · Mainnet track"

### Slide 2 — One-line pitch + GitHub *(template: "Widget Factory!")*

- Headline: **Borrow dollars against your BCH. The vault defends itself and pays only who you approved.**
- GitHub: TODO (repo URL)
- Picture: the vault detail screen (CR gauge, debt, buffer, last keeper tx), as a real screenshot from mainnet.

### Slide 3 — The problem *(template: "The Story of …")*

Title: **Treasuries hold BCH but pay their bills in dollars.**

- Selling BCH to cover costs means giving up the upside. Borrowing against it means watching a liquidation price day
  and night.
- Multisig doesn't stop theft if signers approve a transaction they can't read. The largest multisig thefts worked
  this way: the screen showed one thing, and the signature approved another.
- Most keeper systems need a whitelisted bot that you have to trust.

### Slide 4 — The solution *(template: "Benefits of …")*

Title: **One covenant: a loan, a keeper and a spending policy.**

- **Borrow PUSD** against BCH through ParyonUSD's audited contracts.
- **Anyone can defend it.** When the CR falls toward 110%, anyone can add the buffer to the collateral or repay. The
  covenant refuses every transaction that doesn't make the loan safer.
- **Spending rules on-chain:** allowlisted payees, a per-payment limit, a daily budget, M of N signers.
- **What you see is what you sign:** the signer view decodes every input and output before signing.

### Slide 5 — Live demo *(added)*

Title: **Try it on mainnet now.**

- Three screenshots in a row: 1 Keeper page with "Run defend" · 2 Pay screen with the checks green · 3 Signer view
  showing the decoded tx.
- Text: "Open TODO (URL) → connect with WizardConnect → run the keeper or send the demo payment. A real mainnet tx for
  a few hundred sats."
- Footer: vault address TODO · example txids TODO (short, linking to an explorer).

### Slide 6 — How the covenant works *(added)*

Title: **One script, three UTXOs.**

A diagram (redraw the README mermaid diagram as boxes):

```
KeyUTXO   holds Paryon's loan key   → the vault owns the loan
StateUTXO buffer BCH + policy NFT    → 52 bytes: CR band, fee cap, payee root, limits, today's spend
PusdUTXO  buffer PUSD
```

| Call | Who | The covenant checks |
|---|---|---|
| `defend` | anyone | CR < defend before; debt ↓ or collateral ↑; CR ≥ target after |
| `skim` | anyone | CR > skim; debt unchanged; CR ≥ target after; excess goes to the buffer |
| `pay` | M of N | payee in the allowlist; ≤ per payment; ≤ daily budget |

Footnote: "Paryon's integer CR formula, cross-multiplied: no rounding. Our covenant is unaudited; the demo uses small
amounts."

### Slide 7 — Why BCH *(template: "BCH Usage")*

Title: **Only BCH does all of this in one transaction.**

- **CashTokens + introspection** let the vault own a loan and check the whole transaction, with no admin key.
- **Keepers without permission:** a covenant can say "only make me safer". On most EVM chains keepers are
  whitelisted, and the fight over liquidations goes to MEV.
- **Fees of a fraction of a cent** make a keeper run every 2 minutes affordable.
- **PUSD demand:** treasury loans bring interest to Paryon's stability pool stakers.
- Uses the 2026 Layla upgrade (128-byte commitments) on mainnet.

### Slide 8 — Roadmap *(template: "The Vision for …")*

Title: **Next: from demo vault to real treasuries.**

- An audit of `Vault.cash`, then raise the limits.
- Savings: stake buffer PUSD in Paryon's stability pool.
- More than three signers; interest-rate delegation to the keeper.
- Publish the Paryon transaction builders and the Chipnet Paryon deployment (MIT) for other BCH builders.
- Pilot with one BCH organisation's treasury: TODO (only if one has agreed).

### Slide 9 — Credit and thank you *(template: "THANK YOU!")*

- **Thank you!**
- Credit, in full sentences: "sigsig is a Bitcoin Cash re-implementation of **Cermin**, winner of Mezo Hackathon 2
  (github.com/yeheskieltame/Cermin), with the spending controls of **Wysiwys** (github.com/chiwjieren/wysiwys). It builds
  on **ParyonUSD**'s audited contracts."
- Links: Live app TODO · Code TODO · Video TODO
- **Vote with EMBER2026:** TODO (token-aware `bitcoincash:z…` address) + a QR code.

---

## Checklist before sharing

- [ ] Every TODO filled with a real value; no placeholder left.
- [ ] Screenshots are from mainnet, not Chipnet (or labelled "Chipnet").
- [ ] Sharing set to "anyone with the link can view"; tested in a private window.
- [ ] The same link is in the site banner, the README, and the DoraHacks submission.
- [ ] PDF export committed as `docs/deck.pdf`.
