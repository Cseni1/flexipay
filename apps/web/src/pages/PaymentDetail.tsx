import { type ClaimLinkHandle } from "@flexipay/web-lib/contract"
import { type ReactNode, useEffect, useRef, useState } from "react"
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
import { BlindpaySenderPanel } from "../components/solana/BlindpaySenderPanel"
import { SolanaPayPanel } from "../components/solana/SolanaPayPanel"
import {
	Button,
	Notice,
	Page,
	PageHeader,
	PAYMENT_STATUSES,
	Panel,
	SimulatedLabel,
	StaticField,
	StatusBadge,
} from "../components/ui"
import { Icon, type IconName } from "../components/ui/Icon"
import { usePaymentDetail } from "../hooks/usePaymentDetail"
import { usePaymentQuote } from "../hooks/usePaymentSaving"
import {
	primaryEndpoint,
	recipientDisplayName,
	useRecipientDirectory,
} from "../hooks/useRecipientDirectory"
import { useWakeUpRetry } from "../hooks/useWakeUpRetry"
import { formatPaymentSavingLine } from "../payments/aggregatorSaving"
import { friendlyPayoutLegError } from "../payments/bankDetails"
import { paymentMilestoneTimes } from "../payments/paymentEventTimes"
import {
	initialsOf,
	paymentHeadline,
	paymentProgress,
	type ProgressStep,
} from "../payments/paymentProgress"
import { providerLabel } from "../payments/providerNames"
import { displayFeesTotal, displayMoney } from "../payments/quoteDisplay"
import { isSolanaSettleRail } from "../payments/solanaRails"
import { clearSolanaTransfer } from "../payments/solanaTransferStorage"
import { useSession } from "../providers/SessionProvider"
import "../styles/pages/detail.css"

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
			<p className="field__label">
				Send this link to the person you are paying
			</p>
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

const STEP_ICON: Partial<Record<ProgressStep["state"], IconName>> = {
	done: "check",
	stopped: "close",
}

function ProgressTracker({ steps }: { steps: ProgressStep[] }) {
	return (
		<ol
			className="detail-progress"
			aria-label="Progress"
			data-testid="payment-progress"
		>
			{steps.map((step, index) => {
				const icon =
					step.key === "end" && step.label === "Money returned to you"
						? "back"
						: STEP_ICON[step.state]
				return (
					<li
						key={step.key}
						className={`detail-progress__step detail-progress__step--${step.state}`}
						data-state={step.state}
						aria-current={step.state === "current" ? "step" : undefined}
					>
						<span className="detail-progress__dot" aria-hidden="true">
							{icon ? <Icon name={icon} size={16} /> : index + 1}
						</span>
						<span className="detail-progress__label">{step.label}</span>
					</li>
				)
			})}
		</ol>
	)
}

