import { type ClaimLinkHandle } from "@flexipay/web-lib/contract"
import { useEffect, useRef, useState } from "react"
import { useLocation, useParams } from "react-router-dom"
import {
	ApiError,
	describeApiError,
	fundPayment,
	isAuthRequired,
	isTransientApiError,
} from "../api/client"
import { getSolanaConfig } from "../api/solanaClient"
import { aboutDaysLeft, formatClaimValidUntil } from "../claim/expiry"
import { ApiWakeUpNotice } from "../components/ApiWakeUpNotice"
import { AuthBlockedNotice } from "../components/AuthBlockedNotice"
import { CopyableValue } from "../components/CopyableValue"
import { EventLog } from "../components/payments/EventLog"
import { LegTimeline } from "../components/payments/LegTimeline"
import { PaymentFromToCard } from "../components/payments/PaymentFromToCard"
import { PaymentReceipt } from "../components/payments/PaymentReceipt"
import { PaymentTimestamp } from "../components/payments/PaymentTimestamp"
import { SolanaPayPanel } from "../components/solana/SolanaPayPanel"
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
import { usePaymentSaving } from "../hooks/usePaymentSaving"
import {
	primaryEndpoint,
	recipientDisplayName,
	useRecipientDirectory,
} from "../hooks/useRecipientDirectory"
import { useWakeUpRetry } from "../hooks/useWakeUpRetry"
import { formatPaymentSavingLine } from "../payments/aggregatorSaving"
import { paymentMilestoneTimes } from "../payments/paymentEventTimes"
import { providerLabel } from "../payments/providerNames"
import { displayMoney } from "../payments/quoteDisplay"
import { clearSolanaTransfer } from "../payments/solanaTransferStorage"
import { useSession } from "../providers/SessionProvider"

