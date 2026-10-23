# FlexiPay: Product Definition

Version 4, 23 Oct 2026. Purpose: one agreed definition of the product. Sections 1 to 11 describe the product and its vision and are unchanged in substance. **Section 12 is the reduced hackathon MVP** (what is built and what is not), decided on 23 Oct 2026 as CCR-5 so that the pitch stays whole and the build can be finished.

## 1. One line

**FlexiPay is a payment orchestration platform, with one API and one dashboard, for paying and getting paid between bank accounts, e-wallets and crypto wallets, domestically and internationally, over the best eligible route.**

Wallet-to-wallet crypto alone is not new. The value is bank and crypto in one product, a recipient who chooses how to receive, and a router that picks the best eligible route and explains why.

**Operating model (undecided).** FlexiPay orchestrates. Regulated partners perform the regulated activities: fiat collection and payout, conversion, custody of fiat and KYC. Whether FlexiPay itself needs any authorisation depends on what it initiates, instructs or controls. That needs legal advice before launch and is why this document does not call FlexiPay a "payment provider". NOT VERIFIED.

## 2. The problem

- Sending money across borders is expensive. World Bank data for sending $200, Q1 2025: global average 6.49%, Sub-Saharan Africa 8.78%, Latin America and Caribbean 5.72%, South Asia 4.80% (Remittance Prices Worldwide, issue 53).
- Platforms that pay many people abroad (freelancer and EOR platforms, data-annotation platforms, marketplaces) stitch together several rails. AI-training platforms alone use Stripe, Deel, Payoneer, Hyperwallet and Dots (RemoWork, July 2026). Workers lose money to fees and wait days.
- Large invoices between importers and exporters pay opaque SWIFT fees and FX spreads. A vendor estimate puts a wire into an emerging market at $40 to $80 plus a 2 to 5 percent spread (BlindPay, Sept 2026). Treat vendor numbers as indicative.
- Recipients often have no easy way to receive: no international bank account, or they prefer an e-wallet or dollars.

## 3. What FlexiPay is

**An orchestration layer, not a crypto product.** Blockchain is infrastructure and stays invisible unless the user chooses it.

### Endpoint types

"Wallet" is never used on its own in the product. There are four endpoint types, with very different regulation and behaviour:

| Endpoint type | Nature | Examples |
|---|---|---|
| Bank account | Fiat | Local bank account |
| E-wallet or mobile money | Fiat, issued by a licensed provider | GCash, Maya-style wallets, mobile money |
| Crypto wallet (self-custody) | Crypto, user controls keys | Stellar wallet, Solana wallet, FlexiPay passkey smart wallet (no seed phrase) |
| Crypto exchange or custodial account | Crypto, held by a provider | Exchange deposit address |

One brand can span two types (for example a provider that offers both an e-wallet and crypto services). Each service is treated as its own endpoint.

### Three legs of every payment

| Leg | Examples |
|---|---|
| First mile (collect) | Bank transfer, card, e-wallet, crypto wallet |
| Middle (settle) | Stablecoin on Stellar, or a direct domestic rail |
| Last mile (pay out) | Any endpoint type above |

- **Domestic payments** have only a first and last mile. The router picks a local rail.
- **International payments** use all three. The saving is in the middle leg and the two conversions.

### Directions

Any endpoint type to any other, subject to eligibility. The four headline directions: bank to bank, bank to crypto wallet, crypto wallet to bank, crypto wallet to crypto wallet. Fiat e-wallets behave like banks for routing and compliance purposes.

### Best eligible route

The router works in two steps:

1. **Filter by hard constraints:** regulation and corridor availability, sender and recipient type, limits, liquidity, provider health and reliability, settlement requirements.
2. **Optimise within what is eligible:** cost, speed or reliability, according to the customer's policy.

Cost never overrides eligibility. The router shows the user why a route was chosen and what the alternatives cost. It never forces a payment through crypto where a local rail is better.

### Recipient choice without a FlexiPay account

