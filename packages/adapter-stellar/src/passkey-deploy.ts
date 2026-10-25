import {
	Account,
	Address,
	Keypair,
	Operation,
	StrKey,
	Transaction,
	TransactionBuilder,
	hash,
	xdr,
} from "@stellar/stellar-sdk";
import {
	Api,
	assembleTransaction,
	Server,
} from "@stellar/stellar-sdk/rpc";
import {
	PASSKEY_DEFAULT_DEPLOYER_SEED,
	PASSKEY_WALLET_WASM_HASH,
} from "./passkey-constants.ts";

export type PasskeyDeployRejectCode =
	| "invalid_deploy_tx"
	| "contract_mismatch"
	| "wasm_mismatch"
	| "constructor_mismatch"
	| "invalid_contract_id";

export class PasskeyDeployValidationError extends Error {
	readonly code: PasskeyDeployRejectCode;

	constructor(code: PasskeyDeployRejectCode, message: string) {
		super(message);
		this.name = "PasskeyDeployValidationError";
		this.code = code;
	}
}

export interface ValidatedPasskeyDeploy {
	contractId: string;
	keyId: Buffer;
	func: xdr.HostFunction;
	auth: xdr.SorobanAuthorizationEntry[];
	wasmHashHex: string;
	deployerPublicKey: string;
}

export interface PasskeyDeploySuccess {
	contractId: string;
	deployTxHash: string;
	creationLedger: number;
	status: "deployed";
}

export interface SignedPasskeyDeployEnvelope {
	/** Lowercase hex hash of the signed envelope (before / after send). */
	txHash: string;
	/** Base64 Transaction envelope XDR — seal for ClaimLink recovery; never log. */
	envelopeXdrBase64: string;
	tx: Transaction;
}

/** Shared deployer G… (sha256("kalepail") seed). Public; never fund or use as envelope source. */
export function passkeyDefaultDeployerKeypair(): Keypair {
	return Keypair.fromRawEd25519Seed(
		hash(Buffer.from(PASSKEY_DEFAULT_DEPLOYER_SEED)),
	);
}

export function passkeyDefaultDeployerPublicKey(): string {
	return passkeyDefaultDeployerKeypair().publicKey();
}

/** Decode WebAuthn credential id (std or URL-safe base64). */
export function decodeKeyIdBase64(keyIdBase64: string): Buffer {
	const normalized = keyIdBase64.replace(/-/g, "+").replace(/_/g, "/");
	const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
	const buf = Buffer.from(normalized + pad, "base64");
	if (buf.length === 0) {
		throw new PasskeyDeployValidationError(
			"constructor_mismatch",
			"keyIdBase64 decoded to empty bytes",
		);
	}
	return buf;
}

export function derivePasskeyContractId(
	keyId: Buffer,
	networkPassphrase: string,
	deployerPublicKey: string = passkeyDefaultDeployerPublicKey(),
): string {
	const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
		new xdr.ContractIdPreimageFromAddress({
			address: Address.fromString(deployerPublicKey).toScAddress(),
			salt: hash(keyId),
		}),
	);
	const idPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
		new xdr.HashIdPreimageContractId({
			networkId: hash(Buffer.from(networkPassphrase)),
			contractIdPreimage: preimage,
		}),
	);
	return StrKey.encodeContract(hash(idPreimage.toXDR()));
}

function scValContainsBytes(val: xdr.ScVal, needle: Buffer): boolean {
	const kind = val.switch().name;
	if (kind === "scvBytes") {
		return Buffer.from(val.bytes()).equals(needle);
	}
	if (kind === "scvVec") {
		const vec = val.vec();
		return !!vec?.some((v) => scValContainsBytes(v, needle));
	}
	if (kind === "scvMap") {
		const map = val.map();
		return !!map?.some(
			(e) =>
				scValContainsBytes(e.key(), needle) || scValContainsBytes(e.val(), needle),
		);
	}
	if (kind === "scvAddress") {
		return false;
	}
	if (kind === "scvSymbol" || kind === "scvString") {
		return false;
	}
	try {
		const vec = val.vec();
		if (vec) return vec.some((v) => scValContainsBytes(v, needle));
	} catch {
		/* not a vec */
	}
	return false;
}

function constructorContainsKeyId(
	constructorArgs: xdr.ScVal[],
	keyId: Buffer,
): boolean {
	return constructorArgs.some((arg) => scValContainsBytes(arg, keyId));
}

