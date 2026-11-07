import assert from "node:assert/strict"
import { type Event, type Leg, type Quote } from "@flexipay/web-lib/contract"
import { afterEach, describe, test, vi } from "vitest"
import { type EndpointSummary } from "../src/api/client.ts"
import {
	computeAggregatorSaving,
	sumSavingsByCurrency,
} from "../src/payments/aggregatorSaving.ts"
import {
	bankDetailLabel,
	bankDetailsPayload,
	bankEndpointLabel,
	EMPTY_BANK_DETAILS,
	friendlyPayoutLegError,
} from "../src/payments/bankDetails.ts"
import {
	formatLocalClock,
	formatLocalDateTime,
	formatUtcTitle,
} from "../src/payments/formatPaymentTime.ts"
import {
	findEventTime,
	legEventTime,
	paymentMilestoneTimes,
} from "../src/payments/paymentEventTimes.ts"
import {
	formatDestinationLabel,
	maskAccount,
	onchainDestinationFromEvents,
	payerFromEvents,
} from "../src/payments/paymentParties.ts"
import { isWaitingOnLeg, shouldPollPayment } from "../src/payments/pollRules.ts"
import { providerBadge, providerLabel } from "../src/payments/providerNames.ts"
import {
	displayFeesTotal,
	displayMoney,
	formatQuoteReason,
	isPoundDisplayCurrency,
	toPoundPence,
} from "../src/payments/quoteDisplay.ts"
import {
	linkPaymentSaving,
	lookupStoredSaving,
	rememberQuoteSaving,
	rememberSavingFromQuote,
} from "../src/payments/quoteSavingStore.ts"
import {
	clearSolanaTransfer,
	loadSolanaTransfer,
	saveSolanaTransfer,
} from "../src/payments/solanaTransferStorage.ts"
import {
	isValidMerchantWallet,
	normalizeTillLabel,
	parseTillAmountPounds,
	TILL_LABEL_MAX,
} from "../src/payments/tillAmount.ts"
import {
	clearTillMerchant,
	loadTillMerchant,
	saveTillMerchant,
} from "../src/payments/tillMerchantStorage.ts"
import { buildWhyThisRoute } from "../src/payments/whyThisRoute.ts"

const memoryStorage = () => {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value)
		},
		removeItem: (key: string) => {
			data.delete(key)
		},
		data,
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
})

const plannedLeg = (
	kind: "collect" | "convert" | "settle" | "payout",
	providerId: string,
	amount: string,
	currency: string,
	simulated = true,
) => ({
	kind,
	rail: providerId,
	providerId,
	amountIn: { amount, currency },
	amountOut: { amount, currency },
	simulated,
})

const alt = (...route: ReturnType<typeof plannedLeg>[]) => ({
	route,
	totalCost: { amount: "0", currency: "USD" },
	estimatedTimeSeconds: 0,
	reasons: [],
})

