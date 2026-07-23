# Kaspa Forge Deal Recovery Kit — `dealctl`

**`dealctl`** is the public, party-side recovery CLI for Kaspa Forge **Escrow** and **Deposit**
deals. Its single job is to **rebuild and sign any covenant path your own key already authorizes**,
using nothing but a local recovery record and a Kaspa node of your choice.

> **No Kaspa Forge server is contacted at any step.** Not to look up your deal, not to build the
> transaction, not to broadcast it. The tool talks only to the Kaspa node you point it at.

This kit exists so that **"the service dying does not mean your money is gone."** Even if
`kaspaforge.org` and the entire hosted backend are permanently offline, you can still `release`,
`refund`, `dispute`, run the keyless `auto-release`/`timeout`, and settle a deal by mutual signature —
entirely on your own machine.

## What it cannot do

`dealctl` only **exposes on-chain rights you already hold**. It is honest about its limits:

- It **cannot** recover a lost `.age` backup password.
- It **cannot** recover a lost party private key.
- It **cannot** bypass the escrow contract or grant you a path your key does not authorize.
- It **cannot** make a timelock mature early — a keyless `auto-release`/`timeout` only works once the
  on-chain DAA age has passed the contract's window.

If you have the key and the timelock is ripe, the right is yours and this tool lets you take it.
If you don't, no tool — ours or anyone's — can manufacture it.

---

## 1. Verify what you downloaded

Build from the public source and check it against the published checksum manifest. Do **not** run a
binary from an unofficial mirror.

```bash
# Clone the public source repository
git clone https://github.com/Kaspaforge/kaspaforge
cd kaspaforge/recovery-kit

# Note the exact commit you are building
git log -1 --pretty=oneline

# Verify every shipped file against the signed checksum manifest
sha256sum -c RECOVERY-SHA256SUMS
```

`RECOVERY-SHA256SUMS` covers the contract core, the CLI, the JSON schemas, the test vectors, and the
offline `.age` decryptor. Every line must report `OK`. If anything fails, stop.

## 2. Build from source

```bash
cargo build --release -p dealctl
```

The binary lands at `target/release/dealctl`. Building from source is the canonical path; a
pre-built release binary never replaces this step — always verify checksums either way.

```bash
./target/release/dealctl help
```

## 3. Decrypt your `.age` backup — offline

Your Desk backup is an `age` passphrase-encrypted file. Decrypt it on an **offline** machine to get
`profile.json`. Two equivalent options:

**Option A — the offline browser tool.** Open `keyfile-decrypt.html` from the kit (a single static
page, no network) in a browser, load your `.age` file, enter your passphrase, and save the decrypted
`profile.json`.

**Option B — the `age` CLI.**

```bash
age --decrypt -o profile.json your-backup.age
# age will prompt for your passphrase
```

`profile.json` is plaintext and contains private keys. Keep it on the offline machine and delete it
when you are done (see step 9).

## 4. Extract a minimal recovery record

Never feed the full `profile.json` to the money commands. First extract the minimal, single-deal
record:

```bash
dealctl extract \
  --profile profile.json \
  --deal <deal-id> \
  --output deal.recovery.json
```

- The output is written with `0600` permissions and is **never overwritten** — if
  `deal.recovery.json` already exists, `extract` refuses rather than clobber it.
- The record holds only what this one deal needs: your role, keys, the contract parameters, the
  fingerprint, and the ACTIVE/DISPUTED addresses. It deliberately excludes any service token, chat
  key, seed, or other deals.

## 5. Verify the record — no network

```bash
dealctl verify --recovery deal.recovery.json
```

`verify` is fully **offline**. It checks the schema and contract version, confirms the contract
source fingerprint is one it supports, recomputes your public key from your private key, checks your
key matches your declared role, and re-derives the ACTIVE and DISPUTED addresses locally to confirm
they match the record. If any check fails, it stops before you ever touch the network.

## 6. Check on-chain status — through your own node

```bash
dealctl status --recovery deal.recovery.json --node grpc://127.0.0.1:16110
# add --json for machine-readable output
```

`status` queries the node for the deal's ACTIVE and DISPUTED addresses and lists **every** covenant
UTXO it finds, one line each, showing:

