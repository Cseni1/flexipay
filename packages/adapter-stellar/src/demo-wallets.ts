import { Keypair } from "@stellar/stellar-sdk";

// Baseline custodial demo wallets (ARCHITECTURE §11.3, CCR-5). The backend holds testnet
// keypairs for labelled demo recipients. No wallet connection and no passkey code here.
// Secrets are loaded from the caller's env map; this module never logs or returns them.

export type DemoWalletRole = "payer" | "recipient";

export interface DemoWalletInfo {
	/** Stable id for seed data, e.g. worker_a. */
	id: string;
	/** Always names custody so demos cannot be mistaken for self-custody. */
	label: string;
	role: DemoWalletRole;
	address: string;
	custodial: true;
	/** Demo key material; not a production custody product. */
	simulated: true;
}

interface WalletRecord extends DemoWalletInfo {
	keypair: Keypair;
}

const RECIPIENT_SLOTS = [
	{ id: "worker_a", label: "Custodial demo — Worker A", envAddress: "FP_RECIPIENT_A_ADDRESS", envSecret: "FP_RECIPIENT_A_SECRET" },
	{ id: "worker_b", label: "Custodial demo — Worker B", envAddress: "FP_RECIPIENT_B_ADDRESS", envSecret: "FP_RECIPIENT_B_SECRET" },
] as const;

export class UnknownDemoWalletError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnknownDemoWalletError";
	}
}

/**
 * Holds the demo payer and recipient keypairs used by `StellarSettlementAdapter` to sign
 * vault deposit, lock, cancel and claim. Addresses come from public FP_ settings; secrets
 * from the git-ignored secrets file (or host secret store).
 */
export class CustodialDemoWalletProvider {
	private readonly byId = new Map<string, WalletRecord>();
	private readonly byAddress = new Map<string, WalletRecord>();

	private constructor(wallets: WalletRecord[]) {
		for (const wallet of wallets) {
			this.byId.set(wallet.id, wallet);
			this.byAddress.set(wallet.address, wallet);
		}
	}

	/**
	 * Loads labelled demo wallets from public ids + secrets. `env` should already merge
	 * `scripts/testnet/testnet-ids.env` and `scripts/testnet/.env.secrets` (or host equivalents).
	 */
	static fromEnv(env: Record<string, string | undefined> = process.env): CustodialDemoWalletProvider {
		const wallets: WalletRecord[] = [
			loadWallet(env, {
				id: "payer_demo",
				label: "Custodial demo — Payer",
				role: "payer",
				envAddress: "FP_PAYER_DEMO_ADDRESS",
				envSecret: "FP_PAYER_DEMO_SECRET",
			}),
		];
		for (const slot of RECIPIENT_SLOTS) {
			wallets.push(
				loadWallet(env, {
					id: slot.id,
					label: slot.label,
					role: "recipient",
					envAddress: slot.envAddress,
					envSecret: slot.envSecret,
				}),
			);
		}
		return new CustodialDemoWalletProvider(wallets);
	}

	/** Public view: addresses and labels only. */
	list(): DemoWalletInfo[] {
		return [...this.byId.values()].map(publicInfo);
	}

	get(id: string): DemoWalletInfo {
		const wallet = this.byId.get(id);
		if (!wallet) throw new UnknownDemoWalletError(`unknown demo wallet id: ${id}`);
		return publicInfo(wallet);
	}

	addressOf(id: string): string {
		return this.get(id).address;
	}

	/** Signing key for a known custodial address. Never expose the secret. */
	keypairForAddress(address: string): Keypair {
		const wallet = this.byAddress.get(address);
		if (!wallet) {
			throw new UnknownDemoWalletError(
				`no custodial demo keypair for address ${address}; baseline claims use labelled demo wallets only`,
			);
		}
		return wallet.keypair;
	}

	hasAddress(address: string): boolean {
		return this.byAddress.has(address);
	}
}

function publicInfo(wallet: WalletRecord): DemoWalletInfo {
	return {
		id: wallet.id,
		label: wallet.label,
		role: wallet.role,
		address: wallet.address,
		custodial: true,
		simulated: true,
	};
}

function loadWallet(
	env: Record<string, string | undefined>,
	spec: {
		id: string;
		label: string;
		role: DemoWalletRole;
		envAddress: string;
		envSecret: string;
	},
): WalletRecord {
	const address = env[spec.envAddress];
	const secret = env[spec.envSecret];
	if (!address) throw new Error(`Missing demo wallet address: ${spec.envAddress}`);
	if (!secret) throw new Error(`Missing demo wallet secret: ${spec.envSecret}`);
	const keypair = Keypair.fromSecret(secret);
	if (keypair.publicKey() !== address) {
		throw new Error(
			`${spec.envAddress} does not match the public key of ${spec.envSecret}`,
		);
	}
	return {
		id: spec.id,
		label: spec.label,
		role: spec.role,
		address,
		custodial: true,
		simulated: true,
		keypair,
	};
}
