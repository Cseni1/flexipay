import { Button, InfoPopover, SimulatedLabel } from "../components/ui"

const receiveOptions = [
	{
		value: "bank",
		title: "Bank account",
		detail: "Local bank payout",
		simulated: true,
	},
	{
		value: "ewallet",
		title: "E-wallet",
		detail: "Mobile wallet payout",
		simulated: true,
	},
	{
		value: "crypto",
		title: "Crypto wallet",
		detail: "Stellar testnet address",
		simulated: false,
	},
]

export default function ClaimPage() {
	return (
		<main className="phone-shell">
			<div className="phone-frame">
				<header className="phone-header">
					<span className="phone-brand">FlexiPay</span>
					<SimulatedLabel />
				</header>

				<div className="stack">
					<div>
						<p className="eyebrow">Payment from Demo Platform</p>
						<h1 className="phone-title">Claim your payment</h1>
						<p className="muted">
							Choose how you want to receive it. This is a testnet build and no
							real money moves.
						</p>
					</div>

					<div className="amount-display">
						<div>
							<span className="amount-display__label">Amount</span>
							<span className="amount-display__value">—</span>
							<span className="amount-display__currency">USDC</span>
						</div>
						<InfoPopover label="Amount and fee">
							The claim amount and the fixed vault fee appear here once the
							claim is loaded from the API.
						</InfoPopover>
					</div>

					<fieldset className="option-list">
						<legend className="field__label">Receive to</legend>
						{receiveOptions.map((option) => (
							<label className="option-card" key={option.value}>
								<input
									type="radio"
									name="receive"
									value={option.value}
									defaultChecked={option.value === "crypto"}
								/>
								<span className="option-card__body">
									<span className="option-card__title">{option.title}</span>
									<span className="option-card__detail">{option.detail}</span>
								</span>
								{option.simulated ? <SimulatedLabel /> : null}
							</label>
						))}
					</fieldset>

					<Button disabled>Accept payment</Button>
					<p className="form-note">
						Claim acceptance is wired in CF4. This screen is the CF0 shell.
					</p>
				</div>
			</div>
		</main>
	)
}
