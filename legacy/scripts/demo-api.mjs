/**
 * FlexiPay hackathon demo API.
 * Signs Testnet pay_shift invokes with the local `employer` Stellar CLI identity.
 * Production would use proper wallet / custody signing instead.
 */
import { spawn } from "node:child_process"
import http from "node:http"
import { URL } from "node:url"

const PORT = Number(process.env.DEMO_API_PORT || 8787)
const NETWORK = process.env.STELLAR_NETWORK || "testnet"
const SOURCE = process.env.STELLAR_ACCOUNT || "employer"
const CONTRACT_ID = process.env.PUBLIC_PAY_SHIFT_CONTRACT_ID || process.env.PAY_SHIFT_CONTRACT_ID
const TOKEN_ID =
	process.env.PUBLIC_NATIVE_TOKEN_CONTRACT_ID ||
	"CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
const EMPLOYER =
	process.env.PUBLIC_EMPLOYER_ADDRESS ||
	"GDNFGHPOIPM3RHL7NMQCXRAELEF6AVFJLLOFXM25DDN4ANXMMTU3LFZP"
const WORKER =
	process.env.PUBLIC_WORKER_ADDRESS ||
	"GADUBNTO655LVGIRUH3SP7E4P5FRUL2TWWURNDYQOQ3KMPD3B72WYJHL"
const AMOUNT_STROOPS = process.env.DEMO_AMOUNT_STROOPS || "10000000" // 1 XLM

function runStellar(args) {
	return new Promise((resolve, reject) => {
		const child = spawn("stellar", args, {
			shell: true,
			env: process.env,
		})
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (d) => {
			stdout += d.toString()
		})
		child.stderr.on("data", (d) => {
			stderr += d.toString()
		})
		child.on("error", reject)
		child.on("close", (code) => {
			resolve({ code, stdout, stderr })
		})
	})
}

function extractTxHash(text) {
	const expert = text.match(/stellar\.expert\/explorer\/testnet\/tx\/([a-f0-9]{64})/i)
	if (expert) return expert[1]
	const signed = text.match(/Signing transaction:\s*([a-f0-9]{64})/i)
	if (signed) return signed[1]
	const any = text.match(/\b([a-f0-9]{64})\b/i)
	return any ? any[1] : null
}

async function payShift(shiftId) {
	if (!CONTRACT_ID) {
		throw new Error("PUBLIC_PAY_SHIFT_CONTRACT_ID is not set. Deploy the contract first.")
	}

	const args = [
		"contract",
		"invoke",
		"--id",
		CONTRACT_ID,
		"--source-account",
		SOURCE,
		"--network",
		NETWORK,
		"--send=yes",
		"--",
		"pay_shift",
		"--shift_id",
		shiftId,
		"--employer",
		EMPLOYER,
		"--worker",
		WORKER,
		"--token",
		TOKEN_ID,
		"--amount",
		AMOUNT_STROOPS,
	]

	const result = await runStellar(args)
	const combined = `${result.stdout}\n${result.stderr}`
	if (result.code !== 0) {
		const err = new Error(combined.trim() || `stellar exited ${result.code}`)
		err.raw = combined
		throw err
	}

	const hash = extractTxHash(combined)
	return {
		ok: true,
		shiftId,
		amountStroops: AMOUNT_STROOPS,
		amountXlm: "1",
		employer: EMPLOYER,
		worker: WORKER,
		contractId: CONTRACT_ID,
		tokenId: TOKEN_ID,
		transactionHash: hash,
		explorerUrl: hash
			? `https://stellar.expert/explorer/testnet/tx/${hash}`
			: null,
		raw: combined.trim(),
		timestamp: new Date().toISOString(),
	}
}

const server = http.createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*")
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	res.setHeader("Access-Control-Allow-Headers", "Content-Type")

	if (req.method === "OPTIONS") {
		res.writeHead(204)
		res.end()
		return
	}

	const url = new URL(req.url, `http://localhost:${PORT}`)

	if (req.method === "GET" && url.pathname === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" })
		res.end(
			JSON.stringify({
				ok: true,
				contractId: CONTRACT_ID || null,
				employer: EMPLOYER,
				worker: WORKER,
			}),
		)
		return
	}

	if (req.method === "POST" && url.pathname === "/api/pay") {
		let body = ""
		for await (const chunk of req) body += chunk
		let shiftId = "FW-120926-001"
		try {
			const parsed = body ? JSON.parse(body) : {}
			if (parsed.shiftId) shiftId = String(parsed.shiftId)
		} catch {
			/* use default */
		}

		try {
			const payment = await payShift(shiftId)
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify(payment))
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" })
			res.end(
				JSON.stringify({
					ok: false,
					error: e.message,
					raw: e.raw || null,
				}),
			)
		}
		return
	}

	res.writeHead(404, { "Content-Type": "application/json" })
	res.end(JSON.stringify({ error: "not found" }))
})

server.listen(PORT, () => {
	console.log(`FlexiPay demo API on http://localhost:${PORT}`)
	console.log(`Contract: ${CONTRACT_ID || "(not set yet)"}`)
})
