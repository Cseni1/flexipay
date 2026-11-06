# Payout coverage (6 November 2026)

Which countries each partner can pay out to. Only partner-confirmed facts, with the source.
A corridor is "live" only after an end-to-end test passes (see ARCHITECTURE.md). This file is
coverage on paper, not a promise.

## Tazapay (sandbox API, tested 6 Nov 2026)
Source: GET /v3/metadata/payout/bank?country=XX on service-sandbox.tazapay.com, one call per
country, 187 countries queried. Result files are not committed.

- Local bank rails (71): AD AE AR AT AU BD BE BF BG BJ BR CA CH CL CM CN CR CY CZ DE DK DZ EE ES FI FR GB GH GR HK HR HU ID IE IN IS IT KE KR LI LK LT LU LV MA MT MX MY NG NL NO NP PE PH PK PL PT RO SE SG SI SK SN TG TH TR UG US UY VN ZA
- SWIFT only (90): AG AM AO AZ BB BH BN BO BS BT BW BZ CD CG CI CO CV DJ DM DO EC EG ER ET FJ GA GD GE GM GN GQ GT GW GY HN IL JM JO JP KG KH KM KW KZ LA LC LR LS MD MG MN MO MR MU MV MW MZ NA NE NI NZ OM PA PG PY QA RW SA SB SC SL SR ST SV SZ TD TJ TL TM TN TO TT TW TZ UZ VC VU WS ZM ZW
- No payout method (26): AF AL BA BI BY CF CU HT IQ IR LB LY ME MK ML MM PS RS RU SD SO SS SY UA VE YE

## BlindPay (docs, not tested)
Source: blindpay.com/docs/kb/supported-countries, read 6 Nov 2026. Every country is supported
except the Prohibited tier: AF BY CF CG CD CU GN IR IQ KP LY ML MM NG PS QA RU SO SS SD UA VE YE. Rails named in its docs: ACH, wire, RTP (US),
Pix (Brazil), SPEI (Mexico), ACH via Bitso (Colombia), Transfers via Bitso (Argentina), SEPA, SWIFT.
Confirm a country's tier with support@blindpay.com before launching there.

## Zynta (sandbox API, partly tested 6 Nov 2026)
Quote tested and working: USDC on Base to NGN and KES. Solana and tGBP are refused (Zynta says
Solana is coming). Listed in docs, not tested: GHS, ZAR, UGX, TZS, USD, EUR, GBP (FPS), BRL, TRY.

## Gaps
- Countries Tazapay cannot pay but BlindPay lists as supported (9): AL BA BI HT LB ME MK RS SY.
  Only a single claim from docs, not tested.
- Countries neither partner supports (17): AF BY CF CU IQ IR LY ML MM PS RU SD SO SS UA VE YE. Mostly sanctioned or
  high-risk; no partner will pay these.
- SWIFT-only countries have an option, but it is slower and costs more than a local rail. Africa,
  the Gulf, Central Asia and most of Latin America outside Brazil, Mexico, Argentina, Chile, Peru,
  Uruguay, Costa Rica and Colombia (BlindPay) are mostly SWIFT-only.