/**
 * Parse and verify a passkey-kit shared-deployer CreateWallet carrier (CCR-21).
 * Does not send; does not require the payer secret.
 */
export function validatePasskeyDeployCarrier(input: {
	signedTx: string;
	contractId: string;
	keyIdBase64: string;
	networkPassphrase: string;
	wasmHashHex?: string;
}): ValidatedPasskeyDeploy {
	const wasmPin = (input.wasmHashHex ?? PASSKEY_WALLET_WASM_HASH).toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(wasmPin)) {
		throw new PasskeyDeployValidationError(
			"wasm_mismatch",
			"pinned wasm hash must be 64 lowercase hex chars",
		);
	}
	if (!/^C[A-Z0-9]{55}$/.test(input.contractId)) {
		throw new PasskeyDeployValidationError(
			"invalid_contract_id",
			"contractId must be a C… address",
		);
	}

	let keyId: Buffer;
	try {
		keyId = decodeKeyIdBase64(input.keyIdBase64);
	} catch (e) {
		if (e instanceof PasskeyDeployValidationError) throw e;
		throw new PasskeyDeployValidationError(
			"constructor_mismatch",
			"keyIdBase64 is not valid base64",
		);
	}

	let parsed: Transaction;
	try {
		const built = TransactionBuilder.fromXDR(
			input.signedTx,
			input.networkPassphrase,
		);
		if (!(built instanceof Transaction)) {
			throw new PasskeyDeployValidationError(
				"invalid_deploy_tx",
				"fee-bump envelopes are not accepted as deploy carriers",
			);
		}
		parsed = built;
	} catch (e) {
		if (e instanceof PasskeyDeployValidationError) throw e;
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"signedTx is not a valid Transaction XDR for this network",
		);
	}

	if (parsed.operations.length !== 1) {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"deploy carrier must have exactly one operation",
		);
	}
	const op = parsed.operations[0]!;
	if (op.type !== "invokeHostFunction") {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"deploy carrier must be invokeHostFunction",
		);
	}
	const auth = op.auth ?? [];
	if (auth.length !== 1) {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"deploy carrier must have exactly one Soroban auth entry",
		);
	}
	if (op.func.switch().name !== "hostFunctionTypeCreateContractV2") {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"deploy carrier must be CreateContractV2",
		);
	}

	const create = op.func.createContractV2();
	const preimage = create.contractIdPreimage();
	if (preimage.switch().name !== "contractIdPreimageFromAddress") {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"CreateContractV2 must use from-address preimage",
		);
	}
	const fromAddress = preimage.fromAddress();
	const deployerPublicKey = Address.fromScAddress(fromAddress.address()).toString();
	if (deployerPublicKey !== passkeyDefaultDeployerPublicKey()) {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"deploy preimage must use the shared default deployer",
		);
	}
	const salt = Buffer.from(fromAddress.salt());
	if (!salt.equals(hash(keyId))) {
		throw new PasskeyDeployValidationError(
			"constructor_mismatch",
			"deploy salt does not match sha256(keyId)",
		);
	}

	const executable = create.executable();
	if (executable.switch().name !== "contractExecutableWasm") {
		throw new PasskeyDeployValidationError(
			"wasm_mismatch",
			"CreateContractV2 executable must be WASM",
		);
	}
	const wasmHashHex = Buffer.from(executable.wasmHash()).toString("hex");
	if (wasmHashHex !== wasmPin) {
		throw new PasskeyDeployValidationError(
			"wasm_mismatch",
			"CreateContractV2 WASM hash does not match the pinned passkey wallet",
		);
	}

	const constructorArgs = create.constructorArgs();
	if (!constructorContainsKeyId(constructorArgs, keyId)) {
		throw new PasskeyDeployValidationError(
			"constructor_mismatch",
			"constructor args must include a Secp256r1 credential id matching keyIdBase64",
		);
	}

	const derived = derivePasskeyContractId(
		keyId,
		input.networkPassphrase,
		deployerPublicKey,
	);
	if (derived !== input.contractId) {
		throw new PasskeyDeployValidationError(
			"contract_mismatch",
			"body contractId does not match derived wallet address for keyId",
		);
	}

	const authEntry = auth[0]!;
	const authFn = authEntry.rootInvocation().function();
	if (
		authFn.switch().name !==
		"sorobanAuthorizedFunctionTypeCreateContractV2HostFn"
	) {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"auth entry must authorize CreateContractV2",
		);
	}
	const authCreate = authFn.createContractV2HostFn();
	if (!Buffer.from(authCreate.toXDR()).equals(Buffer.from(create.toXDR()))) {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"auth CreateContractV2 does not match the host function",
		);
	}
	if (authEntry.rootInvocation().subInvocations().length !== 0) {
		throw new PasskeyDeployValidationError(
			"invalid_deploy_tx",
			"deploy auth must have no sub-invocations",
		);
	}

	return {
		contractId: input.contractId,
		keyId,
		func: op.func,
		auth: [authEntry],
		wasmHashHex,
		deployerPublicKey,
	};
}