The sender does not need the recipient's bank details. The recipient receives a claim link, chooses how to receive and receives **without requiring a FlexiPay account, where the selected rail or provider permits it.** Receiving to a wallet can work with a link alone. Cashing out to a bank or e-wallet may trigger onboarding or verification by the partner (for example SEP-12 style customer information). Expired payments return to the sender.

### Money model: crypto flows and fiat flows are different

| Flow | Who holds the money | Rule |
|---|---|---|
| **Crypto flows** | A non-custodial, rule-enforced vault contract with no admin key | Funds locked in a pending payout follow the contract rules (claim, expiry, refund), not anyone's discretion. FlexiPay cannot move them. |
| **Fiat flows** | Regulated partners, in safeguarded accounts | FlexiPay does not hold customer fiat. Bank-originated payments are collected, converted and paid out by partners under their own authorisation. |

## 4. Product surfaces: API and dashboard for everything

One engine, two front doors. The dashboard is a client of the API, so anything possible in one is possible in the other. This section is the product vision; the hackathon MVP builds a thin slice of it (section 12).

**API**
- Create a payment, get a quote (fee, FX rate, route, estimated time, quote validity), confirm, track, cancel or refund.
- Batch payments, recipients, claim links.
- Webhooks: created, funded, processing, on-chain, paid, failed, refunded, and per-leg events.
- API keys, sandbox mode, logs.
- The internal settlement interface is network-agnostic. Stellar is the first implementation.

**Dashboard**
- **One-off payment:** a "Send a payment" form for any direction, with a quote before confirming and live tracking.
- **Batch payments:** CSV upload.
- Payments, recipients, statuses, fees, FX, blockchain references (available but not dominant), reconciliation, reports.
- API keys, webhooks, developer logs, sandbox switch.

**Recipient experience**
- Claim page on a phone: choose how to receive, see the amount and fee before confirming.

## 5. Use cases (profiles on the same engine)

| Use case | What it needs |
|---|---|
| **Small payments (under 200 USD)** | Percentage fee, no minimum; this is where fixed fees hurt most |
| **Marketplaces, freelancer and EOR platforms, data-annotation platforms** | Batch payouts, recipient choice, frequent payments |
| **Tips and service charge** | Pool split by weight, no fee on tips, flat monthly plan for the venue |
| **Larger international invoices (importers and exporters)** | Quote lock, reference and beneficiary details, approval step, higher limits, business verification; capped in the MVP |
| **Domestic payments with a choice of endpoint** | One API, router picks the best eligible local rail; no price claim |
| **Anyone making a one-off payment** | Dashboard form; sender identity checks in production |


## 6. Markets

- **Senders:** US (USD) and Europe (EUR).
- **Receivers:** Philippines and Latin America (one demo country to confirm, Brazil or Mexico).
- **Domestic:** US, UK and EU, plus domestic payouts in the receiving countries.
- **South Africa:** simulated, bank-only, regulation-aware corridor. Not a live stablecoin corridor.
- **Not targeted:** high-risk markets with sanctions or unclear crypto rules.

### Where FlexiPay is and is not cheaper

- **Cheaper:** international payments, especially emerging-market corridors and large invoices.
- **Not cheaper:** domestic payments in most countries. In the Philippines, large banks waived instant-transfer fees from July 2026; Brazil's Pix and India's UPI are near zero.
- **Countries where a crypto wallet may beat local banking domestically** (Argentina, Venezuela, Nigeria) are driven by currency instability and dollar access, not fees. They carry the highest regulatory and sanctions risk and are not MVP targets.

## 7. Regulation-aware routing

A corridor is not only a country. Eligibility depends on recipient type (individual or company), endpoint type and whether a crypto leg is allowed.

Example, South Africa: draft cross-border crypto rules (3 Aug 2026) would stop companies sending or receiving crypto across the border. On 21 Oct 2026 the finance minister said they will be rewritten, with no timeline. Until rules are final, South Africa is routed over bank rails only. This is not legal advice and needs local counsel.

## 8. Quotes, FX and price risk

A quote is a promise, so it needs rules:

