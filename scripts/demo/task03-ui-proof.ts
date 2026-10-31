/**
 * TASK 03: browser-driven DEVNET Solana payment through the real FlexiPay UI.
 *
 * Starts embedded API + Vite, injects a Wallet Standard test wallet (no key logging),
 * drives send → fund → claim accept → sign → PAID, verifies recipient ATA + Explorer.
 *
 *   node scripts/demo/run-task03-ui-proof.mjs
 */
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import {
	createMint,
	getAccount,
	getAssociatedTokenAddressSync,
	getOrCreateAssociatedTokenAccount,
	mintTo,
	TOKEN_PROGRAM_ID,
} from "@solana/spl-token"
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { chromium, type Browser, type Page } from "@playwright/test"
import { resetSolanaRuntimeConfigCache } from "../../apps/api/src/solana/runtime-config.ts"
import { auth, startTestServer } from "../../apps/api/test/helpers.ts"
import { loadSolanaRuntimeConfig } from "../../packages/adapter-solana/src/index.ts"

const WEB_PORT_FALLBACK = 5183

const freePort = async (): Promise<number> =>
	await new Promise((resolve, reject) => {
		const server = createServer()
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (!addr || typeof addr === "string") {
				server.close()
				reject(new Error("no port"))
				return
			}
			const port = addr.port
			server.close((err) => (err ? reject(err) : resolve(port)))
		})
	})

const waitForUrl = async (url: string, ms = 90_000): Promise<void> => {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url)
			if (res.ok || res.status === 404) return
		} catch {
			/* retry */
		}
		await delay(500)
	}
	throw new Error(`Timed out waiting for ${url}`)
}

const kill = async (child: ChildProcess | null): Promise<void> => {
	if (!child || child.killed) return
	child.kill("SIGTERM")
	await delay(500)
	if (!child.killed) child.kill("SIGKILL")
}

