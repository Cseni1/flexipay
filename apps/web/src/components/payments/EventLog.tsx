import { type Event } from "@flexipay/web-lib/contract"
import { useState } from "react"
import { Button } from "../ui"

const formatEventTime = (iso: string): string =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "medium",
	}).format(new Date(iso))

const eventLabel = (type: string): string => {
	const words = type.split(".")
	const first = words[0] ?? type
	return [
		first.charAt(0).toUpperCase() + first.slice(1),
		...words.slice(1),
	].join(" ")
}

export function EventLog({ events }: { events: Event[] }) {
	const [expanded, setExpanded] = useState(false)

	if (events.length === 0) {
		return (
			<div className="empty-state">
				<p className="empty-state__title">No events yet</p>
				<p className="empty-state__body">
					The API event stream appears here once the payment changes.
				</p>
			</div>
		)
	}

	const visible = events.slice(0, expanded ? 10 : 5)
	const scrollable = expanded && events.length > 10

	return (
		<>
			<ol className={`event-list${scrollable ? " event-list--scroll" : ""}`}>
				{visible.map((event) => (
					<li className="event-row" key={event.id}>
						<div>
							<p className="event-row__type">{eventLabel(event.type)}</p>
							<p className="event-row__meta">
								<code className="code-text">{event.id}</code>
							</p>
						</div>
						<time className="event-row__time" dateTime={event.createdAt}>
							{formatEventTime(event.createdAt)}
						</time>
					</li>
				))}
			</ol>
			{events.length > 5 ? (
				<Button
					variant="ghost"
					className="list-more"
					onClick={() => setExpanded((current) => !current)}
				>
					{expanded
						? "Show fewer"
						: `Show more (${Math.min(events.length, 10) - 5})`}
				</Button>
			) : null}
		</>
	)
}
