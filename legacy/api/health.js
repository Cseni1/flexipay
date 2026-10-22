module.exports = async function handler(req, res) {
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.end(JSON.stringify({
    ok: true,
    hasEmployerSecret: Boolean(process.env.EMPLOYER_SECRET),
    hasContractId: Boolean(process.env.PUBLIC_PAY_SHIFT_CONTRACT_ID),
    network: process.env.PUBLIC_STELLAR_NETWORK || null,
  }))
}