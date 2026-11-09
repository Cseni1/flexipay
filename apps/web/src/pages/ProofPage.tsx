import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { Icon } from "../components/ui/Icon"
import { parseSolanaProof, type SolanaProof } from "../payments/solanaProof"
import "../styles/pages/proof.css"

// CCR-52: public page with live, aggregate proof of payments settled on Solana.

const fmt = (n: number) => n.toLocaleString("en-GB")

export default function ProofPage() {
	const [proof, setProof] = useState<SolanaProof | null>(null)
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		const controller = new AbortController()
		fetch("/v1/stats/solana", { signal: controller.signal })
			.then(async (res) => {
				if (!res.ok) throw new Error(String(res.status))
				setProof(parseSolanaProof(await res.json()))
			})
			.catch(() => {
				if (!controller.signal.aborted) setFailed(true)
			})
		return () => controller.abort()
	}, [])

	const network =
		proof?.cluster === "mainnet-beta"
			? "Solana mainnet"
			: `Solana ${proof?.cluster ?? ""} (test network)`

	return (
		<div className="proof-page">
			<header className="proof-hero">
				<Link to="/" className="app-brand">
					<span className="app-brand__mark" aria-hidden="true">
						<Icon name="bolt" size={18} />
					</span>
					<span className="app-brand__text">
						<span className="app-brand__name">FlexiPay</span>
						<span className="app-brand__by">by FlexiWork</span>
					</span>
				</Link>
				<h1 className="proof-hero__title">Payments settled on Solana</h1>
				<p className="proof-hero__text">
					Live numbers from FlexiPay. Every payment here moved on Solana and was
					checked on-chain.
				</p>
				{proof ? (
					<p className="proof-hero__meta" data-testid="proof-network">
						{network}
						{proof.since
							? ` · since ${new Date(proof.since).toLocaleDateString("en-GB")}`
							: ""}
					</p>
				) : null}
			</header>

			<main className="proof-main">
				{failed ? (
					<p className="notice notice--warning" role="alert">
						The numbers could not be loaded. Try again in a minute.
					</p>
				) : !proof ? (
					<p className="form-note" aria-busy="true">
						Loading…
					</p>
				) : (
					<>
						<div className="proof-grid" data-testid="proof-stats">
							<div className="proof-stat">
								<span className="proof-stat__label">Payments settled</span>
								<strong className="proof-stat__value">
									{fmt(proof.settledPayments)}
								</strong>
							</div>
							<div className="proof-stat">
								<span className="proof-stat__label">Delivered</span>
								<strong className="proof-stat__value">
									{fmt(proof.deliveredPayments)}
								</strong>
							</div>
							<div className="proof-stat">
								<span className="proof-stat__label">Unique wallets</span>
								<strong className="proof-stat__value">
									{fmt(proof.uniqueWallets)}
								</strong>
							</div>
							<div className="proof-stat">
								<span className="proof-stat__label">
									Came back to pay again
								</span>
								<strong className="proof-stat__value">
									{fmt(proof.repeatWallets)}
								</strong>
							</div>
						</div>
						<section className="proof-volume" aria-label="Volume">
							<h2 className="proof-volume__title">Volume</h2>
							{proof.volume.length === 0 ? (
								<p className="form-note">No volume yet.</p>
							) : (
								<ul className="proof-volume__list" data-testid="proof-volume">
									{proof.volume.map((v) => (
										<li key={v.asset}>
											<strong>
												{Number(v.amount).toLocaleString("en-GB", {
													maximumFractionDigits: 2,
												})}
											</strong>{" "}
											{v.asset === "TGBP" ? "tGBP" : v.asset}
										</li>
									))}
								</ul>
							)}
						</section>
						<p className="form-note proof-foot">
							Totals only. No names, wallet addresses or payment details are
							shown. Updated{" "}
							{new Date(proof.generatedAt).toLocaleString("en-GB")}.
						</p>
					</>
				)}
			</main>
		</div>
	)
}
