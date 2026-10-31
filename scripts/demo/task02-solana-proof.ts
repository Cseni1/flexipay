/**
 * TASK 02 evidence: create payment → Solana claim destination → real devnet SPL transfer →
 * backend verify → PAID. Uses a local keypair (never browser). Prints signature + explorer URL.
 *
 *   npx tsx scripts/demo/task02-solana-proof.ts
 *
 * Requires network access to Solana devnet. Optional FP_SOLANA_RPC_URL.
 */
import assert from "node:assert/strict"
import {
	buildUsdcTransferTransaction,
	connectionAsRpc,
	explorerUrlForSignature,
	flexipayUsdcToSolanaMinor,
	isSolanaAddress,
	loadSolanaRuntimeConfig,
	verifyUsdcTransfer,
} from "../../packages/adapter-solana/src/index.ts"
import { resetSolanaRuntimeConfigCache } from "../../apps/api/src/solana/runtime-config.ts"
import { auth, startTestServer } from "../../apps/api/test/helpers.ts"
import {
	createMint,
	getOrCreateAssociatedTokenAccount,
	mintTo,
	TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	sendAndConfirmTransaction,
} from "@solana/web3.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const main = async (): Promise<void> => {
	process.env.FP_SETTLEMENT = process.env.FP_SETTLEMENT ?? "mock"
	process.env.FP_SOLANA_CLUSTER = "devnet"
	process.env.FP_SOLANA_USDC_DECIMALS = "7"

	const payer = process.env.FP_SOLANA_PAYER_SECRET
		? Keypair.fromSecretKey(
				Uint8Array.from(JSON.parse(process.env.FP_SOLANA_PAYER_SECRET)),
			)
		: Keypair.generate()
	const recipient = Keypair.generate()
	assert.ok(isSolanaAddress(payer.publicKey.toBase58()))

	const preliminary = loadSolanaRuntimeConfig({
		...process.env,
		FP_SOLANA_USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
	})
	const connection = new Connection(preliminary.rpcUrl, "confirmed")

	const balance = await connection.getBalance(payer.publicKey, "confirmed")
	if (balance < 0.5 * LAMPORTS_PER_SOL) {
		console.log(
			JSON.stringify({
				step: "airdrop",
				payer: payer.publicKey.toBase58(),
				rpc: preliminary.rpcUrl,
			}),
		)
		try {
			const sigAirdrop = await connection.requestAirdrop(
				payer.publicKey,
				2 * LAMPORTS_PER_SOL,
			)
			await connection.confirmTransaction(sigAirdrop, "confirmed")
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause)
			throw new Error(
				`Devnet SOL funding failed (${message}). Public RPC airdrop is closed. ` +
					`Fund a wallet at https://faucet.solana.com then re-run with ` +
					`FP_SOLANA_PAYER_SECRET set to the keypair JSON byte array.`,
			)
		}
	}

	const mint = await createMint(
		connection,
		payer,
		payer.publicKey,
		null,
		7,
		undefined,
		undefined,
		TOKEN_PROGRAM_ID,
	)
	process.env.FP_SOLANA_USDC_MINT = mint.toBase58()
	process.env.FP_SOLANA_USDC_DECIMALS = "7"
	process.env.FP_SOLANA_RPC_URL = preliminary.rpcUrl
	resetSolanaRuntimeConfigCache()

	const senderAta = await getOrCreateAssociatedTokenAccount(
		connection,
		payer,
		mint,
		payer.publicKey,
	)
	const flexipayMinor = 10_000_000n // 1.0000000 USDC (7 decimals)
	await mintTo(
		connection,
		payer,
		mint,
		senderAta.address,
		payer,
		flexipayMinor,
	)

	const api = await startTestServer()
	const { key } = await api.newOrg("Task02 Solana Platform")

	try {
		const created = await fetch(`${api.base}/v1/recipients`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "t02-rcp" }),
			body: JSON.stringify({
				name: "Solana Receiver",
				kind: "individual",
				country: "PH",
			}),
		})
		assert.equal(created.status, 201)
		const recipientRow = (await created.json()) as { id: string }

		const quoteRes = await fetch(`${api.base}/v1/quotes`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "t02-quote" }),
			body: JSON.stringify({
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
				amount: {
					side: "receive",
					value: { amount: flexipayMinor.toString(), currency: "USDC" },
				},
				policy: "cheapest",
				feeMode: "PayerPays",
			}),
		})
		assert.equal(quoteRes.status, 201, await quoteRes.text())
		const quote = (await quoteRes.json()) as { id: string }

		const paymentRes = await fetch(`${api.base}/v1/payments`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "t02-pay" }),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipientRow.id,
				delivery: "claim_link",
				profile: "one_off",
			}),
		})
		assert.equal(paymentRes.status, 201, await paymentRes.text())
		const payment = (await paymentRes.json()) as {
			id: string
			claimLink: { url: string } | null
		}
		assert.ok(payment.claimLink?.url)

		const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "t02-fund" }),
			body: "{}",
		})
		assert.equal(fundRes.status, 200, await fundRes.text())

		const token = payment.claimLink!.url.split("/").pop()!
		const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "t02-accept",
			},
			body: JSON.stringify({
				endpoint: {
					type: "crypto_wallet",
					country: "",
					currency: "USDC",
					network: "solana",
					details: { address: recipient.publicKey.toBase58() },
					simulated: true,
				},
			}),
		})
		assert.equal(accept.status, 200, await accept.text())
		const accepted = (await accept.json()) as {
			paymentStatus: string
			claim: { status: string }
		}
		assert.equal(accepted.claim.status, "accepted")
		assert.equal(accepted.paymentStatus, "processing")

		const intentRes = await fetch(
			`${api.base}/v1/payments/${payment.id}/solana/intent`,
			{ headers: auth(key) },
		)
		assert.equal(intentRes.status, 200, await intentRes.text())
		const intent = (await intentRes.json()) as {
			amount: string
			usdcMint: string
			recipient: string
		}
		assert.equal(intent.recipient, recipient.publicKey.toBase58())
		assert.equal(intent.usdcMint, mint.toBase58())

		const amountMinor = BigInt(intent.amount)
		assert.equal(amountMinor, flexipayUsdcToSolanaMinor(flexipayMinor, 7))

		const built = await buildUsdcTransferTransaction({
			connection,
			payer: payer.publicKey.toBase58(),
			recipientOwner: recipient.publicKey.toBase58(),
			mint: mint.toBase58(),
			amountMinor,
			decimals: 7,
		})
		built.transaction.partialSign(payer)
		const signature = await sendAndConfirmTransaction(
			connection,
			built.transaction,
			[payer],
			{ commitment: "confirmed" },
		)

		const verifiedLocal = await verifyUsdcTransfer(connectionAsRpc(connection), {
			signature,
			mint: mint.toBase58(),
			recipientOwner: recipient.publicKey.toBase58(),
			amountMinor,
			usdcDecimals: 7,
		})
		assert.equal(verifiedLocal.ok, true, JSON.stringify(verifiedLocal))

		let confirmBody: {
			paymentStatus: string
			signature: string
			explorerUrl: string
		} | null = null
		for (let i = 0; i < 8; i += 1) {
			const confirm = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "t02-confirm" }),
					body: JSON.stringify({ signature }),
				},
			)
			if (confirm.status === 202) {
				await sleep(1500)
				continue
			}
			assert.equal(confirm.status, 200, await confirm.text())
			confirmBody = (await confirm.json()) as typeof confirmBody
			break
		}
		assert.ok(confirmBody)
		assert.equal(confirmBody!.paymentStatus, "paid")
		assert.equal(confirmBody!.signature, signature)

		const detail = await fetch(`${api.base}/v1/payments/${payment.id}`, {
			headers: auth(key),
		})
		assert.equal(detail.status, 200)
		const detailBody = (await detail.json()) as {
			status: string
			legs: { kind: string; releaseTxRef: string | null }[]
		}
		assert.equal(detailBody.status, "paid")
		const settle = detailBody.legs.find((l) => l.kind === "settle")
		assert.equal(settle?.releaseTxRef, signature)

		console.log(
			JSON.stringify(
				{
					ok: true,
					evidence: {
						cluster: "devnet",
						mint: mint.toBase58(),
						recipient: recipient.publicKey.toBase58(),
						paymentId: payment.id,
						signature,
						explorerUrl:
							confirmBody!.explorerUrl ||
							explorerUrlForSignature(
								`https://explorer.solana.com/tx/{signature}?cluster=devnet`,
								signature,
							),
						paymentStatus: detailBody.status,
						note: "Devnet test mint — not mainnet USDC",
					},
				},
				null,
				2,
			),
		)
	} finally {
		await api.stop()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
