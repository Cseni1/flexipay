#!/usr/bin/env bash
set -u
APP="https://my.getflexipay.app"
API="https://flexipay-api.onrender.com/v1/solana/config"
fail=0
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 "$APP/")
if [ "$code" = "200" ]; then echo "PASS app returns 200"; else echo "FAIL app returned $code"; fail=1; fi
body=$(curl -s --max-time 90 "$API")
case "$body" in *'"cluster":"devnet"'*) echo "PASS api reports devnet";; *) echo "FAIL api response unexpected"; fail=1;; esac
exit $fail