/**
 * Rebuild an invokeHostFunction as a payer-sourced envelope, simulate, assemble, sign.
 * Does not send. Caller must persist sealed XDR + hash before send (CCR-21).
 */
export async function rebuildAndSignInvokeHostFunction(input: {
	func: xdr.HostFunction;
	auth: xdr.SorobanAuthorizationEntry[];
	payer: Keypair;
	networkPassphrase: string;
	rpcUrl: string;
	/** Inclusion + resource fee budget (stroops as string). */
	fee?: string;
	timeoutSeconds?: number;
	server?: Server;
	/** Error label prefix (deploy | claim). */
	label?: string;
}): Promise<SignedPasskeyDeployEnvelope> {
	const label = input.label ?? "invoke";
	const server = input.server ?? new Server(input.rpcUrl);
	const accountRecord = await server.getAccount(input.payer.publicKey());
	const account = new Account(accountRecord.accountId, accountRecord.sequenceNumber());
	const built = new TransactionBuilder(account, {
		fee: input.fee ?? "1000000",
		networkPassphrase: input.networkPassphrase,
	})
		.addOperation(
			Operation.invokeHostFunction({
				func: input.func,
				auth: input.auth,
			}),
		)
		.setTimeout(input.timeoutSeconds ?? 180)
		.build();

	const sim = await server.simulateTransaction(built);
	if (Api.isSimulationError(sim)) {
		throw new Error(`passkey ${label} simulation failed: ${sim.error}`);
	}
	if (!Api.isSimulationSuccess(sim)) {
		throw new Error(`passkey ${label} simulation did not succeed`);
	}
	const assembled = assembleTransaction(built, sim).build();
	assembled.sign(input.payer);
	const envelopeXdrBase64 = assembled.toXDR();
	const txHash = assembled.hash().toString("hex");
	return { txHash, envelopeXdrBase64, tx: assembled };
}

/**
 * Rebuild the deploy carrier as a payer-sourced envelope, simulate, assemble, and sign.
 * Does not send. Caller must persist sealed XDR + hash before send (CCR-21).
 */
export async function rebuildAndSignPasskeyDeploy(input: {
	validated: ValidatedPasskeyDeploy;
	payer: Keypair;
	networkPassphrase: string;
	rpcUrl: string;
	fee?: string;
	timeoutSeconds?: number;
	server?: Server;
}): Promise<SignedPasskeyDeployEnvelope> {
	return rebuildAndSignInvokeHostFunction({
		func: input.validated.func,
		auth: input.validated.auth,
		payer: input.payer,
		networkPassphrase: input.networkPassphrase,
		rpcUrl: input.rpcUrl,
		fee: input.fee,
		timeoutSeconds: input.timeoutSeconds,
		server: input.server,
		label: "deploy",
	});
}

export function transactionFromXdr(
	envelopeXdrBase64: string,
	networkPassphrase: string,
): Transaction {
	const built = TransactionBuilder.fromXDR(
		envelopeXdrBase64,
		networkPassphrase,
	);
	if (!(built instanceof Transaction)) {
		throw new Error("envelope is not a Transaction");
	}
	return built;
}

export async function sendSignedPasskeyDeploy(input: {
	tx: Transaction;
	rpcUrl: string;
	server?: Server;
}): Promise<{ hash: string }> {
	const server = input.server ?? new Server(input.rpcUrl);
	const sent = await server.sendTransaction(input.tx);
	if (sent.status === "ERROR") {
		const detail =
			typeof sent.errorResult === "string"
				? sent.errorResult
				: sent.errorResult?.toXDR?.("base64") ?? "ERROR";
		throw new Error(`passkey deploy send rejected: ${detail}`);
	}
	const hashHex = sent.hash?.toLowerCase();
	if (!hashHex || !/^[0-9a-f]{64}$/.test(hashHex)) {
		throw new Error("passkey deploy send returned no tx hash");
	}
	return { hash: hashHex };
}

