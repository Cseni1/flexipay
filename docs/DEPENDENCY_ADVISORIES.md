# Dependency advisories (npm audit)

Assessed 5 Nov 2026. `npm audit` reported 90 findings (49 high, 41 moderate). Re-run it before every release and update this note.

## Fixed (5 Nov)

`npm audit fix` (lockfile only, no code change): `axios` and `follow-redirects` (pulled in by `@stellar/stellar-sdk`, which the API uses) and `@stellar/stellar-sdk` itself. 90 findings became 87. API, domain, adapter and web tests pass.

## Remaining, and why they are not fixed now

| Finding | Where it lives | Why it stays for now |
| --- | --- | --- |
| About 40 high/moderate in `@crossmint/*`, `@dynamic-labs/*`, `@reown/*`, `@walletconnect/*`, `viem`, `uuid`, `decode-uri-component`, `query-string` | Browser only, inside the Crossmint wallet SDK (`@crossmint/client-sdk-react-ui` 4.13.3, already the newest release). npm's suggested "fix" is a downgrade to 1.3.13, which would remove the wallet. | No newer version exists. Risks are denial of service or memory use in a user's own browser, not our servers. Revisit when Crossmint publishes a release. |
| `zod` below 4.6.6 (high) | Private copies inside the Crossmint packages (3.22.4). The API uses zod 4.6.7, which is fixed. | Browser only, same reason. |
| `ws` 8.0.0 to 8.20.1 (high) | Private copies inside Dynamic and WalletConnect, browser only. The API's copies are outside the affected range. | Browser only. |
| `sharp` (high) | Image library pulled in by `@dynamic-labs/iconic`; not used by our code or at runtime on the server. | Needs a Dynamic release. |
| `bigint-buffer` (high, buffer overflow in `toBigIntLE`) | `@solana/spl-token` via `@solana/buffer-layout-utils`. No patched version exists. | We only decode token account data returned by our own RPC provider, not data supplied by users. Replace or avoid the decoding path when a fixed release appears. |
| `@solana/web3.js`, `jayson`, `stream-json` (moderate) | API and web, Solana client. The suggested fix is a major rewrite (web3.js 3). | Moderate; denial of service on crafted JSON from the RPC provider. Plan the web3.js 3 migration after Demo Day. |
| `eslint`, `typescript-eslint`, `minimatch`, `glob` (moderate) | Development tooling only; not in the shipped app. | No runtime exposure. |

## Decision rule

Production-reachable and fixable without a rewrite: fix now. Production-reachable with no patch: record here with the reason. Development-only: batch with the next tooling upgrade. Anything critical, or any high that user input can reach on the server, blocks a release.
