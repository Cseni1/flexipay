# Live smoke (read-mostly)

Playwright checks against the **deployed** FlexiPay web app. Separate from `tests/e2e-ui` (mocked local Vite).

## Credentials

Set both (never commit them):

- `FP_QA_EMAIL`
- `FP_QA_PASSWORD`

Optional:

- `FP_LIVE_URL` — default `https://my.getflexipay.app`

If either credential is unset, the suite **skips** with a clear message (exit 0).

Screenshots, video and traces are off so credentials are not written into artifacts.

## Run

From the repo root (Playwright is already a workspace dependency):

```bash
cd tests/e2e-live
FP_QA_EMAIL='…' FP_QA_PASSWORD='…' npx playwright test
```

With a custom base URL:

```bash
cd tests/e2e-live
FP_LIVE_URL='https://my.getflexipay.app' \
FP_QA_EMAIL='…' FP_QA_PASSWORD='…' \
npx playwright test
```

## What it covers

1. Sign in → Dashboard  
2. Pay from: Add funds panel + FlexiPay wallet card  
3. Send: United Kingdom → GBP source / tGBP destination → quote £10 → receive £9.90, fees £0.10  
4. Payments list + Account: no raw `TGBP` / `99,009,900`  
5. `/take-payment` form when that route is deployed  
6. Aggregator read-only quotes (BlindPay BR, Tazapay KE)  

`live-smoke` and `live-aggregator` create no payments (quotes only).

### Live payout (creates one sandbox payment)

USD → Philippines bank via Tazapay: quote, create, fund, wait for Paid (up to 6 minutes). Ten-minute test timeout.

From the repo root:

```bash
FP_QA_EMAIL='…' FP_QA_PASSWORD='…' npm run test:live:payout
```
