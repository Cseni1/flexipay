//! FlexiPay payout vault.
//!
//! Trust model
//! - FlexiPay never holds payer money. A payer deposits into its own balance inside this
//!   contract and can always withdraw whatever is not locked in a pending payout.
//! - There is no admin key. Token, treasury and fee are set by the constructor at deployment and
//!   cannot change. Nobody can initialise the contract between deploy and setup.
//! - A payout is claimed with a secret (claim link). Whoever holds the secret chooses the
//!   receiving address, so the recipient does not need a wallet when the payout is created.
//! - Unclaimed payouts return to the payer's balance after expiry (permissionless refund).
//! - Each payout carries an external id: sha256 of "<payment id>:<attempt>", built by the caller.
//!   The same payer can never create two payouts with the same external id, even after a refund,
//!   so every retry uses a new attempt number.
#![no_std]

use soroban_sdk::{
    Address, Bytes, BytesN, Env, contract, contracterror, contractevent, contractimpl,
    contracttype, panic_with_error, token,
};

const MAX_FEE_BPS: u32 = 1_000; // 10 %
const BPS: i128 = 10_000;

const DAY_LEDGERS: u32 = 17_280; // ~5 s per ledger
const TTL_THRESHOLD: u32 = 30 * DAY_LEDGERS;
const TTL_BUMP: u32 = 60 * DAY_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Reserved: `init` was replaced by the constructor. Kept so the codes below do not move.
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    FeeTooHigh = 4,
    InsufficientBalance = 5,
    PayoutNotFound = 6,
    NotPending = 7,
    Expired = 8,
    NotExpired = 9,
    BadSecret = 10,
    InvalidExpiry = 11,
    DuplicateExternalId = 12,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FeeMode {
    PayerPays,
    RecipientPays,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Pending,
    Claimed,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payout {
    pub id: u64,
    pub payer: Address,
    /// Unique per payer, forever. FlexiPay passes sha256("<payment id>:<attempt>").
    pub external_id: BytesN<32>,
    pub claim_hash: BytesN<32>,
    /// Amount the payer chose to send.
    pub gross: i128,
    pub fee: i128,
    /// Amount the recipient receives.
    pub net: i128,
    /// Amount taken out of the payer balance (gross + fee, or gross when the recipient pays).
    pub locked: i128,
    pub expires_at: u64,
    pub status: Status,
}

#[contracttype]
pub enum DataKey {
    Token,
    Treasury,
    FeeBps,
    NextId,
    Balance(Address),
    Payout(u64),
    External(Address, BytesN<32>),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutCreated {
    #[topic]
    pub id: u64,
    #[topic]
    pub payer: Address,
    pub external_id: BytesN<32>,
    pub gross: i128,
    pub fee: i128,
    pub net: i128,
    pub expires_at: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutClaimed {
    #[topic]
    pub id: u64,
    pub to: Address,
    pub net: i128,
    pub fee: i128,
}

/// Emitted by `refund` (after expiry) and by `cancel` (`cancelled` is true).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutRefunded {
    #[topic]
    pub id: u64,
    pub payer: Address,
    pub amount: i128,
    pub cancelled: bool,
}

#[contract]
pub struct PayoutVault;

fn token_client(env: &Env) -> Result<token::Client<'_>, Error> {
    let addr: Address = env
        .storage()
        .instance()
        .get(&DataKey::Token)
        .ok_or(Error::NotInitialized)?;
    Ok(token::Client::new(env, &addr))
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_BUMP);
}

fn read_balance(env: &Env, who: &Address) -> i128 {
    let key = DataKey::Balance(who.clone());
    let v: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if v > 0 {
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    }
    v
}

fn write_balance(env: &Env, who: &Address, amount: i128) {
    let key = DataKey::Balance(who.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
}

fn read_payout(env: &Env, id: u64) -> Result<Payout, Error> {
    let key = DataKey::Payout(id);
    let p: Payout = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::PayoutNotFound)?;
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
    Ok(p)
}

fn write_payout(env: &Env, p: &Payout) {
    let key = DataKey::Payout(p.id);
    env.storage().persistent().set(&key, p);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_BUMP);
}

#[contractimpl]
impl PayoutVault {
    /// Runs once, as part of deployment. After it nothing about token, treasury or fee can change.
    /// Fails the deployment with `FeeTooHigh` if `fee_bps` is above 10 %.
    pub fn __constructor(env: Env, token: Address, treasury: Address, fee_bps: u32) {
        if fee_bps > MAX_FEE_BPS {
            panic_with_error!(&env, Error::FeeTooHigh);
        }
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        bump_instance(&env);
    }

    /// Payer adds funds to its own balance in the vault.
    pub fn deposit(env: Env, payer: Address, amount: i128) -> Result<(), Error> {
        payer.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let token = token_client(&env)?;
        token.transfer(&payer, env.current_contract_address(), &amount);
        let bal = read_balance(&env, &payer);
        write_balance(&env, &payer, bal + amount);
        bump_instance(&env);
        Ok(())
    }

    /// Payer takes back any amount that is not locked in a pending payout.
    pub fn withdraw(env: Env, payer: Address, amount: i128) -> Result<(), Error> {
        payer.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let bal = read_balance(&env, &payer);
        if bal < amount {
            return Err(Error::InsufficientBalance);
        }
        write_balance(&env, &payer, bal - amount);
        let token = token_client(&env)?;
        token.transfer(&env.current_contract_address(), &payer, &amount);
        bump_instance(&env);
        Ok(())
    }

