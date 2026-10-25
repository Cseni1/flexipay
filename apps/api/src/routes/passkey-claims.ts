import {
	PasskeyDeployRequestSchema,
	PasskeyDeployResponseSchema,
	PasskeyPrepareRequestSchema,
	PasskeyPrepareResponseSchema,
	PasskeySubmitPendingResponseSchema,
	PasskeySubmitRequestSchema,
	PasskeySubmitResponseSchema,
	type PasskeyDeployResponse,
	type PasskeyPrepareResponse,
	type PasskeySubmitPendingResponse,
	type PasskeySubmitResponse,
} from "@flexipay/domain";
import {
	decodeSealedPrepareBlob,
	encodeSealedPrepareBlob,
	getPasskeyDeployTxOutcome,
	hasPayerDemoSecret,
	hostFunctionFromXdr,
	loadPayerDemoKeypair,
	loadStellarEnv,
	matchSignedAuthEntries,
	PasskeyAuthMismatchError,
	PasskeyDeployValidationError,
	prepareVaultPasskeyClaimAuth,
	rebuildAndSignPasskeyClaimRelease,
	rebuildAndSignPasskeyDeploy,
	resubmitPasskeyDeployEnvelope,
	sendSignedPasskeyDeploy,
	validatePasskeyDeployCarrier,
	waitPasskeyDeploySuccess,
} from "@flexipay/adapter-stellar";
import { ApiError } from "../errors.ts";
import { newId, sha256Hex } from "../ids.ts";
import { withIdempotency } from "../idempotency.ts";
import {
	ClaimReleaseRefusedError,
	recordPasskeyClaimRelease,
	unsealClaimSecret,
} from "../orchestrator/index.ts";
import { sealBytes, unsealBytes } from "../orchestrator/claim-seal.ts";
import {
	defineRoute,
	type Ctx,
	type HttpRouteResult,
	type RouteDef,
} from "../routes.ts";
import {
	loadClaimByToken,
	toClaimView,
	type LoadedClaim,
} from "./claims.ts";
import type { Request } from "express";

function assertClaimOpenForPasskey(link: LoadedClaim, now: Date): void {
	if (link.status === "accepted") {
		throw new ApiError(409, "invalid_state", "claim already accepted");
	}
	if (link.status !== "open") {
		throw new ApiError(409, "invalid_state", `claim is ${link.status}`);
	}
	if (link.expiresAt.getTime() <= now.getTime()) {
		throw new ApiError(409, "expired", "claim link expired");
	}
}

function toDeployResponse(
	contractId: string,
	deployTxHash: string,
	creationLedger: number,
): PasskeyDeployResponse {
	return PasskeyDeployResponseSchema.parse({
		contractId,
		deployTxHash,
		creationLedger,
		status: "deployed",
	});
}

async function finishDeploySuccess(
	db: Ctx["db"],
	linkId: string,
	contractId: string,
	deployTxHash: string,
	creationLedger: number,
): Promise<PasskeyDeployResponse> {
	await db.claimLink.update({
		where: { id: linkId },
		data: {
			passkeyContractId: contractId,
			passkeyDeployTxHash: deployTxHash,
			passkeyDeployPendingContractId: null,
			passkeyDeployPendingTxHash: null,
			passkeyDeployPendingSealed: null,
			passkeyDeployPendingSealedNonce: null,
		},
	});
	return toDeployResponse(contractId, deployTxHash, creationLedger);
}

const DEFAULT_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function networkPassphraseFromEnv(
	env: Record<string, string | undefined>,
): string {
	const raw = env.FP_STELLAR_NETWORK_PASSPHRASE?.trim();
	if (!raw) return DEFAULT_TESTNET_PASSPHRASE;
	return raw.replace(/^"(.*)"$/, "$1");
}

function requireStellarEnv(env: Record<string, string | undefined>) {
	try {
		return loadStellarEnv(env);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "stellar env incomplete";
		throw new ApiError(502, "deploy_failed", msg);
	}
}

