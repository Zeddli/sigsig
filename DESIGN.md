# Design

Made with the **taste-skill** (tasteskill 2.5) method. The deal results below came from its dealers, run in this
folder on 2026-11-13 (`.taste-skill/` keeps the history); nothing was picked by taste. The skill gate runs once
`apps/web` has a built page (IMPLEMENTATION.md, day 7).

```
kind:    software  (site-kind software, page type software): a fintech app for treasuries
deal:    palette cool-grey-cobalt · type plex (IBM Plex Sans + Plex Mono) · radius sharp (fintech) ·
         hero: split with the app window (first deal) · nav-cards · footer-dark · close-word ·
         rhythm dark-band · buttons solid · mark arc · ground topglow · effect none · moment iris-opens (1)
why:     a cool grey ground with one cobalt reads as a ledger and a bank form rather than a crypto casino. Cobalt is
         the one colour that means "act"; risk gets its own semantic colours (below), never the accent.
```

## 1. Principles

1. **The real thing on every screen.** The landing hero is the vault page itself, running on live mainnet data, in one
   `app-frame`. There is no illustration of "security" and no 3D coin.
2. **Numbers you can verify.** Every figure (CR, debt, price, budget left) links to the UTXO or contract it was read from.
   Amounts use Plex Mono, tabular figures, with the unit always shown (`BCH`, `PUSD`).
3. **What you see is what you sign.** No signing request leaves the app before the decoded view has been shown in full.
4. **One action per screen.** Each screen has one primary (solid cobalt) button; everything else is a text link or a
   secondary.

## 2. Tokens (printed by `start.mjs css`; keep as is)

```css
:root {
  --p-bg: #eef0f3; --p-surface: #e2e5ea; --p-ink: #0b0c0e; --p-muted: #5d6470;
  --p-accent: #1f2de6; --p-accent-ink: #ffffff; --p-action: #1f2de6; --p-action-ink: #ffffff;
  --p-inv-bg: #0b0c0e; --p-inv-surface: #17181a; --p-inv-ink: #eef0f3; --p-inv-muted: #8e8f92;
  --p-inv-accent: #eef0f3; --p-inv-accent-ink: #0b0c0e; --p-inv-action: #eef0f3; --p-inv-action-ink: #0b0c0e;
  --font-display: "IBM Plex Sans", system-ui, sans-serif;
  --font-text: "IBM Plex Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --display-weight: 500; --display-tracking: -0.025em; --display-tracking-xl: -0.035em; --ly-scale: 0.98;
}
```

App-only semantic tokens. They are used only for health and checks, always next to a word, never alone:

| Token | Value | Use |
|---|---|---|
| `--s-safe` | `#0f7b4a` | CR ≥ target, check passed |
| `--s-watch` | `#a35a00` | defendCR ≤ CR < target, a policy limit close to being reached |
| `--s-danger` | `#c0262d` | CR < defendCR, a check failed, liquidation price |
| `--s-*-bg` | the same at 10% on `--p-bg` | chip grounds |

Dark mode uses the `--p-inv-*` set. The semantic colours are lightened by +12 L* in dark mode, so they keep a 4.5:1
contrast.

Type scale: from `system.css` (display 500, text 400, labels and buttons 500, sentence case). Numbers: `--font-mono`,
`font-variant-numeric: tabular-nums`. Radius: sharp (2px controls, 4px cards). Buttons: solid; they step on hover and
press on click (motion layer).

## 3. The BLAZE banner (every page, top, 40px, `--p-inv-bg`)

```
[arc mark] Built for BLAZE 2026 · BCH re-implementation of Cermin (Mezo Hackathon 2) ↗   |  Deck ↗  ·  Code ↗  ·  Vote EMBER2026: bitcoincash:z…qx [copy] [QR]
```
- One line at ≥1024. At 390 it becomes two rows: the credit on the first; Deck, Code, and a "Vote" button that opens a
  sheet with the full CashTokens address, a copy button and a QR on the second.
- The deck link points to the Widget Factory deck; Code points to the repo; the Cermin credit names the project and links
  its repo. The address is the token-aware `z…` form, shown in Plex Mono, middle-truncated, with a copy button that
  confirms with "Copied".
