//! Step 3: foreign-chain payouts via NEAR Chain Signatures (SPEC §2.4).
//!
//! ===========================================================================
//!  OWNERSHIP NOTE: this file is the hand-off point for the chainsig agent.
//!
//!  Current status: **STUB**. `request_foreign_signature` does not talk to the
//!  MPC signer; it schedules a cheap self-call and `on_foreign_signed` marks the
//!  payout `failed` with detail "chainsig not wired yet", so the whole step
//!  machine (1 -> 6) runs end to end on testnet without the MPC.
//!
//!  To wire the real signer, replace the bodies of
//!    - `request_foreign_signature` (build tx with omni-transaction from
//!      `vault.foreign[index]` + `args`, hash, call `v1.signer-prod.testnet.sign`
//!      with 1 yocto / 250 TGas, `.then(on_foreign_signed)` with 30 TGas), and
//!    - the `Ok(..)` arm of `on_foreign_signed` (parse signature, build the raw
//!      signed tx, call `self.finish_foreign(.., ForeignStatus::Signed, Some(raw), ..)`).
//!
//!  Everything else (in-flight guard, index advance, step 3 -> 4, events, log)
//!  is handled by `finish_foreign` in lib.rs and must keep being used.
//!  Keep `ForeignPayout` / `StepArgs` wire shapes exactly as in SPEC §2.1.
//! ===========================================================================

use near_sdk::json_types::U128;
use near_sdk::{env, near, Gas, NearToken, Promise, PromiseError};

use crate::{Contract, ContractExt};

/// Gas for the MPC `sign` call (SPEC §2.4).
pub const GAS_MPC_SIGN: Gas = Gas::from_tgas(250);
/// Gas for `on_foreign_signed`.
pub const GAS_ON_FOREIGN_SIGNED: Gas = Gas::from_tgas(30);
/// Gas for the stub self-call that stands in for the MPC.
const GAS_STUB_SIGN: Gas = Gas::from_tgas(5);
/// MPC signer contract (SPEC §1).
pub const MPC_SIGNER: &str = "v1.signer-prod.testnet";
/// Deposit required by the MPC `sign` method.
pub const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForeignChain {
    Base,
    Solana,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForeignStatus {
    Pending,
    Signed,
    Broadcast,
    Failed,
}

impl ForeignStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ForeignStatus::Pending => "pending",
            ForeignStatus::Signed => "signed",
            ForeignStatus::Broadcast => "broadcast",
            ForeignStatus::Failed => "failed",
        }
    }
}

/// SPEC §2.1 ForeignPayout. Set by the owner while Alive (status forced to
/// `pending`, `signed_tx`/`tx_hash` forced to null on `set_foreign_payouts`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignPayout {
    pub chain: ForeignChain,
    /// `0x...` (base) or base58 pubkey (solana).
    pub to: String,
    /// Integer string in the chain's smallest unit (wei / lamports).
    pub amount: U128,
    /// Derived source address, informational (set by dashboard).
    #[serde(default)]
    pub from_address: String,
    #[serde(default = "pending")]
    pub status: ForeignStatus,
    /// Hex of the raw signed tx (EVM) / base64 serialized tx (Solana); filled in step 3 callback.
    #[serde(default)]
    pub signed_tx: Option<String>,
    /// Filled by the keeper via `mark_broadcast`.
    #[serde(default)]
    pub tx_hash: Option<String>,
}

fn pending() -> ForeignStatus {
    ForeignStatus::Pending
}

/// SPEC §2.1 StepArgs: keeper supplies ONLY chain-environment fields.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StepArgs {
    #[serde(default)]
    pub evm: Option<EvmArgs>,
    #[serde(default)]
    pub solana: Option<SolanaArgs>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmArgs {
    pub nonce: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub gas_limit: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolanaArgs {
    pub recent_blockhash: String,
}

impl Contract {
    /// Start signing `vault.foreign[index]`. Caller (`execute_step`) has already
    /// checked `index < foreign.len()` and set the in-flight guard.
    ///
    /// STUB: schedules a no-op self-call; `on_foreign_signed` marks the payout failed.
    pub(crate) fn request_foreign_signature(
        &mut self,
        token_id: u64,
        index: usize,
        args: Option<StepArgs>,
    ) -> Promise {
        let _ = args; // used by the real implementation
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_STUB_SIGN)
            .foreign_stub_sign(token_id, index)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                    .on_foreign_signed(token_id, index),
            )
    }
}

#[near]
impl Contract {
    /// STUB stand-in for `v1.signer-prod.testnet.sign`. Remove when wiring chainsig.
    #[private]
    pub fn foreign_stub_sign(&self, token_id: u64, index: usize) -> serde_json::Value {
        serde_json::json!({ "stub": true, "token_id": token_id, "index": index })
    }

    /// Callback for the step-3 signature request. Returns the vault's new `step`.
    #[private]
    pub fn on_foreign_signed(
        &mut self,
        token_id: u64,
        index: usize,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) -> u8 {
        match result {
            // STUB: the real implementation parses the MPC signature here, builds the
            // fully serialized tx and calls finish_foreign(.., Signed, Some(raw_tx), ..).
            Ok(_value) => self.finish_foreign(
                token_id,
                index,
                ForeignStatus::Failed,
                None,
                "chainsig not wired yet",
            ),
            Err(_) => self.finish_foreign(
                token_id,
                index,
                ForeignStatus::Failed,
                None,
                "mpc sign call failed",
            ),
        }
    }
}
