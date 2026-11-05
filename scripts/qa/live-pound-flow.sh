#!/usr/bin/env bash
# Replays the pound flow on the live app up to (not including) the wallet signature:
# quote -> payment (claim link) -> fund -> claim accept -> Solana intent.
# Needs: FP_QA_EMAIL, FP_QA_PASSWORD (a verified test account), FP_QA_RECEIVER (a devnet Solana address).
# Optional: FP_QA_AMOUNT_PENCE (GBP minor units, default 1000 = £10.00; keep it below the sender's test-token balance).
# Never put credentials in this file. Prints the payment id; pay it in the app with Phantom (devnet).
set -u
: "${FP_QA_EMAIL:?set FP_QA_EMAIL}" "${FP_QA_PASSWORD:?set FP_QA_PASSWORD}" "${FP_QA_RECEIVER:?set FP_QA_RECEIVER}"
O="${FP_APP_URL:-https://my.getflexipay.app}"; J=$(mktemp); K=$(date +%s); fail=0; AMT="${FP_QA_AMOUNT_PENCE:-1000}"
case "$AMT" in (*[!0-9]*|"") echo "FP_QA_AMOUNT_PENCE must be digits"; exit 2;; esac
trap 'rm -f "$J"' EXIT
c() { curl -s --max-time 90 -b "$J" -H "Origin: $O" -H 'content-type: application/json' "$@"; }
field() { python3 -c "import sys,json
try: d=json.loads(sys.stdin.read())
except Exception: d={}
v=d
for k in sys.argv[1].split('.'): v=(v or {}).get(k) if isinstance(v,dict) else None
print('' if v is None else v)" "$1"; }
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fail=1; }
curl -s --max-time 90 -c "$J" -o /dev/null -X POST "$O/api/auth/sign-in/email" -H "Origin: $O" -H 'content-type: application/json' \
  -d "{\"email\":\"$FP_QA_EMAIL\",\"password\":\"$FP_QA_PASSWORD\"}"
Q=$(c -X POST "$O/v1/quotes" -H "Idempotency-Key: q-$K" -d '{"source":{"type":"bank_account","currency":"GBP","country":"GB"},"destination":{"type":"crypto_wallet","currency":"TGBP","country":"GB","recipientKind":"individual"},"amount":{"side":"send","value":{"amount":"'"$AMT"'","currency":"GBP"}},"policy":"cheapest","feeMode":"PayerPays"}')
QID=$(echo "$Q" | field id); [ -n "$QID" ] && ok "quote $QID" || { bad "quote: $Q"; exit 1; }
[ "$(echo "$Q" | field expectedReceive.currency)" = "TGBP" ] && ok "receive currency TGBP" || bad "receive currency"
RID=$(c -X POST "$O/v1/recipients" -H "Idempotency-Key: r-$K" -d '{"name":"Pound flow check","kind":"individual","country":"GB"}' | field id)
P=$(c -X POST "$O/v1/payments" -H "Idempotency-Key: p-$K" -d "{\"quoteId\":\"$QID\",\"recipientId\":\"$RID\",\"delivery\":\"claim_link\",\"profile\":\"one_off\"}")
PID=$(echo "$P" | field id); [ -n "$PID" ] && ok "payment $PID" || { bad "payment: $P"; exit 1; }
TOK=$(echo "$P" | field claimLink.url | sed 's|.*/claims/||; s/[?#].*//')
F=$(c -X POST "$O/v1/payments/$PID/fund" -H "Idempotency-Key: f-$K" -d '{}'); [ "$(echo "$F" | field id)" = "$PID" ] && ok "funded" || bad "fund: $F"
A=$(curl -s --max-time 90 -X POST "$O/v1/claims/$TOK/accept" -H 'content-type: application/json' \
  -d "{\"endpoint\":{\"type\":\"crypto_wallet\",\"country\":\"\",\"currency\":\"TGBP\",\"network\":\"solana\",\"details\":{\"address\":\"$FP_QA_RECEIVER\"},\"simulated\":true}}")
[ "$(echo "$A" | field claim.status)" = "accepted" ] && ok "claim accepted" || bad "accept: $A"
I=$(c "$O/v1/payments/$PID/solana/intent")
[ "$(echo "$I" | field asset)" = "TGBP" ] && ok "intent asset TGBP, amount $(echo "$I" | field amount) at $(echo "$I" | field decimals) decimals" || bad "intent: $I"
echo "Next: open $O/payments/$PID, connect Phantom (Devnet, sender account), Sign and send."
exit $fail
