import type { FlexiPayConfig, ProviderAdapter } from "@flexipay/domain"
import { BlindPayAdapter } from "./blindpay.ts"
import { TazapayAdapter } from "./tazapay.ts"
import {
	DUE_PRODUCTION_BASE_URL,
	DUE_SANDBOX_BASE_URL,
	DueAdapter,
} from "./due.ts"
import type { FetchLike } from "./http.ts"

export {
	BlindPayAdapter,
	type BlindPayOptions,
	type BlindPaySandboxAccount,
	type UploadFetch,
} from "./blindpay.ts"
export { TazapayAdapter, type TazapayOptions } from "./tazapay.ts"
export {
	DueAdapter,
	DUE_FUNDING_GRACE_MS,
	decimalToMinor,
	DUE_PRODUCTION_BASE_URL,
	DUE_SANDBOX_BASE_URL,
	type DueOptions,
} from "./due.ts"
export {
	JupiterClient,
	JupiterError,
	JUPITER_KEYED_BASE,
	JUPITER_LITE_BASE,
	type JupiterExactOutQuote,
	type JupiterOptions,
} from "./jupiter.ts"
export type { FetchLike } from "./http.ts"

export interface LiveProviders {
	providers: Map<string, ProviderAdapter>
	/** Partner rows in config that were NOT registered because their keys are missing. */
	skipped: string[]
}

type Env = Record<string, string | undefined>

function value(env: Env, name: string): string | undefined {
	const v = env[name]?.trim()
	return v ? v : undefined
}

/**
 * CCR-29: builds a partner adapter for each config row whose `implementation` names a partner,
 * only when that partner's keys are present. A row without keys is skipped (routing then reports
 * the provider as not registered), so a missing key never breaks the API.
 */
export function createLiveProviders(
	config: FlexiPayConfig,
	env: Env,
	opts: { fetch?: FetchLike } = {},
): LiveProviders {
	const providers = new Map<string, ProviderAdapter>()
	const skipped: string[] = []

	for (const row of config.providers) {
		if (row.implementation === "blindpay") {
			const apiKey = value(env, "BLINDPAY_API_KEY")
			const instanceId = value(env, "BLINDPAY_INSTANCE_ID")
			if (!apiKey || !instanceId) {
				skipped.push(row.id)
				continue
			}
			const customerId = value(env, "BLINDPAY_SANDBOX_CUSTOMER_ID")
			const bankAccountId = value(env, "BLINDPAY_SANDBOX_BANK_ACCOUNT_ID")
			const walletId = value(env, "BLINDPAY_SANDBOX_WALLET_ID")
			providers.set(
				row.id,
				new BlindPayAdapter(row, {
					apiKey,
					instanceId,
					sandbox:
						customerId && bankAccountId && walletId
							? { customerId, bankAccountId, walletId }
							: null,
					liveApproved: env.FP_BLINDPAY_LIVE_APPROVED === "1",
					fetch: opts.fetch,
				}),
			)
		} else if (row.implementation === "tazapay") {
			const apiKey = value(env, "TAZAPAY_API_KEY")
			const apiSecret = value(env, "TAZAPAY_API_SECRET")
			const lowBalance = value(env, "TAZAPAY_LOW_BALANCE_ALERT")
			if (!apiKey || !apiSecret) {
				skipped.push(row.id)
				continue
			}
			providers.set(
				row.id,
				new TazapayAdapter(row, {
					apiKey,
					apiSecret,
					baseUrl: value(env, "TAZAPAY_BASE_URL"),
					sandboxBeneficiaryId:
						value(env, "TAZAPAY_SANDBOX_BENEFICIARY_ID") ?? null,
					beneficiaryEmail: value(env, "TAZAPAY_BENEFICIARY_EMAIL"),
					purposeCode: value(env, "TAZAPAY_PURPOSE_CODE"),
					defaultHoldingCurrency: value(env, "TAZAPAY_HOLDING_CURRENCY"),
					lowBalanceAlert:
						lowBalance && /^\d+$/.test(lowBalance)
							? BigInt(lowBalance)
							: undefined,
					liveApproved: env.FP_TAZAPAY_LIVE_APPROVED === "1",
					fetch: opts.fetch,
				}),
			)
		} else if (row.implementation === "due") {
			// CCR-50: production keys win over sandbox keys; production is still refused at call
			// time unless FP_DUE_LIVE_APPROVED=1.
			const liveKey = value(env, "DUE_API_KEY")
			const liveAccount = value(env, "DUE_ACCOUNT_ID")
			const sandboxKey = value(env, "DUE_SANDBOX_API_KEY")
			const sandboxAccount = value(env, "DUE_SANDBOX_ACCOUNT_ID")
			const live = liveKey && liveAccount
			const apiKey = live ? liveKey : sandboxKey
			const accountId = live ? liveAccount : sandboxAccount
			if (!apiKey || !accountId) {
				skipped.push(row.id)
				continue
			}
			providers.set(
				row.id,
				new DueAdapter(row, {
					apiKey,
					accountId,
					baseUrl:
						value(env, "DUE_BASE_URL") ??
						(live ? DUE_PRODUCTION_BASE_URL : DUE_SANDBOX_BASE_URL),
					senderWallet: value(env, "DUE_SENDER_WALLET"),
					solanaRail: value(env, "DUE_SOLANA_RAIL"),
					purposeCode: value(env, "DUE_PURPOSE_CODE"),
					liveApproved: env.FP_DUE_LIVE_APPROVED === "1",
					fetch: opts.fetch,
				}),
			)
		}
	}
	return { providers, skipped }
}
