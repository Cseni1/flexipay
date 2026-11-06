import type { FlexiPayConfig, ProviderAdapter } from "@flexipay/domain"
import { BlindPayAdapter } from "./blindpay.ts"
import type { FetchLike } from "./http.ts"

export {
	BlindPayAdapter,
	type BlindPayOptions,
	type BlindPaySandboxAccount,
} from "./blindpay.ts"
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
			// Tazapay adapter lands in a follow-up PR (CCR-29); until then the row stays unregistered.
			skipped.push(row.id)
		}
	}
	return { providers, skipped }
}