describe("quoteSavingStore (session storage)", () => {
	test("is a no-op without sessionStorage", () => {
		vi.stubGlobal("sessionStorage", undefined)
		rememberQuoteSaving("q", {
			amount: "1",
			currency: "GBP",
			nextBestLabel: "x",
		})
		linkPaymentSaving("p", "q")
		assert.equal(lookupStoredSaving({ quoteId: "q" }), null)
	})

	test("remembers by quote, links payments and looks up by either key", () => {
		const storage = memoryStorage()
		vi.stubGlobal("sessionStorage", storage)
		rememberQuoteSaving("q1", null)
		assert.equal(storage.data.size, 0)

		rememberQuoteSaving("q1", {
			amount: "125",
			currency: "PHP",
			nextBestLabel: "BlindPay",
		})
		linkPaymentSaving("pay1", "q1")
		assert.equal(lookupStoredSaving({ quoteId: "q1" })?.amount, "125")
		assert.equal(
			lookupStoredSaving({ paymentId: "pay1" })?.nextBestLabel,
			"BlindPay",
		)
		assert.equal(lookupStoredSaving({ paymentId: "nope" }), null)
		assert.equal(lookupStoredSaving({}), null)
		assert.equal(lookupStoredSaving({ quoteId: "q-missing" }), null)
	})

	test("rememberSavingFromQuote computes and stores the saving", () => {
		vi.stubGlobal("sessionStorage", memoryStorage())
		const saving = rememberSavingFromQuote({
			id: "q2",
			expectedReceive: { amount: "1000", currency: "PHP" },
			alternatives: [
				alt(plannedLeg("payout", "tazapay_sandbox", "900", "PHP")),
			],
		} as unknown as Quote)
		assert.deepEqual(saving, {
			amount: "100",
			currency: "PHP",
			nextBestLabel: "Tazapay",
		})
		assert.deepEqual(lookupStoredSaving({ quoteId: "q2" }), saving)
	})

	test("survives corrupt JSON, wrong shapes and a throwing setItem", () => {
		const storage = memoryStorage()
		vi.stubGlobal("sessionStorage", storage)
		storage.setItem("flexipay.aggregatorSavings.v1", "{not json")
		assert.equal(lookupStoredSaving({ quoteId: "q" }), null)
		storage.setItem(
			"flexipay.aggregatorSavings.v1",
			JSON.stringify({ byQuoteId: "x", paymentToQuote: null }),
		)
		assert.equal(lookupStoredSaving({ paymentId: "p" }), null)
		rememberQuoteSaving("q", {
			amount: "1",
			currency: "GBP",
			nextBestLabel: "",
		})
		assert.equal(lookupStoredSaving({ quoteId: "q" })?.amount, "1")

		vi.stubGlobal("sessionStorage", {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota")
			},
		})
		assert.doesNotThrow(() =>
			rememberQuoteSaving("q", {
				amount: "1",
				currency: "GBP",
				nextBestLabel: "",
			}),
		)
	})
})

describe("formatPaymentTime", () => {
	test("formats a valid ISO time in local and UTC forms", () => {
		const iso = "2026-11-05T13:50:52.000Z"
		const date = new Date(iso)
		const pad = (n: number) => String(n).padStart(2, "0")
		const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		assert.equal(formatLocalClock(iso), clock)
		assert.ok(
			formatLocalDateTime(iso).endsWith(`${date.getFullYear()}, ${clock}`),
		)
		assert.ok(formatLocalDateTime(iso).startsWith(`${date.getDate()} `))
		assert.equal(formatUtcTitle(iso), "5 Nov 2026, 13:50:52 UTC")
		assert.equal(
			formatUtcTitle("2026-01-09T04:05:06Z"),
			"9 Jan 2026, 04:05:06 UTC",
		)
	})

	test("invalid input gets placeholders", () => {
		assert.equal(formatLocalDateTime("nope"), "-")
		assert.equal(formatUtcTitle("nope"), "")
		assert.equal(formatLocalClock("nope"), "--:--:--")
	})
})

