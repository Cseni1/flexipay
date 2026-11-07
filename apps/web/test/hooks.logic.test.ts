import assert from "node:assert/strict"
import { type Payment } from "@flexipay/web-lib/contract"
import { afterEach, beforeEach, describe, test, vi } from "vitest"
import type * as ClientModule from "../src/api/client.ts"
import { type EndpointSummary } from "../src/api/client.ts"
import { type AggregatorSaving } from "../src/payments/aggregatorSaving.ts"
import { flush, provideContext, renderHook } from "./helpers/fakeReact.ts"

vi.mock("react", () => import("./helpers/fakeReact.ts"))

const listPayments = vi.fn<(signal?: AbortSignal) => Promise<unknown>>()
const getQuote = vi.fn<(id: string) => Promise<unknown>>()
const listRecipients = vi.fn<(signal?: AbortSignal) => Promise<unknown>>()
const listEndpoints = vi.fn<(opts?: unknown) => Promise<unknown>>()

vi.mock("../src/api/client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ClientModule>()),
	listPayments: (signal?: AbortSignal) => listPayments(signal),
	getQuote: (id: string) => getQuote(id),
	listRecipients: (signal?: AbortSignal) => listRecipients(signal),
	listEndpoints: (opts?: unknown) => listEndpoints(opts),
}))

const { ApiError } = await import("../src/api/client.ts")
const { rememberQuoteSaving, linkPaymentSaving, lookupStoredSaving } =
	await import("../src/payments/quoteSavingStore.ts")

// Hooks use DOM globals (window, document) and the provider is JSX; the Node tsconfig that
// `tsc -b` applies to test/ has neither, so these load untyped with the shapes stated here.
const load = <T>(path: string): Promise<T> =>
	import(/* @vite-ignore */ path) as Promise<T>

type ApiErrorT = InstanceType<typeof ApiError>

const { usePaymentList } = await load<{
	usePaymentList: () => {
		payments: Payment[]
		error: ApiErrorT | null
		loading: boolean
		refresh: () => void
	}
}>("../src/hooks/usePaymentList.ts")
const { usePaymentSaving } = await load<{
	usePaymentSaving: (
		payment: { id: string; quoteId: string } | null,
	) => AggregatorSaving | null
}>("../src/hooks/usePaymentSaving.ts")
const { useRecipientDirectory, recipientDisplayName, primaryEndpoint } =
	await load<{
		useRecipientDirectory: () => {
			names: ReadonlyMap<string, string>
			endpointsByRecipient: ReadonlyMap<string, EndpointSummary[]>
			loading: boolean
		}
		recipientDisplayName: (
			names: ReadonlyMap<string, string>,
			id: string,
		) => string
		primaryEndpoint: (
			byRecipient: ReadonlyMap<string, EndpointSummary[]>,
			id: string,
		) => EndpointSummary | null
	}>("../src/hooks/useRecipientDirectory.ts")