/** Re-submit a previously sealed signed envelope (same hash recovery). */
export async function resubmitPasskeyDeployEnvelope(input: {
	envelopeXdrBase64: string;
	networkPassphrase: string;
	rpcUrl: string;
	server?: Server;
}): Promise<{ hash: string }> {
	const tx = transactionFromXdr(input.envelopeXdrBase64, input.networkPassphrase);
	return sendSignedPasskeyDeploy({
		tx,
		rpcUrl: input.rpcUrl,
		server: input.server,
	});
}

export type DeployTxOutcome =
	| { kind: "success"; txHash: string; ledger: number }
	| { kind: "pending"; txHash: string }
	| { kind: "failed"; txHash: string; reason: string }
	| { kind: "not_found"; txHash: string }
	| { kind: "unknown"; txHash: string; detail: string };

export async function getPasskeyDeployTxOutcome(
	txHash: string,
	rpcUrl: string,
	server?: Server,
): Promise<DeployTxOutcome> {
	const normalized = txHash.toLowerCase();
	const rpc = server ?? new Server(rpcUrl);
	try {
		const got = await rpc.getTransaction(normalized);
		if (got.status === Api.GetTransactionStatus.SUCCESS) {
			const ledger =
				typeof got.ledger === "number"
					? got.ledger
					: Number(got.ledger ?? 0);
			return {
				kind: "success",
				txHash: normalized,
				ledger: Number.isFinite(ledger) ? ledger : 0,
			};
		}
		if (got.status === Api.GetTransactionStatus.FAILED) {
			return {
				kind: "failed",
				txHash: normalized,
				reason: "transaction FAILED on ledger",
			};
		}
		if (got.status === Api.GetTransactionStatus.NOT_FOUND) {
			return { kind: "not_found", txHash: normalized };
		}
		return { kind: "pending", txHash: normalized };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Timeouts / transport errors are not FAILED (CCR-21).
		return { kind: "unknown", txHash: normalized, detail: msg };
	}
}

/** Poll until SUCCESS / FAILED / deadline. NOT_FOUND and unknown stay pending. */
export async function waitPasskeyDeploySuccess(input: {
	txHash: string;
	rpcUrl: string;
	server?: Server;
	timeoutMs?: number;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<{ deployTxHash: string; creationLedger: number }> {
	const timeoutMs = input.timeoutMs ?? 60_000;
	const intervalMs = input.intervalMs ?? 2_000;
	const sleep = input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const deadline = Date.now() + timeoutMs;
	let last: DeployTxOutcome = { kind: "pending", txHash: input.txHash };
	while (Date.now() < deadline) {
		last = await getPasskeyDeployTxOutcome(
			input.txHash,
			input.rpcUrl,
			input.server,
		);
		if (last.kind === "success") {
			return {
				deployTxHash: last.txHash,
				creationLedger: last.ledger,
			};
		}
		if (last.kind === "failed") {
			throw new Error(`passkey deploy failed on-chain: ${last.reason}`);
		}
		await sleep(intervalMs);
	}
	throw new Error(
		`passkey deploy still pending after ${timeoutMs}ms (hash=${input.txHash}, last=${last.kind})`,
	);
}

export function loadPayerDemoKeypair(
	env: Record<string, string | undefined>,
): Keypair {
	const address = env.FP_PAYER_DEMO_ADDRESS?.trim();
	const secret = env.FP_PAYER_DEMO_SECRET?.trim();
	if (!address) {
		throw new Error("Missing FP_PAYER_DEMO_ADDRESS");
	}
	if (!secret) {
		throw new Error("Missing FP_PAYER_DEMO_SECRET");
	}
	const keypair = Keypair.fromSecret(secret);
	if (keypair.publicKey() !== address) {
		throw new Error("FP_PAYER_DEMO_ADDRESS does not match FP_PAYER_DEMO_SECRET");
	}
	return keypair;
}

/** True when public + secret payer demo vars are present (does not log values). */
export function hasPayerDemoSecret(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return Boolean(env.FP_PAYER_DEMO_ADDRESS?.trim() && env.FP_PAYER_DEMO_SECRET?.trim());
}
