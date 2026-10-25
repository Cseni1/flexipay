import { StellarToml } from "@stellar/stellar-sdk";
import type { StellarAssetIdentity } from "./anchor-asset.ts";
import { parseClassicAssetLine } from "./anchor-asset.ts";

export interface AnchorTomlEndpoints {
	homeDomain: string;
	networkPassphrase: string;
	/** SEP-10 server signing key (G…); required to validate the challenge. */
	signingKey: string;
	webAuthEndpoint: string;
	transferServerSep24: string;
	anchorQuoteServer: string;
	/** Present on the SDF test anchor; SEP-45 is for contract accounts (M2), not M1. */
	webAuthForContractsEndpoint?: string;
	webAuthContractId?: string;
}

export interface AnchorTomlResult {
	endpoints: AnchorTomlEndpoints;
	/** Currencies listed in the TOML (code + issuer). */
	currencies: StellarAssetIdentity[];
}

/**
 * Resolves `https://{homeDomain}/.well-known/stellar.toml` via the SDK.
 * Does not cache tokens; endpoints only.
 */
export async function loadAnchorToml(homeDomain: string): Promise<AnchorTomlResult> {
	const domain = homeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
	const raw = (await StellarToml.Resolver.resolve(domain)) as Record<
		string,
		unknown
	>;
	const networkPassphrase = str(raw.NETWORK_PASSPHRASE, "NETWORK_PASSPHRASE");
	const endpoints: AnchorTomlEndpoints = {
		homeDomain: domain,
		networkPassphrase,
		signingKey: str(raw.SIGNING_KEY, "SIGNING_KEY"),
		webAuthEndpoint: str(raw.WEB_AUTH_ENDPOINT, "WEB_AUTH_ENDPOINT"),
		transferServerSep24: str(
			raw.TRANSFER_SERVER_SEP0024,
			"TRANSFER_SERVER_SEP0024",
		),
		anchorQuoteServer: str(raw.ANCHOR_QUOTE_SERVER, "ANCHOR_QUOTE_SERVER"),
	};
	if (typeof raw.WEB_AUTH_FOR_CONTRACTS_ENDPOINT === "string") {
		endpoints.webAuthForContractsEndpoint = raw.WEB_AUTH_FOR_CONTRACTS_ENDPOINT;
	}
	if (typeof raw.WEB_AUTH_CONTRACT_ID === "string") {
		endpoints.webAuthContractId = raw.WEB_AUTH_CONTRACT_ID;
	}

	const currencies: StellarAssetIdentity[] = [];
	const list = raw.CURRENCIES;
	if (Array.isArray(list)) {
		for (const entry of list) {
			if (typeof entry !== "object" || entry === null) continue;
			const row = entry as Record<string, unknown>;
			const code = typeof row.code === "string" ? row.code : "";
			if (!code) continue;
			if (code === "native") {
				currencies.push({
					code: "native",
					issuer: "",
					networkPassphrase,
				});
				continue;
			}
			const issuer = typeof row.issuer === "string" ? row.issuer : "";
			if (!issuer) continue;
			currencies.push(
				parseClassicAssetLine(`${code}:${issuer}`, networkPassphrase),
			);
		}
	}

	return { endpoints, currencies };
}

function str(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`stellar.toml missing ${name}`);
	}
	return value.trim();
}
