import { useState } from "react"
import { Notice, Page, PageHeader, Panel } from "../components/ui"

const QUOTE = `curl -X POST $FP_API_URL/v1/quotes \\
  --oauth2-bearer "$FP_API_KEY" \\
  -H "Idempotency-Key: quote-001" \\
  -d '{"destination":{"country":"PH","type":"ewallet","currency":"PHP","recipientKind":"individual"},
       "amount":{"side":"send","value":{"amount":"125000","currency":"USD"}}}'`

const PAYMENT = `curl -X POST $FP_API_URL/v1/payments \\
  --oauth2-bearer "$FP_API_KEY" \\
  -H "Idempotency-Key: pay-001" \\
  -d '{"quoteId":"<quote id>","recipientId":"<recipient id>","delivery":"claim_link","profile":"one_off"}'`

const EVENTS = [
	"payment.created",
	"payment.onchain",
	"claim.opened",
	"claim.accepted",
	"payment.completed",
	"payment.refunded",
]

function Snippet({ label, code }: { label: string; code: string }) {
	const [state, setState] = useState<"idle" | "copied" | "blocked">("idle")
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(code)
			setState("copied")
		} catch {
			setState("blocked")
		}
	}
	return (
		<div className="snippet">
			<div className="snippet__bar">
				<span>{label}</span>
				<button
					type="button"
					className="filter-chip"
					onClick={() => void copy()}
				>
					Copy
				</button>
				<span role="status" className="form-note">
					{state === "copied"
						? "Copied"
						: state === "blocked"
							? "Copy blocked: select the text"
							: ""}
				</span>
			</div>
			<pre className="snippet__code">{code}</pre>
		</div>
	)
}

export default function Developers() {
	return (
		<Page>
			<PageHeader
				eyebrow="API"
				title="Developers"
				description="This console is an API client. Everything you do here is a v1 call you can make yourself."
			/>
			<Notice>
				The API key stays on the server: the local web proxy adds it, and the
				browser never sees or stores it. Use your own sandbox key from your
				environment.
			</Notice>
			<Panel
				title="Quickstart"
				description="Quote, create, then watch the events."
			>
				<Snippet label="1. Quote with route and reasons" code={QUOTE} />
				<Snippet
					label="2. Create the payment (direct or claim link)"
					code={PAYMENT}
				/>
				<Snippet
					label="3. Read the payment and its events"
					code={
						'curl $FP_API_URL/v1/payments/<payment id> --oauth2-bearer "$FP_API_KEY"'
					}
				/>
			</Panel>
			<Panel title="Events" description="Recorded on every payment, in order.">
				<ul className="event-names">
					{EVENTS.map((name) => (
						<li key={name}>
							<code className="code-text">{name}</code>
						</li>
					))}
				</ul>
			</Panel>
		</Page>
	)
}