const { useTheme } = await load<{
	useTheme: () => { preference: string; cycle: () => void; label: string }
}>("../src/hooks/useTheme.ts")
const { useWakeUpRetry, WAKE_UP_RETRY_DELAYS_MS } = await load<{
	useWakeUpRetry: (opts: {
		error: ApiErrorT | null
		hasData: boolean
		onRetry: () => void
		enabled?: boolean
	}) => {
		waking: boolean
		exhausted: boolean
		attempt: number
		retryNow: () => void
	}
	WAKE_UP_RETRY_DELAYS_MS: number[]
}>("../src/hooks/useWakeUpRetry.ts")
const { useCountdown } = await load<{
	useCountdown: (validUntil: string | null) => {
		remainingMs: number
		expired: boolean
		label: string
	}
}>("../src/hooks/useCountdown.ts")
const { useNotification } = await load<{ useNotification: () => unknown }>(
	"../src/hooks/useNotification.ts",
)
const { NotificationContext } = await load<{ NotificationContext: unknown }>(
	"../src/providers/NotificationProvider.tsx",
)

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
		clear: () => data.clear(),
		key: () => null,
		length: 0,
		data,
	}
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal("window", globalThis)
	vi.stubGlobal("sessionStorage", memoryStorage())
	listPayments.mockReset()
	getQuote.mockReset()
	listRecipients.mockReset()
	listEndpoints.mockReset()
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("usePaymentList", () => {
	test("loads once when nothing is moving", async () => {
		listPayments.mockResolvedValue({
			payments: [{ id: "a", status: "paid" }],
		})
		const hook = renderHook(() => usePaymentList())
		assert.equal(hook.current.loading, true)
		await flush()
		assert.equal(hook.current.loading, false)
		assert.equal(hook.current.payments.length, 1)
		await vi.advanceTimersByTimeAsync(20_000)
		assert.equal(listPayments.mock.calls.length, 1)
	})

	test("polls every 4 s while a payment is moving", async () => {
		listPayments
			.mockResolvedValueOnce({ payments: [{ id: "a", status: "processing" }] })
			.mockResolvedValueOnce({ payments: [{ id: "a", status: "refunding" }] })
			.mockResolvedValue({ payments: [{ id: "a", status: "refunded" }] })
		const hook = renderHook(() => usePaymentList())
		await flush()
		await vi.advanceTimersByTimeAsync(4_000)
		await flush()
		assert.equal(listPayments.mock.calls.length, 2)
		await vi.advanceTimersByTimeAsync(4_000)
		await flush()
		assert.equal(listPayments.mock.calls.length, 3)
		assert.equal(hook.current.payments[0]?.status, "refunded")
		await vi.advanceTimersByTimeAsync(20_000)
		assert.equal(listPayments.mock.calls.length, 3)
	})

	test("maps errors and recovers on refresh", async () => {
		listPayments.mockRejectedValueOnce(new TypeError("offline"))
		const hook = renderHook(() => usePaymentList())
		await flush()
		assert.equal(hook.current.error?.code, "network_error")
		assert.equal(hook.current.loading, false)

		listPayments.mockRejectedValueOnce(new ApiError(401, "auth_required", "x"))
		hook.current.refresh()
		await flush()
		assert.equal(hook.current.error?.code, "auth_required")

		listPayments.mockResolvedValueOnce({ payments: [] })
		hook.current.refresh()
		await flush()
		assert.equal(hook.current.error, null)
	})

	test("unmount stops polling and ignores late answers", async () => {
		let resolve: (v: unknown) => void = () => undefined
		listPayments.mockImplementationOnce(
			() =>
				new Promise((res) => {
					resolve = res
				}),
		)
		const hook = renderHook(() => usePaymentList())
		hook.unmount()
		resolve({ payments: [{ id: "a", status: "processing" }] })
		await flush()
		assert.equal(hook.current.payments.length, 0)

		listPayments.mockReset()
		listPayments.mockResolvedValue({
			payments: [{ id: "b", status: "funded" }],
		})
		const second = renderHook(() => usePaymentList())
		await flush()
		second.unmount()
		await vi.advanceTimersByTimeAsync(10_000)
		assert.equal(listPayments.mock.calls.length, 1)
	})

	test("an error after unmount is swallowed", async () => {
		let reject: (e: unknown) => void = () => undefined
		listPayments.mockImplementationOnce(
			() =>
				new Promise((_res, rej) => {
					reject = rej
				}),
		)
		const hook = renderHook(() => usePaymentList())
		hook.unmount()
		reject(new Error("late"))
		await flush()
		assert.equal(hook.current.error, null)
	})
})

const quoteWithSaving = {
	id: "q_1",
	expectedReceive: { amount: "1000", currency: "PHP" },
	alternatives: [
		{
			route: [
				{
					kind: "payout",
					rail: "blindpay_sandbox",
					providerId: "blindpay_sandbox",
					amountIn: { amount: "1", currency: "USD" },
					amountOut: { amount: "900", currency: "PHP" },
					simulated: true,
				},
			],
		},
	],
}

