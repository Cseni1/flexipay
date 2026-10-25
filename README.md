# FlexiPay

**Pay anyone, anywhere. They choose how to get paid.**

One API and one dashboard for paying people across bank accounts, e-wallets and
crypto wallets, routed over the best eligible rail and settled in USDC on
Stellar. The recipient gets a claim link and picks how to receive.

> **Status: testnet prototype.** Stellar USDC vault settlement is real on testnet.
> Bank, e-wallet and FX providers are simulated and labelled. No real money moves.
> Built for HackMeridian 2026 (Scale: prototype to product).

## The problem

Sending small amounts abroad is expensive: the global average cost of sending $200
is 6.49%, rising to 8.78% for Sub-Saharan Africa and 5.72% for Latin America and
the Caribbean (World Bank, Remittance Prices Worldwide, issue 53, Q1 2025).
Platforms that pay people abroad, such as AI-training and freelancer platforms,
stitch together several payout rails, and many recipients have no international
bank account or would rather hold dollars or use an e-wallet.

## What FlexiPay does

- **One API for every payout.** Get a quote, create a payment, fund it, track every
  leg. Route, fees, FX and expected receive amount are shown before sending.
- **The recipient chooses.** A claim link lets the recipient pick a bank account,
  an e-wallet or a Stellar wallet.
- **Eligibility first, then the route.** Corridor rules, recipient type and limits
  decide which routes are allowed, and the quote says why others were excluded
  (for example, South Africa company payouts are routed over bank rails only).
- **Honest failure handling.** A failed payout is retried once, then refunded
  through the vault, and the per-leg timeline shows what happened.
- **Non-custodial crypto leg.** Funds waiting for a claim sit in a Soroban vault
  with no admin key; they move only by claim, cancel or refund.

```
collect (bank)  ->  convert (FX)  ->  settle (USDC on Stellar vault)  ->  convert  ->  payout (bank / e-wallet)
                                                    |
                                      claim link -> recipient's Stellar wallet
```

Four corridors: US to US, Philippines, Brazil and South Africa.

## Real versus simulated

| Layer | Status |
| --- | --- |
| Soroban `payout_vault` (lock, claim, cancel, refund), test USDC | **Real, Stellar testnet** |
| Routing, pricing, payment orchestration, API, web, claim links | **Real, built here** |
| Bank, e-wallet and FX providers | **Simulated**, labelled in data and in the UI |
| Recipient wallets in the baseline | Custodial testnet demo wallets, labelled |
| KYC and KYB | Simulated |

Details and contract ids: [`docs/STELLAR.md`](docs/STELLAR.md).

## Hackathon milestones

Declared at the start of the hackathon (25 Oct 2026). A status changes only with
evidence behind it.

| # | Milestone | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Cash-out to a bank through an anchor (SEP-10, SEP-24, indicative SEP-38) | In progress | Added when verified |
| 2 | Passkey smart-wallet claim, no seed phrase | In progress | Added when verified |
| 3 | Close known testnet gaps: fee-drift recovery, seal-key check, decoded evidence for every journey | In progress | Added when verified |

What existed on arrival, and what was built at the event: [`docs/PRIOR_WORK.md`](docs/PRIOR_WORK.md)
(git tags `qualifier-v1`, `arrival`, and `submission` at the end).

## Demo journeys

| Id | Journey | Script |
| --- | --- | --- |
| DF1 | One JSON batch pays Philippines e-wallet, Brazil bank and US domestic bank | `scripts/demo/df1-batch.ts` |
| DF2 | One-off payment, quote to paid | `scripts/demo/df2-one-off.ts` |
| DF3 | Claim link: waits for acceptance, then releases on Stellar | `scripts/demo/df3-claim.ts` |
| DF4 | Payout fails, one retry, then refund | `scripts/demo/df4-failure.ts` |
| DF5 | South Africa company: crypto excluded, bank route chosen | `scripts/demo/df5-za-company.ts` |

Run all five against the mock settlement with `node scripts/demo/run-all.ts`.
Evidence from the accepted baseline: `scripts/demo/evidence/`.

## Run it

Requires Node 24. The offline demo needs no network after install and uses an
embedded Postgres.

```bash
npm install
npm run db:generate --workspace=@flexipay/api
npm run validate:config
npm run demo:offline -- --print-plan     # shows what will start
npm run demo:offline                      # Postgres + API + web (mock settlement)
```

Open `http://127.0.0.1:5173/`. API health: `http://127.0.0.1:8788/healthz`.
The seed step needs a local demo API key (`FP_API_KEY`); see
[`docs/LOCAL_DEMO.md`](docs/LOCAL_DEMO.md) for keys, Stellar mode and the web proxy.

## API quickstart

The OpenAPI document is [`apps/api/openapi.json`](apps/api/openapi.json). With the
API running and a key exported as `FP_API_KEY`:

```bash
API=http://127.0.0.1:8788
curl -s $API/v1/corridors -H "Authorization: Bearer $FP_API_KEY"

# quote: send 100.00 USD to a Philippines e-wallet
curl -s $API/v1/quotes -H "Authorization: Bearer $FP_API_KEY" -H "Content-Type: application/json" -d '{
  "source":      {"type":"bank_account","currency":"USD","country":"US"},
  "destination": {"type":"ewallet","currency":"PHP","country":"PH","recipientKind":"individual"},
  "amount":      {"side":"send","value":{"amount":"10000","currency":"USD"}},
  "policy": "cheapest", "feeMode": "PayerPays"
}'
```

Amounts are integer minor units in strings (`"10000"` is 100.00 USD). Next calls:
`POST /v1/payments`, `POST /v1/payments/{id}/fund`, `GET /v1/payments/{id}`;
claim links use `GET /v1/claims/{token}` and `POST /v1/claims/{token}/accept`.
Sandbox controls (`/v1/sandbox/*`) force a failure, mark a provider down, move
time and reset the demo.

## Repository map

| Path | What |
| --- | --- |
| `contracts/payout_vault` | Soroban vault; exact rules in `RULES.md` |
| `packages/domain` | Types, money, config schemas, route selection, state machine |
| `apps/api` | REST API, orchestrator, Postgres schema |
| `apps/web` | Send payment, payment detail and claim screens |
| `packages/adapter-stellar`, `packages/adapters-sim` | Stellar settlement; simulated providers and mock settlement |
| `config/` | Corridors, providers, FX rates and fees (placeholders, labelled) |
| `scripts/demo`, `scripts/seed`, `scripts/testnet` | Demo journeys, seed data, testnet set-up |

Product and design documents: [`docs/PRODUCT.md`](docs/PRODUCT.md),
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/EVENT_PLAN.md`](docs/EVENT_PLAN.md).

## Known limits

Stellar fee-drift recovery is verified on the mock only; the different-seal-key
control has not been run; the mock vault does not survive a restart (the Stellar
vault does); the web proxy that injects the demo key is local-only, not deployed
authentication. Not ready for real customer money: that needs a licensed
operating model, real payout and anchor rails, and a contract audit.

## Team

Csenge Csoka and Csaba Szabo. Licence: Apache-2.0.
