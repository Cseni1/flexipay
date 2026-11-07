import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// CCR-21 passkey deploy / prepare / submit through the HTTP routes, with every Stellar RPC call
// stubbed (no testnet). Covers the success paths, the recovery paths (pending hashes, sealed
// envelopes) and how each failure maps to an HTTP status. The mock vault (FP_SETTLEMENT=mock)
// provides a real funded claim with a locked settle leg.

/** Tx hashes are unique columns: fresh ones per test. */
const hashes = vi.hoisted(() => ({ deploy: "", pending: "", release: "" }));
const hex64 = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

const rpc = vi.hoisted(() => {
	const state = {
		outcome: { kind: "not_found" } as { kind: string; txHash?: string; ledger?: number },
		wait: null as null | ((txHash: string) => Promise<{ deployTxHash: string; creationLedger: number }>),
		send: null as null | (() => Promise<void>),
		resubmitted: [] as string[],
		rebuildDeploy: null as null | (() => Promise<unknown>),
		validate: null as null | ((b: { contractId: string }) => unknown),
		prepare: null as null | (() => Promise<unknown>),
		match: null as null | (() => unknown),
		rebuildRelease: null as null | (() => Promise<unknown>),
		stellarEnvOk: true,
	};
	return state;
});

vi.mock("@flexipay/adapter-stellar", async (importOriginal) => {
	const real = await importOriginal<typeof import("@flexipay/adapter-stellar")>();
	return {
		...real,
		loadStellarEnv: () => {
			if (!rpc.stellarEnvOk) throw new Error("Missing Stellar settings: FP_STELLAR_RPC_URL");
			return { rpcUrl: "http://rpc.invalid", networkPassphrase: "Test SDF Network ; September 2015" };
		},
		hasPayerDemoSecret: () => true,
		loadPayerDemoKeypair: () => ({ publicKey: () => "GPAYER" }),
		getPasskeyDeployTxOutcome: async () => rpc.outcome,
		waitPasskeyDeploySuccess: async ({ txHash }: { txHash: string }) =>
			rpc.wait ? rpc.wait(txHash) : { deployTxHash: txHash, creationLedger: 77 },
		sendSignedPasskeyDeploy: async () => {
			if (rpc.send) await rpc.send();
		},
		resubmitPasskeyDeployEnvelope: async ({ envelopeXdrBase64 }: { envelopeXdrBase64: string }) => {
			rpc.resubmitted.push(envelopeXdrBase64);
			throw new Error("duplicate submit (ignored by the route)");
		},
		validatePasskeyDeployCarrier: (b: { contractId: string }) => (rpc.validate ? rpc.validate(b) : { contractId: b.contractId }),
		rebuildAndSignPasskeyDeploy: async () =>
			rpc.rebuildDeploy ? rpc.rebuildDeploy() : { envelopeXdrBase64: "DEPLOY_ENVELOPE", txHash: hashes.deploy, tx: {} },
		prepareVaultPasskeyClaimAuth: async () =>
			rpc.prepare
				? rpc.prepare()
				: {
						authEntries: [{ toXDR: () => "QUFBQQ==" }],
						hostFunction: { toXDR: () => "SE9TVA==" },
						signatureExpirationLedger: 4242,
						meta: { fingerprints: ["fp1"], nonces: ["1"], addresses: ["C1"] },
					},
		matchSignedAuthEntries: () => (rpc.match ? rpc.match() : []),
		hostFunctionFromXdr: () => ({}),
		rebuildAndSignPasskeyClaimRelease: async () =>
			rpc.rebuildRelease ? rpc.rebuildRelease() : { envelopeXdrBase64: "RELEASE_ENVELOPE", txHash: hashes.release, tx: {} },
	};
});

const { PasskeyAuthMismatchError, PasskeyDeployValidationError } = await import("@flexipay/adapter-stellar");
const { sealBytes } = await import("../src/orchestrator/claim-seal.ts");
const { auth, startTestServer } = await import("./helpers.ts");

const CONTRACT = "C".padEnd(56, "A");
const OTHER_CONTRACT = "C".padEnd(56, "B");
const CARRIER = { contractId: CONTRACT, keyIdBase64: "a2V5", signedTx: "QUFBQQ==" };

let t: Awaited<ReturnType<typeof startTestServer>>;
let key: string;

beforeAll(async () => {
	t = await startTestServer();
	key = (await t.newOrg("Passkey Flow")).key;
}, 180_000);

afterAll(async () => {
	await t.stop();
});