const solanaExplorerUrl = (
	template: string | undefined,
	signature: string,
): string => {
	if (template?.includes("{signature}")) {
		return template.replaceAll("{signature}", signature)
	}
	return `https://explorer.solana.com/tx/${signature}?cluster=devnet`
}

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
			<p className="field__label">Share this link with the recipient</p>
			<input
				className="field__control claim-share__input"
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
			<Notice data-testid="claim-link-expiry">
				{(() => {
					const remaining = aboutDaysLeft(link.expiresAt)
					return (
						<>
							This link is shown once. Copy it now: it can&apos;t be shown again
							once you close this tab or open the payment elsewhere. Valid until{" "}
							{formatClaimValidUntil(link.expiresAt)}
							{remaining ? ` · ${remaining}` : ""}.
						</>
					)
				})()}
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
	const { payment, error, loading, polling, refresh } =
		usePaymentDetail(paymentId)
	const saving = usePaymentSaving(payment)
	const { waking, exhausted, attempt, retryNow } = useWakeUpRetry({
		error,
		hasData: payment !== null,
		onRetry: refresh,
	})
	const { state: sessionState } = useSession()
	const { names, endpointsByRecipient } = useRecipientDirectory()
	const [funding, setFunding] = useState(false)
	const [fundError, setFundError] = useState<string | null>(null)
	const [fundAuthBlocked, setFundAuthBlocked] = useState(false)
	const [solanaExplorerTemplate, setSolanaExplorerTemplate] = useState<
		string | null
	>(null)
	const fundLock = useRef(false)
	const fundAbort = useRef<AbortController | null>(null)

	useEffect(() => () => fundAbort.current?.abort(), [])

	useEffect(() => {
		const controller = new AbortController()
		getSolanaConfig(controller.signal)
			.then((cfg) => setSolanaExplorerTemplate(cfg.explorerTxUrlTemplate))
			.catch(() => {
				/* optional — detail still shows raw releaseTxRef */
			})
		return () => controller.abort()
	}, [])

	useEffect(() => {
		if (payment?.status === "paid") {
			clearSolanaTransfer(payment.id)
		}
	}, [payment?.status, payment?.id])

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
			// The route may have run part-way before the error; show the payment as it really is.
			if (!isAuthRequired(cause)) refresh()
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
	const milestones = payment
		? paymentMilestoneTimes(payment.events)
		: { created: null, funded: null, paid: null }
	const createdAtIso = milestones.created ?? payment?.createdAt ?? null
	const canFund =
		(status === "awaiting_funding" || status === "quoted") && !authBlocked
	const orgName =
		sessionState.status === "signed_in"
			? sessionState.session.organization.name
			: null
	const senderName =
		orgName?.trim() || payment?.organizationId || "Sending organisation"
	const recipientName = payment
		? recipientDisplayName(names, payment.recipientId)
		: "—"
	const destinationEndpoint = payment
		? primaryEndpoint(endpointsByRecipient, payment.recipientId)
		: null

	return (
		<Page>
			<PageHeader
				eyebrow={`Payments / ${paymentId ?? "unknown"}`}
				title="Payment detail"
				description="Journey, cost breakdown, settlement reference and the event log. While a partner payout is processing, this screen refreshes every 10 seconds for up to 15 minutes."
				actions={
					<Button variant="secondary" onClick={refresh} disabled={loading}>
						Refresh
					</Button>
				}
			/>

			{authBlocked ? <AuthBlockedNotice /> : null}

			{error && !payment && waking ? (
				<Panel title="Payment">
					<ApiWakeUpNotice
						onRetry={retryNow}
						attempt={attempt}
						busy={loading}
						exhausted={exhausted}
					/>
				</Panel>
			) : null}

			{error && !payment && !waking ? (
				<Panel title="Payment">
					<Notice tone="warning">
						{isTransientApiError(error)
							? error.message
							: describeApiError(error)}
					</Notice>
					<div className="form-actions">
						<Button variant="secondary" onClick={refresh}>
							Retry
						</Button>
					</div>
				</Panel>
			) : null}

			{loading && !payment && !error ? (
				<Panel title="Payment">
					<p className="muted" role="status">
						Loading payment…
					</p>
				</Panel>
			) : null}

			{payment ? (
				<Grid>
					<div className="stack">
						<PaymentFromToCard
							senderName={senderName}
							recipientName={recipientName}
							events={payment.events}
							endpoint={destinationEndpoint}
						/>
						<Panel
							title="Payment"
							description={
								polling
									? "Checking every 10 seconds while a leg is with the partner."
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
											data-testid="fund-payment"
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
											? displayMoney(
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
										payment.recipientId ? (
											<CopyableValue
												value={payment.recipientId}
												label="Copy recipient id"
											/>
										) : (
											"—"
										)
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
									value={
										<PaymentTimestamp
											iso={createdAtIso}
											data-testid="payment-created-at"
										/>
									}
								/>
								{milestones.funded ? (
									<StaticField
										label="Funded"
										value={
											<PaymentTimestamp
												iso={milestones.funded}
												data-testid="payment-funded-at"
											/>
										}
									/>
								) : null}
								{milestones.paid ? (
									<StaticField
										label="Paid"
										value={
											<PaymentTimestamp
												iso={milestones.paid}
												data-testid="payment-paid-at"
											/>
										}
									/>
								) : null}
								<StaticField
									label="Quote"
									value={
										<CopyableValue
											value={payment.quoteId}
											label="Copy quote id"
										/>
									}
								/>
								<StaticField
									label="Route ends at"
									value={
										lastLeg
											? providerLabel(lastLeg.providerId || lastLeg.rail)
											: "—"
									}
								/>
								{saving ? (
									<StaticField
										label="Aggregator saving"
										value={
											<span data-testid="payment-saving">
												{formatPaymentSavingLine(saving)}
											</span>
										}
									/>
								) : null}
							</div>

							{claimLink ? (
								<ClaimLinkShare link={claimLink} />
							) : payment.delivery === "claim_link" ? (
								<Notice data-testid="claim-link-gone">
									The claim link was shown once when the payment was created and
									can&apos;t be shown again.
								</Notice>
							) : null}

							{payment.status === "processing" &&
							settleLeg &&
							settleLeg.status === "processing" &&
							!settleLeg.releaseTxRef ? (
								<SolanaPayPanel
									paymentId={payment.id}
									onPaid={() => refresh()}
								/>
							) : null}

							{payment.status === "paid" && settleLeg?.releaseTxRef ? (
								<PaymentReceipt
									payment={payment}
									signature={settleLeg.releaseTxRef}
									explorerUrl={solanaExplorerUrl(
										solanaExplorerTemplate ?? undefined,
										settleLeg.releaseTxRef,
									)}
								/>
							) : null}

							{payment.legs.some((leg) => leg.simulated) ? (
								<SimulatedLabel />
							) : null}
						</Panel>

						<Panel
							title="Timeline"
							description="Journey of this payment: legs run in order. Errors and retry evidence appear in the event log."
						>
							<LegTimeline
								legs={payment.legs}
								events={payment.events}
								polling={polling}
							/>
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
									value={
										settleLeg
											? providerLabel(settleLeg.providerId)
											: "No settlement leg"
									}
								/>
								<StaticField
									label="Payout id"
									value={
										settleLeg?.externalRef ? (
											<CopyableValue
												value={settleLeg.externalRef}
												label="Copy payout id"
											/>
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
											<CopyableValue
												value={settleLeg.lockTxRef}
												label="Copy lock transaction"
											/>
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
											<CopyableValue
												value={settleLeg.releaseTxRef}
												label="Copy release transaction"
											/>
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
