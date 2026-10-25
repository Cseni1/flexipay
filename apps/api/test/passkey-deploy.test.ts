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
import {
	PASSKEY_WALLET_WASM_HASH,
	derivePasskeyContractId,
	passkeyDefaultDeployerPublicKey,
} from "@flexipay/adapter-stellar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

const NETWORK = Networks.TESTNET;

function buildValidCarrier(keyId = Buffer.from("api-deploy-cred-01")): {
	contractId: string;
	keyIdBase64: string;
	signedTx: string;
} {
	const deployerPk = passkeyDefaultDeployerPublicKey();
	const salt = hash(keyId);
	const wasmHash = Buffer.from(PASSKEY_WALLET_WASM_HASH, "hex");
	const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
		new xdr.ContractIdPreimageFromAddress({
			address: Address.fromString(deployerPk).toScAddress(),
			salt,
		}),
	);
	const create = new xdr.CreateContractArgsV2({
		contractIdPreimage: preimage,
		executable: xdr.ContractExecutable.contractExecutableWasm(wasmHash),
		constructorArgs: [
			xdr.ScVal.scvVec([
				xdr.ScVal.scvSymbol("Secp256r1"),
				xdr.ScVal.scvBytes(keyId),
			]),
		],
	});
	const func = xdr.HostFunction.hostFunctionTypeCreateContractV2(create);
	const authEntries = [
		new xdr.SorobanAuthorizationEntry({
			credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
				new xdr.SorobanAddressCredentials({
					address: Address.fromString(deployerPk).toScAddress(),
					nonce: xdr.Int64.fromString("7"),
					signatureExpirationLedger: 2_000_000,
					signature: xdr.ScVal.scvVoid(),
				}),
			),
			rootInvocation: new xdr.SorobanAuthorizedInvocation({
				function:
					xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
						create,
					),
				subInvocations: [],
			}),
		}),
	];
	const carrier = Keypair.random();
	const tx = new TransactionBuilder(new Account(carrier.publicKey(), "0"), {
		fee: "100",
		networkPassphrase: NETWORK,
	})
		.addOperation(Operation.invokeHostFunction({ func, auth: authEntries }))
		.setTimeout(30)
		.build();
	return {
		contractId: derivePasskeyContractId(keyId, NETWORK, deployerPk),
		keyIdBase64: keyId.toString("base64url"),
		signedTx: tx.toXDR(),
	};
}

async function openClaimToken(key: string): Promise<string> {
	const recipient = (await (
		await fetch(`${t.base}/v1/recipients`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				name: "Worker A",
				kind: "individual",
				country: "PH",
			}),
		})
	).json()) as { id: string };
	const quote = (await (
		await fetch(`${t.base}/v1/quotes`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
				amount: {
					side: "send",
					value: { amount: "100000", currency: "USD" },
				},
				policy: "cheapest",
				feeMode: "PayerPays",
			}),
		})
	).json()) as { id: string };
	const payment = (await (
		await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipient.id,
				delivery: "claim_link",
				profile: "one_off",
			}),
		})
	).json()) as { claimLink: { url: string } | null };
	return payment.claimLink!.url.split("/").pop()!;
}

describe("CCR-21 passkey deploy route", () => {
	it("requires Idempotency-Key", async () => {
		const { key } = await t.newOrg("Passkey Deploy Org");
		const token = await openClaimToken(key);
		const carrier = buildValidCarrier();
		const res = await fetch(`${t.base}/v1/claims/${token}/passkey/deploy`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(carrier),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code: string }).code).toBe(
			"missing_idempotency_key",
		);
	});

	it("rejects garbage signedTx with 422 invalid_deploy_tx", async () => {
		const { key } = await t.newOrg("Passkey Deploy Org 2");
		const token = await openClaimToken(key);
		const carrier = buildValidCarrier();
		const res = await fetch(`${t.base}/v1/claims/${token}/passkey/deploy`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "deploy-bad-xdr-1",
			},
			body: JSON.stringify({
				...carrier,
				signedTx: Buffer.from("not-a-transaction").toString("base64"),
			}),
		});
		expect(res.status).toBe(422);
		expect(((await res.json()) as { code: string }).code).toBe(
			"invalid_deploy_tx",
		);
	});

	it("returns 502 deploy_failed when FP_PAYER_DEMO_SECRET is missing", async () => {
		const prev = process.env.FP_PAYER_DEMO_SECRET;
		delete process.env.FP_PAYER_DEMO_SECRET;
		try {
			const { key } = await t.newOrg("Passkey Deploy Org 3");
			const token = await openClaimToken(key);
			const carrier = buildValidCarrier(Buffer.from("api-deploy-cred-secret"));
			// Ensure public address alone is not enough.
			process.env.FP_PAYER_DEMO_ADDRESS =
				process.env.FP_PAYER_DEMO_ADDRESS ??
				"GA3VFDLARJMD7IBYZ2EW3SDQBAIASVSFLFKKBLCNI4D3KDMWDQJX6D6F";
			const res = await fetch(`${t.base}/v1/claims/${token}/passkey/deploy`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "deploy-no-secret-1",
				},
				body: JSON.stringify(carrier),
			});
			expect(res.status).toBe(502);
			const body = (await res.json()) as { code: string; message: string };
			expect(body.code).toBe("deploy_failed");
			expect(body.message).toMatch(/FP_PAYER_DEMO_SECRET/);
		} finally {
			if (prev === undefined) delete process.env.FP_PAYER_DEMO_SECRET;
			else process.env.FP_PAYER_DEMO_SECRET = prev;
		}
	});

	it("returns 404 for unknown claim token", async () => {
		const carrier = buildValidCarrier();
		const res = await fetch(
			`${t.base}/v1/claims/${"ab".repeat(32)}/passkey/deploy`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "deploy-missing-claim",
				},
				body: JSON.stringify(carrier),
			},
		);
		expect(res.status).toBe(404);
	});
});
