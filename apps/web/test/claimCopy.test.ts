import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { describe, expect, it } from "vitest"
import {
	claimStatusLabel,
	claimStatusTone,
	closedClaimMessage,
	closedClaimTitle,
	closedClaimTone,
	detailLabel,
	detailPlaceholder,
	formatAmount,
	isCrypto,
	notReadyMessage,
	optionCopy,
	paymentStatusLabel,
	paymentStatusTone,
	supportsClaimAccept,
} from "../src/claim/claimCopy"
import { CLAIM_EXPIRED_ASK_SENDER } from "../src/claim/expiry"

const claim = (overrides: Partial<ClaimView> = {}): ClaimView =>
	({
		paymentId: "pay_1",
		status: "accepted",
		paymentStatus: "processing",
		expiresAt: "2026-11-10T12:00:00.000Z",
		amount: { amount: "250000000", currency: "USDC" },
		corridor: {
			from: { country: "US", currency: "USD" },
			to: { country: "PH", currency: "PHP" },
		},
		allowedDestinationTypes: ["crypto_wallet"],
		simulated: true,
		...overrides,
	}) as ClaimView

describe("claim copy helpers", () => {
	it("uses the app-wide plain status words", () => {
		expect(paymentStatusLabel("processing")).toBe("On its way")
		expect(paymentStatusLabel("funded")).toBe("Paid in")
		expect(paymentStatusLabel("paid")).toBe("Delivered")
		expect(paymentStatusLabel("awaiting_funding")).toBe("Waiting for payment")
		expect(paymentStatusLabel("refunded")).toBe("Money returned")
		expect(paymentStatusLabel("mystery")).toBe("mystery")
		expect(claimStatusLabel("accepted")).toBe("accepted")
		expect(claimStatusLabel("expired")).toBe("expired")
		expect(claimStatusLabel("open")).toBe("open")
	})

	it("maps tones for claim and payment badges", () => {
		expect(claimStatusTone("accepted")).toBe("success")
		expect(claimStatusTone("expired")).toBe("danger")
		expect(claimStatusTone("open")).toBe("warning")
		expect(paymentStatusTone("paid")).toBe("success")
		expect(paymentStatusTone("failed")).toBe("danger")
		expect(paymentStatusTone("refunded")).toBe("muted")
		expect(paymentStatusTone("processing")).toBe("warning")
		expect(paymentStatusTone("quoted")).toBe("neutral")
	})

	it("describes each receive option in plain words", () => {
		expect(optionCopy("bank_account").title).toBe("Bank account")
		expect(optionCopy("ewallet").icon).toBe("phone")
		expect(optionCopy("crypto_wallet").title).toBe("Crypto wallet")
		expect(optionCopy("crypto_custodial").title).toBe("Custodial wallet")
		expect(isCrypto("crypto_custodial")).toBe(true)
		expect(isCrypto("bank_account")).toBe(false)
		expect(supportsClaimAccept("ewallet")).toBe(true)
		expect(supportsClaimAccept("")).toBe(false)
	})

	it("labels the detail field per type and network", () => {
		expect(detailLabel("crypto_wallet", "stellar")).toBe(
			"Stellar testnet wallet address",
		)
		expect(detailLabel("crypto_wallet", "solana")).toMatch(/Solana/)
		expect(detailLabel("ewallet", "stellar")).toBe("E-wallet number")
		expect(detailLabel("bank_account", "stellar")).toBe("Bank account number")
		expect(detailPlaceholder("crypto_wallet", "stellar")).toBe("G…")
		expect(detailPlaceholder("crypto_wallet", "solana")).toMatch(/Base58/)
		expect(detailPlaceholder("bank_account", "solana")).toBe("Account details")
	})

	it("formats non-pound and pound amounts", () => {
		expect(formatAmount("250000000", "USDC")).toEqual({
			value: "25.00",
			currency: "USDC",
		})
		expect(formatAmount("1200000", "PHP")).toEqual({
			value: "12,000.00",
			currency: "PHP",
		})
		expect(formatAmount("42", "XYZ")).toEqual({ value: "42", currency: "XYZ" })
		expect(formatAmount("99009900", "TGBP")).toEqual({
			value: "£9.90",
			currency: null,
		})
	})

	it("gives a friendly title and message for every closed state", () => {
		const expired = claim({ status: "expired", paymentStatus: "expired" })
		expect(closedClaimTitle(expired)).toBe("This link has expired")
		expect(closedClaimMessage(expired)).toBe(CLAIM_EXPIRED_ASK_SENDER)
		expect(closedClaimTone(expired)).toBe("warning")

		const paid = claim({ paymentStatus: "paid" })
		expect(closedClaimTitle(paid)).toBe("Money delivered")
		expect(closedClaimMessage(paid)).toMatch(/^Paid\. We have confirmed/)
		expect(closedClaimTone(paid)).toBe("info")

		const solanaPaid = claim({
			paymentStatus: "paid",
			releaseEvidence: { network: "solana", signature: "sig" },
		} as Partial<ClaimView>)
		expect(closedClaimMessage(solanaPaid)).toMatch(/Solana transfer on-chain/)

		const failed = claim({ paymentStatus: "failed" })
		expect(closedClaimTitle(failed)).toMatch(/didn't go through/)
		expect(closedClaimMessage(failed)).toMatch(/nothing was marked as paid/)

		const refunded = claim({ paymentStatus: "refunded" })
		expect(closedClaimTitle(refunded)).toBe("This payment was stopped")
		expect(closedClaimMessage(refunded)).toMatch(/Money returned/)

		const waiting = claim()
		expect(closedClaimTitle(waiting)).toBe("You're all set")
		expect(closedClaimMessage(waiting)).toMatch(/updates by itself/)
	})

	it("explains why an open claim cannot be accepted yet", () => {
		expect(notReadyMessage(claim({ paymentStatus: "quoted" }))).toMatch(
			/hasn't paid this in yet/,
		)
		expect(notReadyMessage(claim({ paymentStatus: "funded" }))).toMatch(
			/not ready to accept yet/,
		)
		expect(notReadyMessage(claim({ paymentStatus: "cancelled" }))).toMatch(
			/Cancelled/,
		)
	})
})
