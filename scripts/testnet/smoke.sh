#!/usr/bin/env bash
# SC1 smoke test: one payout through payout_vault on testnet, with transaction hashes.
# deposit (payer-demo) -> create_payout (external id sha256("<payment id>:1")) -> claim (recipient-a).
# Run scripts/testnet/setup.sh first. Each run uses a new payment id, so it can be repeated.
set -euo pipefail

cd "$(dirname "$0")/../.."
command -v stellar >/dev/null || {
	echo "stellar CLI not found. Install Stellar CLI 28 (and run: source ~/.cargo/env)." >&2
	exit 1
}
# shellcheck source=/dev/null
source scripts/testnet/testnet-ids.env
NET=testnet
AMOUNT=${FP_SMOKE_AMOUNT:-10000000} # 1 test USDC

sha256_hex() { printf '%s' "$1" | shasum -a 256 | cut -c1-64; }

# Runs a vault call, prints its result and the transaction hash.
vault() {
	local source=$1 label=$2
	shift 2
	local err out hash
	err=$(mktemp)
	if ! out=$(stellar contract invoke --id "$FP_PAYOUT_VAULT_ID" --source-account "$source" --network "$NET" -- "$@" 2>"$err"); then
		echo "FAIL: $label" >&2
		grep -E 'error' "$err" | head -3 >&2
		rm -f "$err"
		exit 1
	fi
	hash=$(grep -oE 'Signing transaction: [0-9a-f]{64}' "$err" | awk '{print $3}' | tail -1)
	rm -f "$err"
	printf '%-14s result=%s tx=%s\n' "$label" "${out:-ok}" "${hash:-none}"
	LAST_OUT=$out
}

usdc_balance() {
	stellar contract invoke --id "$FP_USDC_CONTRACT_ID" --source-account fp-deployer --network "$NET" --send no -- \
		balance --id "$1" | tr -d '"'
}

PAYMENT_ID="smoke_$(date -u +%Y%m%d%H%M%S)"
EXTERNAL_ID=$(sha256_hex "$PAYMENT_ID:1")
SECRET=$(openssl rand -hex 32)
CLAIM_HASH=$(printf '%s' "$SECRET" | xxd -r -p | shasum -a 256 | cut -c1-64)
EXPIRES_AT=$(($(date +%s) + 3600))

# setup happens only in the constructor: the deployed vault must export create_payout but no init
FUNCTIONS=$(stellar contract invoke --id "$FP_PAYOUT_VAULT_ID" --source-account fp-deployer --network "$NET" --send no -- \
	--help 2>&1 | sed -n '/Commands:/,/Options:/p' | awk '{print $1}' || true)
if ! grep -qx create_payout <<<"$FUNCTIONS" || grep -qx init <<<"$FUNCTIONS"; then
	echo "FAIL: unexpected vault interface: $(echo $FUNCTIONS)" >&2
	exit 1
fi
echo "init          absent (constructor only)"

echo "payment id:  $PAYMENT_ID (attempt 1)"
echo "external id: $EXTERNAL_ID"
RECIPIENT_BEFORE=$(usdc_balance "$FP_RECIPIENT_A_ADDRESS")

# PayerPays locks amount + fee, so deposit both
FEE=$((AMOUNT * FP_VAULT_FEE_BPS / 10000))
vault fp-payer-demo deposit deposit --payer "$FP_PAYER_DEMO_ADDRESS" --amount "$((AMOUNT + FEE))"
vault fp-payer-demo create_payout create_payout --payer "$FP_PAYER_DEMO_ADDRESS" --external_id "$EXTERNAL_ID" \
	--claim_hash "$CLAIM_HASH" --amount "$AMOUNT" --mode PayerPays --expires_at "$EXPIRES_AT"
PAYOUT_ID=$LAST_OUT
vault fp-recipient-a claim claim --id "$PAYOUT_ID" --secret "$SECRET" --to "$FP_RECIPIENT_A_ADDRESS"

# the same attempt must not lock twice: expect DuplicateExternalId (#12), not any other error
FEE_DEP=$((AMOUNT + FEE))
vault fp-payer-demo deposit-2 deposit --payer "$FP_PAYER_DEMO_ADDRESS" --amount "$FEE_DEP"
DUP=$(stellar contract invoke --id "$FP_PAYOUT_VAULT_ID" --source-account fp-payer-demo --network "$NET" --send no -- \
	create_payout --payer "$FP_PAYER_DEMO_ADDRESS" --external_id "$EXTERNAL_ID" --claim_hash "$CLAIM_HASH" \
	--amount "$AMOUNT" --mode PayerPays --expires_at "$EXPIRES_AT" 2>&1 || true)
case "$DUP" in
*"Error(Contract, #12)"*) ;;
*)
	echo "FAIL: duplicate external id was not rejected with DuplicateExternalId" >&2
	exit 1
	;;
esac
vault fp-payer-demo withdraw withdraw --payer "$FP_PAYER_DEMO_ADDRESS" --amount "$FEE_DEP"
echo "duplicate     rejected (DuplicateExternalId)"

RECIPIENT_AFTER=$(usdc_balance "$FP_RECIPIENT_A_ADDRESS")
RECEIVED=$((RECIPIENT_AFTER - RECIPIENT_BEFORE))
echo "recipient-a received $RECEIVED stroops"
[ "$RECEIVED" -eq "$AMOUNT" ] || {
	echo "FAIL: expected $AMOUNT" >&2
	exit 1
}
echo "PASS  payout $PAYOUT_ID  vault $FP_PAYOUT_VAULT_ID"
