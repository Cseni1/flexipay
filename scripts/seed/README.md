# Seed and reset (lane D, D2)

Neutral demo data for the DF1–DF5 scripts and the offline demo. Everything here
is simulated, placeholder and synthetic.

## Files

- `fixtures/workers.json` — Demo Platform, Worker A (PH e-wallet, bank and
  crypto endpoints), Worker B (BR bank), Worker C (US bank) and Worker D (ZA
  company bank). Worker D is the fourth neutral recipient DF5 needs: A/B/C are
  individuals in DF1.
- `fixtures/flows.json` — per-flow amounts in integer minor units,
  delivery/profile, expected routes and rails from `tests/e2e/SCENARIOS.md`, the
  DF4 fail-next target and the crypto destination placeholder
  (`FP_RECIPIENT_A_ADDRESS` for Stellar).
- `seed.ts` — reset and seed CLI, API-only.
- `lib/runner.ts` — the contract-bound reset/recipient calls; no database
  access.

No account number, e-wallet id, wallet address, key or token is committed.
`detailsRef` is a label only.

## Commands

```bash
# reset, then create the four neutral recipients through the API
FP_API_URL=http://127.0.0.1:8899 FP_API_KEY=... node scripts/seed/seed.ts

# reset only
FP_API_URL=http://127.0.0.1:8899 FP_API_KEY=... node scripts/seed/seed.ts reset
```

Both commands write one sanitised JSON record to `scripts/demo/evidence/`
(git-ignored) with commit, command, exit code, steps and blockers. The API key
is redacted.

| Exit | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | PASS — every step ran                                            |
| 1    | FAIL — the API answered but a rule was broken                    |
| 2    | BLOCKED — a route or contract is missing, or `FP_API_*` is unset |

## Contract boundary

D2 goes through the API only; it never copies rows into Postgres. The order is:

1. `POST /v1/sandbox/reset` with A0's empty `SandboxResetRequestSchema` body.
2. `POST /v1/recipients` for each fixture worker, with a deterministic
   `Idempotency-Key` (`seed:recipient:<ref>`).
3. `GET /v1/endpoints` to report whether the endpoint family is mounted.

Endpoint creation is deliberately not attempted. A0 has no create-request schema
for `POST /v1/endpoints` (only the claim-accept endpoint shape), and the route
is not mounted on `main` at `8aa2290`. Sending fields would invent a contract.
The exact dependency is:

> Cursor/CC3b: add `POST /v1/endpoints` and its A0 request/response schema; then
> lane D can implement the fixture-endpoint step and the seed command can pass.

## Current status on `8aa2290`

| Command                           | Result                                              |
| --------------------------------- | --------------------------------------------------- |
| `node scripts/seed/seed.ts reset` | **BLOCKED** — `POST /v1/sandbox/reset` returns 404  |
| `node scripts/seed/seed.ts`       | **BLOCKED** — same reset route; no fixtures changed |

The API at `8aa2290` still mounts only `healthz`, `corridors` and `recipients`
(the quote/payment/claim/endpoint/sandbox handlers are A0 stubs, not routes).

## Offline launcher

`scripts/demo/offline.ts` starts the existing development paths:

```bash
node scripts/demo/offline.ts               # API + web, seed when FP_API_KEY is set
node scripts/demo/offline.ts --no-seed
node scripts/demo/offline.ts --print-plan  # no processes started
```

It forces `FP_SETTLEMENT=mock` and uses the simulated providers from `config/`.
The API command owns embedded Postgres and migrations; the launcher does not
start a database, Docker, a queue or a second framework. The root script is the
integrator's one-line wiring (see the D2 evidence file); until it lands, run the
node command directly.

`FP_API_KEY` has no bootstrap route yet: no API call creates an organization or
key. The launcher therefore starts both servers without seeding and names the
missing key. Cursor/integration must provide the local Demo Platform key (for
example a development bootstrap that prints one) before `npm run demo:offline`
can seed in one command.

Story names, if any, belong only in `scripts/seed/demo-data/` and are added by
humans.
