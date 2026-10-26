import { formatMoney } from "@flexipay/web-lib"
import { type ClaimLinkHandle } from "@flexipay/web-lib/contract"
import { useEffect, useRef, useState } from "react"
import { useLocation, useParams } from "react-router-dom"
import {
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

// The API returns the claim token only on create. Map its /v1/claims/{token} path onto the
// browser claim route; never persist or log the token.
const claimPageHref = (link: ClaimLinkHandle): string => {
	try {
		const token = new URL(link.url, window.location.origin).pathname
			.split("/")
			.filter(Boolean)
			.at(-1)
		return token ? `/claim/${encodeURIComponent(token)}` : link.url
	} catch {
		return link.url
	}
}

const absoluteClaimUrl = (link: ClaimLinkHandle): string => {
	try {
		return new URL(claimPageHref(link), window.location.origin).toString()
	} catch {
		return link.url
	}
}

// The claim token is a bearer secret and is never stored or logged: it lives only in the
// navigation state from create and in this component's props.
function ClaimLinkShare({ link }: { link: ClaimLinkHandle }) {
	const url = absoluteClaimUrl(link)
	const [copied, setCopied] = useState<"idle" | "copied" | "blocked">("idle")
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url)
			setCopied("copied")
		} catch {
			// Clipboard blocked: the field below is read-only text the user can select.
			setCopied("blocked")
		}
	}
	return (
		<div className="claim-share" data-testid="claim-link-share">
			<p className="field-label">Share this link with the recipient</p>
			<input
				className="text-field__input"
				readOnly
				value={url}
				aria-label="Claim link"
				data-testid="claim-link-url"
				onFocus={(event) => event.currentTarget.select()}
			/>
			<div className="form-actions">
				<Button type="button" variant="secondary" onClick={() => void copy()}>
					Copy link
				</Button>
				<a href={claimPageHref(link)} target="_blank" rel="noreferrer">
					open claim page
				</a>
				<span role="status" aria-live="polite" className="form-note">
					{copied === "copied"
						? "Copied"
						: copied === "blocked"
							? "Copy blocked by the browser: select the link above and copy it."
							: ""}
				</span>
			</div>
			<Notice>
				This link is shown once. Copy it now: it can&apos;t be shown again once
				you close this tab or open the payment elsewhere. It expires{" "}
				{formatTimestamp(link.expiresAt)}.
			</Notice>
		</div>
	)
}

export default function PaymentDetail() {
	const { paymentId } = useParams<{ paymentId: string }>()
	const location = useLocation()
	const handedOffClaimLink =
		(location.state as { claimLink?: ClaimLinkHandle | null } | null)
			?.claimLink ?? null
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
	const claimLink = payment?.claimLink ?? handedOffClaimLink
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

			{authBlocked ? (
				<Notice tone="warning">
					The local API proxy could not authenticate. Set the server-side
					FP_API_KEY for Vite, then restart the dev server.
				</Notice>
			) : null}

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

							{claimLink ? (
								<ClaimLinkShare link={claimLink} />
							) : payment.delivery === "claim_link" ? (
								<Notice data-testid="claim-link-gone">
									The claim link was shown once when the payment was created and
									can&apos;t be shown again.
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
