import {
	CURRENCY_DECIMALS,
	ProviderError,
	money,
	toMinor,
	type LegExecution,
	type LegQuote,
	type LegQuoteRequest,
	type EndpointRef,
	type Provider,
	type ProviderAdapter,
	type ProviderCapabilities,
	type ProviderLegState,
} from "@flexipay/domain"
import { jsonRequest, type FetchLike, type HttpResult } from "./http.ts"

export type UploadFetch = (
	url: string,
	init: {
		method: "POST"
		headers: Record<string, string>
		body: FormData
		signal?: AbortSignal
	},
) => Promise<{ status: number; text(): Promise<string> }>

// BlindPay off-ramp adapter (CCR-29, recipient bank accounts CCR-34). BlindPay converts USDC to
// local currency and pays the bank in one step, so it serves the convert + payout pair (routing
// keeps both legs on BlindPay):
// - convert: priced from BlindPay's own FX quote; executing it records the step, because the
//   conversion happens inside the payout.
// - payout: creates/reuses a BlindPay bank account for the endpoint, creates a BlindPay quote for
//   the exact local amount and executes it.
// Development instances simulate settlement with the USDB test token and move no real money.
// A production instance is refused unless FP_BLINDPAY_LIVE_APPROVED=1 (written approval only).
//
// Bank accounts belong to a KYC-approved BlindPay customer. FlexiPay does not collect the KYC
// fields BlindPay requires, so this adapter never creates a customer: the receiver id must already
// be persisted on the endpoint by a compliant onboarding flow. Without it, the payout is refused
// with a ProviderError naming the missing KYC data instead of inventing placeholder identity data.

const BASE_URL = "https://api.blindpay.com"
const SOURCE_ASSET = "USDC"
/** BlindPay amounts are integers in hundredths ("1000 represents 10.00"). */
const BLINDPAY_DECIMALS = 2
/** BlindPay minimum for bank account quotes, in hundredths. */
const MIN_REQUEST = 500n
const HEALTH_TTL_MS = 60_000
const BANK_ACCOUNT_REF = "blindpay_bank_account_id"
const RECEIVER_REF = "blindpay_receiver_id"

/** BlindPay customer fields FlexiPay does not collect; listed when no receiver id is available. */
const KYC_FIELDS = [
	"tos_id",
	"type",
	"kyc_type",
	"email",
	"first_name",
	"last_name",
	"date_of_birth",
	"tax_id",
	"address_line_1",
	"city",
	"state_province_region",
	"postal_code",
	"country",
	"id_doc_country",
	"id_doc_type",
	"id_doc_front_file",
	"selfie_file",
] as const

export interface BlindPaySandboxAccount {
	customerId: string
	bankAccountId: string
	walletId: string
}

export interface BlindPayOptions {
	apiKey: string
	instanceId: string
	/** Sandbox recipient and managed wallet; bank-account fallback is development-only. */
	sandbox: BlindPaySandboxAccount | null
	liveApproved: boolean
	baseUrl?: string
	fetch?: FetchLike
	/** CCR-46: multipart upload (FormData body); defaults to the global fetch. */
	uploadFetch?: UploadFetch
	now?: () => number
}

type InstanceType = "development" | "production"

const PAYOUT_STATUS: Record<string, ProviderLegState["status"]> = {
	processing: "processing",
	on_hold: "processing",
	completed: "succeeded",
	failed: "failed",
	refunded: "failed",
}

/** Scales an integer amount between decimal conventions, rounding down. */
function rescale(
	minor: bigint,
	fromDecimals: number,
	toDecimals: number,
): bigint {
	if (toDecimals >= fromDecimals)
		return minor * 10n ** BigInt(toDecimals - fromDecimals)
	return minor / 10n ** BigInt(fromDecimals - toDecimals)
}

function decimalsOf(currency: string): number {
	const d = CURRENCY_DECIMALS[currency]
	if (d === undefined)
		throw new ProviderError(
			"unsupported",
			`BlindPay: unknown currency ${currency}`,
		)
	return d
}

