# Demo Day script (devnet, 12 Nov)

Everything below runs on the hosted app. Devnet only; nothing here moves real money.

## Before you start (once, 10 minutes ahead)

1. Wake the API: open https://flexipay-api.onrender.com/v1/solana/config. It sleeps after 15 minutes idle and the first call can take about a minute.
2. Phantom: Settings, Developer Settings, Testnet Mode on, network Solana Devnet. Two accounts: Account 1 (sender) and Account 2 (receiver).
3. Both accounts hold devnet USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`). Account 1 holds a little devnet SOL for fees.
4. Open https://flexipay-web.vercel.app/login and sign in. Sign-in is rate limited (10 attempts per 15 minutes), so do not retry wrong passwords.

## The run (about 3 minutes)

1. **Send** page: US to Philippines, destination type Crypto wallet (USDC), amount that converts cleanly (send 101 until the decimals fix is merged), fee mode PayerPays. Create the quote, pick or add the recipient, delivery Claim link, create the payment.
2. **Fund** the payment (simulated collect and convert legs; labelled simulated in the UI).
3. Open the **claim link** (new tab, as the receiver). Choose Crypto wallet, Solana USDC (devnet test), connect Phantom as Account 2 or paste its address, accept.
4. Back on the **payment detail** page, switch Phantom to Account 1, click Pay, approve.
5. The page shows paid with the Solana transaction signature and an Explorer link. Open it to show the transfer on devnet.

## What to say

- The collect and FX legs are simulated and labelled as such; the USDC settlement on Solana devnet is real and verified on-chain by the backend before the payment is marked paid.
- The backend checks the receiver's token balance change for the configured mint, binds the transfer to the payment with a Solana Pay reference, and refuses reused transactions.

## If something breaks

| Symptom | Cause | Fix |
|---|---|---|
| Page spins or the API is slow | Render free tier was asleep | Wait about a minute and reload |
| "Payment could not be prepared" | Amount not divisible by 10 in settle units (decimals bug) | Use send amount 101, or the fix once merged |
| Wallet says insufficient SOL or USDC | Account 1 low | Top up devnet SOL or USDC |
| "Too many requests" on login | Sign-in limiter | Wait 15 minutes; use the session you already have |
| Claim link expired | Short claim lifetime | Create a new payment |
