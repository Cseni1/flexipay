# Demo flows (lane D, D1)

One script per acceptance flow from `tests/e2e/SCENARIOS.md` and ARCHITECTURE
§15. Each script calls the same API the UI calls, prints the route, the legs and
the result, and exits non-zero on failure. Fixtures are neutral: Demo Platform,
Worker A/B/C, Supplier D.

## Status (23 Oct 2026)

**Prepared, not yet executed end to end.** At the tested commit the API exposes
only `healthz`, `corridors` and `recipients`; the A0 schemas and the
quote/payment/batch/claim/sandbox routes do not exist yet. A run therefore ends
as **BLOCKED** with the missing item and its owner, never as PASS.See
`scripts/demo/evidence/2026-10-23-d1.md` for the recorded blocker. Per-run JSON
evidence is written to the same folder and git-ignored.

| Flow                   | Script              | Mock    | Stellar                |
| ---------------------- | ------------------- | ------- | ---------------------- |
| DF1 three-worker batch | `df1-batch.ts`      | BLOCKED | —                      |
| DF2 quote to paid      | `df2-one-off.ts`    | BLOCKED | —                      |
| DF3 claim link         | `df3-claim.ts`      | BLOCKED | BLOCKED (SC2 + wiring) |
| DF4 retry then refund  | `df4-failure.ts`    | BLOCKED | —                      |
| DF5 ZA company         | `df5-za-company.ts` | BLOCKED | —                      |

## Run

```bash
# one flow
FP_API_URL=http://127.0.0.1:3000 FP_API_KEY=... node scripts/demo/df2-one-off.ts

# DF3 on Stellar (needs a funded testnet address)
FP_API_URL=... FP_API_KEY=... FP_SETTLEMENT=stellar \
FP_DEMO_CRYPTO_ADDRESS=G... node scripts/demo/df3-claim.ts --mode stellar

# every mock flow, plus DF3 on Stellar
node scripts/demo/run-all.ts --stellar
```

Prerequisites are read from the environment; nothing is committed.

| Variable                 | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `FP_API_URL`             | Base URL of the integrated API                                     |
| `FP_API_KEY`             | Sandbox API key for the Demo Platform organization (never printed) |
| `FP_SETTLEMENT`          | `mock` or `stellar`; DF3's `--mode` overrides it for one run       |
| `FP_OPENAPI_PATH`        | Route inventory, default `apps/api/openapi.json`                   |
| `FP_HTTP_TIMEOUT_MS`     | Per-request timeout, default 15000                                 |
| `FP_DEMO_CRYPTO_ADDRESS` | Claim destination for DF3 on Stellar only                          |

`FP_API_URL` and `FP_API_KEY` are missing from the root `.env.example`; that
file is owned by the integrator. Until they are added, pass them inline or
export them.

## Exit codes

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | PASS — every assertion held                                                          |
| 1    | FAIL — the API answered but a rule was broken                                        |
| 2    | BLOCKED — a prerequisite is missing (route, A0 contract, adapter, address, API down) |

BLOCKED is never treated as a pass, and `run-all.ts` exits 2 unless every run
passed.

## What each flow proves

- **DF1** — three rows in one JSON batch; per-payment funding; US row has
  exactly `collect` and `payout` on `sim_bank_us_ach`, no convert/settle, no
  on-chain event, and its reasons name the domestic rail; PH and BR rows have
  the five-leg stablecoin route with their payout rails.
- **DF2** — quote exposes route, fee breakdown, FX, expected receive and
  validity; the payment is created `awaiting_funding` with legs pending; after
  funding every leg succeeds in order and the paid route equals the quote.
- **DF3** — funding locks but does not release; the claim view is public;
  accepting releases, the payment becomes paid, the route has no payout leg, and
  the release reference is a mock reference in mock mode or a 64-hex testnet
  hash in Stellar mode (distinct from the lock hash).
- **DF4** — `fail-next` makes the first payout and its single retry fail; the
  timeline shows exactly two `leg.failed` events, the payout stays failed,
  collect/convert/settle reverse and the payment is refunded. A third attempt, a
  paid payment or a missing attempt timeline fails the run.
- **DF5** — ZA company quote takes `collect → convert → payout` on
  `sim_bank_za_eft` with no settle leg, explains the crypto exclusion by
  recipient kind, and refuses a crypto quote with 422 and the same reason; the
  paid payment has no on-chain event.

## Structure

- `lib/` — environment, HTTP, preflight, assertions, fixture loading, reporting
  and evidence.
- `lib/api.ts` — the only seam that may build a request body. It refuses to
  return a client while A0 is absent, so no field is guessed.
- `scripts/seed/fixtures/` — neutral workers, endpoints and per-flow
  amounts/expectations.- `scripts/demo/evidence/` — the committed blocker
  record, plus one generated JSON per run: commit, command, exit code, steps,
  blockers. No key, token, account number or address.

## Known integration needs (owner: Csaba)

1. A0 schemas under `packages/domain/src/api`, exported for scripts.
2. CC3a/CC3b routes from ARCHITECTURE §10, reflected in `apps/api/openapi.json`.
3. `/v1/sandbox/fail-next` accepting a count, so DF4's retry can fail
   deterministically.
4. A refund that works without waiting for ledger time (cancel before expiry,
   CCR-5 §5).
5. `FP_API_URL` and `FP_API_KEY` names in the root `.env.example`.
6. SC2's adapter and `FP_SETTLEMENT` wiring for DF3 on Stellar.
