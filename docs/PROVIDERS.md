# Providers: what is confirmed and what to ask (1 November 2026)

Facts below come from each provider's public pages read on 1 Nov 2026. "Not
confirmed" means we could not find it in public documentation and must ask.
Nothing here is a price or a promise. Aligns with "FlexiPay: the plan for 12
November": wallet to wallet USDC on Solana first; bank legs only where a partner
confirms in writing and an end-to-end test passes.

## Wallets

| Provider               | Confirmed                                                                                                              | Not confirmed                                                                                                                                                                                                   | Our use                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Solana Wallet Standard | Connects existing wallets (Phantom and others) with no account or approval. Already in `apps/web` on the agent branch. | n/a                                                                                                                                                                                                             | The launch fallback for every flow.                                                           |
| Crossmint Wallets      | Has a staging console and a production console. Passkey and email login are documented in SDK docs.                    | Whether production Wallets need an order form and KYB. Whether Solana wallets are non-custodial in our account (docs and third-party pages disagree). Whether a staging key is self-service. Per-wallet limits. | "FlexiPay wallet", conditional on the answer. Do not build a dependency until it is answered. |

## Ramps (fiat to and from USDC)

| Provider | Confirmed                                                                                                                                                                                                                                                                                                                                                                                                                           | Not confirmed                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transak  | Whitelabel API and widget; off-ramp (sell) to bank or card exists; Solana is a supported chain; "Transak Stream" is documented separately; production needs enabling by Transak and KYB.                                                                                                                                                                                                                                            | Staging keys and URL; which countries pay out to a bank (not card) from Solana USDC; widget parameters for Solana USDC; order-status or webhook API for sell; fees. |
| MoonPay  | Sandbox switches on automatically with a `pk_test_` key; sandbox sell widget is `https://sell-sandbox.moonpay.com/`; production `https://sell.moonpay.com/`; URLs that carry sensitive parameters (for example `refundWalletAddress`) must be signed on the server with the secret key (HMAC-SHA256 over the query string), and the widget will not load without it; test cards are documented; New York is unsupported in sandbox. | The Solana USDC currency code; payout countries and methods for sell; fees; production activation time.                                                             |

Signing secrets (MoonPay secret key) are server-side only, in env files that are
git-ignored. Never in the web bundle.

## Payout partners (bank legs by country)

Not for 12 Nov unless a partner confirms in writing: Bridge, Conduit, BVNK,
Yativo, BlindPay (Brazil, Mexico, Philippines, India, Colombia, Argentina),
Sphere (US and EU banks). Wise Platform and Airwallex need partner agreements
and are later.

## Questions to send

Send these three to every payout partner, and the specific ones below to the
others.

1. Do you accept USDC on Solana as the funding asset for a payout?
2. Do you pay out to a bank account (not only a card) in these countries:
   ______?
3. What is the total fee, any monthly fee, and how long does KYB take?

**Crossmint:** Do production Wallets need an order form and KYB, and how long
does it take? Are Solana wallets with email or passkey login non-custodial in
our account? Is a staging API key self-service? Are there limits per wallet or
per month?

**Transak:** Which countries can we pay out to a bank account from USDC on
Solana (not card)? Can we set `network` to Solana and `cryptoCurrencyCode` to
USDC in sell? How do we get order status (webhook or API)? How long does KYB for
production keys take?

**MoonPay:** What is the Solana USDC currency code for sell? Which countries and
methods does sell pay out to? Is a webhook available for sell order status? How
long does production activation take?

## Order of work once an answer arrives

1. Crossmint confirms access: `apps/web` adds a "FlexiPay wallet" connector
   behind the same Wallet Standard interface, with Wallet Standard still the
   default.
2. A ramp key arrives: a server-side ramp module signs and returns the widget
   URL (MoonPay) or builds it (Transak); the web app only opens the URL. Order
   status comes back by webhook into the existing event stream. The payment is
   marked paid only after the USDC transfer is verified on chain, the same rule
   as the wallet path.
3. A payout partner confirms a country: a provider entry in `config/` plus an
   adapter, behind the same router; the corridor is labelled live only after an
   end-to-end test passes.
