# Wallets: WizardConnect and XO

Status as of 16 Nov 2026, checked against the published packages and docs listed under "Sources".

| | WizardConnect | XO |
|---|---|---|
| In this build | Implemented: `src/wallet/wizardconnect.ts` | Stub: `src/wallet/xo.ts` (shows why in the connect sheet) |
| Packages | `@wizardconnect/dapp` 0.2.7, `@wizardconnect/core` 0.2.10 (LGPL-3.0-or-later) | `@xo-cash/engine` (pre-release, `next` tag), `@xo-cash/templates`, `@xo-cash/state`, `@xo-cash/primitives` |
| Connect | the dapp shows a `wiz://` URI as a QR, the wallet scans it | none: XO has no dapp-to-wallet channel |
| Signs a raw tx with `sourceOutputs` | yes (`sign_transaction_request`) | no: the engine builds the tx from a template |
| Signs our covenant inputs | yes, with conditions (below) | only through an XO template for the vault |

The app talks to both through one interface (`src/wallet/types.ts`):

```ts
interface Wallet {
  connect(): Promise<Pairing>;          // Pairing.qrUri for the QR, Pairing.ready resolves on wallet_ready
  getAddress(): Promise<string | null>; // token-aware P2PKH from the receive xpub, index 0
  getPubkey(): Promise<string | null>;  // matched against the vault's signer slots
  signTransaction(tx: BuiltTx, opts?: { inputPaths?, broadcast?, signal? }): Promise<{ signedTxHex }>;
  disconnect(): Promise<void>;
}
```

## WizardConnect

### How it works

1. `initiateDappRelay()` opens an end-to-end encrypted session (Nostr NIP-17 gift wrap) on public relays and
   returns `uri` (`wiz://…`) and `qrUri` (`WIZ://…`, upper case, so it fits a QR in alphanumeric mode).
   `DappConnectionManager.attachRelay()` stores the credentials in `localStorage` (`wizardconnect-session`), so a
   reload reconnects without a new scan.