/** BlindPay quotes rates in hundredths ("549.46" means 5.4946 BRL per USDC). */
function rateFromQuotation(quotation: number): {
	scaled: bigint
	text: string
} {
	const scaled = BigInt(Math.round(quotation * 100)) // rate * 10^4
	const whole = scaled / 10_000n
	const frac = (scaled % 10_000n).toString().padStart(4, "0")
	return { scaled, text: `${whole}.${frac}` }
}

export class BlindPayAdapter implements ProviderAdapter {
	readonly id: string
	private readonly row: Provider
	private readonly opts: BlindPayOptions
	private readonly fetchImpl: FetchLike
	private readonly now: () => number
	private readonly issued = new Map<string, string>()
	/** endpointId -> BlindPay bank account id created by this process. */
	private readonly bankAccounts = new Map<string, string>()
	private instanceKind: InstanceType | null = null
	private healthCache: { at: number; value: "up" | "down" } | null = null

	constructor(row: Provider, opts: BlindPayOptions) {
		this.id = row.id
		this.row = row
		this.opts = opts
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
		this.now = opts.now ?? (() => Date.now())
	}

	/** BlindPay instance type, for the operator partner-status route. */
	async instanceType(): Promise<InstanceType> {
		return this.instance()
	}

	capabilities(): ProviderCapabilities {
		return {
			providerId: this.id,
			countries: this.row.countries,
			currencies: this.row.currencies,
			endpointTypes: this.row.endpointTypes,
			legKinds: this.row.legKinds,
			limits: this.row.limits,
			simulated: this.row.simulated,
		}
	}

