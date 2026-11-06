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

export default function WhereWePay() {
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
