import { Networks } from "@creit.tech/stellar-wallets-kit"
import { networkPassphrase, stellarNetwork } from "./env"

/** Minor-unit exponents used for display. The domain package owns conversion arithmetic. */
const DISPLAY_DECIMALS: Readonly<Record<string, number>> = {
	USD: 2,
	PHP: 2,
	BRL: 2,
	ZAR: 2,
	USDC: 7,
}

/**
 * Formats integer minor units as major units without floating-point arithmetic.
 * Unknown currencies fall back to zero decimals; callers should pass a known code.
 */
export function formatMoney(
	amount: string,
	currency: string,
	options: { trimTrailingZeros?: boolean } = {},
): string {
	const decimals = DISPLAY_DECIMALS[currency] ?? 0
	const negative = amount.startsWith("-")
	const digits = (negative ? amount.slice(1) : amount).padStart(
		decimals + 1,
		"0",
	)
	const whole = digits.slice(0, digits.length - decimals)
	const fraction = decimals === 0 ? "" : digits.slice(-decimals)
	const trimmed = options.trimTrailingZeros
		? fraction.replace(/0+$/, "")
		: fraction
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	const value = trimmed ? `${grouped}.${trimmed}` : grouped
	return `${negative ? "-" : ""}${value} ${currency}`
}

/**
 * Parses a major-unit input (e.g. "1,250.00") into integer minor units as a string.
 * USD uses two decimals; no float is ever constructed.
 */
export function parseUsdInput(input: string): string | null {
	const clean = input.trim().replace(/,/g, "")
	const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(clean)
	if (!match) return null
	const whole = match[1] ?? "0"
	const fraction = (match[2] ?? "").padEnd(2, "0")
	return `${BigInt(whole) * 100n + BigInt(fraction)}`.replace(/^0+(?=\d)/, "")
}

/** Shorten a Stellar address/contract id: first 4 + last 4, ellipsised. */
export const shortAddress = (addr: string): string =>
	`${addr.slice(0, 4)}...${addr.slice(-4)}`

/** Human-friendly network label (STANDALONE → Local; otherwise capitalized). */
export const formatNetworkName = (name: string): string =>
	name === "STANDALONE"
		? "Local"
		: name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()

/** Reverse lookup of a network passphrase to its `Networks` enum key. */
const passphraseToName: Record<string, string> = Object.fromEntries(
	Object.entries(Networks).map(([name, passphrase]) => [passphrase, name]),
)

export type NetworkState = "disconnected" | "mismatch" | "ok" | "unverified"

/**
 * Compare the app's configured network against the connected wallet's network
 * using passphrase. Most wallets don't report their network (Wallets Kit issue
 * #62) — a connected wallet with no passphrase is `unverified`, not a mismatch.
 * Keep pure, let component decide how to present state.
 */
export function networkStatus(
	address: string | null | undefined,
	walletPassphrase: string | null | undefined,
): {
	appNetwork: string
	walletNetwork: string
	state: NetworkState
	title: string
} {
	const appNetwork = formatNetworkName(stellarNetwork)
	// Label, in priority order: blank when there's no passphrase (disconnected);
	// the app's own label when the wallet matches the configured passphrase (so a
	// custom/standalone passphrase still reads as e.g. "Local" rather than
	// "Unknown" in the `ok` case); the known `Networks` name; else "Unknown".
	const walletNetwork = !walletPassphrase
		? ""
		: walletPassphrase === networkPassphrase
			? appNetwork
			: passphraseToName[walletPassphrase]
				? formatNetworkName(passphraseToName[walletPassphrase])
				: "Unknown"

	if (!address) {
		return {
			appNetwork,
			walletNetwork,
			state: "disconnected",
			title: "Connect your wallet using this network.",
		}
	}
	if (!walletPassphrase) {
		return {
			appNetwork,
			walletNetwork,
			state: "unverified",
			title: `This wallet doesn't report its network — make sure it is set to ${appNetwork}.`,
		}
	}
	if (walletPassphrase !== networkPassphrase) {
		return {
			appNetwork,
			walletNetwork,
			state: "mismatch",
			title: `Wallet is on ${walletNetwork}, connect to ${appNetwork} instead.`,
		}
	}
	return { appNetwork, walletNetwork, state: "ok", title: "" }
}
