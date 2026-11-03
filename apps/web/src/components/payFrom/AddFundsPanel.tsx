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

/**
 * Hosted Transak staging on-ramp for USDC on Solana into the connected wallet.
 */
export function AddFundsPanel({ walletAddress }: Props) {
	const [country, setCountry] = useState("")
	const blocked = country !== "" && isUnsupportedBuyCountry(country)
	const gate = resolveAddFundsGate(
		readTransakStagingKey(import.meta.env),
		walletAddress,
	)

	const body = blocked ? (
		<p className="form-note" data-testid="add-funds-country-blocked">
			Buying crypto isn&apos;t available in your country yet.
		</p>
	) : gate.status === "unconfigured" ? (
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
				Add funds
			</a>
		</div>
	)

	return (
		<div data-testid="add-funds-panel">
			<Panel
				title="Add funds"
				description="Buy staging USDC on Solana into your connected wallet through Transak. No real money."
				actions={
					<span className="pill pill--test" data-testid="add-funds-test-badge">
						TEST MODE: no real money
					</span>
				}
			>
				<Notice tone="warning" data-testid="add-funds-test-notice">
					TEST MODE: no real money. Staging Transak only — funds are not mainnet
					USDC.
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
				{body}
			</Panel>
		</div>
	)
}