describe("aggregatorSaving edge cases", () => {
	test("picks the best alternative and labels it by its payout leg", () => {
		const saving = computeAggregatorSaving({
			expectedReceive: { amount: "1000", currency: "PHP" },
			alternatives: [
				alt(plannedLeg("payout", "sim_bank_ph", "800", "PHP")),
				alt(
					plannedLeg("payout", "blindpay_sandbox", "950", "PHP"),
					// A trailing non-payout leg still provides the receive amount.
					plannedLeg("convert", "sim_fx", "950", "PHP"),
				),
				alt(plannedLeg("payout", "tazapay_sandbox", "900", "PHP")),
			],
		} as unknown as Quote)
		assert.deepEqual(saving, {
			amount: "50",
			currency: "PHP",
			nextBestLabel: "BlindPay",
		})
	})

	test("falls back to the last leg's provider (or rail) when there is no payout leg", () => {
		const leg = {
			...plannedLeg("settle", "", "900", "PHP"),
			rail: "solana_tgbp",
		}
		const saving = computeAggregatorSaving({
			expectedReceive: { amount: "1000", currency: "PHP" },
			alternatives: [alt(leg)],
		} as unknown as Quote)
		assert.equal(saving?.nextBestLabel, "Solana tGBP")
	})

	test("ignores non-integer amounts and empty routes", () => {
		assert.equal(
			computeAggregatorSaving({
				expectedReceive: { amount: "10.5", currency: "PHP" },
				alternatives: [alt(plannedLeg("payout", "x", "1", "PHP"))],
			} as unknown as Quote),
			null,
		)
		assert.equal(
			computeAggregatorSaving({
				expectedReceive: { amount: "10", currency: "PHP" },
				alternatives: [
					alt(plannedLeg("payout", "x", "1e3", "PHP")),
					{ ...alt(), route: [] },
				],
			} as unknown as Quote),
			null,
		)
		// A better alternative means no saving to show.
		assert.equal(
			computeAggregatorSaving({
				expectedReceive: { amount: "10", currency: "PHP" },
				alternatives: [alt(plannedLeg("payout", "x", "11", "PHP"))],
			} as unknown as Quote),
			null,
		)
	})

	test("sumSavingsByCurrency skips malformed amounts", () => {
		assert.deepEqual(
			sumSavingsByCurrency([
				{ amount: "x", currency: "GBP", nextBestLabel: "" },
				{ amount: "5", currency: "GBP", nextBestLabel: "" },
			]),
			[{ amount: "5", currency: "GBP", nextBestLabel: "" }],
		)
		assert.deepEqual(sumSavingsByCurrency([]), [])
	})
})

describe("quoteDisplay edge cases", () => {
	test("pound currencies and pence rounding", () => {
		assert.equal(isPoundDisplayCurrency("GBP"), true)
		assert.equal(isPoundDisplayCurrency("TGBP"), true)
		assert.equal(isPoundDisplayCurrency("USD"), false)
		assert.equal(toPoundPence("x", "GBP"), null)
		assert.equal(toPoundPence("100", "USD"), null)
		// Half-up: 49_999 → 0p, 50_000 → 1p at 7dp.
		assert.equal(toPoundPence("49999", "TGBP"), 0n)
		assert.equal(toPoundPence("50000", "TGBP"), 1n)
	})

	test("fees total falls back to the API total for non-pound legs or no legs", () => {
		const total = { amount: "4000", currency: "USD" }
		assert.equal(
			displayFeesTotal({
				legs: [
					{
						kind: "collect",
						rail: "x",
						fee: { amount: "100", currency: "USD" },
					},
				],
				flexiPayFee: total,
				total,
				settleUnlockedRemainder: null,
			} as Quote["fees"]),
			displayMoney("4000", "USD"),
		)
		assert.equal(
			displayFeesTotal({
				legs: [],
				flexiPayFee: total,
				total,
				settleUnlockedRemainder: null,
			} as Quote["fees"]),
			displayMoney("4000", "USD"),
		)
	})

	test("rewrites GBP and USDC amounts in reasons", () => {
		assert.equal(formatQuoteReason("fee 150 GBP"), "fee £1.50")
		assert.match(formatQuoteReason("min 10000000 USDC here"), /^min 1 here$/)
		assert.equal(formatQuoteReason("no amounts"), "no amounts")
	})
})

