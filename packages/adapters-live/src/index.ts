import type { FlexiPayConfig, ProviderAdapter } from "@flexipay/domain"
import { BlindPayAdapter } from "./blindpay.ts"
import { TazapayAdapter } from "./tazapay.ts"
import type { FetchLike } from "./http.ts"

export {
	BlindPayAdapter,
	type BlindPayOptions,
	type BlindPaySandboxAccount,
} from "./blindpay.ts"
export { TazapayAdapter, type TazapayOptions } from "./tazapay.ts"
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
					liveApproved: env.FP_TAZAPAY_LIVE_APPROVED === "1",
					fetch: opts.fetch,
				}),
			)
		}
	}
	return { providers, skipped }
}
