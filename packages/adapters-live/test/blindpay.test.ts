import { describe, expect, it, vi } from "vitest"
import {
	ProviderError,
	money,
	type FlexiPayConfig,
	type Provider,
} from "@flexipay/domain"
import {
	BlindPayAdapter,
	createLiveProviders,
	type FetchLike,
} from "../src/index.ts"

// BlindPay adapter against a recorded-shape fake of the BlindPay API (no network).

const ROW: Provider = {
	id: "blindpay_sandbox",
	kind: "bank",
	countries: ["BR", "MX", "CO", "AR"],
	currencies: ["USDC", "BRL", "MXN", "COP", "ARS"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "USDC" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 600,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "blindpay",
}

const SANDBOX = { customerId: "cu_1", bankAccountId: "ba_1", walletId: "wa_1" }

type TestEndpoint = {
	endpointId: string
	type: "bank_account"
	country: string
	currency: string
	details?: Record<string, string>
	recipientName?: string
	recipientKind?: "individual" | "company"
	partnerRefs?: Record<string, string>
}

type Call = {
	method: string
	path: string
	body: unknown
	headers: Record<string, string>
}

function fakeApi(opts: { instanceType?: string; payoutStatus?: string } = {}) {
	const calls: Call[] = []
	const fetch: FetchLike = async (url, init) => {
		const path = new URL(url).pathname
		const body = init.body ? JSON.parse(init.body) : undefined
		calls.push({ method: init.method, path, body, headers: init.headers })
		const reply = (status: number, json: unknown) => ({
			status,
			text: async () => JSON.stringify(json),
		})
		if (path === "/v1/instances/in_1")
			return reply(200, {
				id: "in_1",
				type: opts.instanceType ?? "development",
			})
		if (path === "/v1/instances/in_1/quotes/fx")
			return reply(200, {
				result_amount: 54891,
				blindpay_quotation: 549.46,
				commercial_quotation: 550.01,
			})
		if (path === "/v1/instances/in_1/quotes")
			return reply(200, {
				id: "qu_1",
				sender_amount: 1000,
				receiver_amount: 5443,
			})
		if (path === "/v1/instances/in_1/customers/re_1/bank-accounts")
			return reply(200, { id: "ba_2", type: body?.type ?? "pix" })
		if (path === "/v1/instances/in_1/customers/cu_1/wallets/wa_1")
			return reply(200, { id: "wa_1", address: "So1anaAddr" })
		if (path === "/v1/instances/in_1/mint-usdb-solana")
			return reply(200, { success: true })
		if (path === "/v1/e/instances/in_1/tos")
			return reply(200, {
				url: "https://app.blindpay.com/e/terms-of-service?session_token=test",
			})
		if (path === "/v1/instances/in_1/customers" && init.method === "POST")
			return reply(200, { id: "re_sender", kyc_status: "approved" })
		if (path === "/v1/instances/in_1/customers/re_sender")
			return reply(200, { id: "re_sender", kyc_status: "approved" })
		if (path.endsWith("/bank-accounts") && init.method === "POST")
			return reply(200, { id: "ba_sender", type: body?.type ?? "pix" })
		if (path === "/v1/instances/in_1/prepare-delegate-solana")
			return reply(200, { transaction: "AQAAA" })
		if (path === "/v1/instances/in_1/payouts/solana")
			return reply(200, { id: "pa_sol", status: "processing" })
		if (path === "/v1/instances/in_1/payouts/evm")
			return reply(200, { id: "pa_1", status: "processing" })
		if (path === "/v1/instances/in_1/payouts/pa_1")
			return reply(200, {
				id: "pa_1",
				status: opts.payoutStatus ?? "completed",
			})
		if (path.startsWith("/v1/instances/in_1/payouts/"))
			return reply(404, { message: "not found" })
		return reply(500, { message: "unexpected" })
	}
	return { calls, fetch }
}

function adapter(
	api = fakeApi(),
	extra: Partial<{
		sandbox: typeof SANDBOX | null
		liveApproved: boolean
	}> = {},
) {
	return new BlindPayAdapter(ROW, {
		apiKey: "bp_test_key",
		instanceId: "in_1",
		sandbox: extra.sandbox === undefined ? SANDBOX : extra.sandbox,
		liveApproved: extra.liveApproved ?? false,
		fetch: api.fetch,
	})
}

const leg = (
	kind: "convert" | "payout",
	amountIn = money("5443", "BRL"),
	endpoint?: TestEndpoint,
) => ({
	kind,
	amountIn,
	outCurrency: amountIn.currency,
	endpoint,
	paymentId: "pay_1",
	legId: `leg_${kind}`,
	attempt: 1,
})

const BR_ENDPOINT: TestEndpoint = {
	endpointId: "ep_br",
	type: "bank_account",
	country: "BR",
	currency: "BRL",
	details: {
		accountNumber: "synthetic-br-1234",
		pixKey: "worker-b@example.test",
	},
	recipientName: "Worker B",
	recipientKind: "individual",
	partnerRefs: { blindpay_receiver_id: "re_1" },
}

describe("BlindPay adapter", () => {
	it("prices convert from BlindPay's own FX quote, fee in USDC", async () => {
		const api = fakeApi()
		const q = await adapter(api).quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "BRL",
		})
		expect(api.calls[0]!.body).toEqual({
			from: "USDC",
			to: "BRL",
			request_amount: 10000,
			currency_type: "sender",
		})
		expect(api.calls[0]!.headers.Authorization).toBe("Bearer bp_test_key")
		expect(q.amountOut).toEqual(money("54891", "BRL"))
		expect(q.fxRate).toBe("5.4946")
		// 548.91 BRL at 5.4946 is 99.8999017 USDC delivered (rounded down), so the fee is 0.1000983 USDC.
		expect(q.fee).toEqual(money("1000983", "USDC"))
		expect(q.simulated).toBe(true)
	})

	it("refuses amounts under BlindPay's 5.00 minimum", async () => {
		await expect(
			adapter().quote({
				kind: "convert",
				amountIn: money("40000000", "USDC"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "below_min" })
	})

	it("refuses to convert anything but USDC", async () => {
		await expect(
			adapter().quote({
				kind: "convert",
				amountIn: money("10000", "USD"),
				outCurrency: "BRL",
			}),
		).rejects.toBeInstanceOf(ProviderError)
	})

	it("payout quote passes the converted amount through with no extra fee", async () => {
		const q = await adapter().quote({
			kind: "payout",
			amountIn: money("5443", "BRL"),
			outCurrency: "BRL",
		})
		expect(q.amountOut).toEqual(money("5443", "BRL"))
		expect(q.fee).toEqual(money("0", "BRL"))
	})

	it("convert executes as a record and succeeds at once; idempotent", async () => {
		const a = adapter()
		const first = await a.execute(leg("convert", money("1000000000", "USDC")))
		const again = await a.execute(leg("convert", money("1000000000", "USDC")))
		expect(again.externalRef).toBe(first.externalRef)
		expect((await a.status(first.externalRef)).status).toBe("succeeded")
	})

	it("payout on a development instance quotes the exact local amount, tops up test tokens, pays", async () => {
		const api = fakeApi()
		const a = adapter(api)
		const { externalRef } = await a.execute(leg("payout"))
		expect(externalRef).toBe("pa_1")
		const quote = api.calls.find((c) => c.path.endsWith("/quotes"))!
		expect(quote.body).toMatchObject({
			bank_account_id: "ba_1",
			network: "solana_devnet",
			token: "USDB",
			currency_type: "receiver",
			request_amount: 5443,
		})
		expect(api.calls.some((c) => c.path.endsWith("/mint-usdb-solana"))).toBe(
			true,
		)
		const payout = api.calls.find((c) => c.path.endsWith("/payouts/evm"))!
		expect(payout.body).toEqual({ quote_id: "qu_1", wallet_id: "wa_1" })
		expect(payout.headers["Idempotency-Key"]).toBe("flexipay-leg_payout:1")
		// Replay returns the same payout without calling BlindPay again.
		const before = api.calls.length
		expect((await a.execute(leg("payout"))).externalRef).toBe("pa_1")
		expect(api.calls.length).toBe(before)
	})

	it("creates one bank account per endpoint, returns both partner refs and reuses them", async () => {
		const api = fakeApi()
		const first = await adapter(api).execute(
			leg("payout", money("5443", "BRL"), BR_ENDPOINT),
		)
		expect(first.partnerRefs).toEqual({
			blindpay_receiver_id: "re_1",
			blindpay_bank_account_id: "ba_2",
		})
		const created = api.calls.filter((c) =>
			c.path.endsWith("/customers/re_1/bank-accounts"),
		)
		expect(created).toHaveLength(1)
		expect(created[0]!.body).toEqual({
			type: "pix",
			name: "Worker B",
			pix_key: "worker-b@example.test",
		})
		expect(created[0]!.headers["Idempotency-Key"]).toBe(
			"flexipay-bank-account-ep_br",
		)
		const quote = api.calls.find((c) => c.path.endsWith("/quotes"))!
		expect(quote.body).toMatchObject({ bank_account_id: "ba_2" })

		// A new process reuses the refs persisted on the endpoint; it does not create another account.
		const second = await adapter(api).execute(
			leg("payout", money("5443", "BRL"), {
				...BR_ENDPOINT,
				partnerRefs: first.partnerRefs!,
			}),
		)
		expect(second.partnerRefs).toBeUndefined()
		expect(
			api.calls.filter((c) => c.path.endsWith("/bank-accounts")),
		).toHaveLength(1)
	})

	it("on a development instance, bank details without a KYC receiver still pay the sandbox account", async () => {
		const api = fakeApi()
		const result = await adapter(api).execute(
			leg("payout", money("5443", "BRL"), {
				...BR_ENDPOINT,
				partnerRefs: undefined,
			}),
		)
		expect(result.externalRef).toBeTruthy()
		expect(api.calls.some((c) => c.path.endsWith("/bank-accounts"))).toBe(false)
		const quote = api.calls.find((c) => c.path.endsWith("/quotes"))
		expect(quote?.body).toMatchObject({
			bank_account_id: SANDBOX.bankAccountId,
		})
	})

	it("in production, refuses without a KYC-approved receiver instead of inventing KYC data", async () => {
		const api = fakeApi({ instanceType: "production" })
		const error = await adapter(api, { liveApproved: true })
			.execute(
				leg("payout", money("5443", "BRL"), {
					...BR_ENDPOINT,
					partnerRefs: undefined,
				}),
			)
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ProviderError)
		expect((error as Error).message).toContain("blindpay_receiver_id")
		expect((error as Error).message).toContain("first_name")
		expect(api.calls.some((c) => c.path.endsWith("/bank-accounts"))).toBe(false)
	})

	it("refuses with the missing BlindPay bank field names", async () => {
		const api = fakeApi()
		const error = await adapter(api)
			.execute(
				leg("payout", money("5443", "BRL"), {
					...BR_ENDPOINT,
					details: { accountNumber: "synthetic-br-1234" },
				}),
			)
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ProviderError)
		expect((error as Error).message).toContain("pixKey")
		expect((error as Error).message).toContain("pix_key")
		expect(api.calls.some((c) => c.path.endsWith("/bank-accounts"))).toBe(false)
	})

	it("builds the documented bank-account body for Mexico, Colombia and Argentina", async () => {
		const cases: Array<{ endpoint: TestEndpoint; body: unknown }> = [
			{
				endpoint: {
					endpointId: "ep_mx",
					type: "bank_account",
					country: "MX",
					currency: "MXN",
					details: {
						accountNumber: "synthetic-mx-1234",
						clabe: "012345678901234567",
						speiProtocol: "clabe",
						accountHolderName: "Worker MX",
					},
					recipientName: "Worker MX",
					partnerRefs: { blindpay_receiver_id: "re_1" },
				},
				body: {
					type: "spei_bitso",
					name: "Worker MX",
					beneficiary_name: "Worker MX",
					spei_protocol: "clabe",
					spei_clabe: "012345678901234567",
				},
			},
			{
				endpoint: {
					endpointId: "ep_co",
					type: "bank_account",
					country: "CO",
					currency: "COP",
					details: {
						accountNumber: "synthetic-co-1234",
						firstName: "Worker",
						lastName: "CO",
						documentId: "1234567890",
						documentType: "CC",
						email: "worker-co@example.test",
						bankCode: "001",
						accountType: "saving",
					},
					recipientName: "Worker CO",
					partnerRefs: { blindpay_receiver_id: "re_1" },
				},
				body: {
					type: "ach_cop_bitso",
					name: "Worker CO",
					account_type: "saving",
					ach_cop_beneficiary_first_name: "Worker",
					ach_cop_beneficiary_last_name: "CO",
					ach_cop_document_id: "1234567890",
					ach_cop_document_type: "CC",
					ach_cop_email: "worker-co@example.test",
					ach_cop_bank_code: "001",
					ach_cop_bank_account: "synthetic-co-1234",
				},
			},
			{
				endpoint: {
					endpointId: "ep_ar",
					type: "bank_account",
					country: "AR",
					currency: "ARS",
					details: {
						accountNumber: "0000000000000000000000",
						transfersType: "CVU",
						accountHolderName: "Worker AR",
					},
					recipientName: "Worker AR",
					partnerRefs: { blindpay_receiver_id: "re_1" },
				},
				body: {
					type: "transfers_bitso",
					name: "Worker AR",
					beneficiary_name: "Worker AR",
					transfers_type: "CVU",
					transfers_account: "0000000000000000000000",
				},
			},
		]

		for (const { endpoint, body } of cases) {
			const api = fakeApi()
			await adapter(api).execute(
				leg("payout", money("10000", endpoint.currency), endpoint),
			)
			const created = api.calls.find((c) => c.path.endsWith("/bank-accounts"))
			expect(created?.body).toEqual(body)
		}
	})

	it("uses the sandbox bank account only on a development instance", async () => {
		const api = fakeApi({ instanceType: "production" })
		const error = await adapter(api, { liveApproved: true })
			.execute(leg("payout"))
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ProviderError)
		expect((error as Error).message).toContain("development-only")
		expect(api.calls.some((c) => c.path.endsWith("/quotes"))).toBe(false)
	})

	it("never logs endpoint bank details", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => {}),
		)
		try {
			await adapter().execute(leg("payout", money("5443", "BRL"), BR_ENDPOINT))
			for (const spy of spies) expect(spy).not.toHaveBeenCalled()
		} finally {
			for (const spy of spies) spy.mockRestore()
		}
	})

	it("maps BlindPay payout statuses", async () => {
		expect(
			(await adapter(fakeApi({ payoutStatus: "completed" })).status("pa_1"))
				.status,
		).toBe("succeeded")
		expect(
			(await adapter(fakeApi({ payoutStatus: "processing" })).status("pa_1"))
				.status,
		).toBe("processing")
		expect(
			(await adapter(fakeApi({ payoutStatus: "on_hold" })).status("pa_1"))
				.status,
		).toBe("processing")
		const failed = await adapter(fakeApi({ payoutStatus: "refunded" })).status(
			"pa_1",
		)
		expect(failed.status).toBe("failed")
		expect(failed.error?.code).toBe("returned_to_wallet")
		expect(failed.error?.message).toBe("returned to your wallet")
		await expect(adapter().status("pa_unknown")).rejects.toMatchObject({
			code: "unknown_reference",
		})
	})

	it("never moves real money without written approval", async () => {
		const a = adapter(fakeApi({ instanceType: "production" }))
		await expect(a.execute(leg("payout"))).rejects.toMatchObject({
			code: "unsupported",
		})
		expect(await a.health()).toBe("down")
	})

	it("refuses a payout when no BlindPay recipient account is configured", async () => {
		await expect(
			adapter(fakeApi(), { sandbox: null }).execute(leg("payout")),
		).rejects.toMatchObject({
			code: "unsupported",
		})
	})

	it("a payout cannot be reversed; the convert record can", async () => {
		const a = adapter()
		await expect(a.reverse("pa_1")).rejects.toMatchObject({
			code: "not_reversible",
		})
		expect(
			(await a.reverse("blindpay-convert:leg_convert:1")).externalRef,
		).toContain("reversed")
	})

	it("health is up on a development instance", async () => {
		expect(await adapter().health()).toBe("up")
	})

	it("prepares a devnet delegation and creates a solana payout without a managed wallet", async () => {
		const api = fakeApi()
		const a = adapter(api, { sandbox: null })
		const terms = await a.startTermsOfService(
			"123e4567-e89b-12d3-a456-426614174000",
			"https://flexipay.test/tos",
		)
		expect(terms.url).toContain("app.blindpay.com")
		const customer = await a.createIndividualCustomer("to_1", {
			email: "sender@example.test",
			first_name: "Ada",
			last_name: "Sender",
		})
		expect(customer).toEqual({ id: "re_sender", kycStatus: "approved" })
		const now = Date.now()
		const prepared = await a.prepareSenderWalletDelegation({
			customerId: "re_sender",
			endpoint: BR_ENDPOINT,
			ownerAddress: "SoLanaSenderWallet1111111111111111111111",
			requestAmountHundredths: 10000,
			nowMs: now,
		})
		expect(prepared.transaction).toBe("AQAAA")
		expect(prepared.quoteId).toBe("qu_1")
		const quoteCall = api.calls.find((c) => c.path.endsWith("/quotes"))
		expect(quoteCall?.body).toMatchObject({
			network: "solana_devnet",
			token: "USDB",
			bank_account_id: "ba_sender",
			request_amount: 10000,
		})
		expect(api.calls.some((c) => c.path.endsWith("/payouts/evm"))).toBe(false)
		expect(api.calls.some((c) => c.path.endsWith("/mint-usdb-solana"))).toBe(
			false,
		)
		const again = await a.prepareSenderWalletDelegation({
			customerId: "re_sender",
			endpoint: {
				...BR_ENDPOINT,
				partnerRefs: { blindpay_bank_account_id: "ba_sender" },
			},
			ownerAddress: "SoLanaSenderWallet1111111111111111111111",
			requestAmountHundredths: 10000,
			existingQuoteId: prepared.quoteId,
			quoteExpiresAtMs: prepared.expiresAtMs,
			nowMs: now,
		})
		expect(again.requoted).toBe(false)
		const payout = await a.createSenderWalletPayout({
			quoteId: prepared.quoteId,
			senderWalletAddress: "SoLanaSenderWallet1111111111111111111111",
			signature: "sig_delegation",
			idempotencyKey: "flexipay-solana-pay_1",
		})
		expect(payout.id).toBe("pa_sol")
		const solana = api.calls.find((c) => c.path.endsWith("/payouts/solana"))
		expect(solana?.body).toEqual({
			quote_id: "qu_1",
			sender_wallet_address: "SoLanaSenderWallet1111111111111111111111",
			signed_transaction: "sig_delegation",
		})
		await expect(
			adapter(fakeApi({ instanceType: "production" }), {
				sandbox: null,
			}).prepareSenderWalletDelegation({
				customerId: "re_sender",
				endpoint: BR_ENDPOINT,
				ownerAddress: "SoLanaSenderWallet1111111111111111111111",
				requestAmountHundredths: 10000,
				nowMs: now,
			}),
		).rejects.toMatchObject({ code: "unsupported" })
	})
})