describe("usePaymentSaving", () => {
	test("null payment yields no saving and no fetch", () => {
		const hook = renderHook(() => usePaymentSaving(null))
		assert.equal(hook.current, null)
		assert.equal(getQuote.mock.calls.length, 0)
	})

	test("starts from the session store, then prefers the live quote and stores it", async () => {
		rememberQuoteSaving("q_1", {
			amount: "50",
			currency: "PHP",
			nextBestLabel: "Old",
		})
		getQuote.mockResolvedValue(quoteWithSaving)
		const hook = renderHook(() =>
			usePaymentSaving({ id: "pay_1", quoteId: "q_1" }),
		)
		assert.equal(hook.current?.amount, "50")
		await flush()
		assert.deepEqual(hook.current, {
			amount: "100",
			currency: "PHP",
			nextBestLabel: "BlindPay",
		})
		assert.equal(lookupStoredSaving({ paymentId: "pay_1" })?.amount, "100")
	})

	test("live quote without a positive saving clears it", async () => {
		getQuote.mockResolvedValue({ ...quoteWithSaving, alternatives: [] })
		const hook = renderHook(() =>
			usePaymentSaving({ id: "pay_1", quoteId: "q_1" }),
		)
		await flush()
		assert.equal(hook.current, null)
	})

	test("falls back to the session saving when the quote is gone", async () => {
		rememberQuoteSaving("q_2", {
			amount: "7",
			currency: "GBP",
			nextBestLabel: "Tazapay",
		})
		linkPaymentSaving("pay_2", "q_2")
		getQuote.mockRejectedValue(new ApiError(404, "not_found", "gone"))
		const hook = renderHook(() =>
			usePaymentSaving({ id: "pay_2", quoteId: "q_2" }),
		)
		await flush()
		assert.equal(hook.current?.amount, "7")
	})

	test("ignores answers after unmount", async () => {
		let resolve: (v: unknown) => void = () => undefined
		getQuote.mockImplementation(
			() =>
				new Promise((res) => {
					resolve = res
				}),
		)
		const hook = renderHook(() =>
			usePaymentSaving({ id: "pay_3", quoteId: "q_3" }),
		)
		hook.unmount()
		resolve(quoteWithSaving)
		await flush()
		assert.equal(hook.current, null)
	})

	test("ignores a failure after unmount", async () => {
		let reject: (e: unknown) => void = () => undefined
		getQuote.mockImplementation(
			() =>
				new Promise((_res, rej) => {
					reject = rej
				}),
		)
		const hook = renderHook(() =>
			usePaymentSaving({ id: "pay_3", quoteId: "q_3" }),
		)
		hook.unmount()
		reject(new Error("late"))
		await flush()
		assert.equal(hook.current, null)
	})
})

const endpoint = (id: string, recipientId: string) => ({
	id,
	organizationId: "org",
	recipientId,
	type: "bank_account",
	country: "PH",
	currency: "PHP",
	network: null,
	details: {},
	simulated: true,
	createdAt: "2026-11-01T00:00:00.000Z",
})

