Preconditions: Phantom installed and set to Devnet, two accounts with devnet USDC, the sender account has devnet SOL.

| Step | Action | Expected result | Done |
| --- | --- | --- | --- |
| 1 | Run `bash scripts/qa/check-live.sh`. | Both lines say PASS. This also wakes the sleeping API; wait a minute and rerun if FAIL. | ☐ |
| 2 | Open https://my.getflexipay.app and sign in. | The dashboard opens. | ☐ |
| 3 | Open Pay from. | The "Add funds" panel shows a TEST MODE badge. | ☐ |
| 4 | Open Send; choose United States to Philippines, destination Crypto wallet, fee mode PayerPays, a small amount; create the quote. | The quote is created. | ☐ |
| 5 | Pick or add the recipient, choose delivery Claim link, create the payment. | A claim link is shown. | ☐ |
| 6 | Fund the payment. | Status becomes processing. | ☐ |
| 7 | Open the claim link in a private window; choose Crypto wallet, Solana USDC (devnet test), enter the receiver's Solana address, accept. | The claim is accepted. | ☐ |
| 8 | Back on the payment page, switch Phantom (Devnet) to the sender account, click Pay and approve. | The payment is approved in Phantom. | ☐ |
| 9 | Check the payment result and open the Solana Explorer link. | The payment shows paid, a Solana signature, and a "View on Solana Explorer" link; the Explorer page shows success on devnet. | ☐ |
| 10 | Pound flow: open Send; destination country United Kingdom, destination Crypto wallet (tGBP), fee mode PayerPays, a small amount; create the quote, pick or add the recipient, choose delivery Claim link, create and fund the payment; open the claim link in a private window, choose Crypto wallet, Solana tGBP (devnet test), enter the receiver's Solana address and accept; back on the payment page, switch Phantom (Devnet) to the sender account, click Pay and approve. | A claim link is shown, funding moves the payment to processing, the claim is accepted, and the payment shows paid with a Solana signature and a "View on Solana Explorer" link that shows success on devnet. | ☐ |

## Notes
