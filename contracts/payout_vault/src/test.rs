use super::*;
use soroban_sdk::{
    Address, Bytes, BytesN, Env, Event, contract, contractimpl,
    testutils::{Address as _, Events as _, Ledger},
    token::{StellarAssetClient, TokenClient},
};

const UNIT: i128 = 10_000_000; // 7 decimals, like USDC on Stellar

struct Setup<'a> {
    env: Env,
    vault: PayoutVaultClient<'a>,
    token: TokenClient<'a>,
    payer: Address,
    treasury: Address,
}

fn setup<'a>(fee_bps: u32) -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_addr = sac.address();
    let token = TokenClient::new(&env, &token_addr);
    let asset = StellarAssetClient::new(&env, &token_addr);

    let treasury = Address::generate(&env);
    let payer = Address::generate(&env);
    asset.mint(&payer, &(10_000 * UNIT));

    let vault_id = env.register(
        PayoutVault,
        PayoutVaultArgs::__constructor(&token_addr, &treasury, &fee_bps),
    );
    let vault = PayoutVaultClient::new(&env, &vault_id);

    Setup {
        env,
        vault,
        token,
        payer,
        treasury,
    }
}

fn secret(env: &Env, n: u8) -> Bytes {
    Bytes::from_array(env, &[n, 2, 3, 4, 5, 6, 7, 8])
}

/// External id for a test payout, derived from its secret so each payout gets its own.
fn ext(env: &Env, s: &Bytes) -> BytesN<32> {
    let mut b = Bytes::from_slice(env, b"ext:");
    b.append(s);
    env.crypto().sha256(&b).to_bytes()
}

fn hash_of(env: &Env, s: &Bytes) -> BytesN<32> {
    env.crypto().sha256(s).to_bytes()
}

#[test]
fn deposit_and_withdraw() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(500 * UNIT));
    assert_eq!(s.vault.balance(&s.payer), 500 * UNIT);
    assert_eq!(s.token.balance(&s.payer), 9_500 * UNIT);

    s.vault.withdraw(&s.payer, &(200 * UNIT));
    assert_eq!(s.vault.balance(&s.payer), 300 * UNIT);
    assert_eq!(s.token.balance(&s.payer), 9_700 * UNIT);
}

#[test]
fn withdraw_more_than_balance_fails() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(100 * UNIT));
    let r = s.vault.try_withdraw(&s.payer, &(101 * UNIT));
    assert_eq!(r, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn payer_pays_fee_recipient_gets_full_amount() {
    let s = setup(150); // 1.5 %
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let sec = secret(&s.env, 1);
    let id = s.vault.create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &5_000,
    );
    // 100 + 1.5 locked
    assert_eq!(s.vault.balance(&s.payer), 1_000 * UNIT - 101_5000000);

    let to = Address::generate(&s.env);
    let received = s.vault.claim(&id, &sec, &to);
    assert_eq!(received, 100 * UNIT);
    assert_eq!(s.token.balance(&to), 100 * UNIT);
    assert_eq!(s.token.balance(&s.treasury), 1_5000000);
    assert_eq!(s.vault.get_payout(&id).status, Status::Claimed);
    // vault holds exactly what is left in the payer balance
    assert_eq!(s.token.balance(&s.vault.address), s.vault.balance(&s.payer));
}

#[test]
fn recipient_pays_fee() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let sec = secret(&s.env, 2);
    let id = s.vault.create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::RecipientPays,
        &5_000,
    );
    assert_eq!(s.vault.balance(&s.payer), 900 * UNIT);

    let to = Address::generate(&s.env);
    assert_eq!(s.vault.claim(&id, &sec, &to), 98_5000000);
    assert_eq!(s.token.balance(&to), 98_5000000);
    assert_eq!(s.token.balance(&s.treasury), 1_5000000);
}

#[test]
fn wrong_secret_is_rejected() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(100 * UNIT));
    let sec = secret(&s.env, 3);
    let id = s.vault.create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(50 * UNIT),
        &FeeMode::PayerPays,
        &5_000,
    );
    let to = Address::generate(&s.env);
    let r = s.vault.try_claim(&id, &secret(&s.env, 9), &to);
    assert_eq!(r, Err(Ok(Error::BadSecret)));
    assert_eq!(s.vault.get_payout(&id).status, Status::Pending);
}