describe("useRecipientDirectory", () => {
	test("builds name and endpoint maps", async () => {
		listRecipients.mockResolvedValue({
			recipients: [
				{ id: "r1", name: "Ana" },
				{ id: "r2", name: "  " },
			],
		})
		listEndpoints.mockResolvedValue({
			endpoints: [
				endpoint("e1", "r1"),
				endpoint("e2", "r1"),
				endpoint("e3", "r2"),
			],
		})
		const hook = renderHook(() => useRecipientDirectory())
		assert.equal(hook.current.loading, true)
		await flush()
		assert.equal(hook.current.loading, false)
		assert.equal(recipientDisplayName(hook.current.names, "r1"), "Ana")
		// Blank names and unknown ids fall back to the id.
		assert.equal(recipientDisplayName(hook.current.names, "r2"), "r2")
		assert.equal(recipientDisplayName(hook.current.names, "r9"), "r9")
		assert.equal(
			primaryEndpoint(hook.current.endpointsByRecipient, "r1")?.id,
			"e1",
		)
		assert.equal(hook.current.endpointsByRecipient.get("r1")?.length, 2)
		assert.equal(primaryEndpoint(hook.current.endpointsByRecipient, "r9"), null)
	})

	test("stays empty but stops loading when the API fails", async () => {
		listRecipients.mockRejectedValue(new Error("down"))
		listEndpoints.mockResolvedValue({ endpoints: [] })
		const hook = renderHook(() => useRecipientDirectory())
		await flush()
		assert.equal(hook.current.loading, false)
		assert.equal(hook.current.names.size, 0)
	})

	test("unmount aborts and keeps loading state frozen", async () => {
		let signal: AbortSignal | undefined
		let resolve: (v: unknown) => void = () => undefined
		listRecipients.mockImplementation((s) => {
			signal = s
			return new Promise((res) => {
				resolve = res
			})
		})
		listEndpoints.mockResolvedValue({ endpoints: [] })
		const hook = renderHook(() => useRecipientDirectory())
		hook.unmount()
		assert.equal(signal?.aborted, true)
		resolve({ recipients: [{ id: "r1", name: "Ana" }] })
		await flush()
		assert.equal(hook.current.loading, true)
		assert.equal(hook.current.names.size, 0)
	})

	test("an error after unmount is ignored", async () => {
		let reject: (e: unknown) => void = () => undefined
		listRecipients.mockImplementation(
			() =>
				new Promise((_res, rej) => {
					reject = rej
				}),
		)
		listEndpoints.mockResolvedValue({ endpoints: [] })
		const hook = renderHook(() => useRecipientDirectory())
		hook.unmount()
		reject(new Error("late"))
		await flush()
		assert.equal(hook.current.loading, true)
	})
})

describe("useTheme", () => {
	const fakeDocument = () => {
		const attrs = new Map<string, string>()
		return {
			documentElement: {
				setAttribute: (k: string, v: string) => attrs.set(k, v),
				removeAttribute: (k: string) => attrs.delete(k),
			},
			attrs,
		}
	}

	test("reads the stored preference, applies it and cycles system → light → dark", () => {
		const storage = memoryStorage()
		storage.setItem("fp.theme", "dark")
		const doc = fakeDocument()
		vi.stubGlobal("localStorage", storage)
		vi.stubGlobal("document", doc)
		const hook = renderHook(() => useTheme())
		assert.equal(hook.current.preference, "dark")
		assert.equal(hook.current.label, "Theme: dark")
		assert.equal(doc.attrs.get("data-theme"), "dark")

		hook.current.cycle()
		assert.equal(hook.current.preference, "system")
		assert.equal(hook.current.label, "Theme: system")
		assert.equal(doc.attrs.has("data-theme"), false)
		assert.equal(storage.getItem("fp.theme"), "system")

		hook.current.cycle()
		assert.equal(hook.current.label, "Theme: light")
		assert.equal(doc.attrs.get("data-theme"), "light")
		hook.current.cycle()
		assert.equal(hook.current.preference, "dark")
	})

	test("ignores junk and blocked storage", () => {
		const doc = fakeDocument()
		vi.stubGlobal("document", doc)
		const junk = memoryStorage()
		junk.setItem("fp.theme", "neon")
		vi.stubGlobal("localStorage", junk)
		assert.equal(renderHook(() => useTheme()).current.preference, "system")

		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("blocked")
			},
			setItem: () => {
				throw new Error("blocked")
			},
		})
		const hook = renderHook(() => useTheme())
		assert.equal(hook.current.preference, "system")
		hook.current.cycle()
		assert.equal(hook.current.preference, "light")
	})
})

