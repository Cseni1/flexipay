# Seed fixtures (lane D)

Neutral data for the DF1–DF5 acceptance scripts. Everything here is simulated,
placeholder and synthetic:

- `fixtures/workers.json` — Demo Platform, Worker A (PH e-wallet, bank, crypto
  endpoints), Worker B (BR bank), Worker C (US bank), Supplier D (ZA company
  bank).
- `fixtures/flows.json` — per-flow amounts in integer minor units,
  delivery/profile, expected routes and rails from `tests/e2e/SCENARIOS.md`, the
  DF4 fail-next target and the crypto destination placeholder.

No account number, e-wallet id, wallet address, key or token is committed.
`detailsRef` is a label only; the A0 adapter supplies an in-memory synthetic
value when it maps a fixture to an API body.

## Boundary with D2

D1 only reads these fixtures. D2 owns seeding and reset through the integrated
sandbox API and `/v1/sandbox/reset`; it must not be implemented by copying this
data into the database directly. Story names, if any, belong only in
`scripts/seed/demo-data/` and are added by humans.
