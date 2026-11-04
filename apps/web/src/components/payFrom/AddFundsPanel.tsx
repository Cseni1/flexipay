import { lazy, Suspense, useState, type FormEvent } from "react"
import {
	API_WAKE_UP_MESSAGE,
	ApiError,
	createOnrampOrder,
	describeApiError,
	isTransientApiError,
	type OnrampOrder,
} from "../../api/client"
import {
	buildCreateOnrampOrderBody,
	parseOnrampAmountUsd,
	readCrossmintClientKey,
} from "../../onramp/orders"
import { useSession } from "../../providers/SessionProvider"
import {
	ADD_FUNDS_COUNTRY_OPTIONS,
	isUnsupportedBuyCountry,
} from "../../transak/unsupportedCountries"
import {
	readTransakStagingKey,
	resolveAddFundsGate,
} from "../../transak/widgetUrl"
import { Button, Notice, Panel, SelectField, TextField } from "../ui"

const CrossmintCardCheckout = lazy(async () => {
	const mod = await import("./CrossmintCardCheckout")
	return { default: mod.CrossmintCardCheckout }
})

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

function CrossmintOption({
	walletAddress,
	blocked,
}: {
	walletAddress: string | null
	blocked: boolean
}) {
	const { state, viaSession } = useSession()
	const clientKey = readCrossmintClientKey(import.meta.env)
	const [amount, setAmount] = useState("25")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [order, setOrder] = useState<OnrampOrder | null>(null)

	const email =
		state.status === "signed_in" ? state.session.user?.email?.trim() : ""
	const address = walletAddress?.trim() ?? ""

	if (blocked) return null

	const onSubmit = (event: FormEvent) => {
		event.preventDefault()
		setError(null)
		setOrder(null)
		if (!clientKey) return
		if (!address) {
			setError("Connect a wallet first")
			return
		}
		if (!viaSession || !email) {
			setError("Sign in with email to pay with card.")
			return
		}
		const parsed = parseOnrampAmountUsd(amount)
		if (!parsed.ok) {
			setError(parsed.error)
			return
		}
		let body: ReturnType<typeof buildCreateOnrampOrderBody>
		try {
			body = buildCreateOnrampOrderBody({
				walletAddress: address,
				amountUsd: parsed.amountUsd,
			})
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Invalid amount.")
			return
		}
		setBusy(true)
		void createOnrampOrder(body)
			.then((created) => setOrder(created))
			.catch((cause: unknown) => {
				if (isTransientApiError(cause)) {
					setError(API_WAKE_UP_MESSAGE)
					return
				}
				setError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Could not start card checkout.",
				)
			})
			.finally(() => setBusy(false))
	}

	let body
	if (!clientKey) {
		body = (
			<p className="form-note" data-testid="crossmint-unconfigured">
				Add funds isn&apos;t configured
			</p>
		)
	} else if (!address) {
		body = (
			<p className="form-note" data-testid="crossmint-connect-first">
				Connect a wallet first
			</p>
		)
	} else if (order && clientKey && email) {
		body = (
			<Suspense
				fallback={
					<p className="form-note" role="status">
						Loading card checkout…
					</p>
				}
			>
				<CrossmintCardCheckout
					apiKey={clientKey}
					orderId={order.orderId}
					clientSecret={order.clientSecret}
					receiptEmail={email}
				/>
			</Suspense>
		)
	} else {
		body = (
			<form
				className="form-grid"
				onSubmit={onSubmit}
				data-testid="crossmint-card-form"
			>
				<TextField
					label="Amount (USD)"
					inputMode="numeric"
					hint="Whole dollars from 5 to 100."
					value={amount}
					onChange={(event) => setAmount(event.target.value)}
					data-testid="crossmint-amount"
				/>
				{error ? (
					<Notice tone="warning" data-testid="crossmint-error">
						{error}
					</Notice>
				) : null}
				<div className="form-actions">
					<Button
						type="submit"
						disabled={busy}
						data-testid="crossmint-card-submit"
					>
						{busy ? "Starting…" : "Pay with card (Crossmint, test mode)"}
					</Button>
				</div>
			</form>
		)
	}

	return (
		<section className="add-funds-option" data-testid="add-funds-crossmint">
			<div className="coming-soon-item__head">
				<strong>Pay with card (Crossmint, test mode)</strong>
				<span className="pill pill--test" data-testid="crossmint-test-badge">
					TEST
				</span>
			</div>
			<p className="muted">
				Card on-ramp to Solana USDC via Crossmint staging. No real money.
			</p>
			{body}
		</section>
	)
}

/**
 * Add funds: Transak staging link and Crossmint card checkout (test mode).
 * Country blocks apply to both options via unsupportedCountries.
 */
export function AddFundsPanel({ walletAddress }: Props) {
	const [country, setCountry] = useState("")
	const blocked = country !== "" && isUnsupportedBuyCountry(country)

	return (
		<div data-testid="add-funds-panel">
			<Panel
				title="Add funds"
				description="Buy staging USDC on Solana into your connected wallet. Transak or Crossmint card — test mode only."
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
						<CrossmintOption walletAddress={walletAddress} blocked={blocked} />
					</div>
				)}
			</Panel>
		</div>
	)
}
