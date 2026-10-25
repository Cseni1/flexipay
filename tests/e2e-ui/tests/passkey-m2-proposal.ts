// PASSKEY-M2-PROPOSAL-UNACCEPTED
//
// The M2 passkey interface below is a PROPOSAL from the task brief, not an accepted shared
// contract. It lives only in this browser-test fixture and is intentionally absent from
// apps/web and packages/web-lib: there is no client, no DTO and no request in the app until an
// accepted schema exists (docs/CONTRACT_CHANGES.md would carry the accepted version).
//
// Three proposed routes, all public claim routes without a Bearer token:
//
//   POST /v1/claims/{token}/passkey/deploy   (Idempotency-Key required)
//     body: { contractId, keyIdBase64, signedTx }
//     res:  { contractId, deployTxHash, creationLedger, status: "deployed" }
//
//   POST /v1/claims/{token}/passkey/prepare
//     body: { contractId }
//     res:  { prepareId, payoutId, networkPassphrase, signatureExpirationLedger, authEntries }
//
//   POST /v1/claims/{token}/passkey/submit  (Idempotency-Key required)
//     body: { prepareId, contractId, signedAuthEntries }
//     res:  { claim, paymentId, paymentStatus, releaseTxHash }
//
// `signedTx` and the auth-entry fields are base64 XDR. Those fields can carry the claim secret,
// so they must never reach a console, browser storage, analytics or an evidence snapshot. The
// marker below is used by the tests to prove that.

import type { ClaimView } from "../../../packages/web-lib/claim-contract.ts"

/** Marker that must never appear in a log, in browser storage or in the app bundle. */
export const SENSITIVE_MARKER = "PASSKEY-M2-PROPOSAL-UNACCEPTED"

/** Stand-in for a base64 XDR blob; never a real signature and never sent anywhere. */
export const fakeSignedXdr = (label: string): string =>
	`${label}-${SENSITIVE_MARKER}-AAAA`

export interface PasskeyDeployRequestProposal {
	contractId: string
	keyIdBase64: string
	signedTx: string
}

export interface PasskeyDeployResponseProposal {
	contractId: string
	deployTxHash: string
	creationLedger: number
	status: "deployed"
}

export interface PasskeyPrepareRequestProposal {
	contractId: string
}

export interface PasskeyPrepareResponseProposal {
	prepareId: string
	payoutId: string
	networkPassphrase: string
	signatureExpirationLedger: number
	authEntries: string[]
}

export interface PasskeySubmitRequestProposal {
	prepareId: string
	contractId: string
	signedAuthEntries: string[]
}

export interface PasskeySubmitResponseProposal {
	claim: ClaimView
	paymentId: string
	paymentStatus: string
	releaseTxHash: string
}

/** Proposed route paths. Nothing in apps/web or packages/web-lib may contain these. */
export const PROPOSED_PASSKEY_ROUTES = [
	"/v1/claims/{token}/passkey/deploy",
	"/v1/claims/{token}/passkey/prepare",
	"/v1/claims/{token}/passkey/submit",
] as const

export const fakeContractId =
	"CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000"

export const deployRequestProposal = (
	overrides: Partial<PasskeyDeployRequestProposal> = {},
): PasskeyDeployRequestProposal => ({
	contractId: fakeContractId,
	keyIdBase64: `key-${SENSITIVE_MARKER}`,
	signedTx: fakeSignedXdr("signedTx"),
	...overrides,
})

export const prepareResponseProposal = (
	overrides: Partial<PasskeyPrepareResponseProposal> = {},
): PasskeyPrepareResponseProposal => ({
	prepareId: "prep_fixture_1",
	payoutId: "payout_fixture_1",
	networkPassphrase: "Test SDF Network ; September 2015",
	signatureExpirationLedger: 1_000_002,
	authEntries: [fakeSignedXdr("authEntry")],
	...overrides,
})

export const submitRequestProposal = (
	overrides: Partial<PasskeySubmitRequestProposal> = {},
): PasskeySubmitRequestProposal => ({
	prepareId: "prep_fixture_1",
	contractId: fakeContractId,
	signedAuthEntries: [fakeSignedXdr("signedAuthEntry")],
	...overrides,
})

export const claimViewProposal = (overrides: Record<string, unknown> = {}) => ({
	paymentId: "pay_claim_1",
	status: "accepted",
	paymentStatus: "paid",
	expiresAt: new Date(Date.now() + 120_000).toISOString(),
	amount: { amount: "250000000", currency: "USDC" },
	corridor: {
		from: { country: "US", currency: "USD" },
		to: { country: "PH", currency: "PHP" },
	},
	allowedDestinationTypes: ["crypto_wallet"],
	simulated: true,
	...overrides,
})