- The banner is not dismissible: the rules require it.

## 4. Landing page (`/`): one section per screen

| # | Section | Idea | Picture | Screens |
|---|---|---|---|---|
| 1 | **Hero** (split with the app window) | h1 "BCH treasury vaults that borrow PUSD and pay only who you approved"; one hard fact: "Liquidation at 110%. Keeper can only add safety."; primary **Open the demo vault**; secondary **Run the keeper** | The live vault page in an `app-frame`: CR gauge, debt, buffer, last keeper tx. A small card (300 wide, lower left) loops through the three keeper steps (price drop → defend tx → CR back to target) | 1 |
| 2 | **Loan** | Borrow PUSD against BCH through Paryon's audited contracts | Fragment: the borrow form with the live price and max borrow | 1 |
| 3 | **Keeper** (dark-band) | Anyone can defend the vault; the covenant refuses anything else | Diagram card: one input (price), the covenant as the processor, three lanes (add collateral, repay, refuse), with pulses along the lines | 1 |
| 4 | **Spending rules** | Allowlist, per-payment limit, daily budget, M of N | Fragment: the pay screen with the budget bar | 1 |
| 5 | **Signer view** (moment: *iris-opens*) | "Read the transaction, not the button" | The decoded tx: inputs and outputs labelled, checks ticked. The iris opens on this section's inset panel | 1 |
| 6 | **Credit and parts** | Cermin, Wysiwys, ParyonUSD, CashScript, WizardConnect, with their real icons | Logo row (real icons via `icons.mjs`) + three links | 1 |
| 7 | **Close** (close-word) | One word set large: "Defend." with the primary **Open the demo vault** | Type | 1 |
| — | Footer (footer-dark) | Repo, deck, docs, licence, Chipnet faucet link | — | — |

Nav: `nav-cards`. Wordmark with the arc mark on the left; Vaults · Keeper · Docs; **Connect wallet** on the right.
Copy limit: 60–80 words a screen outside the UI mocks. Banned words follow `copy.md` (no "seamless", "revolutionary",
"unlock").

## 5. App screens

### 5.1 Connect
"Connect wallet" opens a sheet with two choices: **WizardConnect** (QR + deep link) and **XO wallet**. Each shows its real
icon. A network switch (Chipnet / Mainnet) sits in the sheet footer; the current network is always shown in the nav as a
chip (`Chipnet` amber, `Mainnet` ink).

### 5.2 Vault detail (`/vaults/:id`), the core screen
```
┌ header: vault name · address (mono, copy) · network chip · signers 2 of 3 ───────────────┐
│ ┌ Health (span 7) ───────────────────────┐ ┌ Actions (span 5) ─────────────────────────┐ │
│ │ CR 164%   [====|=====|=========▲     ]  │ │ [ Defend vault ]  primary only when CR < defend│
│ │ defend 130 · target 150 · skim 200      │ │ Skim excess    (link; enabled when CR > skim)  │
│ │ Debt 250.00 PUSD   Collateral 0.7400 BCH│ │ Pay            (link; signers only)            │
│ │ Liquidation price $372.10  Price $540.12│ │ Admin ▾                                        │
│ └─────────────────────────────────────────┘ └───────────────────────────────────────────┘ │
│ ┌ Buffer (span 4) ┐ ┌ Today's budget (span 4) ┐ ┌ Interest (span 4) ┐                       │
│ │ 0.1200 BCH      │ │ 40 / 100 PUSD  [====  ] │ │ 1.5% · paid per day│                      │
│ │ 30.00 PUSD      │ │ resets at block 960 336 │ │ redemption risk: low│                     │
│ └─────────────────┘ └─────────────────────────┘ └────────────────────┘                     │
│ Activity: table of keeper/pay/admin txs, each with a short txid link to the explorer        │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```
- The CR gauge is a horizontal bar with three tick marks (defend, target, skim) and the liquidation zone below 110%
  hatched in `--s-danger`. The current CR is a triangle plus its number. The status word is always shown ("Safe",
  "Watch", "Defend now").
- Defend is the page's single primary only when it is needed; otherwise the primary is "Pay" for signers and nothing for
  visitors.