#[test]
fn cannot_claim_twice() {
    let s = setup(0);
    s.vault.deposit(&s.payer, &(100 * UNIT));
    let sec = secret(&s.env, 4);
    let id = s.vault.create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(50 * UNIT),
        &FeeMode::PayerPays,
        &5_000,
    );
    let to = Address::generate(&s.env);
    s.vault.claim(&id, &sec, &to);
    let r = s.vault.try_claim(&id, &sec, &to);
    assert_eq!(r, Err(Ok(Error::NotPending)));
}

#[test]
fn expiry_blocks_claim_and_allows_permissionless_refund() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let sec = secret(&s.env, 5);
    let id = s.vault.create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &2_000,
    );

    // too early to refund
    assert_eq!(s.vault.try_refund(&id), Err(Ok(Error::NotExpired)));

    s.env.ledger().set_timestamp(2_000);
    let to = Address::generate(&s.env);
    assert_eq!(s.vault.try_claim(&id, &sec, &to), Err(Ok(Error::Expired)));

    s.vault.refund(&id);
    assert_eq!(s.vault.balance(&s.payer), 1_000 * UNIT);
    assert_eq!(s.vault.get_payout(&id).status, Status::Refunded);
}

#[test]
fn payer_can_cancel_pending_payout() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let sec = secret(&s.env, 6);
    let id = s.vault.create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &5_000,
    );
    s.vault.cancel(&id);
    assert_eq!(s.vault.balance(&s.payer), 1_000 * UNIT);
    // a cancelled payout cannot be claimed
    let to = Address::generate(&s.env);
    assert_eq!(
        s.vault.try_claim(&id, &sec, &to),
        Err(Ok(Error::NotPending))
    );
}

#[test]
fn insufficient_balance_blocks_payout() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(100 * UNIT));
    let sec = secret(&s.env, 7);
    let r = s.vault.try_create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(100 * UNIT), // needs 101.5 with fee
        &FeeMode::PayerPays,
        &5_000,
    );
    assert_eq!(r, Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn constructor_sets_config_at_deployment() {
    let s = setup(150);
    assert_eq!(
        s.vault.config(),
        (s.token.address.clone(), s.treasury.clone(), 150)
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn fee_cap_is_enforced_at_deployment() {
    let env = Env::default();
    let a = Address::generate(&env);
    env.register(PayoutVault, PayoutVaultArgs::__constructor(&a, &a, &1_001));
}

fn lock(s: &Setup, n: u8, amount: i128) -> (u64, Bytes) {
    let sec = secret(&s.env, n);
    let id = s.vault.create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &amount,
        &FeeMode::PayerPays,
        &5_000,
    );
    (id, sec)
}

#[test]
fn duplicate_external_id_is_rejected() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let (_, sec) = lock(&s, 10, 100 * UNIT);
    let balance_after_first = s.vault.balance(&s.payer);

    // same external id, different claim secret
    let r = s.vault.try_create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &secret(&s.env, 11)),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &5_000,
    );
    assert_eq!(r, Err(Ok(Error::DuplicateExternalId)));
    assert_eq!(s.vault.balance(&s.payer), balance_after_first);
}

#[test]
fn external_id_stays_used_after_cancel() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let (id, sec) = lock(&s, 12, 100 * UNIT);
    s.vault.cancel(&id);

    let r = s.vault.try_create_payout(
        &s.payer,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &5_000,
    );
    assert_eq!(r, Err(Ok(Error::DuplicateExternalId)));
}

#[test]
fn same_external_id_for_another_payer_is_allowed() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let (_, sec) = lock(&s, 13, 100 * UNIT);

    let other = Address::generate(&s.env);
    StellarAssetClient::new(&s.env, &s.token.address).mint(&other, &(1_000 * UNIT));
    s.vault.deposit(&other, &(1_000 * UNIT));
    let id = s.vault.create_payout(
        &other,
        &ext(&s.env, &sec),
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &5_000,
    );
    assert_eq!(s.vault.get_payout(&id).payer, other);
}

#[test]
fn payout_by_external_finds_the_payout() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let (id, sec) = lock(&s, 14, 100 * UNIT);
    assert_eq!(
        s.vault.payout_by_external(&s.payer, &ext(&s.env, &sec)),
        Some(id)
    );
    assert_eq!(
        s.vault
            .payout_by_external(&s.payer, &ext(&s.env, &secret(&s.env, 99))),
        None
    );
    assert_eq!(s.vault.get_payout(&id).external_id, ext(&s.env, &sec));
}