beforeEach(() => {
	Object.assign(hashes, { deploy: hex64(), pending: hex64(), release: hex64() });
	Object.assign(rpc, {
		outcome: { kind: "not_found" },
		wait: null,
		send: null,
		resubmitted: [],
		rebuildDeploy: null,
		validate: null,
		prepare: null,
		match: null,
		rebuildRelease: null,
		stellarEnvOk: true,
	});
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${t.base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

let seq = 0;
const idem = () => ({ "idempotency-key": `pk-${++seq}-${Math.random()}` });

/** An open, funded crypto claim: settle leg processing with a vault payout id. */
async function fundedClaim(): Promise<{ token: string; paymentId: string }> {
	const api = (path: string, body: unknown) =>
		fetch(`${t.base}${path}`, { method: "POST", headers: auth(key), body: JSON.stringify(body) }).then((r) => r.json());
	const recipient = await api("/v1/recipients", { name: "Worker A", kind: "individual", country: "PH" });
	const quote = await api("/v1/quotes", {
		source: { type: "bank_account", currency: "USD", country: "US" },
		destination: { type: "crypto_wallet", currency: "USDC", country: "PH", recipientKind: "individual" },
		amount: { side: "send", value: { amount: "100000", currency: "USD" } },
		policy: "cheapest",
		feeMode: "PayerPays",
	});
	const payment = await api("/v1/payments", {
		quoteId: quote.id,
		recipientId: recipient.id,
		delivery: "claim_link",
		profile: "one_off",
	});
	const funded = await api(`/v1/payments/${payment.id}/fund`, {});
	expect(funded.status).toBe("processing");
	return { paymentId: payment.id, token: payment.claimLink.url.split("/").pop() };
}

async function deployedClaim() {
	const c = await fundedClaim();
	await t.db.claimLink.update({
		where: { paymentId: c.paymentId },
		data: { passkeyContractId: CONTRACT, passkeyDeployTxHash: hashes.deploy },
	});
	return c;
}

const deploy = (token: string, body: unknown = CARRIER, h = idem()) => post(`/v1/claims/${token}/passkey/deploy`, body, h);
const prepare = (token: string, contractId = CONTRACT) => post(`/v1/claims/${token}/passkey/prepare`, { contractId });
const submit = (token: string, prepareId: string, h = idem(), contractId = CONTRACT) =>
	post(`/v1/claims/${token}/passkey/submit`, { prepareId, contractId, signedAuthEntries: ["QUFBQQ=="] }, h);

async function codeOf(res: Response): Promise<string> {
	return ((await res.json()) as { code: string }).code;
}

describe("passkey deploy", () => {
	it("first deploy: binds the pending hash before sending, then records the contract; a replay is cached", async () => {
		const { token, paymentId } = await fundedClaim();
		let pendingAtSend: string | null = null;
		rpc.send = async () => {
			pendingAtSend = (await t.db.claimLink.findUniqueOrThrow({ where: { paymentId } })).passkeyDeployPendingTxHash;
		};
		const h = idem();
		const res = await deploy(token, CARRIER, h);
		const body = await res.json();
		expect(res.status, JSON.stringify(body)).toBe(200);
		expect(body).toEqual({ contractId: CONTRACT, deployTxHash: hashes.deploy, creationLedger: 77, status: "deployed" });
		expect(pendingAtSend).toBe(hashes.deploy);
		const link = await t.db.claimLink.findUniqueOrThrow({ where: { paymentId } });
		expect(link.passkeyContractId).toBe(CONTRACT);
		expect(link.passkeyDeployTxHash).toBe(hashes.deploy);
		expect(link.passkeyDeployPendingTxHash).toBeNull();
		expect(link.passkeyDeployPendingSealed).toBeNull();

		rpc.send = async () => {
			throw new Error("must not send twice");
		};
		const replay = await deploy(token, CARRIER, h);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(body);
	});

	it("an already deployed claim is confirmed from the chain, never redeployed; another contract is refused", async () => {
		const { token } = await deployedClaim();
		rpc.rebuildDeploy = async () => {
			throw new Error("must not rebuild");
		};
		rpc.outcome = { kind: "success", txHash: hashes.deploy, ledger: 9 };
		const ok = await deploy(token);
		expect(ok.status).toBe(200);
		expect((await ok.json()).creationLedger).toBe(9);

		const mismatch = await deploy(token, { ...CARRIER, contractId: OTHER_CONTRACT });
		expect(mismatch.status).toBe(422);
		expect(await codeOf(mismatch)).toBe("contract_mismatch");
	});

	it("an already deployed claim whose hash lags is polled; a failed poll or a failed hash is 502", async () => {
		const { token } = await deployedClaim();
		rpc.outcome = { kind: "pending" };
		expect((await deploy(token)).status).toBe(200);
		rpc.wait = async () => {
			throw new Error("timed out waiting for deploy");
		};
		const slow = await deploy(token);
		expect(slow.status).toBe(502);
		expect((await slow.json()).message).toMatch(/timed out/);
		rpc.outcome = { kind: "failed" };
		const failed = await deploy(token);
		expect(failed.status).toBe(502);
		expect((await failed.json()).message).toMatch(/failed on-chain/);
	});

	async function pendingClaim(withSeal = true) {
		const c = await fundedClaim();
		const { sealed, nonce } = sealBytes(Buffer.from("PENDING_ENVELOPE", "utf8"), t.runtime.claimSealKey);
		await t.db.claimLink.update({
			where: { paymentId: c.paymentId },
			data: {
				passkeyDeployPendingContractId: CONTRACT,
				passkeyDeployPendingTxHash: hashes.pending,
				...(withSeal ? { passkeyDeployPendingSealed: sealed, passkeyDeployPendingSealedNonce: nonce } : {}),
			},
		});
		return c;
	}

	it("a pending deploy that landed is finished without a rebuild", async () => {
		const { token, paymentId } = await pendingClaim();
		rpc.rebuildDeploy = async () => {
			throw new Error("must not rebuild");
		};
		rpc.outcome = { kind: "success", txHash: hashes.pending, ledger: 5 };
		const res = await deploy(token);
		expect(res.status).toBe(200);
		expect((await res.json()).deployTxHash).toBe(hashes.pending);
		const link = await t.db.claimLink.findUniqueOrThrow({ where: { paymentId } });
		expect(link.passkeyDeployTxHash).toBe(hashes.pending);
		expect(link.passkeyDeployPendingTxHash).toBeNull();
	});

	it("a pending deploy bound to another contract is refused", async () => {
		const { token } = await pendingClaim();
		const res = await deploy(token, { ...CARRIER, contractId: OTHER_CONTRACT });
		expect(res.status).toBe(422);
		expect(await codeOf(res)).toBe("contract_mismatch");
	});

	it("a pending deploy the chain cannot find is resubmitted from the sealed envelope, then confirmed", async () => {
		const { token } = await pendingClaim();
		rpc.outcome = { kind: "not_found" };
		const res = await deploy(token);
		expect(res.status).toBe(200);
		expect(rpc.resubmitted).toEqual(["PENDING_ENVELOPE"]);
		expect((await res.json()).deployTxHash).toBe(hashes.pending);
	});

	it("a pending deploy not found and without its sealed envelope is a 502; a pending one that never lands is a 502", async () => {
		const noSeal = await pendingClaim(false);
		rpc.outcome = { kind: "unknown" };
		const res = await deploy(noSeal.token);
		expect(res.status).toBe(502);
		expect((await res.json()).message).toMatch(/sealed envelope missing/);

		const stuck = await pendingClaim();
		rpc.outcome = { kind: "pending" };
		rpc.wait = async () => {
			throw new Error("still pending");
		};
		const pending = await deploy(stuck.token);
		expect(pending.status).toBe(502);
		expect(rpc.resubmitted).toEqual([]);
	});

	it("a pending deploy that failed on-chain is cleared and rebuilt", async () => {
		const { token, paymentId } = await pendingClaim();
		rpc.outcome = { kind: "failed" };
		const res = await deploy(token);
		expect(res.status).toBe(200);
		expect((await res.json()).deployTxHash).toBe(hashes.deploy);
		const link = await t.db.claimLink.findUniqueOrThrow({ where: { paymentId } });
		expect(link.passkeyDeployTxHash).toBe(hashes.deploy);
	});

	it("maps carrier, configuration, rebuild, send and confirmation failures", async () => {
		const { token, paymentId } = await fundedClaim();
		rpc.validate = () => {
			throw new PasskeyDeployValidationError("invalid_deploy_tx", "not a deploy");
		};
		const bad = await deploy(token);
		expect(bad.status).toBe(422);
		expect(await codeOf(bad)).toBe("invalid_deploy_tx");
		rpc.validate = null;

		rpc.stellarEnvOk = false;
		const env = await deploy(token);
		expect(env.status).toBe(502);
		expect((await env.json()).message).toMatch(/Missing Stellar settings/);
		rpc.stellarEnvOk = true;

		rpc.rebuildDeploy = async () => {
			throw new Error("simulation failed");
		};
		const rebuild = await deploy(token);
		expect(rebuild.status).toBe(502);
		expect((await rebuild.json()).message).toBe("simulation failed");
		rpc.rebuildDeploy = null;

		rpc.send = async () => {
			throw new Error("rpc refused the send");
		};
		const send = await deploy(token);
		expect(send.status).toBe(502);
		// The pending binding stays for the recovery path.
		expect((await t.db.claimLink.findUniqueOrThrow({ where: { paymentId } })).passkeyDeployPendingTxHash).toBe(hashes.deploy);
	});

	it("a deploy whose confirmation times out is a 502 and keeps the pending binding", async () => {
		const { token, paymentId } = await fundedClaim();
		rpc.wait = async () => {
			throw new Error("deploy pending");
		};
		const res = await deploy(token);
		expect(res.status).toBe(502);
		expect((await t.db.claimLink.findUniqueOrThrow({ where: { paymentId } })).passkeyDeployPendingTxHash).toBe(hashes.deploy);
	});

	it("refuses an expired or an already accepted claim", async () => {
		const expired = await fundedClaim();
		await t.db.claimLink.update({ where: { paymentId: expired.paymentId }, data: { expiresAt: new Date(Date.now() - 1000) } });
		const e = await deploy(expired.token);
		expect(e.status).toBe(409);
		expect(await codeOf(e)).toBe("expired");

		const accepted = await fundedClaim();
		await t.db.claimLink.update({ where: { paymentId: accepted.paymentId }, data: { status: "accepted" } });
		const a = await deploy(accepted.token);
		expect(a.status).toBe(409);
		expect((await a.json()).message).toMatch(/already accepted/);

		await t.db.claimLink.update({ where: { paymentId: accepted.paymentId }, data: { status: "expired" } });
		expect((await deploy(accepted.token)).status).toBe(409);
	});
});

describe("passkey prepare", () => {
	it("returns unsigned auth entries and stores only the sealed copy", async () => {
		const { token, paymentId } = await deployedClaim();
		const res = await prepare(token);
		const body = await res.json();
		expect(res.status, JSON.stringify(body)).toBe(200);
		expect(body.authEntries).toEqual(["QUFBQQ=="]);
		expect(body.signatureExpirationLedger).toBe(4242);
		const row = await t.db.passkeyClaimPrepare.findUniqueOrThrow({ where: { id: body.prepareId } });
		expect(row.paymentId).toBe(paymentId);
		expect(row.status).toBe("open");
		expect(row.payoutId).toBe(body.payoutId);
		expect(Buffer.from(row.authEntriesSealed).toString("utf8")).not.toContain("QUFBQQ==");
	});

	it("maps an auth mismatch to 422 and any other build failure to 502", async () => {
		const { token } = await deployedClaim();
		rpc.prepare = async () => {
			throw new PasskeyAuthMismatchError("auth tree does not match the vault claim");
		};
		const mismatch = await prepare(token);
		expect(mismatch.status).toBe(422);
		expect(await codeOf(mismatch)).toBe("auth_mismatch");
		rpc.prepare = async () => {
			throw new Error("rpc simulate failed");
		};
		const down = await prepare(token);
		expect(down.status).toBe(502);
		expect(await codeOf(down)).toBe("prepare_failed");
	});

	it("refuses when the settle leg failed or the payment is not waiting for release", async () => {
		const failed = await deployedClaim();
		const settle = await t.db.leg.findFirstOrThrow({ where: { paymentId: failed.paymentId, kind: "settle" } });
		await t.db.leg.update({ where: { id: settle.id }, data: { errorCode: "fee_drift" } });
		const f = await prepare(failed.token);
		expect(f.status).toBe(409);
		expect(await codeOf(f)).toBe("settle_failed");

		const notWaiting = await deployedClaim();
		await t.db.payment.update({ where: { id: notWaiting.paymentId }, data: { status: "paid" } });
		const n = await prepare(notWaiting.token);
		expect(n.status).toBe(409);
		expect(await codeOf(n)).toBe("invalid_state");
	});

	it("an unknown claim token is 404", async () => {
		expect((await prepare("ff".repeat(32))).status).toBe(404);
		expect((await submit("ff".repeat(32), "pkp_x")).status).toBe(404);
	});
});

describe("passkey submit", () => {
	async function prepared() {
		const c = await deployedClaim();
		const res = await prepare(c.token);
		expect(res.status).toBe(200);
		return { ...c, prepareId: ((await res.json()) as { prepareId: string }).prepareId };
	}

	it("releases the claim: the payment is paid, the claim accepted, the prepare submitted", async () => {
		const { token, paymentId, prepareId } = await prepared();
		const res = await submit(token, prepareId);
		const body = await res.json();
		expect(res.status, JSON.stringify(body)).toBe(200);
		expect(body.paymentStatus).toBe("paid");
		expect(body.releaseTxRef).toBe(hashes.release);
		expect(body.claim.status).toBe("accepted");
		const settle = await t.db.leg.findFirstOrThrow({ where: { paymentId, kind: "settle" } });
		expect(settle.releaseTxRef).toBe(hashes.release);
		const row = await t.db.passkeyClaimPrepare.findUniqueOrThrow({ where: { id: prepareId } });
		expect(row.status).toBe("submitted");
		expect(row.pendingTxSealed).toBeNull();
	});

	// BUG: the submit route (apps/api/src/routes/passkey-claims.ts:854-858) runs
	// assertClaimOpenForPasskey before withIdempotency. After a successful release the claim is
	// `accepted`, so a client that lost the 200 and retries with the same Idempotency-Key gets
	// 409 "claim already accepted" instead of the cached 200 (CCR-21 "Restart / lost HTTP":
	// replay uses IdempotencyRecord after claim re-validation). Expected: the cached 200.
	it.fails("BUG: a lost 200 replayed with the same Idempotency-Key returns the cached success", async () => {
		const { token, prepareId } = await prepared();
		const h = idem();
		const first = await submit(token, prepareId, h);
		expect(first.status).toBe(200);
		const replay = await submit(token, prepareId, h);
		expect(replay.status).toBe(200);
	});

	// BUG: withIdempotency (apps/api/src/idempotency.ts:57-76) caches every non-throwing result,
	// including the 202 pending answer of submit. CCR-21 tells the client to "retry submit with
	// the same Idempotency-Key" after a 202, but that retry returns the cached 202 forever, even
	// once the release tx has succeeded on-chain; only a new key reaches the recovery path.
	// Expected: a 202 is not cached (or the replay re-runs recovery) so the same key reaches 200.
	it.fails("BUG: after a 202, retrying with the same Idempotency-Key reaches the 200 once the release lands", async () => {
		const { token, prepareId } = await prepared();
		rpc.wait = async () => {
			throw new Error("not yet");
		};
		const h = idem();
		expect((await submit(token, prepareId, h)).status).toBe(202);
		rpc.wait = null;
		rpc.outcome = { kind: "success", txHash: hashes.release, ledger: 3 };
		const retry = await submit(token, prepareId, h);
		expect(retry.status).toBe(200);
	});

	it("documents today's replay behaviour (see the two BUG cases above)", async () => {
		const pending = await prepared();
		rpc.wait = async () => {
			throw new Error("not yet");
		};
		const h = idem();
		const first = await (await submit(pending.token, pending.prepareId, h)).json();
		rpc.wait = null;
		rpc.outcome = { kind: "success", txHash: hashes.release, ledger: 3 };
		const cached = await submit(pending.token, pending.prepareId, h);
		expect(cached.status).toBe(202);
		expect(await cached.json()).toEqual(first);
		// A new key recovers it.
		const fresh = await submit(pending.token, pending.prepareId);
		expect(fresh.status).toBe(200);
		// And now the claim is accepted, the original key is refused before the cache.
		const after = await submit(pending.token, pending.prepareId, h);
		expect(after.status).toBe(409);
		expect((await after.json()).message).toMatch(/already accepted/);
	});

	it("a release that is sent but not yet confirmed answers 202 pending; the next submit recovers it", async () => {
		const { token, paymentId, prepareId } = await prepared();
		rpc.wait = async () => {
			throw new Error("not yet");
		};
		const pending = await submit(token, prepareId);
		expect(pending.status).toBe(202);
		const pb = await pending.json();
		expect(pb).toMatchObject({ status: "pending", prepareId, paymentId, pendingTxHash: hashes.release });
		expect((await t.db.leg.findFirstOrThrow({ where: { paymentId, kind: "settle" } })).releaseTxRef).toBeNull();

		// Still unknown on the chain: resubmitted from the sealed envelope, still pending.
		rpc.outcome = { kind: "not_found" };
		const again = await submit(token, prepareId);
		expect(again.status).toBe(202);
		expect(rpc.resubmitted).toEqual(["RELEASE_ENVELOPE"]);

		// The chain now reports success: finished with that hash.
		rpc.outcome = { kind: "success", txHash: hashes.release, ledger: 3 };
		const done = await submit(token, prepareId);
		expect(done.status).toBe(200);
		expect((await done.json()).paymentStatus).toBe("paid");
	});

	it("a pending release that later confirms through the poll is finished", async () => {
		const { token, prepareId } = await prepared();
		rpc.wait = async () => {
			throw new Error("not yet");
		};
		expect((await submit(token, prepareId)).status).toBe(202);
		rpc.wait = null;
		rpc.outcome = { kind: "pending" };
		const done = await submit(token, prepareId);
		expect(done.status).toBe(200);
		expect(rpc.resubmitted).toEqual([]);
	});

	it("a pending release that failed on-chain fails the prepare (502), after which it cannot be reused", async () => {
		const { token, prepareId } = await prepared();
		rpc.wait = async () => {
			throw new Error("not yet");
		};
		expect((await submit(token, prepareId)).status).toBe(202);
		rpc.outcome = { kind: "failed" };
		const failed = await submit(token, prepareId);
		expect(failed.status).toBe(502);
		expect(await codeOf(failed)).toBe("release_failed");
		expect((await t.db.passkeyClaimPrepare.findUniqueOrThrow({ where: { id: prepareId } })).status).toBe("failed");
		const reuse = await submit(token, prepareId);
		expect(reuse.status).toBe(409);
		expect((await reuse.json()).message).toMatch(/prepare is failed/);
	});

	it("a pending release whose sealed envelope is gone and the chain does not know it is a 502", async () => {
		const { token, prepareId } = await prepared();
		await t.db.passkeyClaimPrepare.update({ where: { id: prepareId }, data: { pendingTxHash: hashes.pending } });
		rpc.outcome = { kind: "unknown" };
		const res = await submit(token, prepareId);
		expect(res.status).toBe(502);
		expect((await res.json()).message).toMatch(/sealed envelope missing/);
	});

	it("refuses a prepare from another claim, a contract mismatch and signed entries that do not match", async () => {
		const a = await prepared();
		const b = await deployedClaim();
		const foreign = await submit(b.token, a.prepareId);
		expect(foreign.status).toBe(404);

		await t.db.passkeyClaimPrepare.update({ where: { id: a.prepareId }, data: { contractId: OTHER_CONTRACT } });
		const mismatch = await submit(a.token, a.prepareId);
		expect(mismatch.status).toBe(422);
		expect(await codeOf(mismatch)).toBe("contract_mismatch");
		await t.db.passkeyClaimPrepare.update({ where: { id: a.prepareId }, data: { contractId: CONTRACT } });

		rpc.match = () => {
			throw new PasskeyAuthMismatchError("signatureExpirationLedger differs");
		};
		const wrong = await submit(a.token, a.prepareId);
		expect(wrong.status).toBe(422);
		expect(await codeOf(wrong)).toBe("auth_mismatch");
		// The prepare stays reserved for a corrected retry.
		expect((await t.db.passkeyClaimPrepare.findUniqueOrThrow({ where: { id: a.prepareId } })).status).toBe("reserved");
		rpc.match = null;
		expect((await submit(a.token, a.prepareId)).status).toBe(200);
	});

	it("maps rebuild and send failures to 502 release_failed", async () => {
		const { token, prepareId } = await prepared();
		rpc.rebuildRelease = async () => {
			throw new Error("simulate release failed");
		};
		const rebuild = await submit(token, prepareId);
		expect(rebuild.status).toBe(502);
		expect(await codeOf(rebuild)).toBe("release_failed");
		rpc.rebuildRelease = null;
		rpc.send = async () => {
			throw new Error("send refused");
		};
		const send = await submit(token, prepareId);
		expect(send.status).toBe(502);
		expect((await send.json()).message).toBe("send refused");
	});

	it("refuses to release a claim whose settle leg failed (CCR-15)", async () => {
		const { token, paymentId, prepareId } = await prepared();
		const settle = await t.db.leg.findFirstOrThrow({ where: { paymentId, kind: "settle" } });
		await t.db.leg.update({ where: { id: settle.id }, data: { status: "failed" } });
		const res = await submit(token, prepareId);
		expect(res.status).toBe(409);
		expect(await codeOf(res)).toBe("settle_failed");
	});
});
