# payout_vault rules

The exact behaviour of the `payout_vault` contract. `MockSettlementAdapter` (`packages/adapters-sim`, task SF2) must follow these rules so that tests and the offline demo behave the same as Stellar testnet. Every rule here is covered by a test in `src/test.rs`.

The zip's `reference-only/mock-chain-rules.js` predates the external id and the events. Where it differs from this file, this file wins.

## Setup

- Setup runs in the constructor, `__constructor(token, treasury, fee_bps)`, as part of deployment. There is no `init` function, so nobody can set up the contract between deploy and setup.
- `fee_bps` is at most 1000 (10%). Otherwise deployment fails with `FeeTooHigh` (#4).
- There is no admin key. The token, treasury and fee never change after deployment. To change them, deploy a new vault.
- The token is a constructor argument, so the same code can run a second vault on another asset (for example the test anchor's USDC at the event).
- For routes that settle through the vault, the FlexiPay fee is this fixed fee. The quote reads it from `config()`. The settlement adapter checks the token, treasury and fee at startup and stops on a mismatch.

## Amounts

- All amounts are integers in the token's smallest unit. Test USDC has 7 decimals: `1 USDC = 10_000_000`.
- `fee = amount * fee_bps / 10_000`, rounded down (integer division).

## Operations

| Operation | Who authorises | Rules | Errors |
|---|---|---|---|
| `deposit(payer, amount)` | payer | Moves `amount` from the payer's token balance into the payer's balance inside the vault. | `InvalidAmount` if amount ≤ 0 |
| `withdraw(payer, amount)` | payer | Returns unlocked vault balance to the payer. | `InvalidAmount`, `InsufficientBalance` |
| `create_payout(payer, external_id, claim_hash, amount, mode, expires_at)` | payer | Checks run in this order: amount > 0; `expires_at` is after now; the external id is unused for this payer; fee and amounts are computed; the payer's balance covers `locked`. Then `locked` leaves the payer's vault balance, the external id is marked used and the payout is stored as `Pending`. Returns the payout id (1, 2, 3 and so on). | `InvalidAmount`, `InvalidExpiry`, `DuplicateExternalId`, `InsufficientBalance` |
| `claim(id, secret, to)` | `to` (the receiving address) | Payout must be `Pending`; now must be before `expires_at` (claiming at exactly `expires_at` fails); `sha256(secret)` must equal `claim_hash`. Then the status becomes `Claimed`, `net` goes to `to` and `fee` (if above 0) goes to the treasury. Returns `net`. | `PayoutNotFound`, `NotPending`, `Expired`, `BadSecret` |
| `cancel(id)` | the payout's payer | Payout must be `Pending`. No expiry check. `locked` goes back to the payer's vault balance and the status becomes `Refunded`. | `PayoutNotFound`, `NotPending` |
| `refund(id)` | anyone | Payout must be `Pending` and now must be at or after `expires_at`. `locked` goes back to the payer's vault balance and the status becomes `Refunded`. | `PayoutNotFound`, `NotPending`, `NotExpired` |

**Fee modes**

| Mode | `locked` (taken from the payer) | `net` (to the recipient) |
|---|---|---|
| `PayerPays` | amount + fee | amount |
| `RecipientPays` | amount | amount − fee (must be above 0, otherwise `InvalidAmount`) |

## External id (duplicate protection)

- Uniqueness is per payer: the key is `(payer, external_id)`. Two different payers may use the same external id.
- An external id stays used forever, even after `cancel` or `refund`.
- **One external id per lock attempt.** After a refund the state machine may retry or re-route, and each attempt locks again, so each attempt needs a new id:

  `external_id = sha256(utf8("<payment id>:<attempt>"))`, where the attempt is a decimal number starting at 1.

  For example, the first lock of payment `pay_demo_1` uses `sha256("pay_demo_1:1")`; after a refund the retry uses `sha256("pay_demo_1:2")`. Locking `pay_demo_1:1` a second time fails with `DuplicateExternalId`.
- The client's own `externalId` never goes on-chain. The API rejects duplicate client external ids (409) off-chain. On-chain, the vault guarantees that the same payment attempt is never locked twice.
- The mock must enforce the same rule with the same derivation. It may keep the plain `"<payment id>:<attempt>"` string as the key.
- `payout_by_external(payer, external_id)` returns the payout id, or nothing. The adapter uses it to recover when a lock transaction succeeded but its response was lost: look up the current attempt's id instead of locking again.

Tests: `duplicate_external_id_is_rejected`, `external_id_stays_used_after_cancel`, `same_external_id_for_another_payer_is_allowed`, `payout_by_external_finds_the_payout`, `retry_after_refund_needs_new_external_id`.

## Views

`get_payout(id)` returns the stored payout or fails with `PayoutNotFound`. It includes `payer`, `external_id`, `claim_hash`, `gross`, `fee`, `net`, `locked`, `expires_at` and `status`. Two more views: `balance(payer)` and `config()`, which returns `(token, treasury, fee_bps)`.

## Events

| Event (topic name) | Topics | Data | Emitted by |
|---|---|---|---|
| `payout_created` | id, payer | external_id, gross, fee, net, expires_at | `create_payout` |
| `payout_claimed` | id | to, net, fee | `claim` |
| `payout_refunded` | id | payer, amount (= locked), cancelled | `refund` (cancelled = false), `cancel` (cancelled = true) |

The mock emits the same three events in the same situations.

## Error codes

The Stellar settlement adapter and the mock settlement adapter map these numbers and names identically.

| Code | Name |
|---|---|
| 1 | AlreadyInitialized (reserved, no longer raised since setup moved to the constructor) |
| 2 | NotInitialized (cannot happen after a successful deployment) |
| 3 | InvalidAmount |
| 4 | FeeTooHigh |
| 5 | InsufficientBalance |
| 6 | PayoutNotFound |
| 7 | NotPending |
| 8 | Expired |
| 9 | NotExpired |
| 10 | BadSecret |
| 11 | InvalidExpiry |
| 12 | DuplicateExternalId |

## What the unit tests do not prove

Tests run with mocked authorisation. `contract_address_receiver_is_accepted_mock_auth_only` shows that a contract address can be the receiver and is the address asked to authorise. It does **not** show that a passkey smart wallet can authorise a claim. That is proven on testnet by event task E2 (DF8).