describe("bankDetails edge cases", () => {
	test("labels every key and builds a trimmed payload", () => {
		assert.equal(bankDetailLabel("swiftCode"), "SWIFT/BIC")
		assert.equal(bankDetailLabel("branchCode"), "Branch code")
		assert.deepEqual(
			bankDetailsPayload({
				...EMPTY_BANK_DETAILS,
				accountNumber: " 123 ",
				iban: " GB00 ",
				branchCode: "  ",
			}),
			{ accountNumber: "123", iban: "GB00" },
		)
	})

	test("endpoint labels with masked or missing bank names and accounts", () => {
		assert.equal(bankEndpointLabel({}), "Bank ••????")
		assert.equal(
			bankEndpointLabel({ bankName: "****", accountNumber: "1" }),
			"Bank ••1",
		)
		assert.equal(
			bankEndpointLabel({ bankName: "B**O", accountNumber: "••••3210" }),
			"BO ••3210",
		)
	})

	test("friendlyPayoutLegError matches whole keys only", () => {
		assert.equal(friendlyPayoutLegError("nothing missing"), null)
		assert.equal(friendlyPayoutLegError("swiftCodes are odd"), null)
		assert.equal(
			friendlyPayoutLegError("missing: iban, bankCode"),
			"The bank needs: IBAN, Bank code",
		)
	})
})

const event = (
	type: string,
	snapshot: Record<string, unknown>,
	createdAt = "t",
): Event => ({ id: type, type, createdAt, paymentId: "p", snapshot }) as Event

describe("paymentParties edge cases", () => {
	test("skips non-onchain and blank snapshot values", () => {
		const events = [
			event("payment.created", { payer: "X", destination: "Y" }),
			event("payment.onchain", { payer: "  ", destination: 3 }),
			event("payment.onchain", { payer: " Payer ", destination: " Dest " }),
		]
		assert.equal(payerFromEvents(events), "Payer")
		assert.equal(onchainDestinationFromEvents(events), "Dest")
		assert.equal(payerFromEvents([]), null)
		assert.equal(onchainDestinationFromEvents([events[0] as Event]), null)
	})

	const ep = (type: string, details: Record<string, string>) =>
		({ type, details }) as unknown as EndpointSummary

	test("destination label per endpoint type with fallbacks", () => {
		assert.equal(maskAccount(" 123 "), "123")
		assert.equal(
			formatDestinationLabel(ep("ewallet", { phoneNumber: "+639171234567" })),
			"E-wallet ••••4567",
		)
		assert.equal(
			formatDestinationLabel(
				ep("crypto_custodial", {
					address: "So1111111111111111111111111111111111111112",
				}),
			),
			"So11…1112",
		)
		assert.equal(
			formatDestinationLabel(ep("bank_account", {}), "DestAddressLong1234"),
			"Dest…1234",
		)
		assert.equal(formatDestinationLabel(ep("ewallet", {})), "—")
		assert.equal(formatDestinationLabel(null), "—")
		assert.equal(formatDestinationLabel(undefined, "short"), "short")
	})
})

describe("paymentEventTimes edge cases", () => {
	const leg = (id: string, kind: string) => ({ id, kind }) as unknown as Leg

	test("settle legs prefer their own payment.onchain, else their leg event", () => {
		const events = [
			event("payment.onchain", { legId: "other" }, "t0"),
			event("leg.failed", { legId: "settle1" }, "t1"),
			event("payment.onchain", { legId: "settle1" }, "t2"),
			event("leg.succeeded", { legId: "payout1" }, "t3"),
			event("leg.succeeded", { legId: "" }, "t4"),
		]
		assert.equal(legEventTime(events, leg("settle1", "settle")), "t2")
		assert.equal(
			legEventTime(events.slice(0, 2), leg("settle1", "settle")),
			"t1",
		)
		assert.equal(legEventTime(events, leg("payout1", "payout")), "t3")
		assert.equal(legEventTime(events, leg("nope", "collect")), null)
	})

	test("milestones and missing events", () => {
		const events = [
			event("payment.created", {}, "c"),
			event("payment.paid", {}, "p"),
		]
		assert.deepEqual(paymentMilestoneTimes(events), {
			created: "c",
			funded: null,
			paid: "p",
		})
		assert.equal(findEventTime([], "payment.created"), null)
	})
})

