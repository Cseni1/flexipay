module.exports = async function handler(req, res) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }
  const send = (code, body) => {
    res.statusCode = code
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    res.end(JSON.stringify(body))
  }

  if (req.method === "OPTIONS") return send(204, {})
  if (req.method !== "POST") return send(405, { ok: false, error: "Method not allowed" })

  const trim = (v) => (typeof v === "string" ? v.trim() : v)

  try {
    const sdk = await import("@stellar/stellar-sdk")
    const {
      Address,
      BASE_FEE,
      Contract,
      Keypair,
      Networks,
      TransactionBuilder,
      nativeToScVal,
      rpc,
    } = sdk

    const secret = trim(process.env.EMPLOYER_SECRET)
    const contractId = trim(process.env.PUBLIC_PAY_SHIFT_CONTRACT_ID)
    if (!secret) return send(500, { ok: false, error: "Missing EMPLOYER_SECRET" })
    if (!contractId) return send(500, { ok: false, error: "Missing PUBLIC_PAY_SHIFT_CONTRACT_ID" })

    const tokenId =
      trim(process.env.PUBLIC_NATIVE_TOKEN_CONTRACT_ID) ||
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
    const employer =
      trim(process.env.PUBLIC_EMPLOYER_ADDRESS) ||
      "GDNFGHPOIPM3RHL7NMQCXRAELEF6AVFJLLOFXM25DDN4ANXMMTU3LFZP"
    const worker =
      trim(process.env.PUBLIC_WORKER_ADDRESS) ||
      "GADUBNTO655LVGIRUH3SP7E4P5FRUL2TWWURNDYQOQ3KMPD3B72WYJHL"
    const rpcUrl =
      trim(process.env.PUBLIC_STELLAR_RPC_URL) || "https://soroban-testnet.stellar.org"
    const amount = BigInt(trim(process.env.DEMO_AMOUNT_STROOPS) || "10000000")

    let body = req.body
    if (typeof body === "string") body = body ? JSON.parse(body) : {}
    if (!body || typeof body !== "object") body = {}
    const shiftId = String(body.shiftId || "FW-120926-001")

    const keypair = Keypair.fromSecret(secret)
    if (keypair.publicKey() !== employer) {
      return send(500, { ok: false, error: "EMPLOYER_SECRET does not match PUBLIC_EMPLOYER_ADDRESS" })
    }

    const server = new rpc.Server(rpcUrl, { allowHttp: false })
    const account = await server.getAccount(keypair.publicKey())
    const contract = new Contract(contractId)
    const op = contract.call(
      "pay_shift",
      nativeToScVal(shiftId, { type: "string" }),
      Address.fromString(employer).toScVal(),
      Address.fromString(worker).toScVal(),
      Address.fromString(tokenId).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    )

    const built = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(60)
      .build()

    const prepared = await server.prepareTransaction(built)
    prepared.sign(keypair)
    const sendTx = await server.sendTransaction(prepared)
    if (sendTx.status === "ERROR") {
      return send(500, { ok: false, error: "Failed to submit Testnet transaction", detail: sendTx })
    }

    const hash = sendTx.hash
    let final
    for (let i = 0; i < 45; i++) {
      final = await server.getTransaction(hash)
      if (final.status === "SUCCESS") break
      if (final.status === "FAILED") {
        return send(500, { ok: false, error: "Transaction failed on Testnet" })
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!final || final.status !== "SUCCESS") {
      return send(500, { ok: false, error: "Timed out waiting for Testnet settlement", transactionHash: hash })
    }

    return send(200, {
      ok: true,
      shiftId,
      amountStroops: amount.toString(),
      amountXlm: "1",
      employer,
      worker,
      contractId,
      tokenId,
      transactionHash: hash,
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/" + hash,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    const message = (e && e.message) || String(e)
    const already =
      message.includes("Error(Contract, #1)") ||
      message.includes("AlreadyPaid") ||
      JSON.stringify((e && e.response) || e || {}).includes("#1")
    return send(500, {
      ok: false,
      error: already
        ? "This shift was already paid on-chain (duplicate protection)."
        : message,
      name: e && e.name,
    })
  }
}

module.exports.config = { maxDuration: 60 }