    /// Lock funds for one recipient. `claim_hash` is sha256 of the secret put in the claim link.
    /// Returns the payout id.
    pub fn create_payout(
        env: Env,
        payer: Address,
        external_id: BytesN<32>,
        claim_hash: BytesN<32>,
        amount: i128,
        mode: FeeMode,
        expires_at: u64,
    ) -> Result<u64, Error> {
        payer.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if expires_at <= env.ledger().timestamp() {
            return Err(Error::InvalidExpiry);
        }
        let ext_key = DataKey::External(payer.clone(), external_id.clone());
        if env.storage().persistent().has(&ext_key) {
            return Err(Error::DuplicateExternalId);
        }
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .ok_or(Error::NotInitialized)?;
        let fee = amount * (fee_bps as i128) / BPS;
        let (locked, net) = match mode {
            FeeMode::PayerPays => (amount + fee, amount),
            FeeMode::RecipientPays => (amount, amount - fee),
        };
        if net <= 0 {
            return Err(Error::InvalidAmount);
        }
        let bal = read_balance(&env, &payer);
        if bal < locked {
            return Err(Error::InsufficientBalance);
        }
        write_balance(&env, &payer, bal - locked);

        let id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextId)
            .ok_or(Error::NotInitialized)?;
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        bump_instance(&env);

        env.storage().persistent().set(&ext_key, &id);
        env.storage()
            .persistent()
            .extend_ttl(&ext_key, TTL_THRESHOLD, TTL_BUMP);

        write_payout(
            &env,
            &Payout {
                id,
                payer: payer.clone(),
                external_id: external_id.clone(),
                claim_hash,
                gross: amount,
                fee,
                net,
                locked,
                expires_at,
                status: Status::Pending,
            },
        );
        PayoutCreated {
            id,
            payer,
            external_id,
            gross: amount,
            fee,
            net,
            expires_at,
        }
        .publish(&env);
        Ok(id)
    }

    /// Recipient claims with the secret from the claim link and picks the receiving address.
    /// Returns the amount received.
    pub fn claim(env: Env, id: u64, secret: Bytes, to: Address) -> Result<i128, Error> {
        to.require_auth();
        let mut p = read_payout(&env, id)?;
        if p.status != Status::Pending {
            return Err(Error::NotPending);
        }
        if env.ledger().timestamp() >= p.expires_at {
            return Err(Error::Expired);
        }
        let hash: BytesN<32> = env.crypto().sha256(&secret).to_bytes();
        if hash != p.claim_hash {
            return Err(Error::BadSecret);
        }

        p.status = Status::Claimed;
        write_payout(&env, &p);

        let token = token_client(&env)?;
        let vault = env.current_contract_address();
        token.transfer(&vault, &to, &p.net);
        if p.fee > 0 {
            let treasury: Address = env
                .storage()
                .instance()
                .get(&DataKey::Treasury)
                .ok_or(Error::NotInitialized)?;
            token.transfer(&vault, &treasury, &p.fee);
        }
        bump_instance(&env);
        PayoutClaimed {
            id,
            to,
            net: p.net,
            fee: p.fee,
        }
        .publish(&env);
        Ok(p.net)
    }

    /// Payer cancels a pending payout before it is claimed. Funds go back to the payer balance.
    pub fn cancel(env: Env, id: u64) -> Result<(), Error> {
        let mut p = read_payout(&env, id)?;
        p.payer.require_auth();
        if p.status != Status::Pending {
            return Err(Error::NotPending);
        }
        p.status = Status::Refunded;
        write_payout(&env, &p);
        let bal = read_balance(&env, &p.payer);
        write_balance(&env, &p.payer, bal + p.locked);
        PayoutRefunded {
            id,
            payer: p.payer,
            amount: p.locked,
            cancelled: true,
        }
        .publish(&env);
        Ok(())
    }

    /// After expiry anyone can return the locked funds to the payer balance.
    pub fn refund(env: Env, id: u64) -> Result<(), Error> {
        let mut p = read_payout(&env, id)?;
        if p.status != Status::Pending {
            return Err(Error::NotPending);
        }
        if env.ledger().timestamp() < p.expires_at {
            return Err(Error::NotExpired);
        }
        p.status = Status::Refunded;
        write_payout(&env, &p);
        let bal = read_balance(&env, &p.payer);
        write_balance(&env, &p.payer, bal + p.locked);
        PayoutRefunded {
            id,
            payer: p.payer,
            amount: p.locked,
            cancelled: false,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_payout(env: Env, id: u64) -> Result<Payout, Error> {
        read_payout(&env, id)
    }

    /// Payout id for a payer's external id, if one was ever created. Lets an off-chain caller
    /// recover after a lost response instead of creating the payout again.
    pub fn payout_by_external(env: Env, payer: Address, external_id: BytesN<32>) -> Option<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::External(payer, external_id))
    }

    pub fn balance(env: Env, payer: Address) -> i128 {
        read_balance(&env, &payer)
    }

    pub fn config(env: Env) -> Result<(Address, Address, u32), Error> {
        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::NotInitialized)?;
        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;
        let fee_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::FeeBps)
            .ok_or(Error::NotInitialized)?;
        Ok((token, treasury, fee_bps))
    }
}

#[cfg(test)]
mod test;