- **mode** (ACTIVE or DISPUTED),
- **outpoint** (`txid:index`),
- **amount**,
- **covenant id**,
- **DAA age**, and how much DAA remains until `auto-release`/`timeout` becomes possible,
- the **actions available to your role** right now.

The node is treated as **untrusted input**: `status` never lets the node change where money goes.
All addresses and scripts are computed locally from your recovery record; the node only reports which
UTXOs exist. The default node is loopback (`grpc://127.0.0.1:16110`); a remote node is specified
explicitly with `--node grpc://your-node:16110`.

### One transaction per UTXO

`dealctl` **never combines two covenant UTXOs into one spend.** If a deal address holds more than one
UTXO, a money command must be told which one:

- `--outpoint txid:index` acts on exactly that UTXO, or
- `--all` builds a **separate** transaction for **each** matching UTXO.

If there is exactly one matching UTXO, you may omit both.

---

## 7. Rights tables — who can do what

A money command only works if your key authorizes it and, for the keyless paths, the timelock is
ripe. `dealctl` refuses to sign with the wrong role's key even in cases the contract itself would
reject.

### Escrow

```bash
dealctl escrow release   --recovery deal.recovery.json [--node …] [--outpoint txid:index | --all] [--output tx.json] [--broadcast]
dealctl escrow refund    --recovery deal.recovery.json …
dealctl escrow dispute   --recovery deal.recovery.json …
dealctl escrow auto-release --recovery deal.recovery.json …
dealctl escrow timeout   --recovery deal.recovery.json …
```

| Command        | Mode                        | Authorization | Result                                    |
|----------------|-----------------------------|---------------|-------------------------------------------|
| `release`      | ACTIVE or DISPUTED          | buyer key     | everything to **seller** + resolve fee    |
| `refund`       | ACTIVE or DISPUTED          | seller key    | everything to **buyer** + resolve fee     |
| `dispute`      | ACTIVE                      | buyer key     | move to **DISPUTED** (same covenant)      |
| `auto-release` | ACTIVE, age ≥ dispute_window | **no key**   | to **seller** + resolve fee               |
| `timeout`      | DISPUTED, age ≥ arbiter_deadline | **no key** | to the **`timeout_to`** party, **no service fee** |

### Deposit

Deposit ("Deposit"/«Залог») runs on the same contract with the roles renamed. The **holder** is the
contract buyer; the **depositor** is the contract seller. The recovery record must have
`product = deposit` — you cannot apply Deposit terminology to a plain Escrow record by accident.

```bash
dealctl deposit return      --recovery deal.recovery.json …
dealctl deposit concede     --recovery deal.recovery.json …
dealctl deposit claim       --recovery deal.recovery.json …
dealctl deposit auto-return --recovery deal.recovery.json …
dealctl deposit timeout     --recovery deal.recovery.json …
```

| Command       | Maps to        | Mode                             | Authorization | Result                                       |
|---------------|----------------|----------------------------------|---------------|----------------------------------------------|
| `return`      | `release`      | ACTIVE or DISPUTED               | holder key    | everything to **depositor** + resolve fee    |
| `concede`     | `refund`       | ACTIVE or DISPUTED               | depositor key | everything to **holder** + resolve fee       |
| `claim`       | `dispute`      | ACTIVE                           | holder key    | move to **DISPUTED** (same covenant)         |
| `auto-return` | `auto-release` | ACTIVE, age ≥ dispute_window     | **no key**    | to **depositor** + resolve fee               |
| `timeout`     | `timeout`      | DISPUTED, age ≥ arbiter_deadline | **no key**    | to the **`timeout_to`** party, **no service fee** |

### Funding recovery

If a deal's funding was interrupted, these finish or undo it. Both require a verified funding key in
the record.

```bash
# Finish an interrupted deposit: move funding UTXOs into the ACTIVE covenant genesis
dealctl fund --recovery deal.recovery.json [--node …] [--output tx.json] [--broadcast]

# Sweep not-yet-locked funds back to a plain address you control
dealctl sweep-funding --recovery deal.recovery.json --to kaspa:q… [--node …] [--broadcast]
```

### Mutual settlement

Two parties can settle a deal by co-signing one agreed transaction, without an arbiter. Each signs
their half; either party then combines the two.

