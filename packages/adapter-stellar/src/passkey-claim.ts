import { contract, type Keypair, xdr } from "@stellar/stellar-sdk";
import type { StellarEnv } from "./stellar-env.ts";
import {
	PASSKEY_CLAIM_AUTH_LIFETIME_LEDGERS,
	PasskeyAuthMismatchError,
	authEntryAddress,
	authEntryNonce,
	rootInvocationFingerprint,
	stampAuthEntryExpiration,
	type PreparedAuthMeta,
} from "./passkey-claim-auth.ts";
import {
	rebuildAndSignInvokeHostFunction,
	type SignedPasskeyDeployEnvelope,
} from "./passkey-deploy.ts";
import { VAULT_ERRORS, toVaultError } from "./vault-errors.ts";

const ERROR_TYPES = Object.fromEntries(
	Object.entries(VAULT_ERRORS).map(([code, name]) => [code, { message: name }]),
);

type ClaimClient = contract.Client & {
	claim: (args: {
		id: bigint;
		secret: Buffer;
		to: string;
	}) => Promise<contract.AssembledTransaction<unknown>>;
};

function isResult(value: unknown): value is contract.Result<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { isErr?: unknown }).isErr === "function"
	);
}

function unwrapSimulation(tx: contract.AssembledTransaction<unknown>): void {
	const simErr = (tx.simulation as { error?: string } | undefined)?.error;
	const value = tx.result;
	if (isResult(value)) {
		if (value.isOk()) return;
		const err =
			toVaultError(value.unwrapErr()) ?? toVaultError(simErr ?? "");
		throw err ?? new Error(`payout_vault claim simulate failed: ${simErr ?? "unknown"}`);
	}
	if (simErr) {
		throw toVaultError(simErr) ?? new Error(`payout_vault claim simulate failed: ${simErr}`);
	}
}

export interface PreparedPasskeyClaimAuth {
	signatureExpirationLedger: number;
	authEntries: xdr.SorobanAuthorizationEntry[];
	hostFunction: xdr.HostFunction;
	meta: PreparedAuthMeta;
}

/**
 * Simulate vault `claim(id, secret, to=C…)` with payer as envelope source.
 * Returns unsigned C… auth entries stamped with a single signatureExpirationLedger.
 * Requires live RPC (contract spec + simulation). Not a testnet success proof by itself.
 */
export async function prepareVaultPasskeyClaimAuth(input: {
	env: StellarEnv;
	payer: Keypair;
	payoutId: bigint;
	secret: Buffer;
	toContractId: string;
	authLifetimeLedgers?: number;
}): Promise<PreparedPasskeyClaimAuth> {
	const { signTransaction } = contract.basicNodeSigner(
		input.payer,
		input.env.networkPassphrase,
	);
	const client = (await contract.Client.from({
		contractId: input.env.payoutVaultId,
		rpcUrl: input.env.rpcUrl,
		networkPassphrase: input.env.networkPassphrase,
		errorTypes: ERROR_TYPES,
		publicKey: input.payer.publicKey(),
		signTransaction,
	})) as ClaimClient;

	const tx = await client.claim({
		id: input.payoutId,
		secret: input.secret,
		to: input.toContractId,
	});
	unwrapSimulation(tx);

	const latestLedger = (tx.simulation as { latestLedger?: number } | undefined)
		?.latestLedger;
	if (latestLedger == null || !Number.isFinite(latestLedger)) {
		throw new Error("claim simulation missing latestLedger");
	}
	const lifetime = input.authLifetimeLedgers ?? PASSKEY_CLAIM_AUTH_LIFETIME_LEDGERS;
	const signatureExpirationLedger = latestLedger + lifetime;

	if (!tx.built || tx.built.operations.length !== 1) {
		throw new Error("claim simulation did not produce a single operation");
	}
	const op = tx.built.operations[0]!;
	if (op.type !== "invokeHostFunction") {
		throw new Error("claim simulation operation is not invokeHostFunction");
	}

	const needed = tx.needsNonInvokerSigningBy();
	if (!needed.includes(input.toContractId)) {
		throw new PasskeyAuthMismatchError(
			`claim simulation does not require auth from ${input.toContractId}`,
		);
	}

	const allAuth = op.auth ?? [];
	const forContract = allAuth.filter(
		(e) => authEntryAddress(e) === input.toContractId,
	);
	if (forContract.length === 0) {
		throw new PasskeyAuthMismatchError(
			"no Soroban auth entries for the passkey contractId",
		);
	}

	const stamped = forContract.map((e) =>
		stampAuthEntryExpiration(e, signatureExpirationLedger),
	);

	const meta: PreparedAuthMeta = {
		signatureExpirationLedger,
		fingerprints: stamped.map(rootInvocationFingerprint),
		nonces: stamped.map(authEntryNonce),
		addresses: stamped.map(authEntryAddress),
	};

	return {
		signatureExpirationLedger,
		authEntries: stamped,
		hostFunction: op.func,
		meta,
	};
}

export async function rebuildAndSignPasskeyClaimRelease(input: {
	hostFunction: xdr.HostFunction;
	signedAuth: xdr.SorobanAuthorizationEntry[];
	payer: Keypair;
	networkPassphrase: string;
	rpcUrl: string;
	fee?: string;
	timeoutSeconds?: number;
}): Promise<SignedPasskeyDeployEnvelope> {
	return rebuildAndSignInvokeHostFunction({
		func: input.hostFunction,
		auth: input.signedAuth,
		payer: input.payer,
		networkPassphrase: input.networkPassphrase,
		rpcUrl: input.rpcUrl,
		fee: input.fee,
		timeoutSeconds: input.timeoutSeconds,
		label: "claim",
	});
}

export function hostFunctionFromXdr(base64: string): xdr.HostFunction {
	return xdr.HostFunction.fromXDR(base64, "base64");
}
