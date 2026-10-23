import {
	Button,
	EmptyState,
	Grid,
	Notice,
	Page,
	PageHeader,
	PAYMENT_STATUSES,
	Panel,
	SimulatedLabel,
	StaticField,
	StatusBadge,
} from "../components/ui"

export default function PaymentDetail() {
	return (
		<Page>
			<PageHeader
				eyebrow="Payments / demo-payment"
				title="Payment detail"
				description="Status, per-leg progress, settlement reference and the event log. CF1 fills this shell from the API."
				actions={
					<Button variant="secondary" disabled>
						Refresh
					</Button>
				}
			/>

			<Grid>
				<div className="stack">
					<Panel
						title="Payment"
						description="No payment is loaded in the CF0 shell."
						actions={<StatusBadge status="awaiting_funding" />}
					>
						<div className="form-grid">
							<StaticField
								label="Amount"
								value="—"
								hint="Minor units and currency."
							/>
							<StaticField label="Recipient" value="Worker A" />
							<StaticField label="Destination" value="E-wallet · Philippines" />
							<StaticField
								label="Stellar reference"
								value="—"
								hint="Shown when a Stellar settlement exists."
							/>
						</div>
						<Notice>
							This is a layout preview. The values, timeline and event rows are
							populated in CF1; the shell does not invent API data.
						</Notice>
					</Panel>

					<Panel
						title="Timeline"
						description="Legs, attempts and errors appear in order."
					>
						<EmptyState title="No legs yet">
							A payment timeline will show each leg and any retry here.
						</EmptyState>
					</Panel>

					<Panel
						title="Event log"
						description="The API event stream for this payment."
					>
						<EmptyState title="No events yet">
							Events will appear here once a payment exists.
						</EmptyState>
					</Panel>
				</div>

				<div className="stack">
					<Panel
						title="Status key"
						description="One colour language across the three screens."
					>
						<div className="status-list">
							{PAYMENT_STATUSES.map((status) => (
								<StatusBadge key={status} status={status} />
							))}
						</div>
					</Panel>

					<Panel
						title="Settlement"
						description="The settlement adapter is selected by configuration."
						actions={<SimulatedLabel />}
					>
						<div className="form-grid">
							<StaticField label="Adapter" value="Mock settlement" />
							<StaticField label="Reference" value="—" />
						</div>
						<p className="muted">
							Stellar testnet references appear here when the Stellar adapter is
							selected.
						</p>
					</Panel>
				</div>
			</Grid>
		</Page>
	)
}