function requirePayerSecret(
	env: Record<string, string | undefined>,
	code: "deploy_failed" | "prepare_failed" | "release_failed" = "deploy_failed",
): void {
	if (!hasPayerDemoSecret(env)) {
		throw new ApiError(
			502,
			code,
			"FP_PAYER_DEMO_SECRET is not configured on this API host",
		);
	}
}

async function recoverOrSubmitDeploy(input: {
	ctx: Ctx;
	link: LoadedClaim;
	body: {
		contractId: string;
		keyIdBase64: string;
		signedTx: string;
	};
}): Promise<PasskeyDeployResponse> {
	const { ctx, link, body } = input;
	const runtime = ctx.runtime;
	if (!runtime) {
		throw new ApiError(500, "internal_error", "runtime not configured");
	}
	const env = process.env;

	// Already SUCCESS on this claim — never redeploy.
	if (link.passkeyDeployTxHash && link.passkeyContractId) {
		const stellarEnv = requireStellarEnv(env);
		if (link.passkeyContractId !== body.contractId) {
			throw new ApiError(
				422,
				"contract_mismatch",
				"claim already bound to a different passkey contractId",
			);
		}
		const outcome = await getPasskeyDeployTxOutcome(
			link.passkeyDeployTxHash,
			stellarEnv.rpcUrl,
		);
		if (outcome.kind === "success") {
			return toDeployResponse(
				link.passkeyContractId,
				outcome.txHash,
				outcome.ledger,
			);
		}
		// Hash recorded as success locally; chain lag — poll briefly.
		if (outcome.kind === "pending" || outcome.kind === "not_found" || outcome.kind === "unknown") {
			try {
				const waited = await waitPasskeyDeploySuccess({
					txHash: link.passkeyDeployTxHash,
					rpcUrl: stellarEnv.rpcUrl,
					timeoutMs: 45_000,
				});
				return toDeployResponse(
					link.passkeyContractId,
					waited.deployTxHash,
					waited.creationLedger,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "deploy recovery failed";
				throw new ApiError(502, "deploy_failed", msg);
			}
		}
		throw new ApiError(502, "deploy_failed", "recorded deploy hash failed on-chain");
	}

	// Pending binding: recover same hash first (CCR-21 — no blind rebuild).
	if (link.passkeyDeployPendingTxHash) {
		const stellarEnv = requireStellarEnv(env);
		const pendingHash = link.passkeyDeployPendingTxHash;
		const pendingContract =
			link.passkeyDeployPendingContractId ?? body.contractId;
		if (pendingContract !== body.contractId) {
			throw new ApiError(
				422,
				"contract_mismatch",
				"pending deploy is bound to a different contractId",
			);
		}
		const outcome = await getPasskeyDeployTxOutcome(
			pendingHash,
			stellarEnv.rpcUrl,
		);
		if (outcome.kind === "success") {
			return finishDeploySuccess(
				ctx.db,
				link.id,
				pendingContract,
				outcome.txHash,
				outcome.ledger,
			);
		}
		if (outcome.kind === "failed") {
			await ctx.db.claimLink.update({
				where: { id: link.id },
				data: {
					passkeyDeployPendingContractId: null,
					passkeyDeployPendingTxHash: null,
					passkeyDeployPendingSealed: null,
					passkeyDeployPendingSealedNonce: null,
				},
			});
			// Fall through to a new build after clearing failed pending.
		} else {
			// PENDING / NOT_FOUND / unknown — restore sealed envelope if needed.
			if (
				outcome.kind === "not_found" ||
				outcome.kind === "unknown"
			) {
				if (
					!link.passkeyDeployPendingSealed ||
					!link.passkeyDeployPendingSealedNonce
				) {
					throw new ApiError(
						502,
						"deploy_failed",
						"pending deploy hash not found and sealed envelope missing",
					);
				}
				const envelopeXdr = unsealBytes(
					Buffer.from(link.passkeyDeployPendingSealed),
					Buffer.from(link.passkeyDeployPendingSealedNonce),
					runtime.claimSealKey,
				).toString("utf8");
				try {
					await resubmitPasskeyDeployEnvelope({
						envelopeXdrBase64: envelopeXdr,
						networkPassphrase: stellarEnv.networkPassphrase,
						rpcUrl: stellarEnv.rpcUrl,
					});
				} catch {
					// Duplicate submit / race is fine — continue poll for same hash.
				}
			}
			try {
				const waited = await waitPasskeyDeploySuccess({
					txHash: pendingHash,
					rpcUrl: stellarEnv.rpcUrl,
					timeoutMs: 60_000,
				});
				return finishDeploySuccess(
					ctx.db,
					link.id,
					pendingContract,
					waited.deployTxHash,
					waited.creationLedger,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "deploy still pending";
				throw new ApiError(502, "deploy_failed", msg);
			}
		}
	}

	// Validate carrier before requiring secrets / RPC (stable 422s for Freebuff).
	const passphrase = networkPassphraseFromEnv(env);
	let validated;
	try {
		validated = validatePasskeyDeployCarrier({
			signedTx: body.signedTx,
			contractId: body.contractId,
			keyIdBase64: body.keyIdBase64,
			networkPassphrase: passphrase,
		});
	} catch (e) {
		if (e instanceof PasskeyDeployValidationError) {
			throw new ApiError(422, e.code, e.message);
		}
		throw e;
	}

	requirePayerSecret(env);
	const stellarEnv = requireStellarEnv(env);
	const payer = loadPayerDemoKeypair(env);
	let signed;
	try {
		signed = await rebuildAndSignPasskeyDeploy({
			validated,
			payer,
			networkPassphrase: stellarEnv.networkPassphrase,
			rpcUrl: stellarEnv.rpcUrl,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : "rebuild failed";
		throw new ApiError(502, "deploy_failed", msg);
	}

	const { sealed, nonce } = sealBytes(
		Buffer.from(signed.envelopeXdrBase64, "utf8"),
		runtime.claimSealKey,
	);

	// Persist pending binding BEFORE send (CCR-21).
	await ctx.db.claimLink.update({
		where: { id: link.id },
		data: {
			passkeyDeployPendingContractId: validated.contractId,
			passkeyDeployPendingTxHash: signed.txHash,
			passkeyDeployPendingSealed: sealed,
			passkeyDeployPendingSealedNonce: nonce,
		},
	});

	try {
		await sendSignedPasskeyDeploy({
			tx: signed.tx,
			rpcUrl: stellarEnv.rpcUrl,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : "send failed";
		throw new ApiError(502, "deploy_failed", msg);
	}

	try {
		const waited = await waitPasskeyDeploySuccess({
			txHash: signed.txHash,
			rpcUrl: stellarEnv.rpcUrl,
			timeoutMs: 90_000,
		});
		return finishDeploySuccess(
			ctx.db,
			link.id,
			validated.contractId,
			waited.deployTxHash,
			waited.creationLedger,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "deploy pending";
		throw new ApiError(502, "deploy_failed", msg);
	}
}

/**
 * Express Request is stashed on Ctx for claim-scoped idempotency (auth: none).
 * Set by app.ts when route.idempotency === "claim".
 */
export type CtxWithRequest = Ctx & { req?: Request };

function settleWaiting(link: LoadedClaim) {
	const settle = link.payment.legs.find((l) => l.kind === "settle");
	if (settle && (settle.status === "failed" || settle.errorCode === "fee_drift")) {
		throw new ApiError(
			409,
			"settle_failed",
			"the funds for this payment were returned; the claim cannot be released",
		);
	}
	if (
		link.payment.status !== "processing" ||
		!settle ||
		settle.status !== "processing" ||
		!settle.externalRef
	) {
		throw new ApiError(
			409,
			"invalid_state",
			"settle leg is not waiting for claim release (fund payment first)",
		);
	}
	return settle;
}

function assertPasskeyBound(link: LoadedClaim, contractId: string): void {
	if (!link.passkeyContractId || !link.passkeyDeployTxHash) {
		throw new ApiError(
			409,
			"invalid_state",
			"passkey wallet not deployed for this claim",
		);
	}
	if (link.passkeyContractId !== contractId) {
		throw new ApiError(
			422,
			"contract_mismatch",
			"contractId does not match the deployed passkey wallet on this claim",
		);
	}
}

async function handlePrepare(
	ctx: Ctx,
	token: string,
	body: { contractId: string },
): Promise<PasskeyPrepareResponse> {
	const runtime = ctx.runtime;
	if (!runtime) {
		throw new ApiError(500, "internal_error", "runtime not configured");
	}
	const link = await loadClaimByToken(ctx.db, token);
	if (!link) throw new ApiError(404, "not_found", "Claim not found");
	const now = runtime.now();
	assertClaimOpenForPasskey(link, now);
	assertPasskeyBound(link, body.contractId);
	const settle = settleWaiting(link);

	if (!link.secretSealed || !link.secretSealedNonce) {
		throw new ApiError(502, "prepare_failed", "claim secret seal missing");
	}

	const env = process.env;
	requirePayerSecret(env, "prepare_failed");
	const stellarEnv = requireStellarEnv(env);
	const payer = loadPayerDemoKeypair(env);
	const secretHex = unsealClaimSecret(
		Buffer.from(link.secretSealed),
		Buffer.from(link.secretSealedNonce),
		runtime.claimSealKey,
	);

	let prepared;
	try {
		prepared = await prepareVaultPasskeyClaimAuth({
			env: stellarEnv,
			payer,
			payoutId: BigInt(settle.externalRef!),
			secret: Buffer.from(secretHex, "hex"),
			toContractId: body.contractId,
		});
	} catch (e) {
		if (e instanceof PasskeyAuthMismatchError) {
			throw new ApiError(422, e.code, e.message);
		}
		const msg = e instanceof Error ? e.message : "prepare failed";
		throw new ApiError(502, "prepare_failed", msg);
	}

	const authEntriesBase64 = prepared.authEntries.map((e) =>
		e.toXDR("base64"),
	);
	const sealedPlain = encodeSealedPrepareBlob({
		v: 1,
		authEntries: authEntriesBase64,
		hostFunction: prepared.hostFunction.toXDR("base64"),
	});
	const { sealed, nonce } = sealBytes(sealedPlain, runtime.claimSealKey);
	const prepareId = newId("pkp");

	await ctx.db.passkeyClaimPrepare.create({
		data: {
			id: prepareId,
			paymentId: link.paymentId,
			tokenHash: sha256Hex(token),
			contractId: body.contractId,
			payoutId: settle.externalRef!,
			networkPassphrase: stellarEnv.networkPassphrase,
			signatureExpirationLedger: prepared.signatureExpirationLedger,
			status: "open",
			authInvocationFingerprints: prepared.meta.fingerprints,
			authNonces: prepared.meta.nonces,
			authAddresses: prepared.meta.addresses,
			authEntriesSealed: sealed,
			authEntriesSealedNonce: nonce,
		},
	});

	return PasskeyPrepareResponseSchema.parse({
		prepareId,
		payoutId: settle.externalRef!,
		networkPassphrase: stellarEnv.networkPassphrase,
		signatureExpirationLedger: prepared.signatureExpirationLedger,
		authEntries: authEntriesBase64,
	});
}

async function handleSubmit(
	ctx: Ctx,
	token: string,
	body: {
		prepareId: string;
		contractId: string;
		signedAuthEntries: string[];
	},
): Promise<HttpRouteResult> {
	const runtime = ctx.runtime;
	if (!runtime) {
		throw new ApiError(500, "internal_error", "runtime not configured");
	}
	const link = await loadClaimByToken(ctx.db, token);
	if (!link) throw new ApiError(404, "not_found", "Claim not found");
	const now = runtime.now();
	assertClaimOpenForPasskey(link, now);
	assertPasskeyBound(link, body.contractId);
	settleWaiting(link);

	const prepare = await ctx.db.passkeyClaimPrepare.findUnique({
		where: { id: body.prepareId },
	});
	if (
		!prepare ||
		prepare.paymentId !== link.paymentId ||
		prepare.tokenHash !== sha256Hex(token)
	) {
		throw new ApiError(404, "not_found", "Prepare not found for this claim");
	}
	if (prepare.contractId !== body.contractId) {
		throw new ApiError(422, "contract_mismatch", "prepare contractId mismatch");
	}

	const env = process.env;
	requirePayerSecret(env, "release_failed");
	const stellarEnv = requireStellarEnv(env);

	const pendingBody = (
		pendingTxHash: string,
		paymentStatus: string,
	): PasskeySubmitPendingResponse =>
		PasskeySubmitPendingResponseSchema.parse({
			status: "pending",
			prepareId: prepare.id,
			paymentId: link.paymentId,
			paymentStatus,
			pendingTxHash,
		});

	const successBody = async (
		releaseTxRef: string,
	): Promise<PasskeySubmitResponse> => {
		let status: string;
		try {
			status = (
				await recordPasskeyClaimRelease(
					ctx.db,
					link.paymentId,
					{
						getProvider: runtime.getProvider,
						settlement: runtime.settlement,
						vaultPayer: runtime.vaultPayer,
						now: runtime.now,
						claimSealKey: runtime.claimSealKey,
					},
					releaseTxRef,
				)
			).status;
		} catch (e) {
			if (e instanceof ClaimReleaseRefusedError) {
				throw new ApiError(409, "settle_failed", e.message);
			}
			throw e;
		}
		await ctx.db.passkeyClaimPrepare.update({
			where: { id: prepare.id },
			data: {
				status: "submitted",
				pendingTxHash: null,
				pendingTxSealed: null,
				pendingTxSealedNonce: null,
			},
		});
		const refreshed = await loadClaimByToken(ctx.db, token);
		if (!refreshed) throw new ApiError(404, "not_found", "Claim not found");
		return PasskeySubmitResponseSchema.parse({
			claim: toClaimView(refreshed, runtime.now()),
			paymentId: link.paymentId,
			paymentStatus: status,
			releaseTxRef,
		});
	};

	// Recovery: pendingTxHash set → getTransaction first (CCR-21).
	if (prepare.pendingTxHash) {
		const outcome = await getPasskeyDeployTxOutcome(
			prepare.pendingTxHash,
			stellarEnv.rpcUrl,
		);
		if (outcome.kind === "success") {
			return {
				httpStatus: 200,
				body: await successBody(outcome.txHash),
			};
		}
		if (outcome.kind === "failed") {
			await ctx.db.passkeyClaimPrepare.update({
				where: { id: prepare.id },
				data: {
					status: "failed",
					pendingTxHash: null,
					pendingTxSealed: null,
					pendingTxSealedNonce: null,
					reservedAt: null,
				},
			});
			throw new ApiError(502, "release_failed", "pending release tx FAILED on-chain");
		}
		if (outcome.kind === "not_found" || outcome.kind === "unknown") {
			if (!prepare.pendingTxSealed || !prepare.pendingTxSealedNonce) {
				throw new ApiError(
					502,
					"release_failed",
					"pending release hash not found and sealed envelope missing",
				);
			}
			const envelopeXdr = unsealBytes(
				Buffer.from(prepare.pendingTxSealed),
				Buffer.from(prepare.pendingTxSealedNonce),
				runtime.claimSealKey,
			).toString("utf8");
			try {
				await resubmitPasskeyDeployEnvelope({
					envelopeXdrBase64: envelopeXdr,
					networkPassphrase: stellarEnv.networkPassphrase,
					rpcUrl: stellarEnv.rpcUrl,
				});
			} catch {
				/* race / duplicate — continue poll */
			}
		}
		try {
			const waited = await waitPasskeyDeploySuccess({
				txHash: prepare.pendingTxHash,
				rpcUrl: stellarEnv.rpcUrl,
				timeoutMs: 45_000,
			});
			return {
				httpStatus: 200,
				body: await successBody(waited.deployTxHash),
			};
		} catch {
			return {
				httpStatus: 202,
				body: pendingBody(prepare.pendingTxHash, link.payment.status),
			};
		}
	}

	if (prepare.status !== "open" && prepare.status !== "reserved") {
		throw new ApiError(
			409,
			"invalid_state",
			`prepare is ${prepare.status}`,
		);
	}

	// Atomic open → reserved (CCR-21). Concurrent second reserve → 409.
	if (prepare.status === "open") {
		const reserved = await ctx.db.passkeyClaimPrepare.updateMany({
			where: { id: prepare.id, status: "open" },
			data: { status: "reserved", reservedAt: new Date() },
		});
		if (reserved.count !== 1) {
			throw new ApiError(
				409,
				"idempotency_conflict",
				"prepare already reserved by a concurrent submit",
			);
		}
	}

	const fingerprints = prepare.authInvocationFingerprints as string[];
	const nonces = prepare.authNonces as string[];
	const addresses = prepare.authAddresses as string[];
	let signed;
	try {
		signed = matchSignedAuthEntries(
			{
				signatureExpirationLedger: prepare.signatureExpirationLedger,
				fingerprints,
				nonces,
				addresses,
			},
			body.signedAuthEntries,
		);
	} catch (e) {
		if (e instanceof PasskeyAuthMismatchError) {
			throw new ApiError(422, e.code, e.message);
		}
		throw e;
	}

	const blob = decodeSealedPrepareBlob(
		unsealBytes(
			Buffer.from(prepare.authEntriesSealed),
			Buffer.from(prepare.authEntriesSealedNonce),
			runtime.claimSealKey,
		),
	);
	const hostFunction = hostFunctionFromXdr(blob.hostFunction);
	const payer = loadPayerDemoKeypair(env);

	let signedEnvelope;
	try {
		signedEnvelope = await rebuildAndSignPasskeyClaimRelease({
			hostFunction,
			signedAuth: signed,
			payer,
			networkPassphrase: stellarEnv.networkPassphrase,
			rpcUrl: stellarEnv.rpcUrl,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : "release rebuild failed";
		throw new ApiError(502, "release_failed", msg);
	}

	const { sealed, nonce } = sealBytes(
		Buffer.from(signedEnvelope.envelopeXdrBase64, "utf8"),
		runtime.claimSealKey,
	);
	await ctx.db.passkeyClaimPrepare.update({
		where: { id: prepare.id },
		data: {
			pendingTxHash: signedEnvelope.txHash,
			pendingTxSealed: sealed,
			pendingTxSealedNonce: nonce,
		},
	});

	try {
		await sendSignedPasskeyDeploy({
			tx: signedEnvelope.tx,
			rpcUrl: stellarEnv.rpcUrl,
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : "release send failed";
		throw new ApiError(502, "release_failed", msg);
	}

	try {
		const waited = await waitPasskeyDeploySuccess({
			txHash: signedEnvelope.txHash,
			rpcUrl: stellarEnv.rpcUrl,
			timeoutMs: 90_000,
		});
		return {
			httpStatus: 200,
			body: await successBody(waited.deployTxHash),
		};
	} catch {
		return {
			httpStatus: 202,
			body: pendingBody(signedEnvelope.txHash, link.payment.status),
		};
	}
}

export const passkeyClaimRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/claims/{token}/passkey/deploy",
		summary:
			"Public: submit passkey-kit createWallet carrier; backend pays with FP_PAYER_DEMO",
		auth: "none",
		idempotency: "claim",
		body: PasskeyDeployRequestSchema,
		success: { status: 200, schema: PasskeyDeployResponseSchema },
		handler: async (ctx, { body, params }) => {
			const req = (ctx as CtxWithRequest).req;
			if (!req) {
				throw new ApiError(500, "internal_error", "request context missing");
			}
			const token = params.token!;
			const link = await loadClaimByToken(ctx.db, token);
			if (!link) throw new ApiError(404, "not_found", "Claim not found");
			const now = ctx.runtime?.now() ?? new Date();
			assertClaimOpenForPasskey(link, now);

			const orgId = link.payment.organizationId;
			const result = await withIdempotency(
				ctx.db,
				req,
				orgId,
				async () => {
					const fresh = await loadClaimByToken(ctx.db, token);
					if (!fresh) throw new ApiError(404, "not_found", "Claim not found");
					assertClaimOpenForPasskey(fresh, ctx.runtime?.now() ?? new Date());
					const response = await recoverOrSubmitDeploy({
						ctx,
						link: fresh,
						body,
					});
					return { status: 200, body: response };
				},
				{
					required: true,
					beforeReturnCache: async () => {
						const again = await loadClaimByToken(ctx.db, token);
						if (!again) {
							throw new ApiError(404, "not_found", "Claim not found");
						}
						if (again.payment.organizationId !== orgId) {
							throw new ApiError(
								409,
								"idempotency_conflict",
								"claim organization no longer matches Idempotency-Key scope",
							);
						}
						assertClaimOpenForPasskey(again, ctx.runtime?.now() ?? new Date());
					},
				},
			);
			return result.body;
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/claims/{token}/passkey/prepare",
		summary:
			"Public: build vault claim auth entries for a C… passkey wallet",
		auth: "none",
		body: PasskeyPrepareRequestSchema,
		success: { status: 200, schema: PasskeyPrepareResponseSchema },
		handler: async (ctx, { body, params }) => {
			return handlePrepare(ctx, params.token!, body);
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/claims/{token}/passkey/submit",
		summary:
			"Public: submit passkey-signed claim auth; 200 released / 202 pending",
		auth: "none",
		idempotency: "claim",
		body: PasskeySubmitRequestSchema,
		success: { status: 200, schema: PasskeySubmitResponseSchema },
		extraResponses: [
			{
				status: 202,
				description:
					"Release tx persisted or awaiting confirmation; Leg.releaseTxRef not written yet",
				schema: PasskeySubmitPendingResponseSchema,
			},
		],
		handler: async (ctx, { body, params }) => {
			const req = (ctx as CtxWithRequest).req;
			if (!req) {
				throw new ApiError(500, "internal_error", "request context missing");
			}
			const token = params.token!;
			const link = await loadClaimByToken(ctx.db, token);
			if (!link) throw new ApiError(404, "not_found", "Claim not found");
			const now = ctx.runtime?.now() ?? new Date();
			assertClaimOpenForPasskey(link, now);
			const orgId = link.payment.organizationId;

			const result = await withIdempotency(
				ctx.db,
				req,
				orgId,
				async () => {
					const out = await handleSubmit(ctx, token, body);
					return { status: out.httpStatus, body: out.body };
				},
				{
					required: true,
					beforeReturnCache: async () => {
						const again = await loadClaimByToken(ctx.db, token);
						if (!again) {
							throw new ApiError(404, "not_found", "Claim not found");
						}
						if (again.payment.organizationId !== orgId) {
							throw new ApiError(
								409,
								"idempotency_conflict",
								"claim organization no longer matches Idempotency-Key scope",
							);
						}
					},
				},
			);
			return {
				httpStatus: result.status as 200 | 202,
				body: result.body,
			} satisfies HttpRouteResult;
		},
	}),
];