#[test]
fn create_and_claim_emit_events() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let (id, sec) = lock(&s, 15, 100 * UNIT);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.vault.address),
        [PayoutCreated {
            id,
            payer: s.payer.clone(),
            external_id: ext(&s.env, &sec),
            gross: 100 * UNIT,
            fee: 1_5000000,
            net: 100 * UNIT,
            expires_at: 5_000,
        }
        .to_xdr(&s.env, &s.vault.address)]
    );

    let to = Address::generate(&s.env);
    s.vault.claim(&id, &sec, &to);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.vault.address),
        [PayoutClaimed {
            id,
            to,
            net: 100 * UNIT,
            fee: 1_5000000,
        }
        .to_xdr(&s.env, &s.vault.address)]
    );
}

#[test]
fn refund_and_cancel_emit_events() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let (cancelled_id, _) = lock(&s, 16, 100 * UNIT);
    let (expired_id, _) = lock(&s, 17, 200 * UNIT);

    s.vault.cancel(&cancelled_id);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.vault.address),
        [PayoutRefunded {
            id: cancelled_id,
            payer: s.payer.clone(),
            amount: 101_5000000,
            cancelled: true,
        }
        .to_xdr(&s.env, &s.vault.address)]
    );

    s.env.ledger().set_timestamp(5_000);
    s.vault.refund(&expired_id);
    assert_eq!(
        s.env.events().all().filter_by_contract(&s.vault.address),
        [PayoutRefunded {
            id: expired_id,
            payer: s.payer.clone(),
            amount: 203_0000000,
            cancelled: false,
        }
        .to_xdr(&s.env, &s.vault.address)]
    );
}

/// Stands in for a smart-wallet contract account in the test below.
#[contract]
struct ContractAccountStandIn;

#[contractimpl]
impl ContractAccountStandIn {
    pub fn noop(_env: Env) {}
}

/// Proves only that the vault accepts a contract address as the receiver and asks that
/// address to authorise the claim. Auth is mocked here, so this does NOT prove that a passkey
/// smart wallet can authorise a claim. That is proven on testnet by event task E2 (DF8).
#[test]
fn contract_address_receiver_is_accepted_mock_auth_only() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let (id, sec) = lock(&s, 18, 100 * UNIT);

    let to = s.env.register(ContractAccountStandIn, ());
    assert_eq!(s.vault.claim(&id, &sec, &to), 100 * UNIT);
    // the receiver, not the payer, is the address asked to authorise
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, to);
    assert_eq!(s.token.balance(&to), 100 * UNIT);
}

/// External id as the settlement adapter builds it: sha256 of "<payment id>:<attempt>".
fn attempt_id(env: &Env, payment_id: &str, attempt: &str) -> BytesN<32> {
    let mut b = Bytes::from_slice(env, payment_id.as_bytes());
    b.append(&Bytes::from_slice(env, b":"));
    b.append(&Bytes::from_slice(env, attempt.as_bytes()));
    env.crypto().sha256(&b).to_bytes()
}

#[test]
fn retry_after_refund_needs_new_external_id() {
    let s = setup(150);
    s.vault.deposit(&s.payer, &(1_000 * UNIT));
    let sec = secret(&s.env, 19);
    let first = attempt_id(&s.env, "pay_demo_1", "1");
    let id = s.vault.create_payout(
        &s.payer,
        &first,
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &2_000,
    );
    s.env.ledger().set_timestamp(2_000);
    s.vault.refund(&id);

    // locking the same attempt again fails
    let r = s.vault.try_create_payout(
        &s.payer,
        &first,
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &9_000,
    );
    assert_eq!(r, Err(Ok(Error::DuplicateExternalId)));

    // the next attempt has a new id and succeeds
    let second = attempt_id(&s.env, "pay_demo_1", "2");
    let retry = s.vault.create_payout(
        &s.payer,
        &second,
        &hash_of(&s.env, &sec),
        &(100 * UNIT),
        &FeeMode::PayerPays,
        &9_000,
    );
    assert_eq!(s.vault.get_payout(&retry).status, Status::Pending);
    assert_eq!(s.vault.payout_by_external(&s.payer, &second), Some(retry));
    assert_eq!(s.vault.payout_by_external(&s.payer, &first), Some(id));
}
