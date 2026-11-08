import { useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ApiError, describeApiError, saveBlindpayTos } from "../api/client"
import { SenderKycPanel } from "../components/payments/SenderKycPanel"
import { Notice } from "../components/ui"

/**
 * CCR-46: BlindPay's terms page sends the sender back here with `?tos_id=`. The id is saved
 * automatically and the next identity step is shown; nothing to copy or paste.
 */
export default function BlindpayTermsDone() {
	const [params] = useSearchParams()
	const tosId = params.get("tos_id")?.trim() ?? ""
	const [next, setNext] = useState<unknown>(null)
	const [error, setError] = useState<string | null>(null)
	const started = useRef(false)

	useEffect(() => {
		if (!tosId || started.current) return
		started.current = true
		saveBlindpayTos(tosId)
			.then((saved) => setNext(saved.next))
			.catch((cause: unknown) =>
				setError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Could not save your acceptance of BlindPay's terms",
				),
			)
	}, [tosId])

	return (
		<section className="stack" data-testid="blindpay-terms-done">
			<h1 className="page-header__title">Identity check</h1>
			{!tosId ? (
				<Notice tone="warning">
					BlindPay did not return a terms acceptance. Start again from Send.
				</Notice>
			) : error ? (
				<Notice tone="warning">{error}</Notice>
			) : next ? (
				<>
					<Notice>Terms accepted.</Notice>
					<SenderKycPanel details={next} />
				</>
			) : (
				<p>Saving your acceptance…</p>
			)}
			<p>
				<Link to="/">Back to Send</Link>
			</p>
		</section>
	)
}