describe("createLiveProviders", () => {
	const config = { providers: [ROW] } as unknown as FlexiPayConfig

	it("registers BlindPay only when its keys are set", () => {
		expect(createLiveProviders(config, {}).providers.size).toBe(0)
		expect(createLiveProviders(config, {}).skipped).toEqual([
			"blindpay_sandbox",
		])
		const live = createLiveProviders(config, {
			BLINDPAY_API_KEY: "k",
			BLINDPAY_INSTANCE_ID: "in_1",
		})
		expect([...live.providers.keys()]).toEqual(["blindpay_sandbox"])
	})
})

describe("CCR-46 uploadKycFile", () => {
	const make = (reply: { status: number; body: string }) => {
		const seen: Array<{
			url: string
			headers: Record<string, string>
			form: FormData
		}> = []
		const a = new BlindPayAdapter(ROW, {
			apiKey: "bp_test_key",
			instanceId: "in_1",
			sandbox: null,
			liveApproved: false,
			fetch: async () => ({ status: 500, text: async () => "{}" }),
			uploadFetch: async (url, init) => {
				seen.push({ url, headers: init.headers, form: init.body })
				return { status: reply.status, text: async () => reply.body }
			},
		})
		return { a, seen }
	}

	it("posts the file to the onboarding bucket with the instance id and key", async () => {
		const { a, seen } = make({
			status: 200,
			body: JSON.stringify({
				file_url: "https://files.blindpay.com/1-kyc.png",
			}),
		})
		const out = await a.uploadKycFile({
			bytes: new Uint8Array([1, 2, 3]),
			contentType: "image/png",
			name: "kyc.png",
		})
		expect(out).toEqual({ fileUrl: "https://files.blindpay.com/1-kyc.png" })
		expect(seen[0]!.url).toBe(
			"https://api.blindpay.com/v1/upload?instance_id=in_1",
		)
		expect(seen[0]!.headers.Authorization).toBe("Bearer bp_test_key")
		expect(seen[0]!.form.get("bucket")).toBe("onboarding")
		const file = seen[0]!.form.get("file") as Blob
		expect(file.type).toBe("image/png")
		expect(file.size).toBe(3)
	})

	it("fails on a BlindPay error, a non-JSON reply or a non-https URL", async () => {
		const file = {
			bytes: new Uint8Array([1]),
			contentType: "image/jpeg",
			name: "x.jpg",
		}
		await expect(
			make({
				status: 400,
				body: JSON.stringify({ message: "file_type_not_allowed" }),
			}).a.uploadKycFile(file),
		).rejects.toThrow(/upload failed \(HTTP 400: file_type_not_allowed\)/)
		await expect(
			make({ status: 200, body: "not json" }).a.uploadKycFile(file),
		).rejects.toThrow()
		await expect(
			make({
				status: 200,
				body: JSON.stringify({ file_url: "http://x" }),
			}).a.uploadKycFile(file),
		).rejects.toThrow(/no https file URL/)
	})
})
