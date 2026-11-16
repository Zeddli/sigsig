# Overview

> Working name: **Sigsig**. A BCH treasury vault that borrows ParyonUSD against BCH, defends itself, and only pays
> who you approved. Built for **BLAZE 2026** (mainnet track).
>
> **Credit:** this is a Bitcoin Cash re-implementation of **[Cermin](https://github.com/yeheskieltame/Cermin)**, winner of
> Mezo Hackathon 2, which first combined a per-user vault, a keeper and a savings buffer on Mezo (BTC/MUSD). Our addition
> is the spending-control layer from **[Wysiwys](https://github.com/chiwjieren/wysiwys)**.

## 1. What it does

An organisation (a DAO, a company, a fund) holds BCH and needs dollars to operate, but does not want to sell its BCH.
Sigsig gives it a **vault**: a CashScript covenant that

1. **borrows PUSD** (ParyonUSD, the BCH-native stablecoin) against BCH collateral, through Paryon's own audited contracts;
2. **keeps itself safe:** anyone may send a *defend* transaction when the loan gets close to liquidation (110%), or a
   *skim* transaction when it is over-collateralised. The covenant accepts only transactions that make the position
   safer, and none can move value outside the vault. This works like Cermin's keeper, except that nobody needs
   permission or a key to run it;
3. **pays bills under rules the chain enforces:** an M-of-N group of signers can pay only approved payees, at most X per
   payment and Y per day. The signer view decodes the exact transaction before anyone signs it ("what you see is what you
   sign").

## 2. Features

| Feature | Who uses it | Enforced by |
|---|---|---|
| Open a vault (loan key, state NFT, first borrow) | Treasury admins | Paryon `Borrowing` + our `Vault` covenant |
| Health readout: CR, liquidation price, buffer, interest due | Everyone | Read from the loan NFT and the price contract |
| **Defend:** move buffer BCH into collateral, or burn buffer PUSD to repay | Anyone (keeper, judge, bot) | `Vault.defend`: strictly safer, no value out |
| **Skim:** take excess collateral back into the buffer | Anyone | `Vault.skim`: stays at or above the target CR |
| **Pay:** to an allowlisted payee, within the per-payment limit and daily budget | M-of-N signers | `Vault.pay` |
| Signer view: decoded inputs and outputs, policy checks, CR after the payment | Each signer | Client-side decoder; the covenant re-checks everything |
| Admin: repay, withdraw, change interest, change policy, emergency exit | M-of-N signers | `Vault.admin*` |
| Savings (stretch): stake PUSD in Paryon's stability pool | M-of-N signers | Paryon `StabilityPool` |
| Wallet connection | Everyone | WizardConnect / XO |

## 3. Architecture at a glance

```
          ┌──────────── Web app (static, React) ────────────┐
 signer ─►│ Vaults · Vault detail · Pay · Sign · Keeper     │◄── WizardConnect / XO wallet
 judge  ─►│ tx builders (CashScript SDK) · decoder · health │
          └───────────────┬─────────────────────────────────┘
                          │ Electrum (Fulcrum)  — chipnet / mainnet
          ┌───────────────▼──────────────────────────────────────────────┐
          │ Bitcoin Cash                                                  │
          │  Paryon contracts (price, borrowing, loan, manage, pool …)    │
          │  Our Vault covenant  = KeyUTXO (loanKey) + StateUTXO (policy) │
          └───────────────▲──────────────────────────────────────────────┘
                          │ same tx builders, no keys needed for defend/skim
                 Keeper bot (Node, cron)   ·   Chipnet mock oracle (signs prices)
```

## 4. Why it is good for BCH

- **First real use of PUSD by a treasury.** It brings demand for ParyonUSD loans and for interest that flows to stability
  pool stakers, so BCH holders can get dollars without selling.
- **Shows covenant vaults in production:** CashTokens state, introspection, a contract composing with another protocol's
  contracts, and the 2026 Layla limits (128-byte commitments), all live on mainnet.
- **Keepers without permission or MEV games:** defend/skim can only help the vault, so anyone can run them. This is a
  public good that does not exist on most EVM chains, where keepers are whitelisted.
- **Safer treasury operations.** The spending rules are checked on-chain rather than by an off-chain service, and signers
  see what they are signing. That is the main failure in large multisig thefts.
- **Reusable parts:** the Paryon transaction builders (Paryon's own library is not open source yet), the Chipnet Paryon
  deployment with a mock oracle, and the decoding signer view are all published MIT for other BCH builders.

## 5. Scope for BLAZE (deadline 22 Nov 2026, 14:00 UTC)

Must ship: covenant, setup, defend, skim, pay, signer view, the keeper button and bot, a live demo on mainnet, the top
banner (deck, repo, EMBER2026 vote address, Cermin credit). Stretch: stability pool savings, interest delegation,
more than 3 signers.

See [ARCHITECTURE.md](ARCHITECTURE.md), [DESIGN.md](DESIGN.md), [IMPLEMENTATION.md](IMPLEMENTATION.md) and
[docs/01-paryon-feasibility-and-covenant-design.md](docs/01-paryon-feasibility-and-covenant-design.md).
