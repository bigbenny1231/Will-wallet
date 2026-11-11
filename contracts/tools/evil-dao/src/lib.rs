//! Attacker "DAO" for the C-2 regression check on testnet (contracts/attack-c2.sh).
//!
//! `add_proposal` accepts the 1 NEAR bond (its own receipt succeeds, so NEAR refunds nothing) and returns a
//! promise to `boom`, which panics. The vault contract's `on_dao_proposal` callback therefore sees `Err`.
//! Before the fix that `Err` credited the bond back to the vault, so the vault was paid the bond twice
//! (once here, once in `claim`), out of other vaults' NEAR. After the fix nothing is credited.
use near_sdk::serde_json::Value;
use near_sdk::{env, near, Gas, NearToken, Promise};

#[near(contract_state)]
#[derive(Default)]
pub struct EvilDao {}

#[near]
impl EvilDao {
    #[payable]
    pub fn add_proposal(&mut self, #[allow(unused_variables)] proposal: Value) -> Promise {
        Promise::new(env::current_account_id()).function_call(
            "boom".to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            Gas::from_tgas(5),
        )
    }

    pub fn boom(&self) {
        env::panic_str("staged failure: the bond was kept")
    }

    /// How much NEAR this account has kept from bonds (its balance), for the attack report.
    pub fn kept(&self) -> NearToken {
        env::account_balance()
    }
}