### 5.3 Keeper (`/keeper`)
A list of known vaults with CR, status and their available action. Each row has **Run defend** or **Run skim**; the button
is disabled with a reason ("CR 164% is inside 130–200%") when the covenant would refuse. A preview drawer shows the tx
decode (the same component as the signer view) and the fee: "You pay ~600 sats; the vault repays up to 2 000 sats".
After broadcast: an inline "Sent" state with the txid, then the row's CR updates.

### 5.4 Pay (`/vaults/:id/pay`)
A payee select (labels from the allowlist; an address field is not offered at all), the amount with its unit switch,
and live checks as chips: `Allowed payee ✓`, `≤ per payment 50 PUSD ✓`, `Budget left today 60 → 20 PUSD ✓`. A failed
chip names the limit and the number. Primary: **Create payment request**. This leads to the signer view.

### 5.5 Signer view (`/sign/:requestId`)
The most important screen; it gets the most space and is never a modal.
```
You are signing: Pay 30.00 PUSD to "Payroll — Ops"         2 of 3 signatures needed · 1 collected (Alice)
┌ Inputs ─────────────────────────────┐   ┌ Outputs ─────────────────────────────────────┐
│ Vault state  0.1200 BCH  [vault]    │ → │ Payroll — Ops   30.00 PUSD   [allowlisted]   │
│ Vault PUSD   30.00 PUSD  [vault]    │   │ Vault state     0.1196 BCH   [returns]       │
│ Fee          0.0001 BCH  [you]      │   │ Change          …            [you]           │
└─────────────────────────────────────┘   └──────────────────────────────────────────────┘
Checks (re-run here, then enforced on-chain): ✓ payee in allowlist  ✓ ≤ 50 PUSD  ✓ budget 60 → 30  ✓ CR unchanged 164%
Raw: tx hex · sighash preimage (collapsed, mono, copy)
[ Sign with wallet ]   Reject
```
- Every output has a label taken from a known source (vault, allowlist, Paryon contract, burn); an unknown output shows
  in `--s-danger` as "Unknown address" and disables signing.
- Rows show amounts in both units where they apply; addresses are middle-truncated with a full-value tooltip and copy.
- Sharing: "Copy request link" and a QR for the other signers.

### 5.6 New vault (`/new`)
A three-step stepper (1 Loan key · 2 Policy · 3 Borrow). One transaction per step, each with the decode preview. The
policy step edits signers (pubkeys or "use connected wallet"), M, the CR band (three linked sliders with numeric
inputs), keeper fee cap, payees (label + address, max 8), per-payment limit and daily budget.

## 6. States
- **Loading:** skeleton rows at the final size (no layout shift); numbers show `—` until read.
- **Empty:** "No vaults on Chipnet yet. Open one" plus the primary.
- **Errors:** inline under the field or action, naming the covenant rule that failed ("Refused: CR after defend 141% is
  below target 150%"). Electrum offline: a banner under the BLAZE banner with a retry button.
- **Pending tx:** row state "In mempool" → "Confirmed (1)"; we never claim success before the broadcast is accepted.

## 7. Motion (motion layer only)
The hero enters once on load. Linked cards lift 2px; buttons step and press. The hero's small card loops in a 2.5–4 s
cycle with a pause disc. The one moment is *iris-opens* on the signer section. Under reduced motion everything rests.
Nothing fades in on scroll; nothing tilts.

## 8. Responsive and accessibility
- Widths checked: 1440, 1024, 820, 768, 390, 320. At 390 the vault cards stack (Health → Actions → Buffer → Budget →
  Interest); actions become a sticky bottom bar with the single primary; the tables become row cards.
- Tap targets are at least 44px; the skip link comes first; focus rings are visible; the CR gauge has a text equivalent
  (`aria-valuetext="CR 164 percent, safe; defend below 130"`); colour is never the only signal.
- Contrast ≥ 4.5:1 for text, including the semantic chips.

## 9. Assets to supply
- Real icons: BCH, ParyonUSD, CashScript, WizardConnect, XO, Cermin (from their official sources via `icons.mjs`).
- The Widget Factory deck URL, the repo URL, and the EMBER2026 vote address (token-aware `z…`) for the banner.
- Share image: a 1200×630 tile of the hero (`shoot.mjs`).
