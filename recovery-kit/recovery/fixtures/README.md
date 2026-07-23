# Recovery record fixtures & attack vectors

These are canonical recovery records used to smoke-test the party CLI offline. The `.valid.json`
record must pass `dealctl verify`; every `attack-*.json` must FAIL it (non-zero exit). They match the
deterministic keys of the golden vectors (`../vectors/v1.json`).

```bash
dealctl verify --recovery deal-recovery.valid.json                     # exit 0
dealctl verify --recovery deal-recovery.attack-wrong-party-key.json    # exit 1
```

| File | Expectation | What it attacks |
|------|-------------|-----------------|
| `deal-recovery.valid.json` | passes | a well-formed, self-consistent record |
| `deal-recovery.attack-wrong-party-key.json` | rejected | `party_sk` does not derive `party_pk` |
| `deal-recovery.attack-wrong-role.json` | rejected | `party_pk` does not match the key for the claimed role |
| `deal-recovery.attack-tampered-active-address.json` | rejected | recorded ACTIVE address ≠ locally recomputed |
| `deal-recovery.attack-fee-budget-too-high.json` | rejected | `fee_budget` above the contract cap (0.1 KAS) |
| `deal-recovery.attack-unknown-source.json` | rejected | contract source not in the fail-closed registry |
| `deal-recovery.attack-uppercase-hex.json` | rejected | non-lowercase hex (strict parsing, no panic) |
| `deal-recovery.attack-incomplete-missing-sk.json` | rejected | incomplete record (no signing key) — fails at parse |
| `deal-recovery.attack-modified-buyer-key.json` | rejected | modified buyer key → ACTIVE/DISPUTED addresses no longer match |
| `deal-recovery.attack-modified-seller-key.json` | rejected | modified seller key → address mismatch |
| `deal-recovery.attack-modified-arbiter-key.json` | rejected | modified arbiter key → address mismatch |
| `deal-recovery.attack-modified-fee-key.json` | rejected | modified fee key → address mismatch |
| `deal-recovery.attack-wrong-network.json` | rejected | wrong network prefix → recomputed addresses mismatch |
