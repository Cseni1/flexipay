import assert from "node:assert/strict"
import { type PaymentDetail } from "@flexipay/web-lib/contract"
import { afterEach, beforeEach, describe, test, vi } from "vitest"
import type * as ClientModule from "../src/api/client.ts"
import { flush, renderHook } from "./helpers/fakeReact.ts"

vi.mock("react", () => import("./helpers/fakeReact.ts"))

const getPayment =
	vi.fn<(id: string, signal?: AbortSignal) => Promise<unknown>>()

vi.mock("../src/api/client.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ClientModule>()),
	getPayment: (id: string, signal?: AbortSignal) => getPayment(id, signal),
}))

const { ApiError } = await import("../src/api/client.ts")

// The hook uses `window` timers; the Node tsconfig that `tsc -b` applies to test/ has no
// DOM lib, so it loads untyped with the shape stated here.
const load = <T>(path: string): Promise<T> =>
	import(/* @vite-ignore */ path) as Promise<T>
const { usePaymentDetail } = await load<{
	usePaymentDetail: (paymentId: string | undefined) => {
		payment: PaymentDetail | null
		error: InstanceType<typeof ApiError> | null
		loading: boolean
		polling: boolean
		refresh: () => void
	}
}>("../src/hooks/usePaymentDetail.ts")

const payment = (status: string, legStatuses: string[] = []): PaymentDetail =>
	({
		id: "pay_1",
		status,
		legs: legStatuses.map((s, i) => ({ id: `leg_${i}`, status: s })),
		events: [],
	}) as unknown as PaymentDetail

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal("window", globalThis)
	getPayment.mockReset()
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe("usePaymentDetail", () => {
	test("reports a missing payment id without calling the API", () => {
		const hook = renderHook(() => usePaymentDetail(undefined))
		assert.equal(hook.current.loading, false)
		assert.equal(hook.current.polling, false)
		assert.equal(hook.current.error?.code, "missing_payment_id")
		assert.equal(getPayment.mock.calls.length, 0)
	})

	test("loads a settled payment once and does not poll", async () => {
		getPayment.mockResolvedValue(payment("paid", ["succeeded"]))
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		assert.equal(hook.current.loading, true)
		await flush()
		assert.equal(hook.current.loading, false)
		assert.equal(hook.current.payment?.status, "paid")
		assert.equal(hook.current.error, null)
		assert.equal(hook.current.polling, false)
		await vi.advanceTimersByTimeAsync(60_000)
		assert.equal(getPayment.mock.calls.length, 1)
		assert.equal(getPayment.mock.calls[0]?.[0], "pay_1")
	})

	test("polls fast (2 s) between legs and slow (10 s) while a leg is with a partner", async () => {
		getPayment
			.mockResolvedValueOnce(payment("funded", ["pending"]))
			.mockResolvedValueOnce(payment("processing", ["processing"]))
			.mockResolvedValue(payment("paid", ["succeeded"]))
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		await flush()
		assert.equal(hook.current.polling, false)
		assert.equal(getPayment.mock.calls.length, 1)

		await vi.advanceTimersByTimeAsync(1_999)
		assert.equal(getPayment.mock.calls.length, 1)
		await vi.advanceTimersByTimeAsync(1)
		await flush()
		assert.equal(getPayment.mock.calls.length, 2)
		assert.equal(hook.current.polling, true)
		// Background refresh does not flip loading back on.
		assert.equal(hook.current.loading, false)

		await vi.advanceTimersByTimeAsync(9_999)
		assert.equal(getPayment.mock.calls.length, 2)
		await vi.advanceTimersByTimeAsync(1)
		await flush()
		assert.equal(getPayment.mock.calls.length, 3)
		assert.equal(hook.current.payment?.status, "paid")
		assert.equal(hook.current.polling, false)
	})

	test("stops polling once the 15 minute budget is spent", async () => {
		getPayment.mockImplementation(async () => {
			return payment("processing", ["processing"])
		})
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		await flush()
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 20_000)
		await flush()
		const calls = getPayment.mock.calls.length
		assert.ok(calls > 50 && calls <= 92, `calls=${calls}`)
		assert.equal(hook.current.polling, false)
		await vi.advanceTimersByTimeAsync(60_000)
		assert.equal(getPayment.mock.calls.length, calls)
	})

	test("keeps an ApiError and wraps any other failure", async () => {
		getPayment.mockRejectedValueOnce(new ApiError(404, "not_found", "Nope"))
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		await flush()
		assert.equal(hook.current.error?.code, "not_found")
		assert.equal(hook.current.loading, false)

		getPayment.mockRejectedValueOnce(new TypeError("boom"))
		hook.current.refresh()
		assert.equal(hook.current.loading, true)
		await flush()
		assert.equal(hook.current.error?.code, "unknown_error")
		assert.equal(
			hook.current.error?.message,
			"The payment could not be loaded.",
		)
	})

	test("refresh re-fetches and clears a previous error", async () => {
		getPayment
			.mockRejectedValueOnce(new ApiError(503, "http_503", "down"))
			.mockResolvedValueOnce(payment("paid"))
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		await flush()
		assert.equal(hook.current.error?.status, 503)
		hook.current.refresh()
		await flush()
		assert.equal(hook.current.error, null)
		assert.equal(hook.current.payment?.status, "paid")
		assert.equal(getPayment.mock.calls.length, 2)
	})

	test("unmount aborts the in-flight request and cancels the poll timer", async () => {
		let seenSignal: AbortSignal | undefined
		getPayment.mockImplementation(async (_id, signal) => {
			seenSignal = signal
			return payment("funded", ["pending"])
		})
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		await flush()
		hook.unmount()
		assert.equal(seenSignal?.aborted, true)
		await vi.advanceTimersByTimeAsync(30_000)
		assert.equal(getPayment.mock.calls.length, 1)
	})

	test("ignores a late failure after unmount", async () => {
		let reject: (e: unknown) => void = () => undefined
		getPayment.mockImplementation(
			() =>
				new Promise((_resolve, rej) => {
					reject = rej
				}),
		)
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		hook.unmount()
		reject(new ApiError(500, "internal_error", "late"))
		await flush()
		assert.equal(hook.current.error, null)
	})

	test("ignores a late success after unmount", async () => {
		let resolve: (v: unknown) => void = () => undefined
		getPayment.mockImplementation(
			() =>
				new Promise((res) => {
					resolve = res
				}),
		)
		const hook = renderHook(() => usePaymentDetail("pay_1"))
		hook.unmount()
		resolve(payment("paid"))
		await flush()
		assert.equal(hook.current.payment, null)
	})
})