const main = async (): Promise<void> => {
	process.env.FP_SETTLEMENT = process.env.FP_SETTLEMENT ?? "mock"
	process.env.FP_SOLANA_CLUSTER = "devnet"
	process.env.FP_SOLANA_USDC_DECIMALS = "7"

	const payer = process.env.FP_SOLANA_PAYER_SECRET
		? Keypair.fromSecretKey(
				Uint8Array.from(JSON.parse(process.env.FP_SOLANA_PAYER_SECRET)),
			)
		: null
	assert.ok(payer, "FP_SOLANA_PAYER_SECRET required (use run-task03-ui-proof.mjs)")

	const recipient = Keypair.generate()
	const preliminary = loadSolanaRuntimeConfig({
		...process.env,
		FP_SOLANA_USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
	})
	const connection = new Connection(preliminary.rpcUrl, "confirmed")
	const balance = await connection.getBalance(payer.publicKey, "confirmed")
	assert.ok(
		balance >= 0.05 * LAMPORTS_PER_SOL,
		`Payer needs ≥0.05 SOL on devnet (have ${balance / LAMPORTS_PER_SOL})`,
	)
	console.log(
		JSON.stringify({
			step: "payer_balance",
			payer: payer.publicKey.toBase58(),
			lamports: balance,
		}),
	)

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
	const mintBuffer = 50_000_000n
	const senderAta = await getOrCreateAssociatedTokenAccount(
		connection,
		payer,
		mint,
		payer.publicKey,
	)
	await mintTo(
		connection,
		payer,
		mint,
		senderAta.address,
		payer,
		mintBuffer,
	)

	process.env.FP_SOLANA_USDC_MINT = mint.toBase58()
	process.env.FP_SOLANA_USDC_DECIMALS = "7"
	process.env.FP_SOLANA_RPC_URL = preliminary.rpcUrl
	resetSolanaRuntimeConfigCache()

	const api = await startTestServer()
	const { key } = await api.newOrg("Task03 UI Platform")
	const webPort = await freePort().catch(() => WEB_PORT_FALLBACK)
	const webOrigin = `http://127.0.0.1:${webPort}`

	let vite: ChildProcess | null = null
	let browser: Browser | null = null

	try {
		const webDir = join(dirname(fileURLToPath(import.meta.url)), "../../apps/web")
		vite = spawn(
			process.platform === "win32" ? "npx.cmd" : "npx",
			["vite", "--port", String(webPort), "--strictPort", "--host", "127.0.0.1"],
			{
				cwd: webDir,
				env: {
					...process.env,
					FP_API_URL: api.base,
					FP_API_KEY: key,
				},
				stdio: ["ignore", "pipe", "pipe"],
				shell: process.platform === "win32",
			},
		)
		await waitForUrl(webOrigin)

		browser = await chromium.launch({ headless: true })
		const context = await browser.newContext()
		await context.addInitScript(
			({ secretKey, rpcUrl }) => {
				;(
					window as unknown as {
						__FP_SOLANA_TEST_WALLET__?: {
							secretKey: number[]
							rpcUrl: string
						}
					}
				).__FP_SOLANA_TEST_WALLET__ = { secretKey, rpcUrl }
			},
			{
				secretKey: Array.from(payer.secretKey),
				rpcUrl: preliminary.rpcUrl,
			},
		)

		const sender: Page = await context.newPage()
		await sender.goto(webOrigin)
		await sender.getByLabel("Destination country").selectOption("PH")
		await sender.getByLabel("Destination", { exact: true }).selectOption(
			"crypto_wallet",
		)
		await sender.getByLabel("Recipient kind").selectOption("individual")
		await sender.getByLabel("Vault fee payer").selectOption("PayerPays")
		await sender.getByLabel("Amount (USD)").fill("1.00")
		await sender.getByLabel("Recipient", { exact: true }).fill("Task03 Receiver")
		await sender.getByRole("button", { name: "Get quote" }).click()
		await sender.getByTestId("delivery-claim-link").click()
		await sender.getByTestId("create-payment").click()
		await sender.waitForURL(/\/payments\//)

		const paymentUrl = sender.url()
		const paymentId = paymentUrl.split("/payments/")[1]?.split(/[?#]/)[0]
		assert.ok(paymentId)

		const claimShare = sender.getByTestId("claim-link-url")
		await claimShare.waitFor({ timeout: 15_000 })
		const claimHref = await claimShare.inputValue()
		assert.ok(claimHref.includes("/claim/"))

		await sender.getByTestId("fund-payment").click()
		await sender.locator('[data-status="processing"]').waitFor({ timeout: 90_000 })

		const claimPage = await context.newPage()
		await claimPage.goto(new URL(claimHref, webOrigin).toString())
		await claimPage.getByRole("radio", { name: /Crypto wallet/i }).check()
		await claimPage
			.getByRole("radio", { name: /Solana USDC \(devnet test\)/i })
			.check()
		await claimPage.locator("#claim-detail").fill(recipient.publicKey.toBase58())
		await claimPage.getByTestId("claim-accept").click()
		await claimPage
			.locator('[data-claim-status="accepted"]')
			.waitFor({ timeout: 30_000 })
		assert.notEqual(
			await claimPage.locator('[data-payment-status="paid"]').count(),
			1,
			"Accept must not mark PAID before on-chain verify",
		)

		await sender.bringToFront()
		await sender.reload()
		await sender.getByTestId("solana-pay-panel").waitFor({ timeout: 60_000 })
		await sender.getByTestId("solana-wallet-connect").click()
		await sender
			.getByTestId("solana-wallet-address")
			.waitFor({ timeout: 15_000 })
		const shownAddress = (
			await sender.getByTestId("solana-wallet-address").innerText()
		).trim()
		assert.equal(shownAddress, payer.publicKey.toBase58())

		sender.on("console", (msg) => {
			if (msg.type() === "error") {
				console.error("[browser]", msg.text())
			}
		})
		await sender.getByTestId("solana-pay-send").click()
		try {
			await sender
				.locator('[data-status="paid"]')
				.first()
				.waitFor({ timeout: 180_000 })
			await sender.getByTestId("solana-pay-success").waitFor({ timeout: 30_000 })
		} catch (cause) {
			const errVisible = await sender.getByTestId("solana-pay-error").count()
			const errText =
				errVisible > 0
					? await sender.getByTestId("solana-pay-error").innerText()
					: "(no solana-pay-error)"
			const body = await sender.locator("main, body").first().innerText()
			throw new Error(
				`Pay did not reach PAID. UI error: ${errText}\nBody excerpt:\n${body.slice(0, 2000)}`,
				{ cause },
			)
		}
		const explorerHref = await sender
			.getByTestId("payment-explorer-link")
			.getAttribute("href")
		assert.ok(explorerHref, "Explorer link missing on sender success")
		const signature = explorerHref.split("/tx/")[1]?.split("?")[0]
		assert.ok(signature)
		const explorerUrl = explorerHref

		await sender.reload()
		await sender
			.locator('[data-status="paid"]')
			.first()
			.waitFor({ timeout: 30_000 })
		await sender.getByTestId("solana-pay-success").waitFor({ timeout: 15_000 })

		const detailRes = await fetch(`${api.base}/v1/payments/${paymentId}`, {
			headers: auth(key),
		})
		const detailBody = (await detailRes.json()) as {
			status: string
			legs: { kind: string; releaseTxRef: string | null }[]
		}
		assert.equal(detailBody.status, "paid")
		const settle = detailBody.legs.find((l) => l.kind === "settle")
		assert.equal(settle?.releaseTxRef, signature)

		const replay = await fetch(
			`${api.base}/v1/payments/${paymentId}/solana/confirm`,
			{
				method: "POST",
				headers: auth(key, { "idempotency-key": "t03-replay" }),
				body: JSON.stringify({ signature }),
			},
		)
		assert.equal(replay.status, 200)
		const conflict = await fetch(
			`${api.base}/v1/payments/${paymentId}/solana/confirm`,
			{
				method: "POST",
				headers: auth(key, { "idempotency-key": "t03-conflict" }),
				body: JSON.stringify({ signature: "ConflictSig" + "y".repeat(56) }),
			},
		)
		assert.equal(conflict.status, 409)

		await claimPage.bringToFront()
		await claimPage
			.locator('[data-payment-status="paid"]')
			.waitFor({ timeout: 60_000 })
		await claimPage.getByTestId("claim-release-evidence").waitFor()
		await claimPage.getByTestId("claim-explorer-link").waitFor()

		const recipientAta = getAssociatedTokenAddressSync(
			mint,
			recipient.publicKey,
		)
		const recipientAccount = await getAccount(connection, recipientAta)
		assert.ok(recipientAccount.amount > 0n)

		console.log(
			JSON.stringify(
				{
					ok: true,
					evidence: {
						cluster: "devnet",
						mode: "browser-ui",
						paymentId,
						payer: payer.publicKey.toBase58(),
						recipient: recipient.publicKey.toBase58(),
						mint: mint.toBase58(),
						recipientBalanceAfter: recipientAccount.amount.toString(),
						signature,
						explorerUrl,
						paymentStatus: detailBody.status,
						duplicateProtection: {
							sameSignatureReplay: 200,
							differentSignatureConflict: 409,
						},
						claimReleaseEvidenceVisible: true,
						note: "Devnet test mint — browser Wallet Standard harness; not mainnet",
					},
				},
				null,
				2,
			),
		)
	} finally {
		await browser?.close().catch(() => undefined)
		await kill(vite)
		await api.stop()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