describe("useWakeUpRetry", () => {
	test("does nothing for non-transient errors or when data is on screen", () => {
		const onRetry = vi.fn()
		const authError = new ApiError(401, "auth_required", "x")
		const hook = renderHook(() =>
			useWakeUpRetry({ error: authError, hasData: false, onRetry }),
		)
		assert.equal(hook.current.waking, false)
		vi.advanceTimersByTime(120_000)
		assert.equal(onRetry.mock.calls.length, 0)

		const withData = renderHook(() =>
			useWakeUpRetry({
				error: new ApiError(0, "network_error", "x"),
				hasData: true,
				onRetry,
			}),
		)
		assert.equal(withData.current.waking, false)

		const disabled = renderHook(() =>
			useWakeUpRetry({
				error: new ApiError(0, "network_error", "x"),
				hasData: false,
				onRetry,
				enabled: false,
			}),
		)
		assert.equal(disabled.current.waking, false)
	})

	test("retries on the backoff schedule, then reports exhausted; retryNow resets", () => {
		const onRetry = vi.fn()
		const error = new ApiError(0, "api_waking", "x")
		const hook = renderHook(() =>
			useWakeUpRetry({ error, hasData: false, onRetry }),
		)
		assert.equal(hook.current.waking, true)
		assert.equal(hook.current.exhausted, false)

		for (const [i, delay] of WAKE_UP_RETRY_DELAYS_MS.entries()) {
			vi.advanceTimersByTime(delay - 1)
			assert.equal(onRetry.mock.calls.length, i)
			vi.advanceTimersByTime(1)
			assert.equal(onRetry.mock.calls.length, i + 1)
		}
		assert.equal(hook.current.attempt, WAKE_UP_RETRY_DELAYS_MS.length)
		assert.equal(hook.current.exhausted, true)
		vi.advanceTimersByTime(120_000)
		assert.equal(onRetry.mock.calls.length, WAKE_UP_RETRY_DELAYS_MS.length)

		hook.current.retryNow()
		assert.equal(onRetry.mock.calls.length, WAKE_UP_RETRY_DELAYS_MS.length + 1)
		assert.equal(hook.current.attempt, 0)
		assert.equal(hook.current.exhausted, false)
	})

	test("attempt resets when the error clears", () => {
		const onRetry = vi.fn()
		let error: InstanceType<typeof ApiError> | null = new ApiError(
			503,
			"http_503",
			"x",
		)
		const hook = renderHook(() =>
			useWakeUpRetry({ error, hasData: false, onRetry }),
		)
		vi.advanceTimersByTime(WAKE_UP_RETRY_DELAYS_MS[0] ?? 0)
		assert.equal(hook.current.attempt, 1)
		error = null
		hook.rerender()
		assert.equal(hook.current.waking, false)
		assert.equal(hook.current.attempt, 0)
		hook.unmount()
	})
})

describe("useCountdown", () => {
	test("counts down to validUntil and expires", () => {
		vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"))
		const hook = renderHook(() => useCountdown("2026-11-07T12:01:30.000Z"))
		assert.equal(hook.current.label, "1:30")
		assert.equal(hook.current.expired, false)
		vi.advanceTimersByTime(1_000)
		assert.equal(hook.current.label, "1:29")
		vi.advanceTimersByTime(89_000)
		assert.equal(hook.current.label, "0:00")
		assert.equal(hook.current.expired, true)
		assert.equal(hook.current.remainingMs, 0)
		hook.unmount()
	})

	test("rounds partial seconds up", () => {
		vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"))
		const hook = renderHook(() => useCountdown("2026-11-07T12:00:09.200Z"))
		assert.equal(hook.current.label, "0:10")
	})

	test("missing or invalid timestamps are expired", () => {
		assert.equal(renderHook(() => useCountdown(null)).current.expired, true)
		const bad = renderHook(() => useCountdown("not a date"))
		assert.equal(bad.current.expired, true)
		assert.equal(bad.current.label, "0:00")
	})
})

describe("useNotification", () => {
	test("throws outside the provider and returns the context inside it", () => {
		assert.throws(
			() => renderHook(() => useNotification()),
			/must be used within a NotificationProvider/,
		)
		const value = { addNotification: () => undefined }
		provideContext(NotificationContext, value)
		assert.equal(renderHook(() => useNotification()).current, value)
		provideContext(NotificationContext, undefined)
	})
})