describe("pollRules / providerNames / whyThisRoute / tillAmount", () => {
	test("poll rules", () => {
		assert.equal(shouldPollPayment({ status: "created" } as never), false)
		assert.equal(
			isWaitingOnLeg({ status: "processing", legs: [] } as never),
			false,
		)
	})

	test("provider ids that clean to nothing keep the raw id", () => {
		assert.equal(providerLabel("sim_"), "sim_")
		assert.equal(providerLabel("___"), "___")
		assert.equal(providerLabel("sim_bank_ph_instapay"), "Bank Ph Instapay")
		assert.equal(providerBadge(false), "Sandbox")
		assert.equal(providerBadge(true), "Simulated")
		assert.equal(providerBadge(false, "sim_fx"), "Simulated")
	})

	test("why-this-route dedupes alternatives and skips missing leg kinds", () => {
		const quote = {
			route: [
				plannedLeg("collect", "sim_bank_gb", "1000", "GBP"),
				plannedLeg("payout", "tazapay_sandbox", "70000", "PHP", false),
			],
			alternatives: [
				alt(plannedLeg("payout", "tazapay_sandbox", "69000", "PHP")),
				alt(plannedLeg("payout", "blindpay_sandbox", "68000", "PHP")),
				alt(plannedLeg("payout", "blindpay_sandbox", "67000", "PHP")),
			],
		} as unknown as Quote
		const lines = buildWhyThisRoute(quote)
		assert.equal(lines.length, 2)
		assert.equal(lines[0]?.kindLabel, "Collect")
		assert.deepEqual(lines[0]?.others, [])
		assert.equal(lines[0]?.sentence, "Collect: Bank Gb delivers £10.00")
		assert.equal(lines[1]?.chosenBadge, "Sandbox")
		assert.deepEqual(
			lines[1]?.others.map((o) => o.provider),
			["BlindPay"],
		)
		assert.match(lines[1]?.sentence ?? "", /\(others: BlindPay 680\.00 PHP\)$/)
	})

	test("till amount bounds, wallets and labels", () => {
		assert.equal(parseTillAmountPounds(""), null)
		assert.equal(parseTillAmountPounds("0.99"), null)
		assert.equal(parseTillAmountPounds("1"), "100")
		assert.equal(parseTillAmountPounds("10000"), "1000000")
		assert.equal(parseTillAmountPounds("10000.01"), null)
		assert.equal(
			isValidMerchantWallet("  So11111111111111111111111111111111111111112 "),
			true,
		)
		assert.equal(isValidMerchantWallet("0OIl"), false)
		assert.equal(normalizeTillLabel("   "), undefined)
		assert.equal(normalizeTillLabel(" Table 4 "), "Table 4")
		assert.equal(normalizeTillLabel("x".repeat(TILL_LABEL_MAX + 1)), null)
	})
})

describe("browser storage defaults", () => {
	test("till merchant and Solana transfer use localStorage when present", () => {
		vi.stubGlobal("localStorage", memoryStorage())
		saveTillMerchant({ wallet: "w", label: "l" })
		assert.deepEqual(loadTillMerchant(), { wallet: "w", label: "l" })
		clearTillMerchant()
		assert.equal(loadTillMerchant(), null)

		saveSolanaTransfer("p1", { signature: "s", sentAt: "t" })
		assert.deepEqual(loadSolanaTransfer("p1"), { signature: "s", sentAt: "t" })
		clearSolanaTransfer("p1")
		assert.equal(loadSolanaTransfer("p1"), null)
		// Empty payment ids never touch storage.
		saveSolanaTransfer("", { signature: "s", sentAt: "t" })
		assert.equal(loadSolanaTransfer(""), null)
		clearSolanaTransfer("")
	})

	test("no localStorage means no-ops", () => {
		vi.stubGlobal("localStorage", undefined)
		saveTillMerchant({ wallet: "w", label: "l" })
		assert.equal(loadTillMerchant(), null)
		clearTillMerchant()
		saveSolanaTransfer("p1", { signature: "s", sentAt: "t" })
		assert.equal(loadSolanaTransfer("p1"), null)
		clearSolanaTransfer("p1")
	})
})
