# Kaspa Forge — contracts, apps & recovery kit

This is the open-source code behind **Kaspa Forge — Safe + Escrow + Market + Desk**, built
on Kaspa Toccata covenants. It contains the browser app, contracts, Android client and
offline recovery tooling needed to verify the platform's non-custodial claims.

- **[Safe](https://kaspaforge.org/safe.html)** — a vault for KAS. Every withdrawal waits out
  a delay you set and can be cancelled with a separate alarm key.
- **[Escrow](https://kaspaforge.org/escrow-index.html)** — escrow for P2P deals. Funds sit in
  an on-chain contract; even the arbiter can only send them to the buyer, the seller, or the
  fixed service fee.
- **[Market](https://kaspaforge.org/market.html)** — a marketplace powered by non-custodial
  Kaspa payments and escrow.
- **[Desk](https://kaspaforge.org/desk.html)** — the unified browser workspace for the wallet,
  safes, escrow deals, listings and opt-in encrypted profile sync.

This repository includes the **offline recovery kit** for Safe and the **on-chain contracts**
for Safe and Escrow, so you can verify — and, for Safe, operate — everything **without our
website**, against any Kaspa node.

- [`contracts/vault.sil`](contracts/vault.sil) — the vault covenant (Silverscript).
- [`contracts/escrow.sil`](contracts/escrow.sil) — the escrow covenant (Silverscript).
  Its rules live on-chain, enforced by Kaspa consensus; the website and our server are
  conveniences, not custodians.
- [`vaultctl/`](vaultctl/) — a CLI that does everything the vault website does, from your
  recovery sheet.

## Emergency quickstart (vault)

You need the **recovery sheet** (`kaspa-safe-recovery-….txt`) printed or saved when the
vault was created. It contains all keys and parameters — the tool reads it as is.

```bash
# 1. Prerequisites: Rust (https://rustup.rs), protobuf-compiler, clang
#    Debian/Ubuntu: apt install -y protobuf-compiler clang
# 2. Build (5–10 min first time):
cd vaultctl && cargo build --release
# 3. Check your vault:
./target/release/vaultctl status --recovery /path/to/kaspa-safe-recovery-XXXX.txt
```

## Commands (vault)

| command | what it does | needs |
|---|---|---|
| `status   --recovery <sheet>` | vault balance, age, inheritance timer; add `--dest <addr>` to see an in-flight withdrawal and its cancel window | nothing |
| `initiate --recovery <sheet> --to <kaspa:q…>` | start a withdrawal (destination is locked forever) | hot key (in sheet) |
| `cancel   --recovery <sheet> --dest <kaspa:q…>` | cancel an in-flight withdrawal — coins snap back to the vault | alarm key (in sheet) |
| `complete --recovery <sheet> --dest <kaspa:q…>` | deliver a matured withdrawal to its destination | no key |
| `checkin  --recovery <sheet>` | "I'm alive" — resets the inheritance timer | hot key |
| `inherit  --recovery <sheet> [--heir-sk <hex>]` | after the inheritance period: deliver the funds to the heir. Automatic mode needs no key at all; manual mode needs the heir's own private key | — / heir key |
| `migrate  --recovery <sheet> --to <kaspa:q…> [--dest <addr>]` | move the WHOLE vault anywhere instantly, no delay — both signatures are full owner authority by definition (vault-version upgrade, rotation of a leaked key, exit). `--dest` rescues a mid-withdrawal UTXO from the unvault address. Store the two keys apart: together they are instant full power | hot + alarm keys |

Global flags:

- `--node grpc://host:16110` — any Kaspa v2+ node with `--utxoindex`
  (default: `grpc://node.kaspaforge.org:16110`, the Kaspa Forge public node).
- `--dry-run` — build and sign the transaction, print its txid, **don't** broadcast.
  Use it first if you're unsure.

`--recovery` accepts the wizard's `.txt` sheet (English or Russian) or a JSON file:
`{"network":"mainnet","delay":8640,"hot_sk":"…","alarm_pk":"…","heir_pk":"…","inherit_delay":259200,"auto_inherit":true}`.

`--dest` for `cancel`/`complete` is the address the withdrawal is going **to**: for your
own withdrawal you know it; for a thief's it is shown in your Telegram alert and in the
website's vault panel.

## Verify the vault contract yourself

```bash
cd vaultctl && cargo run --release -- selftest
```

Runs all contract paths (including attacks: early completion, wrong keys, wrong
destination, premature inheritance, one-key migrate, two-input siphon) inside the real
Kaspa node VM — 25 checks, executed with the consensus compute-budget limit.

## The escrow contract

[`contracts/escrow.sil`](contracts/escrow.sil) is the covenant behind Kaspa Escrow. A deal's
funds live in it while the deal is open. The contract admits a fixed set of paths, and in
**every** one the money goes strictly to the **buyer**, the **seller**, or the **service fee
address** — never anywhere else, including to the arbiter:

- `release` (buyer) / `refund` (seller) — the amicable outcomes.
- `autoRelease` — no signature: once the dispute window passes with no dispute, funds
  auto-release to the seller.
- `dispute` (buyer) — freezes the optimistic auto-release and summons the arbiter.
- `arbitrateToBuyer` / `arbitrateToSeller` / `arbitrateSplit` (arbiter) — a dispute verdict.
  The arbiter can only pick **buyer**, **seller**, or a **split between the two** — theft is
  not an expressible transaction.
- `timeoutToBuyer` / `timeoutToSeller` — no signature: an emergency exit if the arbiter never
  rules by the contract deadline, so the deal outlives the website.

Read the annotated source in [`contracts/escrow.sil`](contracts/escrow.sil); it is the same
covenant compiled into every escrow address on-chain.

## Trust model

- Keys are generated in your browser and printed on your recovery sheet. We never see them.
- The vault address is a pure function of your parameters — `status` recomputes it and
  warns if it doesn't match the sheet (most common cause: wrong inheritance mode).
- Anything these contracts allow requires **your** keys (or, for the emergency/auto paths,
  a hard-bound destination) — there is no admin path, for us or anyone.

## Kaspa Forge web frontend & Android source

This repo also contains the full web frontend (`web/`) and a Tauri 2 Android wrapper (`app/`)
for Kaspa Safe. No prebuilt Android package is currently distributed: the previous APK releases
were retired because they no longer represent the current Kaspa Forge product. Do not install an
old package from a cache or third-party mirror.

- Build locally: `cd app && npm install && cp -r ../web web && npx tauri android init && npx tauri icon app-icon.png && npx tauri android build --apk`
