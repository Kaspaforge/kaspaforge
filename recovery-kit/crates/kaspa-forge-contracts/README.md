# kaspa-forge-contracts

The public core of Kaspa Forge — the escrow/deposit covenant transition builders, the recovery
record schema, the contract-version registry, and the canonical test vectors.

This is a pure-Rust library with **no gRPC and no hosted-server dependency**. The browser WASM crate
(`kaspa-safe-core`) re-exports these exact builders, so the browser, this crate, and the party-side
CLI (`dealctl`) build byte-identical transactions from one implementation (proven by the parity
vectors below).

## Modules

| Module | Description |
|--------|-------------|
| `tx` | Shared tx-building primitives: p2pk/p2sh scripts, `InputSpec`, `build_tx*`, covenant sigscript, signing, genesis covenant id, address helpers. |
| `escrow` | `EscrowParams`, contract compilation, and every escrow/deposit transition builder: fund, release, refund, dispute, autoRelease, timeout, arbitrateTo/Split, mutual sign/combine. |
| `recovery` | The minimal party-side recovery record (`RecoveryRecord`) and its fail-closed offline `verify()`. Strict `deny_unknown_fields`; strict lowercase-hex parsing. |
| `registry` | The fail-closed allowlist of supported contract versions with real source + compiler fingerprints. |
| `vectors` | Builds the canonical golden vectors (addresses + transaction ids/outputs). |

## Build & test

```bash
cd kaspa-safe/contracts
cargo test              # library + VM + parity-vector tests
cargo run --bin gen_vectors   # regenerate vectors/v1.json (deterministic)
```

`tests/vectors.rs` is the parity gate: the committed `vectors/v1.json` must be reproduced
byte-for-byte by the current toolchain, or the build fails.

## Contract source & fingerprint

`escrow.sil` is embedded via `include_str!` and its SHA-256 is recorded in the registry:

```
escrow v1 source_sha256: 65d4b6bb3c516647b72a873dab1272445c498f8b17bfba19ec15519726dcb4a0
```

`registry::assert_compiler_matches` additionally recompiles a canonical reference contract and checks
the compiled ACTIVE/DISPUTED script hashes, so a mismatched SilverScript toolchain is caught before
any address is trusted.

## Recovery CLI

The party-side recovery CLI (`dealctl`) is built on this crate; its usage, the Escrow/Deposit rights
tables, and the offline-sign / online-submit flow are documented in
[`../recovery/README.md`](../recovery/README.md) (EN) and `../recovery/README-RU.md` (RU).

## Security notes

- A recovery record carries the recovering party's **own** signing key (`party_sk`) and the public
  constructor parameters — and nothing else (no seed/master, service token, chat key, arbiter key, or
  operator metadata). Every struct rejects unknown fields.
- `verify()` is offline and fail-closed: it recomputes the party pubkey, the funding address, and the
  ACTIVE/DISPUTED covenant addresses locally and refuses on any mismatch, unknown version,
  out-of-range fee budget, or unsafe integer.
- The registry is fail-closed: an unknown version/source is rejected, never silently accepted.