function CostRow({
	label,
	value,
	strong = false,
	testId,
}: {
	label: string
	value: ReactNode
	strong?: boolean
	testId?: string
}) {
	return (
		<div
			className={`detail-costs__row${strong ? " detail-costs__row--total" : ""}`}
		>
			<dt>{label}</dt>
			<dd data-testid={testId}>{value}</dd>
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
	const { quote, saving } = usePaymentQuote(payment)
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
	const refundTxRef = payment?.refundTxRef ?? null
	const lastLeg = payment?.legs.at(-1)
	const milestones = payment
		? paymentMilestoneTimes(payment.events)
		: { created: null, funded: null, paid: null }
	const createdAtIso = milestones.created ?? payment?.createdAt ?? null
	const senderWalletSettle = settleLeg?.rail === "sender_wallet_blindpay"
	const payoutLeg = payment?.legs.find((leg) => leg.kind === "payout")
	const canFund =
		(status === "awaiting_funding" || status === "quoted") &&
		!authBlocked &&
		!senderWalletSettle
	const showBlindpay =
		senderWalletSettle &&
		!payoutLeg?.externalRef &&
		(status === "awaiting_funding" ||
			status === "processing" ||
			status === "funded")
	const showSolanaPay =
		status === "processing" &&
		!!settleLeg &&
		isSolanaSettleRail(settleLeg.rail) &&
		settleLeg.status === "processing" &&
		!settleLeg.releaseTxRef
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

	const senderActionNeeded = showSolanaPay || !!showBlindpay
	const steps = payment
		? paymentProgress({
				status: payment.status,
				legs: payment.legs,
				funded: milestones.funded !== null,
				senderActionNeeded,
			})
		: []
	const paidIn = steps[0]?.key === "pay" && steps[0].state === "done"
	const delivered = status === "paid"
	const stopped = steps.some((step) => step.state === "stopped")
	const youPay = firstLeg
		? displayMoney(firstLeg.amountIn.amount, firstLeg.amountIn.currency)
		: "—"
	const receiveMoney = lastLeg?.amountOut ?? quote?.expectedReceive ?? null
	const theyGet = receiveMoney
		? displayMoney(receiveMoney.amount, receiveMoney.currency)
		: "—"
	const feeText = quote ? displayFeesTotal(quote.fees) : null
	const rateText =
		quote?.fxRate && quote.source.currency !== quote.destination.currency
			? `1 ${quote.source.currency} = ${quote.fxRate} ${quote.destination.currency}`
			: null
	const problem = payment?.legs.find((leg) => leg.error)?.error ?? null
	const problemText = problem
		? (friendlyPayoutLegError(problem.message) ?? problem.message)
		: null
	const simulated = payment?.legs.some((leg) => leg.simulated) ?? false

	const action: { icon: IconName; title: string; text: string } | null =
		!payment
			? null
			: canFund
				? {
						icon: "wallet",
						title: "Pay to send your money",
						text: `${recipientName} gets ${theyGet} once you pay ${youPay}.`,
					}
				: showSolanaPay
					? {
							icon: "wallet",
							title: "Pay from your wallet",
							text: "Send the amount below from your wallet. We take it from there.",
						}
					: showBlindpay
						? {
								icon: "shield",
								title: "Approve in your wallet",
								text: "Connect your wallet and approve the payment. We send it to their bank.",
							}
						: claimLink
							? {
									icon: "link",
									title: "Send them the claim link",
									text: "They open the link and choose how to get the money.",
								}
							: null

	return (
		<Page>
			<div className="detail">
				<PageHeader
					eyebrow="Payments"
					title="Payment details"
					description={
						payment
							? "Everything about this payment in one place. This page updates by itself while your money is moving."
							: undefined
					}
					actions={
						<Button variant="secondary" onClick={refresh} disabled={loading}>
							<Icon name="back" size={16} />
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
					<>
						<section
							className="hero detail-hero"
							data-testid="payment-summary"
							data-status={payment.status}
							aria-label="Payment summary"
						>
							<div className="detail-hero__top">
								<div className="person detail-hero__person">
									<span className="person__avatar detail-hero__avatar">
										{initialsOf(recipientName)}
									</span>
									<span className="detail-hero__who">
										<span className="detail-hero__kicker">
											{delivered
												? "Sent to"
												: stopped
													? "Payment to"
													: "Sending to"}
										</span>
										<span className="detail-hero__name">{recipientName}</span>
									</span>
								</div>
								<div className="detail-hero__badges">
									{simulated ? (
										<SimulatedLabel>Simulated</SimulatedLabel>
									) : null}
									<StatusBadge status={payment.status} />
								</div>
							</div>

							<div className="detail-hero__money">
								{stopped ? (
									<>
										<p className="detail-hero__label">Payment amount</p>
										<p
											className="detail-hero__amount"
											data-testid="payment-summary-send"
										>
											{youPay}
										</p>
										<p className="detail-hero__paid">
											{recipientName} would have got{" "}
											<strong data-testid="payment-summary-receive">
												{theyGet}
											</strong>
										</p>
									</>
								) : (
									<>
										<p className="detail-hero__label">
											{delivered ? "They got" : "They get"}
										</p>
										<p
											className="detail-hero__amount"
											data-testid="payment-summary-receive"
										>
											{theyGet}
										</p>
										<p className="detail-hero__paid">
											{paidIn ? "You paid" : "You pay"}{" "}
											<strong data-testid="payment-summary-send">
												{youPay}
											</strong>
										</p>
									</>
								)}
							</div>

							<p className="detail-hero__headline">
								{paymentHeadline(payment.status, recipientName)}
								{polling ? (
									<span className="detail-live" role="status">
										<span className="detail-live__dot" aria-hidden="true" />
										Checking every 10 seconds
									</span>
								) : null}
							</p>

							<ProgressTracker steps={steps} />
						</section>

						{error ? (
							<Notice tone="warning">{describeApiError(error)}</Notice>
						) : null}
						{fundError ? <Notice tone="warning">{fundError}</Notice> : null}
						{problemText &&
						(payment.status === "failed" ||
							payment.status === "refunding" ||
							payment.status === "refunded") ? (
							<Notice tone="warning" data-testid="payment-problem">
								What went wrong: {problemText}
							</Notice>
						) : null}

						{senderWalletSettle && payment.status === "refunded" ? (
							<Notice data-testid="blindpay-returned">
								returned to your wallet
							</Notice>
						) : null}

						{senderWalletSettle &&
						payoutLeg?.externalRef &&
						payment.status === "processing" ? (
							<Notice data-testid="blindpay-tracking">
								Tracking the payout. A failure returns the stablecoins to your
								wallet.
							</Notice>
						) : null}

						{action ? (
							<section
								className="detail-action"
								data-testid="payment-next-step"
								aria-labelledby="detail-action-title"
							>
								<div className="detail-action__head">
									<span className="detail-action__icon" aria-hidden="true">
										<Icon name={action.icon} size={22} />
									</span>
									<div>
										<p className="detail-action__eyebrow">Next step</p>
										<h3
											className="detail-action__title"
											id="detail-action-title"
										>
											{action.title}
										</h3>
										<p className="detail-action__text">{action.text}</p>
									</div>
								</div>

								{canFund ? (
									<div className="detail-action__cta">
										<Button
											className="detail-action__button"
											onClick={() => void handleFund()}
											disabled={funding || authBlocked}
											data-testid="fund-payment"
										>
											{funding ? "Funding…" : "Fund payment"}
											{funding ? null : <Icon name="arrow" size={18} />}
										</Button>
										<p className="form-note">
											Tap once. We start moving the money straight away.
										</p>
									</div>
								) : null}

								{showBlindpay ? (
									<div className="detail-action__panel">
										<BlindpaySenderPanel
											paymentId={payment.id}
											onChanged={() => refresh()}
										/>
									</div>
								) : null}

								{showSolanaPay && settleLeg ? (
									<div className="detail-action__panel">
										<SolanaPayPanel
											paymentId={payment.id}
											quoteId={payment.quoteId}
											settleRail={settleLeg.rail}
											settleAmount={settleLeg.amountOut}
											recipientFieldLabel={
												payment.delivery === "direct"
													? "FlexiPay settlement account"
													: "Recipient"
											}
											onPaid={() => refresh()}
										/>
									</div>
								) : null}

								{claimLink ? <ClaimLinkShare link={claimLink} /> : null}
							</section>
						) : null}

						{!claimLink && payment.delivery === "claim_link" ? (
							<Notice data-testid="claim-link-gone">
								The claim link was shown once when the payment was created and
								can&apos;t be shown again.
							</Notice>
						) : null}

						<div className="detail-grid">
							<section
								className="panel detail-card"
								aria-labelledby="detail-receipt-title"
								data-testid="payment-cost"
							>
								<header className="detail-card__head">
									<span className="detail-card__icon" aria-hidden="true">
										<Icon name="receipt" size={20} />
									</span>
									<h3 className="detail-card__title" id="detail-receipt-title">
										Receipt
									</h3>
								</header>
								<dl className="detail-costs">
									<CostRow
										label={paidIn ? "You paid" : "You pay"}
										value={youPay}
										testId="payment-cost-send"
									/>
									{feeText ? (
										<CostRow
											label="Fee"
											value={feeText}
											testId="payment-cost-fee"
										/>
									) : null}
									{rateText ? (
										<CostRow
											label="Exchange rate"
											value={rateText}
											testId="payment-cost-rate"
										/>
									) : null}
									<CostRow
										label={
											delivered
												? "They got"
												: stopped
													? "They would have got"
													: "They get"
										}
										value={theyGet}
										strong
										testId="payment-cost-receive"
									/>
								</dl>
								{saving ? (
									<p className="detail-saving">
										<Icon name="bolt" size={16} />
										<span data-testid="payment-saving">
											{formatPaymentSavingLine(saving)}
										</span>
									</p>
								) : null}
								<dl className="detail-facts">
									<div>
										<dt>Started</dt>
										<dd>
											<PaymentTimestamp
												iso={createdAtIso}
												data-testid="payment-created-at"
											/>
										</dd>
									</div>
									{milestones.funded ? (
										<div>
											<dt>Paid in</dt>
											<dd>
												<PaymentTimestamp
													iso={milestones.funded}
													data-testid="payment-funded-at"
												/>
											</dd>
										</div>
									) : null}
									{milestones.paid ? (
										<div>
											<dt>Delivered</dt>
											<dd>
												<PaymentTimestamp
													iso={milestones.paid}
													data-testid="payment-paid-at"
												/>
											</dd>
										</div>
									) : null}
									<div>
										<dt>How they get it</dt>
										<dd>
											{payment.delivery === "claim_link"
												? "With a claim link"
												: "Straight to their account"}
										</dd>
									</div>
									{payment.reference ? (
										<div>
											<dt>Your note</dt>
											<dd>{payment.reference}</dd>
										</div>
									) : null}
								</dl>
							</section>

							<PaymentFromToCard
								senderName={senderName}
								recipientName={recipientName}
								events={payment.events}
								endpoint={destinationEndpoint}
							/>
						</div>

						{payment.status === "paid" && settleLeg?.releaseTxRef ? (
							<div className="detail-receipt">
								<PaymentReceipt
									payment={payment}
									signature={settleLeg.releaseTxRef}
									explorerUrl={solanaExplorerUrl(
										solanaExplorerTemplate ?? undefined,
										settleLeg.releaseTxRef,
									)}
								/>
							</div>
						) : null}

						<details
							className="detail-tech"
							data-testid="payment-technical-details"
						>
							<summary className="detail-tech__summary">
								<span className="detail-tech__icon" aria-hidden="true">
									<Icon name="code" size={18} />
								</span>
								<span className="detail-tech__text">
									<span className="detail-tech__title">Technical details</span>
									<span className="detail-tech__hint">
										References and the full history, for support.
									</span>
								</span>
								<Icon name="chevron" className="detail-tech__chevron" />
							</summary>

							<div className="detail-tech__body">
								<Panel title="References">
									<div className="form-grid">
										<StaticField
											label="Payment"
											value={
												<CopyableValue
													value={payment.id}
													label="Copy payment id"
												/>
											}
										/>
										<StaticField
											label="Amount"
											value={youPay}
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
												payment.delivery === "claim_link"
													? "Claim link"
													: "Direct"
											}
										/>
										<StaticField
											label="Reference"
											value={payment.reference ?? "—"}
										/>
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
									</div>
								</Panel>

								<Panel
									title="Settlement"
									description="The settlement reference is shown only when a settle leg exists."
									actions={
										settleLeg?.simulated ? <SimulatedLabel /> : undefined
									}
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
										<StaticField
											label="Refund transaction"
											value={
												refundTxRef ? (
													<a
														data-testid="payment-refund-link"
														href={solanaExplorerUrl(
															solanaExplorerTemplate ?? undefined,
															refundTxRef,
														)}
														target="_blank"
														rel="noreferrer"
													>
														<code className="code-text">{refundTxRef}</code>
													</a>
												) : (
													"—"
												)
											}
											hint="Confirmed on-chain return to the original payer (CCR-37)."
										/>
									</div>
									{!settleLeg ? (
										<p className="muted">
											This route ends at a payout or domestic rail, so there is
											no on-chain settlement reference.
										</p>
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
						</details>
					</>
				) : null}
			</div>
		</Page>
	)
}
