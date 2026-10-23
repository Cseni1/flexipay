# Demo flows (lane D, D1)

One script per acceptance flow from `tests/e2e/SCENARIOS.md` and ARCHITECTURE
§15. Each script calls the same API the UI calls, prints the route, the legs and
the result, and exits non-zero on failure. Fixtures are neutral: Demo Platform
and Worker A to Worker D (Worker D is the ZA company that DF5 needs).

## Status (23 Oct 2026)

**Prepared, not yet executed end to end.** At the tested commit `8aa2290` the
API mounts only `healthz`, `corridors` and `recipients`; A0 schemas exist but
the quote/payment/batch/claim/endpoint/sandbox handlers are not mounted. A run
therefore ends as **BLOCKED** with the missing item and its owner, never as
PASS. See `scripts/demo/evidence/2026-10-23-d1.md` for the recorded blocker,
`2026-10-23-d1-review.md` for the review fixes and `2026-10-23-d2.md` for the
seed/offline work. Per-run JSON evidence is written to the same folder and
git-ignored.

DF1 takes the domestic explanation from `Quote.reasons` (no batch-row reason
field is invented). DF4 still needs the endpoint route and a defined way to read
payout attempts, the `leg.failed` cardinality and the settle leg's status after
a refund; the runner blocks instead of guessing those shapes.

| Flow                   | Script              | Mock    | Stellar                |
| ---------------------- | ------------------- | ------- | ---------------------- |
| DF1 three-worker batch | `df1-batch.ts`      | BLOCKED | —                      |
| DF2 quote to paid      | `df2-one-off.ts`    | BLOCKED | —                      |
| DF3 claim link         | `df3-claim.ts`      | BLOCKED | BLOCKED (SC2 + wiring) |
| DF4 retry then refund  | `df4-failure.ts`    | BLOCKED | —                      |
| DF5 ZA company         | `df5-za-company.ts` | BLOCKED | —                      |

## Run

```bash
# offline: embedded Postgres + API + web, mock settlement, loopback only
node scripts/demo/offline.ts --no-seed

# one flow
FP_API_URL=http://127.0.0.1:3000 FP_API_KEY=... node scripts/demo/df2-one-off.ts

# DF3 on Stellar (needs Worker A's published address and a testnet RPC)
FP_API_URL=... FP_API_KEY=... FP_SETTLEMENT=stellar \
FP_RECIPIENT_A_ADDRESS=G... FP_STELLAR_RPC_URL=https://... \
FP_STELLAR_NETWORK_PASSPHRASE='Test SDF Network ; September 2015' \
node scripts/demo/df3-claim.ts --mode stellar

# every mock flow, plus DF3 on Stellar
node scripts/demo/run-all.ts --stellar
```

Prerequisites are read from the environment; nothing is committed.

| Variable                        | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `FP_API_URL`                    | Base URL of the integrated API                                     |
| `FP_API_KEY`                    | Sandbox API key for the Demo Platform organization (never printed) |
| `FP_SETTLEMENT`                 | `mock` or `stellar`; DF3's `--mode` overrides it for one run       |
| `FP_OPENAPI_PATH`               | Route inventory, default `apps/api/openapi.json`                   |
| `FP_HTTP_TIMEOUT_MS`            | Per-request timeout, default 15000                                 |
| `FP_RECIPIENT_A_ADDRESS`        | Worker A's published testnet address; DF3 claim destination        |
| `FP_STELLAR_RPC_URL`            | Public testnet RPC used to verify the release hash                 |
| `FP_STELLAR_NETWORK_PASSPHRASE` | Expected testnet passphrase, checked against the RPC               |

`FP_API_URL` and `FP_API_KEY` are missing from the root `.env.example`; that
file is owned by the integrator. Until they are added, pass them inline or
export them.

### Offline launcher (D2)

The launcher starts the same development commands a person would run:

- `npm run dev --workspace @flexipay/api` — embedded Postgres, migrations, API;
- `npm run dev --workspace @flexipay/web` — Vite;
- `FP_SETTLEMENT=mock` and the simulated providers in `config/`;
- loopback only, no Docker, no second database, no queue.