2. The wallet scans and answers `wallet_ready` with its xpubs for the named paths `receive` (m/44'/145'/0'/0),
   `change` (…/1) and `defi` (…/7). The dapp never sees a derivation path or a private key. We take
   `getPubkey(0, 0n)` (receive #0) as the signer key and encode its address with libauth.
3. To sign, the dapp sends `sign_transaction_request`:
   ```ts
   manager.signTransaction({
     transaction: { transaction: txHex, sourceOutputs, userPrompt: tx.summary, broadcast: false },
     inputPaths: [[inputIndex, 'receive', 0], ...],   // only the inputs this wallet must sign
   });
   ```
   `transaction` is the BCH WalletConnect object from `@bch-wc2/interfaces` (`WcSignTransactionRequest`), the
   same object CashScript's `TransactionBuilder.generateWcTransactionObject()` returns. Each `sourceOutputs[i]`
   is `Input & Output & { contract?: { abiFunction, redeemScript, artifact } }`.
4. The wallet must sign with `SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID` (0x61 for Schnorr) and refuses
   anything else; it answers `sign_transaction_response` with `signedTransaction` (hex) or `error`.

### Can it sign covenant inputs with sourceOutputs? Yes, with three conditions (implemented in src/data/live.ts)

What a wallet does with a contract input is wallet code, not protocol. We read Cashonize's implementation
(`src/utils/dapp/wizSigning.ts`, `createSignedWizTransaction`), the first wallet with WizardConnect:

- For an input whose `sourceOutputs[i].contract.artifact.contractName` is set, it takes
  `sourceOutputs[i].unlockingBytecode`, looks for the placeholder push `41` + 65 zero bytes (CashScript's
  `placeholderSignature()`), signs the input against `contract.redeemScript` with the key named in
  `inputPaths`, and swaps the placeholder for the real signature. Same for a pubkey placeholder (`21` + 33 zero bytes).
- It throws if the placeholder is there but the input has no `inputPaths` entry, or `redeemScript` is missing
  or not a `Uint8Array`.
- Inputs with no placeholder and no `inputPaths` entry keep the unlocking bytecode the dapp gave (all of
  Paryon's inputs 0-5, and the vault inputs of `defend`/`skim`, which need no signature).

So for `Vault.pay(s1, s2, s3, payee, proof)` the builder in `@sigsig/core` must:

1. **Put one placeholder per request, in the signing wallet's own slot,** and an empty push (OP_0, "absent")
   in the other two. The wallet replaces the first placeholder it finds (`String.replace`, not `replaceAll`),
   so two placeholders would put this signer's signature in the wrong slot and `checkSig(s_k, pk_k)` fails.
2. **Send `contract.redeemScript` as bytes** (the vault's full redeem script) and `contract.artifact.contractName`,
   or Cashonize treats the input as P2PKH. `inputPaths` must list the vault-state input index with the signer's
   path (`[vaultStateIndex, 'receive', 0]` by default, `defaultInputPaths()` in `src/wallet/types.ts`).
3. **Collect M signatures by merging, not by chaining.** With `SIGHASH_UTXOS | ALL` the signature covers every
   input's outpoint and source output and every output, but not the other inputs' unlocking bytecode. So each
   signer signs the same unsigned tx with only their own slot as placeholder; the app pulls `s_k` out of each
   returned tx and writes the final unlocking bytecode with all M signatures. A signer never has to sign a tx
   that already holds another signer's signature.

### Can a WizardConnect wallet sign an arbitrary sighash (for `paymentSighash`)? No: whole transactions only

hdwalletv1 has one signing action, `sign_transaction_request`; the published extensions (`bch_stealth_bip352`,
`rpa_bip47`, proposed `decrypt`) add no sign-hash or sign-message action, and the `WalletAdapter` interface a
wallet implements has only `signTransaction(request)`. The wallet computes the sighash itself from the tx and
`sourceOutputs`. So the app never hands the wallet `paymentSighash(...)`; it hands it the tx that produces that
hash and reads the signature back out:

1. `prepareSignature(slot)` = core's `buildPay(ctx, req, { [mySlot]: 'placeholder', others: null })`.
2. `wallet.signTransaction(tx, { inputPaths })` with `[0, 'receive', 0]` and, for a PUSD payment,
   `[2, 'receive', 0]` too: input 2 (the PUSD buffer) runs `Vault.pay` with the same arguments, so its unlocking
   bytecode also holds the placeholder, and Cashonize throws on a placeholder input missing from `inputPaths`
   (the covenant does not check the signature at input 2; it is harmless).
3. `extractSignature(signedTxHex)` (src/data/live.ts) takes the one 65-byte push from input 0: Schnorr + `0x61`
   (ALL | UTXOS | FORKID), which is exactly `signPayment`/`paymentSighash(ctx, built, 0x61)` with the wallet's key.
   It goes into the request link (`#s2=…`), and when M are in, `buildPay(ctx, req, {1: sig1, 3: sig3})` assembles
   the tx; slots that did not sign get an empty push (`null`), never a placeholder (NULLFAIL would fail the script).

The covenant side must accept that hash type: CashScript's `checkSig` accepts any valid sighash flag with
FORKID, and the vault must not pin `SIGHASH_ALL` alone. Its `pay` test should use a 65-byte signature with
`0x61`.

### Risks we cannot close from the web app

- Only Cashonize 0.9+ is confirmed to implement contract placeholders over WizardConnect. Another wallet may
  sign only P2PKH inputs and reject or ignore the vault input. Test on Chipnet with every wallet we name.
- The wallet's sign dialog shows what it can decode. Our own signer view (`/sign/:requestId`) is the "what you
  see is what you sign" check; the wallet's dialog is the second.
- WizardConnect's `inputPaths` lets the dapp choose the key. A wrong path gives an invalid signature, never a
  theft (SIGHASH_UTXOS), but it is a failed round with the signer.
- The packages are LGPL-3.0-or-later; we use them unmodified from npm, which LGPL allows in an MIT app.

### What `@sigsig/core` needs to hand the UI

`BuiltTx.sourceOutputs` in the `WcSourceOutput` shape (as `generateWcTransactionObject()` produces), the
unsigned `txHex` with the placeholder in exactly one slot per signer request, and the index of the vault-state
input (the decoded view already labels it `vault-state`).

## XO

XO (xo.cash, by General Protocols, a BLAZE sponsor) is a template system plus a wallet, not a connect-and-sign
wallet. BLAZE's rule names an "XO Template integration".

- **The stack:** `@xo-cash/engine` opens one account (a mnemonic on one network), imports *templates*
  (a standard description of a use case: roles, actions, variables, transactions, outputs and locking scripts,
  identified by a hash of its content), and builds every transaction from a template. A multi-party action is an
  *invitation*: one party creates it, each party adds signed *commits* (append-only), and `executeAction()`
  builds and broadcasts. Invitations are passed as strings (`serializeInvitation`); "how you send that string is
  up to you".
- **The wallet:** the XO web dev wallet (blaze.xo.cash) runs that engine in the browser (template import, an
  invitation list and an invitation sync over a WebSocket). We found no WizardConnect, WalletConnect or other
  dapp request handler in its bundle, and no published dapp SDK.

**What integration means for sigsig:** write an XO template for the vault that mirrors `Vault.cash`: the
locking script with its constructor parameters as template variables, and the `pay`, `defend` and `skim`
unlocking scripts as actions with roles (`signer1..3`, `keeper`). A pay then becomes an XO invitation that
the M signers commit to in the XO wallet. The covenant itself does not change. Paryon's inputs 0-5 would also
need template entries (or to be fixed inputs the template takes as given), which is the bulk of the work.

**Why it is a stub here:** the engine is pre-release (`0.1.0-next…`), the template language for CashScript
covenants with token introspection is not documented in the published API, and a template that also models
Paryon's loan contracts is a project of its own. The connect sheet shows XO with its real icon and says it is
not in this build; `createXo()` throws `unsupported` with that reason.

**Next step if the team wants the XO prize track:** start with the `defend` action only (no signatures, no
secrets: the simplest template), then `pay`.

## Sources

- WizardConnect docs: https://wizardconnect-456f57.gitlab.io (protocol, dapp, extensions pages)
- Packages: `npm view @wizardconnect/dapp`, `@wizardconnect/core`, `@bch-wc2/interfaces` (type `WcSignTransactionRequest`)
- CashScript WalletConnect guide (placeholders, `generateWcTransactionObject`): https://cashscript.org/docs/guides/walletconnect
- Cashonize source, `src/utils/dapp/wizSigning.ts`: https://github.com/cashonize/cashonize-wallet
- XO: https://xo.cash, https://stack.xo.cash (getting started, API), the web wallet https://blaze.xo.cash
- BLAZE 2026 rules (WizardConnect and/or XO template integration): https://dorahacks.io/hackathon/bchblaze2026/
