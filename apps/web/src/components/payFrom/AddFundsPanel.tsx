import { useState } from "react"
import {
	ADD_FUNDS_COUNTRY_OPTIONS,
	isUnsupportedBuyCountry,
} from "../../transak/unsupportedCountries"
import {
	readTransakStagingKey,
	resolveAddFundsGate,
} from "../../transak/widgetUrl"
import { Notice, Panel, SelectField } from "../ui"

type Props = {
	/** Connected Solana wallet address, if any. */
	walletAddress: string | null
}

function TransakOption({
	walletAddress,
	blocked,
}: {
	walletAddress: string | null
	blocked: boolean
}) {
	const gate = resolveAddFundsGate(
		readTransakStagingKey(import.meta.env),
		walletAddress,
	)

	if (blocked) return null

	const body =
		gate.status === "unconfigured" ? (
			<p className="form-note" data-testid="add-funds-unconfigured">
				Add funds isn&apos;t configured
			</p>
		) : gate.status === "connect_first" ? (
			<p className="form-note" data-testid="add-funds-connect-first">
				Connect a wallet first
			</p>
		) : (
			<div className="form-actions">
				<a
					className="button button--primary"
					href={gate.url}
					target="_blank"
					rel="noreferrer"
					data-testid="add-funds-open"
				>
					Add funds with Transak
				</a>
			</div>
		)

	return (
		<section className="add-funds-option" data-testid="add-funds-transak">
			<div className="coming-soon-item__head">
				<strong>Transak (staging)</strong>
				<span className="pill pill--test">TEST</span>
			</div>
			<p className="muted">Buy staging USDC on Solana into your wallet.</p>
			{body}
		</section>
	)
}

/**
 * Add funds: Transak staging link (test mode). Crossmint card checkout was removed on
 * 7 Nov 2026 after Crossmint declined the application.
 * Country blocks apply via unsupportedCountries.
 */
export function AddFundsPanel({ walletAddress }: Props) {
	const [country, setCountry] = useState("")
	const blocked = country !== "" && isUnsupportedBuyCountry(country)

	return (
		<div data-testid="add-funds-panel">
			<Panel
				title="Add funds"
				description="Buy staging USDC on Solana into your connected wallet with Transak — test mode only."
				actions={
					<span className="pill pill--test" data-testid="add-funds-test-badge">
						TEST MODE: no real money
					</span>
				}
			>
				<Notice tone="warning" data-testid="add-funds-test-notice">
					TEST MODE: no real money. Staging partners only — funds are not
					mainnet USDC.
				</Notice>
				<SelectField
					label="Where are you buying from?"
					data-testid="add-funds-country"
					value={country}
					onChange={(event) => setCountry(event.target.value)}
					options={[
						{ value: "", label: "Select a country" },
						...ADD_FUNDS_COUNTRY_OPTIONS,
					]}
				/>
				{blocked ? (
					<p className="form-note" data-testid="add-funds-country-blocked">
						Buying crypto isn&apos;t available in your country yet.
					</p>
				) : (
					<div className="stack">
						<TransakOption walletAddress={walletAddress} blocked={blocked} />
					</div>
				)}
			</Panel>
		</div>
	)
}