| Variable                    | Purpose                               |
| --------------------------- | ------------------------------------- |
| `FP_API_PORT`               | API port, default 8788                |
| `FP_WEB_PORT`               | Vite port, default 5173               |
| `FP_OFFLINE_API_TIMEOUT_MS` | API readiness timeout, default 120000 |
| `FP_OFFLINE_WEB_TIMEOUT_MS` | Web readiness timeout, default 60000  |

It waits for `GET /healthz` and the Vite page before reporting ready, then runs
`scripts/seed/seed.ts` when `FP_API_KEY` is set. `--no-seed` skips that step;
`--print-plan` prints the loopback plan without starting anything. The root
`demo:offline` script is the integrator's one-line wiring; see the D2 evidence.

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
  exactly `collect` and `payout` on `sim_bank_us_ach`, no convert/settle and no
  on-chain event; PH and BR rows have the five-leg stablecoin route with their
  payout rails. The domestic explanation is blocked on A0: reasons belong to a
  quote, and no batch-row reason field is defined.
- **DF2** — quote exposes route, fee breakdown, FX, expected receive and
  validity; the payment is created `awaiting_funding` with legs pending; after
  funding every leg succeeds in order and the paid route equals the quote.
- **DF3** — funding locks but does not release; the claim view is public;
  accepting releases, the payment becomes paid, the route has no payout leg. The
  release reference is the settle leg's `externalRef`. Mock mode requires a
  labelled mock reference; Stellar mode verifies the hash through the testnet
  RPC (`getNetwork` passphrase + `getTransaction` SUCCESS + ledger). A 64-hex
  string alone is never treated as proof, and `--mode` only says what was
  requested.
- **DF4** — `fail-next` makes the first payout and its retry fail; the payout
  stays failed, collect and convert reverse, and the payment is refunded. The
  flow then blocks: neither A0 nor SCENARIOS.md defines how attempts are exposed
  (repeated legs, an attempts array, or one leg), the `leg.failed` cardinality,
  or the settle leg's status after a vault refund.
- **DF5** — ZA company quote takes `collect → convert → payout` on
  `sim_bank_za_eft` with no settle leg and a non-empty exclusion reason, and a
  crypto quote is refused with 422 and a non-empty reason. The exact prose and
  the recipient-kind wording are not asserted; no stable reason code exists yet.
  The paid payment has no on-chain event.

## Structure

- `lib/` — environment, HTTP, preflight, assertions, fixture loading, reporting
  and evidence.
- `lib/api.ts` — the only seam that may build a request body. It refuses to
  return a client while A0 is absent, so no field is guessed.
- `lib/contract-gaps.ts` — blocked seams for evidence A0 has not defined.
- `lib/stellar-proof.ts` — testnet RPC verification of a release hash.
- `scripts/seed/fixtures/` — neutral workers, endpoints and per-flow
  amounts/expectations.
- `scripts/demo/evidence/` — committed blocker/review records, plus one
  generated JSON per run: commit, command, exit code, steps, blockers. No key,
  token, account number or address.

## Known integration needs (owner: Csaba)

1. A0 schemas under `packages/domain/src/api`, exported for scripts.
2. CC3a/CC3b routes from ARCHITECTURE §10, reflected in `apps/api/openapi.json`.
3. `/v1/sandbox/fail-next` accepting a count, so DF4's retry can fail
   deterministically.
4. A refund that works without waiting for ledger time (cancel before expiry,
   CCR-5 §5).
5. `FP_API_URL` and `FP_API_KEY` names in the root `.env.example`.
6. SC2's adapter and `FP_SETTLEMENT` wiring for DF3 on Stellar.
7. A0 answers for the blocked evidence: the batch-row route/reason field, how
   payout attempts are exposed (and `leg.failed` cardinality), the settle leg's
   status after a vault refund, and whether lock and release references are
   separate fields.
8. A stable refusal-reason code if DF5 must prove the recipient-kind wording
   rather than only a non-empty explanation.
