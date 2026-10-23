import {
	Button,
	EmptyState,
	Grid,
	InfoPopover,
	Page,
	PageHeader,
	Panel,
	SelectField,
	SimulatedLabel,
	StaticField,
	TextField,
} from "../components/ui"

const countries = [
	{ value: "us", label: "United States" },
	{ value: "ph", label: "Philippines" },
	{ value: "br", label: "Brazil" },
	{ value: "za", label: "South Africa" },
]

const destinations = [
	{ value: "bank", label: "Bank account" },
	{ value: "ewallet", label: "E-wallet" },
	{ value: "crypto", label: "Crypto wallet" },
]

export default function SendPayment() {
	return (
		<Page>
			<PageHeader
				eyebrow="Payments"
				title="Send a payment"
				description="Set up a payout, review the chosen route and fund it. The live quote and funding flow arrive with CF1."
			/>

			<Grid>
				<Panel
					title="Payment details"
					description="Inputs for the payout. Nothing is submitted from this shell."
				>
					<div className="form-grid">
						<StaticField
							label="Source"
							value="USD operating account"
							hint="The source account is fixed for the MVP."
						/>
						<SelectField
							id="destination-country"
							label="Destination country"
							options={countries}
							defaultValue="ph"
						/>
						<SelectField
							id="destination-type"
							label="Destination"
							options={destinations}
							defaultValue="ewallet"
						/>
						<TextField
							id="amount"
							label="Amount"
							placeholder="100000000"
							inputMode="numeric"
							hint="Integer minor units; USDC has six decimals."
						/>
						<TextField
							id="recipient"
							label="Recipient"
							placeholder="Worker A"
							autoComplete="off"
						/>
					</div>

					<div className="form-actions">
						<Button disabled>Get quote</Button>
						<span className="form-note">
							Quote creation is wired in CF1 against the A0 contract.
						</span>
					</div>
				</Panel>

				<div className="stack">
					<Panel
						title="Quote"
						description="Route, fees, FX and validity appear here after a quote exists."
						actions={<SimulatedLabel />}
					>
						<EmptyState title="No quote yet">
							The quote panel is ready for the API shape, but no response fields
							are invented in CF0.
						</EmptyState>
					</Panel>

					<Panel
						title="Why this route?"
						description="Eligibility comes before price. Excluded alternatives stay visible."
						actions={
							<InfoPopover label="Route selection">
								The router first removes ineligible corridors, then compares the
								remaining providers. CF1 renders the chosen route and every
								exclusion reason.
							</InfoPopover>
						}
					>
						<p className="muted">
							The route explanation will list the chosen rail and why other
							options were excluded.
						</p>
					</Panel>
				</div>
			</Grid>
		</Page>
	)
}