- **Quote validity:** every quote has an expiry. Default window to be decided.
- **Who bears price movement** between quote and settlement: stated per payment profile (sender, recipient, or FlexiPay's partner).
- **Quote lock:** only offered where a partner commits to the rate for the validity window. NOT VERIFIED which partners will.
- **Stablecoin risk:** a depeg or a frozen stablecoin during settlement needs a defined response (pause, re-quote, refund path).
- **What the user sees:** amount sent, fee, FX rate, expected received amount and validity time, before confirming.

## 9. Payment lifecycle and failure across legs

Every payment is a state machine with one state per leg. Failure in any leg has a defined path:

- **First leg succeeds, middle or last leg fails:** reverse or refund per leg according to the route (for crypto flows, the vault rules; for fiat flows, the partner's reversal process).
- **Settlement succeeds, payout fails:** retry, re-route to another eligible provider, or refund, depending on policy and what was already settled.
- **Unclaimed payments:** expire and return to the sender.
- **Every transition is logged** and exposed through the API, webhooks and dashboard.

## 10. Business model

- **Payments:** percentage fee only, no minimum, paid by the sender or the recipient. FX is shown upfront.
- **Tips:** no fee on tips. The venue pays a flat monthly plan.
- **Later:** premium API plans, enterprise pricing, instant-payout premium.
- **Pricing is set only after real provider quotes.** Gate from earlier planning: enough margin per 50 USD payout (0.40 to 0.50 USD) and three committed pilots.

## 11. Competition

Payoneer, Deel, Remote, Hyperwallet, Dots, Wise Platform, Stripe and Bridge, Airtm, and for B2B trade payments XTransfer. Several EOR platforms already ship stablecoin payouts.

**Payout providers** include regulated banks, e-wallet providers and Stellar anchors, all behind the same provider layer.

**Where FlexiPay differs:** one API and dashboard covering bank, e-wallet and crypto endpoints, recipient choice without requiring a FlexiPay account where the rail permits it, routing that is honest about when not to use crypto, lower cost on small cross-border payments, and tips and service charge on the same engine.

## 12. Hackathon MVP (HackMeridian, Lisbon, 25 and 26 Oct 2026)

**Scope in one line:** outgoing platform payouts from a US dollar bank source to a bank account, an e-wallet or a Stellar crypto wallet, over four corridors, with the route chosen by eligibility and explained. The rest of the vision is described in the pitch and not built.

**Why reduced:** the build window is one day before travel, then the event. Everything cut below is cut from the hackathon version only. The pitch still presents the full product; the demo shows the thin slice that carries its argument.

| Built (real) | Not built in the hackathon (shown in the pitch only) |
|---|---|
| US dollar bank source; four corridors: US to US, Philippines, Brazil, South Africa | Other source types, countries and networks; EU, UK and Mexico |
| Single payment and JSON batch through the API | CSV import, Batches screen |
| Quote with route, fee, FX, validity, and reasons including why other routes are excluded | Cost, speed and balanced optimisation; a general route search |
| One approved route per destination type; a retry once, then a proper refund | Automatic provider switching; general recovery for arbitrary routes |
| Claim link, delivered to a crypto wallet or a chosen bank or e-wallet | Recipients screen, Developers dashboard, reports |
| Payment status, per-leg timeline and an event log through the API | Webhook delivery |
| Stellar testnet settlement through the vault contract, with a mock settlement as offline fallback | Real fiat money movement |
| Sandbox controls through the API (force a failure, mark a provider down, move time, reset) | Tips module (shown as a use case) |
| Bank, e-wallet and FX providers: **simulated and labelled** | KYC and KYB (simulated, labelled) |
| **At the event:** cash-out to a bank through the SDF test anchor; passkey smart-wallet claim | Fee sponsorship (stretch) |

**Baseline recipient wallet:** the baseline recipient uses a custodial testnet wallet held by the backend, clearly labelled. The passkey smart wallet replaces it at the event.

**Demo story (about 3 minutes):** a data-annotation platform pays workers abroad. One worker opens the claim link on a phone, creates a wallet with a fingerprint (no seed phrase), and cashes out to a bank account through a Stellar anchor, seeing an indicative price first (on testnet the reference anchor pays out to a US-dollar bank account; local anchors in production). Then the route comparison, a US domestic payout where the router picks the local rail and says why, a failed last leg that is refunded, and the South Africa case showing regulation-aware routing. Before the event the same story runs with the custodial demo wallet and the anchor step shown as the next part.

**Entry:** one **Scale** builder-track entry (standalone under published rules; thematic tracks are Genesis-only). Anchor cash-out and passkey claim are planned **event** work, not Scale eligibility requirements. Everything built before the event is disclosed as the arrival baseline (`docs/PRIOR_WORK.md`).

## 13. Architecture principles (details come next)

- Payment intent is separate from the settlement network.
- Providers and networks are replaceable adapters. Never build around one anchor.
- Countries, currencies, rails, endpoint types, providers and regulatory availability are configuration, not code.
- Routing is eligibility first, then optimisation.
- Payments are per-leg state machines with defined reversal paths and quote validity.
- Crypto flows use non-custodial vault contracts (no admin key on the vault); fiat flows stay with regulated partners.
- Stellar standards (SEP-24, SEP-31, SEP-38) over hard-coded providers where possible.
- Passkey smart wallets for recipients (built at the event).

## 14. Risks and what is not verified

- FlexiPay's regulatory operating model (orchestrator only versus own authorisation): NOT VERIFIED, needs legal advice.
- Judging criteria and track rules for HackMeridian: NOT VERIFIED (the event lists Genesis and Scale tracks; check hackmeridian.com).
- SDF test anchor: reported up on 22 Oct 2026 by a team check (serves SEP-10, SEP-24, SEP-31 and SEP-38 with test USDC and SRT; issuer GBBD47...). Re-check on Sunday morning before relying on it.
- Real all-in costs per corridor and any partner quotes or rate locks: NOT VERIFIED.
- Domestic bank fees outside the Philippines, and local rules in Latin America: NOT VERIFIED.
- EU rules (MiCA) for sending from Europe with stablecoins: NOT VERIFIED.
- Onboarding requirements of bank, e-wallet and off-ramp partners: NOT VERIFIED.
- South Africa: draft rules, not law, being rewritten.
- Competitive claims from vendor blogs are indicative only.
- Contracts are not yet compiled or audited. Nothing here is legal or financial advice.

## 15. Decisions to confirm

1. Latin American demo country: Brazil or Mexico.
2. Larger-invoice tier: built feature (quote lock, approval, cap) or labelled profile only.
3. Hero customer in the demo: data-annotation platform or freelancer marketplace.
4. Percentage fee to show in the demo (placeholder until quotes).
5. Default quote validity window and who bears price movement per profile.
6. Operating model: orchestrator only, or pursue authorisation later (legal advice).

## 16. Revision notes (v2)

Changed from v1: "payment provider" became "payment orchestration platform"; the vault statement was split into crypto flows and fiat flows; "no set-up" became "without requiring a FlexiPay account where the rail or provider permits it"; "wallet" is now four distinct endpoint types; "cheapest rail" became "best eligible route". Added: quote, FX and price-risk rules, and the per-leg lifecycle with failure paths.

## 17. Revision notes (v3)

Passkey smart wallet added as a self-custody wallet option and built at the event; Stellar anchors listed as payout providers, with bank cash-out through the test anchor built at the event; fee sponsorship as a stretch; tips moved to a stretch goal shown in the pitch; demo story updated. Entry wording later corrected: Scale standalone; thematic tracks Genesis-only.

## 18. Revision notes (v4)

Section 12 rewritten: the hackathon MVP is reduced to outgoing payouts over four corridors (CCR-5, 23 Oct 2026), with a table of what is built and what is shown in the pitch only; baseline recipient wallet is a labelled custodial testnet wallet. Sections 1 to 11 keep the product vision. Header and section 4 note which part is built.
