import {
	PasskeyDeployRequestSchema,
	PasskeyDeployResponseSchema,
	type PasskeyDeployResponse,
} from "@flexipay/domain";
import {
	getPasskeyDeployTxOutcome,
	hasPayerDemoSecret,
	loadPayerDemoKeypair,
	loadStellarEnv,
	PasskeyDeployValidationError,
	rebuildAndSignPasskeyDeploy,
	resubmitPasskeyDeployEnvelope,
	sendSignedPasskeyDeploy,
	validatePasskeyDeployCarrier,
	waitPasskeyDeploySuccess,
} from "@flexipay/adapter-stellar";
import { ApiError } from "../errors.ts";
import { sha256Hex } from "../ids.ts";
import { withIdempotency } from "../idempotency.ts";
import { sealBytes, unsealBytes } from "../orchestrator/claim-seal.ts";
import { defineRoute, type Ctx, type RouteDef } from "../routes.ts";
import type { Request } from "express";

async function loadClaimByToken(db: Ctx["db"], token: string) {
	const tokenHash = sha256Hex(token);
	return db.claimLink.findUnique({
		where: { tokenHash },
		include: {
			payment: {
				include: {
					quote: true,
					legs: { orderBy: { position: "asc" } },
				},
			},
		},
	});
}

type LoadedClaim = NonNullable<Awaited<ReturnType<typeof loadClaimByToken>>>;

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

function requirePayerSecret(env: Record<string, string | undefined>): void {
	if (!hasPayerDemoSecret(env)) {
		throw new ApiError(
			502,
			"deploy_failed",
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

	// Pending binding: recover same hash first (CCR-20 — no blind rebuild).
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

	// Persist pending binding BEFORE send (CCR-20).
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
					// Re-load after idempotency miss (row may have changed).
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
];
