import { useEffect, useMemo, useState } from "react"
import { describeApiError, listCorridors, ApiError } from "../api/client"
import {
	sandboxPayoutsWorld,
	summarizeCorridor,
	type CorridorSummary,
	type WorldPayoutRow,
} from "../api/corridors"
import { ProviderBadge } from "../components/payments/ProviderBadge"
import { Notice, Page, PageHeader, Panel } from "../components/ui"
import coverage from "../data/coverage.json"

type CoverageStatus = "local_bank" | "swift_only" | "not_covered"

type CoverageCountry = {
	code: string
	name: string
	status: CoverageStatus
	region: string
}

const STATUS_LABEL: Record<CoverageStatus, string> = {
	local_bank: "Local bank rail",
	swift_only: "SWIFT only",
	not_covered: "Not covered",
}

const REGION_ORDER = [
	"Europe",
	"Middle East & North Africa",
	"Sub-Saharan Africa",
	"Americas",
	"Asia & Pacific",
	"Other",
] as const

const countries = coverage.countries as CoverageCountry[]

const byRegion = (() => {
	const map = new Map<string, CoverageCountry[]>()
	for (const country of countries) {
		const list = map.get(country.region) ?? []
		list.push(country)
		map.set(country.region, list)
	}
	for (const list of map.values()) {
		list.sort((a, b) => a.name.localeCompare(b.name))
	}
	return map
})()

const CURRENCY_SIGN: Record<string, string> = {
	GBP: "£ pounds",
	USD: "$ dollars",
}

function WorldList({ rows }: { rows: WorldPayoutRow[] }) {
	return (
		<ul className="coverage-list" data-testid="sandbox-world">
			{rows.map((row) => (
				<li
					key={row.code}
					className="coverage-list__row"
					data-testid={`sandbox-country-${row.code}`}
				>
					<span className="coverage-list__name">
						<span className="coverage-list__code">{row.code}</span> {row.name}
						<span className="sandbox-priced__from" data-testid="sandbox-from">
							{" "}
							· from {row.from.map((c) => CURRENCY_SIGN[c] ?? c).join(" or ")}
						</span>
					</span>
					<span className="sandbox-priced__partner">
						{row.partners.map((partner) => (
							<span key={partner.id} className="sandbox-priced__partner-name">
								{partner.name}{" "}
								<ProviderBadge simulated providerId={partner.id} />
							</span>
						))}
					</span>
				</li>
			))}
		</ul>
	)
}

export default function WhereWePay() {
	const [corridors, setCorridors] = useState<CorridorSummary[] | null>(null)
	const [corridorsError, setCorridorsError] = useState<string | null>(null)

	useEffect(() => {
		const controller = new AbortController()
		let active = true
		listCorridors(controller.signal)
			.then((response) => {
				if (!active) return
				setCorridors(response.corridors.map(summarizeCorridor))
				setCorridorsError(null)
			})
			.catch((cause: unknown) => {
				if (!active || controller.signal.aborted) return
				setCorridors(null)
				setCorridorsError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Corridors could not be loaded from the API.",
				)
			})
		return () => {
			active = false
			controller.abort()
		}
	}, [])

	const world = useMemo(
		() => (corridors ? sandboxPayoutsWorld(corridors) : null),
		[corridors],
	)

	return (
		<Page>
			<PageHeader
				eyebrow="Coverage"
				title="Where we pay"
				description="Paper coverage from partner docs and sandbox metadata — not live payments."
			/>
			<Notice data-testid="coverage-disclaimer">
				As of 6 Nov 2026 — {coverage.disclaimer}. Source: {coverage.source}.
			</Notice>

			<Panel
				title="Priced live in sandbox"
				description={
					world && world.length > 0
						? `Pay from pounds or dollars into ${world.length} countries. Partners compete on each payment; FlexiPay picks the route that delivers the most.`
						: "Countries a partner sandbox prices today, from GET /v1/corridors."
				}
			>
				{corridorsError ? (
					<Notice tone="warning" data-testid="sandbox-corridors-unavailable">
						Corridors unavailable: {corridorsError}
					</Notice>
				) : null}
				{world ? (
					<div className="sandbox-priced" data-testid="sandbox-priced">
						{world.length > 0 ? (
							<WorldList rows={world} />
						) : (
							<p className="form-note">
								No partner sandbox payout corridors were returned.
							</p>
						)}
					</div>
				) : corridorsError ? null : (
					<p className="form-note" data-testid="sandbox-priced-loading">
						Loading sandbox corridors…
					</p>
				)}
			</Panel>

			{REGION_ORDER.filter((region) => byRegion.has(region)).map((region) => (
				<Panel key={region} title={region}>
					<ul
						className="coverage-list"
						data-testid={`coverage-region-${region}`}
					>
						{(byRegion.get(region) ?? []).map((country) => (
							<li
								key={country.code}
								className="coverage-list__row"
								data-status={country.status}
							>
								<span className="coverage-list__name">
									<span className="coverage-list__code">{country.code}</span>{" "}
									{country.name}
								</span>
								<span
									className={`coverage-pill coverage-pill--${country.status}`}
								>
									{STATUS_LABEL[country.status]}
								</span>
							</li>
						))}
					</ul>
				</Panel>
			))}
		</Page>
	)
}
