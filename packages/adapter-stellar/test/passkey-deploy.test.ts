import {
	Account,
	Address,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	hash,
	xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
	PASSKEY_WALLET_WASM_HASH,
	decodeKeyIdBase64,
	derivePasskeyContractId,
	passkeyDefaultDeployerPublicKey,
	validatePasskeyDeployCarrier,
	PasskeyDeployValidationError,
} from "../src/index.ts";

const NETWORK = Networks.TESTNET;

function buildCarrier(opts: {
	keyId: Buffer;
	wasmHashHex?: string;
	deployer?: string;
	constructorArgs?: xdr.ScVal[];
	authMismatch?: boolean;
}): { signedTx: string; contractId: string; keyIdBase64: string } {
	const deployerPk = opts.deployer ?? passkeyDefaultDeployerPublicKey();
	const salt = hash(opts.keyId);
	const wasmHash = Buffer.from(
		opts.wasmHashHex ?? PASSKEY_WALLET_WASM_HASH,
		"hex",
	);
	const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
		new xdr.ContractIdPreimageFromAddress({
			address: Address.fromString(deployerPk).toScAddress(),
			salt,
		}),
	);
	const executable = xdr.ContractExecutable.contractExecutableWasm(wasmHash);
	const constructorArgs =
		opts.constructorArgs ??
		[
			xdr.ScVal.scvVec([
				xdr.ScVal.scvSymbol("Secp256r1"),
				xdr.ScVal.scvBytes(opts.keyId),
			]),
		];
	const create = new xdr.CreateContractArgsV2({
		contractIdPreimage: preimage,
		executable,
		constructorArgs,
	});
	const func = xdr.HostFunction.hostFunctionTypeCreateContractV2(create);
	const authCreate = opts.authMismatch
		? new xdr.CreateContractArgsV2({
				contractIdPreimage: preimage,
				executable,
				constructorArgs: [xdr.ScVal.scvVoid()],
			})
		: create;
	const auth = [
		new xdr.SorobanAuthorizationEntry({
			credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
				new xdr.SorobanAddressCredentials({
					address: Address.fromString(deployerPk).toScAddress(),
					nonce: xdr.Int64.fromString("1"),
					signatureExpirationLedger: 1_000_000,
					signature: xdr.ScVal.scvVoid(),
				}),
			),
			rootInvocation: new xdr.SorobanAuthorizedInvocation({
				function:
					xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
						authCreate,
					),
				subInvocations: [],
			}),
		}),
	];
	const carrier = Keypair.random();
	const account = new Account(carrier.publicKey(), "0");
	const tx = new TransactionBuilder(account, {
		fee: "100",
		networkPassphrase: NETWORK,
	})
		.addOperation(Operation.invokeHostFunction({ func, auth }))
		.setTimeout(30)
		.build();
	const contractId = derivePasskeyContractId(opts.keyId, NETWORK, deployerPk);
	return {
		signedTx: tx.toXDR(),
		contractId,
		keyIdBase64: opts.keyId.toString("base64url"),
	};
}

describe("passkey deploy carrier validation", () => {
	it("accepts a shared-deployer CreateContractV2 carrier with matching keyId", () => {
		const keyId = Buffer.from("flexipay-test-cred-001");
		const carrier = buildCarrier({ keyId });
		const validated = validatePasskeyDeployCarrier({
			...carrier,
			networkPassphrase: NETWORK,
		});
		expect(validated.contractId).toBe(carrier.contractId);
		expect(validated.wasmHashHex).toBe(PASSKEY_WALLET_WASM_HASH);
		expect(validated.deployerPublicKey).toBe(passkeyDefaultDeployerPublicKey());
		expect(validated.keyId.equals(keyId)).toBe(true);
	});

	it("rejects wasm hash mismatch", () => {
		const keyId = Buffer.from("flexipay-test-cred-002");
		const carrier = buildCarrier({
			keyId,
			wasmHashHex: "ab".repeat(32),
		});
		expect(() =>
			validatePasskeyDeployCarrier({
				...carrier,
				networkPassphrase: NETWORK,
			}),
		).toThrow(PasskeyDeployValidationError);
		try {
			validatePasskeyDeployCarrier({
				...carrier,
				networkPassphrase: NETWORK,
			});
		} catch (e) {
			expect((e as PasskeyDeployValidationError).code).toBe("wasm_mismatch");
		}
	});

	it("rejects contractId that does not match keyId derivation", () => {
		const keyId = Buffer.from("flexipay-test-cred-003");
		const carrier = buildCarrier({ keyId });
		expect(() =>
			validatePasskeyDeployCarrier({
				signedTx: carrier.signedTx,
				contractId: derivePasskeyContractId(
					Buffer.from("other-cred"),
					NETWORK,
				),
				keyIdBase64: carrier.keyIdBase64,
				networkPassphrase: NETWORK,
			}),
		).toThrowError(/contractId|derived/i);
	});

	it("rejects constructor without credential id bytes", () => {
		const keyId = Buffer.from("flexipay-test-cred-004");
		const carrier = buildCarrier({
			keyId,
			constructorArgs: [xdr.ScVal.scvSymbol("Ed25519")],
		});
		try {
			validatePasskeyDeployCarrier({
				...carrier,
				networkPassphrase: NETWORK,
			});
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(PasskeyDeployValidationError);
			expect((e as PasskeyDeployValidationError).code).toBe(
				"constructor_mismatch",
			);
		}
	});

	it("rejects non-default deployer preimage", () => {
		const keyId = Buffer.from("flexipay-test-cred-005");
		const other = Keypair.random().publicKey();
		const carrier = buildCarrier({ keyId, deployer: other });
		try {
			validatePasskeyDeployCarrier({
				...carrier,
				networkPassphrase: NETWORK,
			});
			expect.unreachable();
		} catch (e) {
			expect((e as PasskeyDeployValidationError).code).toBe("invalid_deploy_tx");
		}
	});

	it("rejects auth/host-function CreateContractV2 mismatch", () => {
		const keyId = Buffer.from("flexipay-test-cred-006");
		const carrier = buildCarrier({ keyId, authMismatch: true });
		try {
			validatePasskeyDeployCarrier({
				...carrier,
				networkPassphrase: NETWORK,
			});
			expect.unreachable();
		} catch (e) {
			expect((e as PasskeyDeployValidationError).code).toBe("invalid_deploy_tx");
		}
	});

	it("decodes std and url-safe keyId base64 the same", () => {
		const raw = Buffer.from([0xff, 0x00, 0x7e, 0x3d]);
		const std = raw.toString("base64");
		const url = raw.toString("base64url");
		expect(decodeKeyIdBase64(std).equals(raw)).toBe(true);
		expect(decodeKeyIdBase64(url).equals(raw)).toBe(true);
	});
});
