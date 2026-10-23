# FlexiPay

**Work gets approved. Payouts route with reasons — including a Stellar claim link.**

HackMeridian testnet prototype: US-dollar source → eligible bank, e-wallet or
Stellar crypto destination over four corridors, with per-leg status, refunds and
an offline mock fallback.

## Docs

| Doc | Purpose |
| --- | --- |
| [`docs/LOCAL_DEMO.md`](docs/LOCAL_DEMO.md) | Local startup, seed, DF scripts, UI demo path, gaps |
| [`docs/STELLAR.md`](docs/STELLAR.md) | Real vault settlement vs simulated banking/FX |
| [`docs/PRIOR_WORK.md`](docs/PRIOR_WORK.md) | Arrival baseline vs event work; tags |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) / [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Product and build contracts |
| [`scripts/demo/README.md`](scripts/demo/README.md) | Lane-D flow scripts |

## Quick start (offline / mock)

```bash
npm install
npm run db:generate --workspace=@flexipay/api
npm run validate:config
npm run demo:offline -- --print-plan
npm run demo:offline -- --no-seed
# with a local Demo Platform key exported as FP_API_KEY:
npm run demo:offline
```

Open `http://127.0.0.1:5173/`. API health: `http://127.0.0.1:8788/healthz`.

Full commands, Stellar mode, refund/offline notes and verification gaps:
**`docs/LOCAL_DEMO.md`**.

## Real vs simulated (one line)

Bank / e-wallet / FX legs are **simulated and labelled**. When
`FP_SETTLEMENT=stellar`, the settle leg uses the real Soroban `payout_vault` on
Stellar testnet. Offline demo is always mock settlement.

## Tested tip

Pre-event handoff commit: **`e3f788c`**. D1/D2 evidence:
`scripts/demo/evidence/2026-10-23-d1-d2-final-acceptance.md`.

CCR-11 Stellar restart is **PASS** (evidence on main after integration). Remaining:
Stellar fee-drift recovery **NOT VERIFIED**; different-seal-key control **NOT RUN**;
mock vault is not restart-safe; Vite proxy is not deployed auth.

## Entry (published rules)

**Scale** builder track (standalone). Thematic tracks are **Genesis-only**.
Anchor and passkey work are planned **at the event** (after Sun 25 Oct 11:30),
not Scale eligibility requirements. Existing git tag: `qualifier-v1` only.