```bash
# Each party signs, agreeing on the amount to the buyer (in sompi)
dealctl mutual-sign --recovery deal.recovery.json --to-buyer <sompi> [--outpoint txid:index] --output me.sig.json

# Combine the two signatures into a final transaction
dealctl mutual-combine --recovery deal.recovery.json \
  --buyer-signature buyer.sig.json \
  --seller-signature seller.sig.json \
  [--output tx.json] [--broadcast]
```

`mutual-combine` accepts only two signatures from **different** roles over the **exact same**
transaction. Any mismatch in parameters, outputs, mode, or outpoint stops it.

---

## 8. Offline-sign, then online-submit

Every money command follows the same safe default:

1. builds the transaction **offline**,
2. runs a **local verifier** over its inputs and outputs,
3. prints a **human-readable preview**,
4. saves it to `--output` **if** you passed that flag,
5. and **does not broadcast** unless you pass `--broadcast`.

### Air-gapped signing (keep the key off the network)

To sign with your private key on a machine that has **no network at all**, use the four-step flow.
Only the first and last steps touch a node; signing is fully offline.

The private key **never touches the online machine** — the online steps use a public watch file.

```bash
# 1) OFFLINE — write a PUBLIC watch view of the deal (addresses + ids only, NO private key inside):
dealctl watch --recovery deal.recovery.json --output watch.json

# 2) Move watch.json to the ONLINE machine and export the covenant lines (still NO key on this machine):
dealctl prepare --watch watch.json --node grpc://your-node:16110 --output lines.json

# 3) Move lines.json BACK to the OFFLINE machine and SIGN — no --node:
dealctl escrow release --recovery deal.recovery.json --line lines.json --output release.tx.json
#   (if there are several lines, add --outpoint txid:index to pick one)

# 4) Move release.tx.json to an ONLINE machine and submit — NO private key required:
dealctl submit --tx release.tx.json --node grpc://your-node:16110
```

Only `watch.json`, `lines.json` and `release.tx.json` ever cross to the online machine — none contains
a private key. Step 3 runs entirely offline and binds `lines.json` to your recovery record (the
network, product and deal id must match), so a package prepared for another deal cannot be signed.
`submit` re-validates the envelope, txid and structural path policy before sending.

> Advanced: instead of `--line lines.json` you may pass the line by hand with all four of
> `--outpoint txid:index --amount <sompi> --covenant-id <hex> --mode 0|1`. A money command connects to
> a node ONLY if neither `--line` nor that full set is supplied.

Before anything is broadcast, **read the preview**: check the network, the mode/outpoint, every
output address and amount, and the fees. The tool builds each shown address from the verified output
script, but the final responsibility to confirm the money goes where you expect is yours.

## 9. Clean up

`profile.json` and the intermediate files contain private keys or key-bearing material. When you are
finished, delete them from the machine:

```bash
rm -f profile.json deal.recovery.json me.sig.json *.sig.json
# keep only what you deliberately want to retain
```

If you still hold the deal, keep your original `.age` backup safe and offline — it is what lets you
regenerate `profile.json` again later.

---

## 10. Honest limitations

- The kit recovers **only** deals whose complete recovery record you already hold. It cannot
  reconstruct a deal's redeem script from a private key alone — the constructor parameters must be in
  your backup. Keep a fresh `.age` backup after every deal is funded.
- It performs **no** counterparty discovery, **no** judgment of whether a deal was fulfilled, and
  **no** arbitration. It only builds the on-chain paths the contract already permits.
- It does not run the chat, mediator, marketplace, registry, or any hosted feature. Those are out of
  scope by design and are not part of this package.
- Multi-node quorum is not supported; a single node of your choosing is used, and treated as
  untrusted.

---

## ⚠️ Mandatory warnings

- **A lost `.age` password cannot be recovered.** There is no backdoor and no reset.
- **A lost party private key cannot be recovered.** Without it, the paths it authorizes are gone.
- **No service token is needed for on-chain recovery.** Everything here works with your keys and a
  node alone.
- **Support will NEVER ask for your `.age` file, your password, your profile/recovery JSON, or your
  private key.** Anyone who does is attacking you. Do not send them.
- **Do not install binaries from unofficial sources.** Build from source, or verify the published
  checksums, before running anything.
- **`--all` creates several separate transactions** — one per UTXO. Know how many UTXOs you are
  acting on before you use it.
- **Always check the addresses and amounts in the preview before broadcasting.** Once a transaction
  is on-chain it cannot be undone.