	async quote(req: LegQuoteRequest): Promise<LegQuote> {
		this.assertServes(req.kind)
		if (req.kind === "convert") return this.quoteConvert(req)
		// payout: the conversion already happened on the convert leg; nothing more is charged here.
		if (req.amountIn.currency !== req.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"BlindPay payout must be in the local currency",
			)
		}
		this.assertCurrency(req.outCurrency)
		const request = rescale(
			toMinor(req.amountIn),
			decimalsOf(req.outCurrency),
			BLINDPAY_DECIMALS,
		)
		if (request < MIN_REQUEST) {
			throw new ProviderError(
				"below_min",
				"BlindPay pays out at least 5.00 in local currency",
			)
		}
		return {
			providerId: this.id,
			fee: money(0n, req.outCurrency),
			fxRate: null,
			amountOut: req.amountIn,
			estimatedTimeSeconds: this.row.estimatedTimeSeconds,
			simulated: this.row.simulated,
		}
	}

	private async quoteConvert(req: LegQuoteRequest): Promise<LegQuote> {
		if (req.amountIn.currency !== SOURCE_ASSET) {
			throw new ProviderError(
				"unsupported",
				`BlindPay converts ${SOURCE_ASSET} only`,
			)
		}
		this.assertCurrency(req.outCurrency)
		const inMinor = toMinor(req.amountIn)
		const inDecimals = decimalsOf(SOURCE_ASSET)
		const request = rescale(inMinor, inDecimals, BLINDPAY_DECIMALS)
		if (request < MIN_REQUEST) {
			throw new ProviderError("below_min", "BlindPay needs at least 5.00 USDC")
		}
		const res = await this.call(
			"POST",
			`/v1/instances/${this.opts.instanceId}/quotes/fx`,
			{
				from: SOURCE_ASSET,
				to: req.outCurrency,
				request_amount: Number(request),
				currency_type: "sender",
			},
		)
		const body = this.ok(res, "FX quote")
		const result = body.result_amount
		const quotation = body.blindpay_quotation
		if (
			typeof result !== "number" ||
			typeof quotation !== "number" ||
			quotation <= 0
		) {
			throw new Error("BlindPay FX quote returned no amount or rate")
		}
		const outMinor = rescale(
			BigInt(Math.floor(result)),
			BLINDPAY_DECIMALS,
			decimalsOf(req.outCurrency),
		)
		const rate = rateFromQuotation(quotation)
		// USDC value of what the recipient gets, at BlindPay's own rate; the rest is BlindPay's fee.
		const deliveredInUsdc =
			(rescale(outMinor, decimalsOf(req.outCurrency), inDecimals) * 10_000n) /
			rate.scaled
		const feeMinor = inMinor > deliveredInUsdc ? inMinor - deliveredInUsdc : 0n
		return {
			providerId: this.id,
			fee: money(feeMinor, SOURCE_ASSET),
			fxRate: rate.text,
			amountOut: money(outMinor, req.outCurrency),
			estimatedTimeSeconds: 0,
			simulated: this.row.simulated,
		}
	}

	async execute(leg: LegExecution): Promise<{
		externalRef: string
		partnerRefs?: Record<string, string>
	}> {
		this.assertServes(leg.kind)
		const key = `${leg.legId}:${leg.attempt}`
		const known = this.issued.get(key)
		if (known) return { externalRef: known }

		if (leg.kind === "convert") {
			const ref = `blindpay-convert:${key}`
			this.issued.set(key, ref)
			return { externalRef: ref }
		}

		const type = await this.instance()
		if (type === "production" && !this.opts.liveApproved) {
			throw new ProviderError(
				"unsupported",
				"BlindPay production instance is not approved for real money",
			)
		}
		const funding = this.opts.sandbox
		if (!funding) {
			throw new ProviderError(
				"unsupported",
				"BlindPay payout needs a configured funding wallet",
			)
		}
		this.assertCurrency(leg.amountIn.currency)
		const request = rescale(
			toMinor(leg.amountIn),
			decimalsOf(leg.amountIn.currency),
			BLINDPAY_DECIMALS,
		)
		const account = await this.bankAccountFor(leg.endpoint, type, funding)
		const network = type === "development" ? "solana_devnet" : "solana"
		const token = type === "development" ? "USDB" : SOURCE_ASSET

		const quote = this.ok(
			await this.call("POST", `/v1/instances/${this.opts.instanceId}/quotes`, {
				bank_account_id: account.bankAccountId,
				network,
				token,
				currency_type: "receiver",
				request_amount: Number(request),
				cover_fees: false,
			}),
			"payout quote",
		)
		if (typeof quote.id !== "string")
			throw new Error("BlindPay payout quote returned no id")

		if (type === "development" && typeof quote.sender_amount === "number") {
			await this.mintTestTokens(funding, quote.sender_amount, key)
		}

		const payout = this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/payouts/evm`,
				{ quote_id: quote.id, wallet_id: funding.walletId },
				`flexipay-${key}`,
			),
			"payout",
		)
		if (typeof payout.id !== "string")
			throw new Error("BlindPay payout returned no id")
		this.issued.set(key, payout.id)
		return {
			externalRef: payout.id,
			...(account.partnerRefs ? { partnerRefs: account.partnerRefs } : {}),
		}
	}

	/**
	 * CCR-34: reuse the bank account persisted on the endpoint, else create one under the
	 * recipient's already KYC-approved BlindPay customer. A customer cannot be created here:
	 * BlindPay requires identity documents and a tos_id that FlexiPay does not collect.
	 */
	private async bankAccountFor(
		endpoint: EndpointRef | undefined,
		type: InstanceType,
		funding: BlindPaySandboxAccount,
	): Promise<{
		bankAccountId: string
		partnerRefs?: Record<string, string>
	}> {
		const known =
			endpoint?.partnerRefs?.[BANK_ACCOUNT_REF] ??
			(endpoint ? this.bankAccounts.get(endpoint.endpointId) : undefined)
		if (known) return { bankAccountId: known }

		const details = endpoint?.details ?? {}
		if (Object.keys(details).length === 0) {
			if (type === "development") {
				return { bankAccountId: funding.bankAccountId }
			}
			throw new ProviderError(
				"unsupported",
				"BlindPay payout needs the recipient's bank details; the sandbox account is a development-only fallback",
			)
		}
		if (!endpoint) {
			throw new ProviderError(
				"unsupported",
				"BlindPay payout needs an endpoint to create the recipient's bank account",
			)
		}

		const receiverId = endpoint.partnerRefs?.[RECEIVER_REF]
		if (!receiverId) {
			// Integrator (CCR-34): recipients are not KYC-onboarded at BlindPay yet, so on a development
			// instance a payout with bank details still goes to the sandbox account instead of failing.
			if (type === "development") {
				return { bankAccountId: funding.bankAccountId }
			}
			throw new ProviderError(
				"unsupported",
				`BlindPay bank account for endpoint ${endpoint.endpointId} needs a KYC-approved receiver id in partnerRefs.${RECEIVER_REF}; FlexiPay does not store the customer KYC fields BlindPay requires (${KYC_FIELDS.join(", ")}), so no receiver was created`,
			)
		}

		const body = this.bankAccountBody(endpoint)
		const account = this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/customers/${encodeURIComponent(receiverId)}/bank-accounts`,
				body,
				`flexipay-bank-account-${endpoint.endpointId}`,
			),
			"bank account",
		)
		if (typeof account.id !== "string" || account.id.length === 0) {
			throw new Error("BlindPay create bank account returned no id")
		}
		this.bankAccounts.set(endpoint.endpointId, account.id)
		return {
			bankAccountId: account.id,
			partnerRefs: {
				[RECEIVER_REF]: receiverId,
				[BANK_ACCOUNT_REF]: account.id,
			},
		}
	}

	/** Builds the documented bank-account body for the four BlindPay payout corridors. */
	private bankAccountBody(endpoint: EndpointRef): Record<string, unknown> {
		const details = endpoint.details ?? {}
		const name = endpoint.recipientName ?? details.accountHolderName
		const beneficiary = details.accountHolderName ?? endpoint.recipientName
		const missing: string[] = []
		if (!name) missing.push("recipientName (BlindPay name)")
		const need = (key: string, field: string): string => {
			const value = details[key]
			if (!value) missing.push(`${key} (BlindPay ${field})`)
			return value ?? ""
		}

		let body: Record<string, unknown>
		switch (endpoint.country) {
			case "BR": {
				const pixKey = need("pixKey", "pix_key")
				body = { type: "pix", name: name ?? "", pix_key: pixKey }
				break
			}
			case "MX": {
				const clabe = need("clabe", "spei_clabe")
				const protocol = need("speiProtocol", "spei_protocol")
				if (protocol && !["clabe", "debitcard", "phonenum"].includes(protocol))
					missing.push(
						`speiProtocol (BlindPay spei_protocol must be clabe, debitcard or phonenum)`,
					)
				if (!beneficiary)
					missing.push("accountHolderName (BlindPay beneficiary_name)")
				const institution = details.speiInstitutionCode
				if (
					(protocol === "debitcard" || protocol === "phonenum") &&
					!institution
				)
					missing.push(
						"speiInstitutionCode (BlindPay spei_institution_code, required for debitcard/phonenum)",
					)
				body = {
					type: "spei_bitso",
					name: name ?? "",
					beneficiary_name: beneficiary ?? "",
					spei_protocol: protocol,
					spei_clabe: clabe,
					...(institution ? { spei_institution_code: institution } : {}),
				}
				break
			}
			case "CO": {
				const firstName = need("firstName", "ach_cop_beneficiary_first_name")
				const lastName = need("lastName", "ach_cop_beneficiary_last_name")
				const documentId = need("documentId", "ach_cop_document_id")
				const documentType = need("documentType", "ach_cop_document_type")
				const email = need("email", "ach_cop_email")
				const bankCode = need("bankCode", "ach_cop_bank_code")
				const accountNumber = need("accountNumber", "ach_cop_bank_account")
				const accountType = need("accountType", "account_type")
				if (
					documentType &&
					!["CC", "CE", "NIT", "PASS", "PEP"].includes(documentType)
				)
					missing.push(
						"documentType (BlindPay ach_cop_document_type must be CC, CE, NIT, PASS or PEP)",
					)
				if (accountType && !["checking", "saving"].includes(accountType))
					missing.push(
						"accountType (BlindPay account_type must be checking or saving)",
					)
				body = {
					type: "ach_cop_bitso",
					name: name ?? "",
					account_type: accountType,
					ach_cop_beneficiary_first_name: firstName,
					ach_cop_beneficiary_last_name: lastName,
					ach_cop_document_id: documentId,
					ach_cop_document_type: documentType,
					ach_cop_email: email,
					ach_cop_bank_code: bankCode,
					ach_cop_bank_account: accountNumber,
				}
				break
			}
			case "AR": {
				const transfersType = need("transfersType", "transfers_type")
				const account = need("accountNumber", "transfers_account")
				if (transfersType && !["CVU", "CBU", "ALIAS"].includes(transfersType))
					missing.push(
						"transfersType (BlindPay transfers_type must be CVU, CBU or ALIAS)",
					)
				if (!beneficiary)
					missing.push("accountHolderName (BlindPay beneficiary_name)")
				body = {
					type: "transfers_bitso",
					name: name ?? "",
					beneficiary_name: beneficiary ?? "",
					transfers_type: transfersType,
					transfers_account: account,
				}
				break
			}
			default:
				throw new ProviderError(
					"unsupported",
					`BlindPay has no bank account rail for ${endpoint.country}`,
				)
		}

		if (missing.length > 0) {
			throw new ProviderError(
				"unsupported",
				`BlindPay bank account for endpoint ${endpoint.endpointId} is missing ${missing.join(", ")}; see https://blindpay.com/docs/bank-accounts#required-fields-per-type`,
			)
		}
		return body
	}

	/** Development only: tops up the sandbox wallet with USDB so the payout can run. */
	private async mintTestTokens(
		sandbox: BlindPaySandboxAccount,
		senderHundredths: number,
		key: string,
	) {
		const wallet = this.ok(
			await this.call(
				"GET",
				`/v1/instances/${this.opts.instanceId}/customers/${sandbox.customerId}/wallets/${sandbox.walletId}`,
			),
			"sandbox wallet",
		)
		if (typeof wallet.address !== "string")
			throw new Error("BlindPay sandbox wallet has no address")
		const amount = (Math.ceil(senderHundredths / 100) + 1).toString()
		this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/mint-usdb-solana`,
				{ address: wallet.address, amount },
				`flexipay-mint-${key}`,
			),
			"sandbox mint",
		)
	}

	/**
	 * CCR-45: hosted terms page. The sender accepts it in the browser; FlexiPay stores
	 * the tos id they are redirected with and does not invent identity data.
	 */
	async startTermsOfService(
		idempotencyKey: string,
		redirectUrl?: string,
	): Promise<{ url: string }> {
		const body = this.ok(
			await this.call(
				"POST",
				`/v1/e/instances/${this.opts.instanceId}/tos`,
				{
					idempotency_key: idempotencyKey,
					...(redirectUrl ? { redirect_url: redirectUrl } : {}),
				},
			),
			"terms of service",
		)
		const url =
			typeof body.url === "string"
				? body.url
				: typeof body.tos_url === "string"
					? body.tos_url
					: ""
		if (!url.startsWith("https://")) {
			throw new Error("BlindPay terms of service returned no https URL")
		}
		return { url }
	}

	/**
	 * CCR-46: uploads one KYC document or selfie to BlindPay's encrypted `onboarding`
	 * bucket and returns its opaque file URL. FlexiPay keeps no copy of the file.
	 */
	async uploadKycFile(file: {
		bytes: Uint8Array
		contentType: string
		name: string
	}): Promise<{ fileUrl: string }> {
		const form = new FormData()
		form.append("bucket", "onboarding")
		form.append(
			"file",
			new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
			file.name,
		)
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), 60_000)
		let status: number
		let json: unknown = null
		try {
			const upload: UploadFetch =
				this.opts.uploadFetch ?? ((url, init) => fetch(url, init))
			const res = await upload(
				`${this.opts.baseUrl ?? BASE_URL}/v1/upload?instance_id=${encodeURIComponent(this.opts.instanceId)}`,
				{
					method: "POST",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${this.opts.apiKey}`,
					},
					body: form,
					signal: controller.signal,
				},
			)
			status = res.status
			const text = await res.text()
			try {
				json = text ? JSON.parse(text) : null
			} catch {
				json = null
			}
		} finally {
			clearTimeout(timer)
		}
		const body = this.ok({ status, json }, "upload")
		const fileUrl = typeof body.file_url === "string" ? body.file_url : ""
		if (!fileUrl.startsWith("https://")) {
			throw new Error("BlindPay upload returned no https file URL")
		}
		return { fileUrl }
	}

	/**
	 * Forwards a customer the sender submitted. Development instances approve immediately.
	 * This method does not fill tax id, date of birth, or document URLs.
	 */
	async createIndividualCustomer(
		tosId: string,
		kyc: Record<string, unknown>,
	): Promise<{ id: string; kycStatus: string }> {
		const created = this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/customers`,
				{
					...kyc,
					tos_id: tosId,
					type: "individual",
					kyc_type: "standard",
				},
			),
			"customer",
		)
		if (typeof created.id !== "string" || created.id.length === 0) {
			throw new Error("BlindPay create customer returned no id")
		}
		const kycStatus =
			typeof created.kyc_status === "string" ? created.kyc_status : "verifying"
		return { id: created.id, kycStatus }
	}

	async customerKycStatus(customerId: string): Promise<string> {
		const body = this.ok(
			await this.call(
				"GET",
				`/v1/instances/${this.opts.instanceId}/customers/${encodeURIComponent(customerId)}`,
			),
			"customer",
		)
		return typeof body.kyc_status === "string" ? body.kyc_status : "verifying"
	}

	/**
	 * Locks a Solana payout quote (5 minutes) and returns the delegation transaction
	 * the sender's wallet must sign. Dev instances use solana_devnet and USDB.
	 * A production instance is refused unless live payouts are approved.
	 */
	async prepareSenderWalletDelegation(input: {
		customerId: string
		endpoint: EndpointRef
		ownerAddress: string
		requestAmountHundredths: number
		existingQuoteId?: string | null
		quoteExpiresAtMs?: number | null
		nowMs: number
	}): Promise<{
		quoteId: string
		expiresAtMs: number
		transaction: string
		partnerRefs: Record<string, string>
		requoted: boolean
	}> {
		const type = await this.instance()
		if (type === "production" && !this.opts.liveApproved) {
			throw new ProviderError(
				"unsupported",
				"BlindPay production instance is not approved for real money",
			)
		}
		const endpoint: EndpointRef = {
			...input.endpoint,
			partnerRefs: {
				...(input.endpoint.partnerRefs ?? {}),
				[RECEIVER_REF]: input.customerId,
			},
		}
		const funding = this.opts.sandbox ?? {
			customerId: input.customerId,
			bankAccountId: "",
			walletId: "",
		}
		const account = await this.bankAccountFor(endpoint, type, funding)
		const reusable =
			input.existingQuoteId &&
			input.quoteExpiresAtMs !== undefined &&
			input.quoteExpiresAtMs !== null &&
			input.quoteExpiresAtMs > input.nowMs
		let quoteId = reusable ? input.existingQuoteId! : ""
		let expiresAtMs = reusable ? input.quoteExpiresAtMs! : 0
		let requoted = !reusable
		if (!reusable) {
			const network = type === "development" ? "solana_devnet" : "solana"
			const token = type === "development" ? "USDB" : SOURCE_ASSET
			const quote = this.ok(
				await this.call(
					"POST",
					`/v1/instances/${this.opts.instanceId}/quotes`,
					{
						bank_account_id: account.bankAccountId,
						network,
						token,
						currency_type: "receiver",
						request_amount: input.requestAmountHundredths,
						cover_fees: false,
					},
				),
				"payout quote",
			)
			if (typeof quote.id !== "string") {
				throw new Error("BlindPay payout quote returned no id")
			}
			quoteId = quote.id
			expiresAtMs =
				typeof quote.expires_at === "number"
					? quote.expires_at
					: input.nowMs + 5 * 60 * 1000
		}
		const prepared = this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/prepare-delegate-solana`,
				{ owner_address: input.ownerAddress, quote_id: quoteId },
			),
			"delegation",
		)
		if (typeof prepared.transaction !== "string" || prepared.transaction.length === 0) {
			throw new Error("BlindPay delegation returned no transaction")
		}
		return {
			quoteId,
			expiresAtMs,
			transaction: prepared.transaction,
			partnerRefs: {
				[RECEIVER_REF]: input.customerId,
				[BANK_ACCOUNT_REF]: account.bankAccountId,
				...(account.partnerRefs ?? {}),
			},
			requoted,
		}
	}

	/** Creates the Solana payout. `signature` is the delegation transaction signature. */
	async createSenderWalletPayout(input: {
		quoteId: string
		senderWalletAddress: string
		signature: string
		idempotencyKey: string
	}): Promise<{ id: string; status: string }> {
		const type = await this.instance()
		if (type === "production" && !this.opts.liveApproved) {
			throw new ProviderError(
				"unsupported",
				"BlindPay production instance is not approved for real money",
			)
		}
		const payout = this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/payouts/solana`,
				{
					quote_id: input.quoteId,
					sender_wallet_address: input.senderWalletAddress,
					signed_transaction: input.signature,
				},
				input.idempotencyKey,
			),
			"solana payout",
		)
		if (typeof payout.id !== "string") {
			throw new Error("BlindPay payout returned no id")
		}
		const status = typeof payout.status === "string" ? payout.status : "processing"
		return { id: payout.id, status }
	}

	async status(externalRef: string): Promise<ProviderLegState> {
		if (externalRef.startsWith("blindpay-convert:"))
			return { status: "succeeded", externalRef }
		const res = await this.call(
			"GET",
			`/v1/instances/${this.opts.instanceId}/payouts/${encodeURIComponent(externalRef)}`,
		)
		if (res.status === 404)
			throw new ProviderError(
				"unknown_reference",
				`BlindPay has no payout ${externalRef}`,
			)
		const body = this.ok(res, "payout status")
		const raw = typeof body.status === "string" ? body.status : ""
		const status = PAYOUT_STATUS[raw] ?? "processing"
		if (raw === "failed" || raw === "refunded") {
			return {
				status: "failed",
				externalRef,
				error: {
					code: "returned_to_wallet",
					message: "returned to your wallet",
				},
			}
		}
		if (status === "failed") {
			return {
				status,
				externalRef,
				error: { code: "provider_down", message: `BlindPay payout ${raw}` },
			}
		}
		return { status, externalRef }
	}

	async reverse(externalRef: string): Promise<{ externalRef: string }> {
		// The convert step is only a record (the money converts inside the payout), so undoing it moves
		// nothing. A BlindPay payout cannot be pulled back.
		if (externalRef.startsWith("blindpay-convert:"))
			return { externalRef: `${externalRef}:reversed` }
		throw new ProviderError(
			"not_reversible",
			"A BlindPay payout cannot be reversed",
		)
	}

	async health(): Promise<"up" | "down"> {
		const t = this.now()
		if (this.healthCache && t - this.healthCache.at < HEALTH_TTL_MS)
			return this.healthCache.value
		let value: "up" | "down" = "down"
		try {
			const type = await this.instance(true)
			value = type === "production" && !this.opts.liveApproved ? "down" : "up"
		} catch {
			value = "down"
		}
		this.healthCache = { at: t, value }
		return value
	}

	private async instance(refresh = false): Promise<InstanceType> {
		if (this.instanceKind && !refresh) return this.instanceKind
		const body = this.ok(
			await this.call("GET", `/v1/instances/${this.opts.instanceId}`),
			"instance",
		)
		const type: InstanceType =
			body.type === "development" ? "development" : "production"
		this.instanceKind = type
		return type
	}

	private assertServes(kind: string) {
		if (!this.row.legKinds.includes(kind as Provider["legKinds"][number])) {
			throw new ProviderError("unsupported", `BlindPay does not serve ${kind}`)
		}
	}

	private assertCurrency(currency: string) {
		if (!this.row.currencies.includes(currency)) {
			throw new ProviderError(
				"unsupported",
				`BlindPay does not pay out ${currency}`,
			)
		}
	}

	private call(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		idempotencyKey?: string,
	) {
		return jsonRequest(this.fetchImpl, {
			method,
			url: `${this.opts.baseUrl ?? BASE_URL}${path}`,
			headers: {
				Authorization: `Bearer ${this.opts.apiKey}`,
				...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
			},
			body,
		})
	}

	private ok(res: HttpResult, what: string): Record<string, unknown> {
		if (
			res.status >= 200 &&
			res.status < 300 &&
			res.json &&
			typeof res.json === "object"
		) {
			return res.json as Record<string, unknown>
		}
		const message =
			res.json && typeof res.json === "object" && "message" in res.json
				? String((res.json as { message: unknown }).message).slice(0, 200)
				: "no detail"
		throw new Error(`BlindPay ${what} failed (HTTP ${res.status}: ${message})`)
	}
}
