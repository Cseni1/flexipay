import { formatMoney } from "@flexipay/web-lib"
import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import {
	AUTH_NOT_CONFIGURED_MESSAGE,
	ApiError,
	describeApiError,
	fundPayment,
	isAuthRequired,
} from "../api/client"
import { EventLog } from "../components/payments/EventLog"
import { LegTimeline } from "../components/payments/LegTimeline"
import {
	Button,
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
import { usePaymentDetail } from "../hooks/usePaymentDetail"

const POLLING_STATUSES = new Set(["funded", "processing", "refunding"])

const formatTimestamp = (iso: string): string =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(iso))

export default function PaymentDetail() {
	const { paymentId } = useParams<{ paymentId: string }>()
	const { payment, error, loading, refresh } = usePaymentDetail(paymentId)
	const [funding, setFunding] = useState(false)
	const [fundError, setFundError] = useState<string | null>(null)
	const [fundAuthBlocked, setFundAuthBlocked] = useState(false)
	const fundLock = useRef(false)
	const fundAbort = useRef<AbortController | null>(null)

	useEffect(() => () => fundAbort.current?.abort(), [])

	const authBlocked = fundAuthBlocked || isAuthRequired(error)

	const handleFund = async () => {
		if (!payment || fundLock.current || authBlocked) return
		if (payment.status !== "awaiting_funding" && payment.status !== "quoted")
			return
		fundLock.current = true
		setFunding(true)
		setFundError(null)
		const controller = new AbortController()
		fundAbort.current = controller
		try {
			await fundPayment(payment.id, `fund-${payment.id}`, controller.signal)
			refresh()
		} catch (cause) {
			if (controller.signal.aborted) return
			if (isAuthRequired(cause)) setFundAuthBlocked(true)
			setFundError(
				cause instanceof ApiError
					? `Funding failed: ${describeApiError(cause)}`
					: "Funding failed. Try again.",
			)
		} finally {
			if (!controller.signal.aborted) {
				setFunding(false)
				fundLock.current = false
			}
		}
	}

	const status = payment?.status
	const firstLeg = payment?.legs[0]
	const settleLeg = payment?.legs.find((leg) => leg.kind === "settle")
	const lastLeg = payment?.legs.at(-1)
	const canFund =
		(status === "awaiting_funding" || status === "quoted") && !authBlocked
	const polling = status ? POLLING_STATUSES.has(status) : false

	return (
		<Page>
			<PageHeader
				eyebrow={`Payments / ${paymentId ?? "unknown"}`}
				title="Payment detail"
				description="Status, per-leg progress, settlement reference and the event log. The screen polls only while the payment is moving."
				actions={
					<Button variant="secondary" onClick={refresh} disabled={loading}>
						Refresh
					</Button>
				}
			/>

			<Notice tone="warning">{AUTH_NOT_CONFIGURED_MESSAGE}</Notice>

			{error && !payment ? (
				<Panel title="Payment">
					<Notice tone="warning">{describeApiError(error)}</Notice>
					<div className="form-actions">
						<Button variant="secondary" onClick={refresh}>
							Retry
						</Button>
					</div>
				</Panel>
			) : null}

			{loading && !payment ? (
				<Panel title="Payment">
					<p className="muted" role="status">
						Loading payment…
					</p>
				</Panel>
			) : null}

			{payment ? (
				<Grid>
					<div className="stack">
						<Panel
							title="Payment"
							description={
								polling
									? "Updating every two seconds while it moves."
									: undefined
							}
							actions={<StatusBadge status={payment.status} />}
							footer={
								canFund ? (
									<div className="form-actions">
										{" "}
										<Button
											onClick={() => void handleFund()}
											disabled={funding || authBlocked}
										>
											{funding ? "Funding…" : "Fund payment"}
										</Button>
										<span className="form-note">
											Funding runs the route; a second click is ignored.
										</span>
									</div>
								) : undefined
							}
						>
							{error ? (
								<Notice tone="warning">{describeApiError(error)}</Notice>
							) : null}
							{fundError ? <Notice tone="warning">{fundError}</Notice> : null}
							<div className="form-grid">
								<StaticField
									label="Amount"
									value={
										firstLeg
											? formatMoney(
													firstLeg.amountIn.amount,
													firstLeg.amountIn.currency,
												)
											: "—"
									}
									hint="First leg amount in."
								/>
								<StaticField
									label="Recipient"
									value={
										<code className="code-text">{payment.recipientId}</code>
									}
								/>
								<StaticField
									label="Delivery"
									value={
										payment.delivery === "claim_link" ? "Claim link" : "Direct"
									}
								/>
								<StaticField
									label="Reference"
									value={payment.reference ?? "—"}
								/>
								<StaticField
									label="Created"
									value={formatTimestamp(payment.createdAt)}
								/>
								<StaticField
									label="Updated"
									value={formatTimestamp(payment.updatedAt)}
								/>
								<StaticField
									label="Quote"
									value={<code className="code-text">{payment.quoteId}</code>}
								/>
								<StaticField
									label="Route ends at"
									value={lastLeg ? lastLeg.rail : "—"}
								/>
							</div>

							{payment.claimLink ? (
								<Notice>
									Claim link ready until{" "}
									{formatTimestamp(payment.claimLink.expiresAt)}:{" "}
									<a
										href={payment.claimLink.url}
										target="_blank"
										rel="noreferrer"
									>
										open claim page
									</a>
								</Notice>
							) : null}

							{payment.legs.some((leg) => leg.simulated) ? (
								<SimulatedLabel />
							) : null}
						</Panel>

						<Panel
							title="Timeline"
							description="Legs run in order. Errors and retry evidence appear in the event log."
						>
							<LegTimeline legs={payment.legs} />
						</Panel>

						<Panel
							title="Event log"
							description="The API event stream for this payment."
						>
							<EventLog events={payment.events} />
						</Panel>
					</div>

					<div className="stack">
						<Panel
							title="Settlement"
							description="The settlement reference is shown only when a settle leg exists."
							actions={settleLeg?.simulated ? <SimulatedLabel /> : undefined}
						>
							<div className="form-grid">
								<StaticField
									label="Adapter"
									value={settleLeg ? settleLeg.providerId : "No settlement leg"}
								/>
								<StaticField
									label="Payout id"
									value={
										settleLeg?.externalRef ? (
											<code className="code-text">{settleLeg.externalRef}</code>
										) : (
											"—"
										)
									}
									hint="Vault payout id; never a transaction hash."
								/>
								<StaticField
									label="Lock transaction"
									value={
										settleLeg?.lockTxRef ? (
											<code className="code-text">{settleLeg.lockTxRef}</code>
										) : (
											"—"
										)
									}
									hint="LockResult transaction hash."
								/>
								<StaticField
									label="Release transaction"
									value={
										settleLeg?.releaseTxRef ? (
											<code className="code-text">
												{settleLeg.releaseTxRef}
											</code>
										) : (
											"—"
										)
									}
									hint="Release or refund transaction hash."
								/>
							</div>
							{!settleLeg ? (
								<p className="muted">
									This route ends at a payout or domestic rail, so there is no
									on-chain settlement reference.
								</p>
							) : null}
						</Panel>

						<Panel
							title="Status key"
							description="One colour language across the three screens."
						>
							<div className="status-list">
								{PAYMENT_STATUSES.map((statusValue) => (
									<StatusBadge key={statusValue} status={statusValue} />
								))}
							</div>
						</Panel>
					</div>
				</Grid>
			) : null}
		</Page>
	)
}
