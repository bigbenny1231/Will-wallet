//! Minimal NEP-171 (core), NEP-177 (metadata) and NEP-181 (enumeration) for the
//! Will NFT. Ownership lives in `Vault::owner_id`; `media` is an on-chain SVG
//! rendered from the vault state at read time (SPEC §2.5). Approvals (NEP-178)
//! are not supported.

use near_contract_standards::non_fungible_token::events::{NftMint, NftTransfer};
use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, TokenMetadata};
use near_contract_standards::non_fungible_token::Token;
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, PromiseOrValue,
};
use serde_json::json;
use std::collections::HashMap;

use crate::types::{StoredState, Vault, VaultState};
use crate::{Contract, ContractExt};

const GAS_NFT_ON_TRANSFER: Gas = Gas::from_tgas(40);
const GAS_NFT_RESOLVE: Gas = Gas::from_tgas(15);

pub const COLOR_ALIVE: &str = "#2ecc71";
pub const COLOR_WARNING: &str = "#f39c12";
pub const COLOR_TRIGGERED: &str = "#e74c3c";
pub const COLOR_SETTLED: &str = "#7f8c8d";

const ICON: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiMwZjExMTUiLz48Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIyMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMmVjYzcxIiBzdHJva2Utd2lkdGg9IjUiLz48L3N2Zz4=";

#[ext_contract(ext_nft_receiver)]
#[allow(dead_code)]
trait NonFungibleTokenReceiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool>;
}

pub(crate) fn emit_mint(owner: &AccountId, id: u64) {
    let tid = id.to_string();
    NftMint { owner_id: owner, token_ids: &[tid.as_str()], memo: None }.emit();
}

pub(crate) fn emit_transfer(old: &AccountId, new: &AccountId, id: u64, memo: Option<&str>) {
    let tid = id.to_string();
    NftTransfer {
        old_owner_id: old,
        new_owner_id: new,
        token_ids: &[tid.as_str()],
        authorized_id: None,
        memo,
    }
    .emit();
}

fn parse_id(token_id: &str) -> u64 {
    token_id.parse().unwrap_or_else(|_| env::panic_str("invalid token_id"))
}

pub fn state_color(s: VaultState) -> &'static str {
    match s {
        VaultState::Alive => COLOR_ALIVE,
        VaultState::Warning => COLOR_WARNING,
        VaultState::Triggered => COLOR_TRIGGERED,
        VaultState::Settled => COLOR_SETTLED,
    }
}

/// 400x400 SVG for the vault at `now_ms` (SPEC §2.5). Contains no user strings.
pub fn render_svg(id: u64, v: &Vault, now_ms: u64) -> String {
    let state = v.state_at(now_ms);
    let color = state_color(state);
    let status = match state {
        VaultState::Alive => format!("next beat in {}s", v.warning_at_ms().saturating_sub(now_ms).div_ceil(1000)),
        VaultState::Warning => format!("overdue - trigger in {}s", v.trigger_at_ms().saturating_sub(now_ms).div_ceil(1000)),
        VaultState::Triggered => format!("settling - step {}/5", v.step.min(5)),
        VaultState::Settled => "settled".to_string(),
    };
    let heirs = v.heirs.len();
    let plural = if heirs == 1 { "" } else { "s" };
    // Ring progress: fraction of the trigger window remaining.
    let circumference: u64 = 943; // 2*pi*150
    let dash = match state {
        VaultState::Alive | VaultState::Warning => {
            let window = v.trigger_at_ms().saturating_sub(v.last_beat_ms).max(1);
            let left = v.trigger_at_ms().saturating_sub(now_ms);
            circumference * left.min(window) / window
        }
        _ => circumference,
    };
    format!(
        concat!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">"##,
            r##"<rect width="400" height="400" fill="#0f1115"/>"##,
            r##"<circle cx="200" cy="200" r="150" fill="none" stroke="#1f232b" stroke-width="14"/>"##,
            r##"<circle cx="200" cy="200" r="150" fill="none" stroke="{color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="{dash} {circ}" transform="rotate(-90 200 200)"/>"##,
            r##"<text x="200" y="150" text-anchor="middle" font-family="monospace" font-size="18" fill="#9aa3b2">WILL #{id}</text>"##,
            r##"<text x="200" y="210" text-anchor="middle" font-family="sans-serif" font-size="44" font-weight="700" fill="{color}">{state}</text>"##,
            r##"<text x="200" y="250" text-anchor="middle" font-family="monospace" font-size="16" fill="#e6e9ef">{status}</text>"##,
            r##"<text x="200" y="280" text-anchor="middle" font-family="monospace" font-size="14" fill="#9aa3b2">{heirs} heir{plural}</text>"##,
            r##"<text x="200" y="385" text-anchor="middle" font-family="monospace" font-size="11" fill="#5c6370">Dead Man's Wallet</text>"##,
            "</svg>"
        ),
        color = color,
        dash = dash,
        circ = circumference,
        id = id,
        state = state.as_str(),
        status = status,
        heirs = heirs,
        plural = plural,
    )
}

pub fn media_data_uri(id: u64, v: &Vault, now_ms: u64) -> String {
    format!("data:image/svg+xml;base64,{}", STANDARD.encode(render_svg(id, v, now_ms)))
}

pub(crate) fn token_view(id: u64, v: &Vault) -> Token {
    let now = env::block_timestamp_ms();
    let state = v.state_at(now);
    Token {
        token_id: id.to_string(),
        owner_id: v.owner_id.clone(),
        metadata: Some(TokenMetadata {
            title: Some(format!("Will #{id}")),
            description: Some(format!(
                "Dead Man's Wallet vault {id}. State: {}. Heartbeat every {}s, triggers after {} missed.",
                state.as_str(),
                v.heartbeat_interval_s,
                u64::from(v.grace_missed) + 1
            )),
            media: Some(media_data_uri(id, v, now)),
            media_hash: None,
            copies: Some(1),
            issued_at: Some(v.created_ms.to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: Some(v.last_beat_ms.to_string()),
            extra: Some(
                json!({"state": state.as_str(), "trigger_at_ms": v.trigger_at_ms(), "heirs": v.heirs.len()})
                    .to_string(),
            ),
            reference: None,
            reference_hash: None,
        }),
        approved_account_ids: Some(HashMap::new()),
    }
}

#[near]
impl Contract {
    // ----- NEP-171 core -----

    /// Owner-only, while Alive/Warning; 1 yoctoNEAR. Transfers ownership of the vault.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let id = parse_id(&token_id);
        self.internal_nft_transfer(id, &receiver_id, approval_id, memo.as_deref());
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        let id = parse_id(&token_id);
        let previous_owner_id = self.internal_nft_transfer(id, &receiver_id, approval_id, memo.as_deref());
        let sender_id = env::predecessor_account_id();
        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_NFT_ON_TRANSFER)
            .nft_on_transfer(sender_id, previous_owner_id.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_NFT_RESOLVE)
                    .nft_resolve_transfer(previous_owner_id, receiver_id, token_id, None),
            )
            .into()
    }

    /// Returns true if the token was successfully transferred to `receiver_id`.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let _ = approved_account_ids;
        let must_revert = match env::promise_result_checked(0, 16) {
            Ok(bytes) => serde_json::from_slice::<bool>(&bytes).unwrap_or(true),
            Err(_) => true,
        };
        if !must_revert {
            return true;
        }
        let id = parse_id(&token_id);
        let Some(mut v) = self.vaults.get(&id) else { return true };
        if v.owner_id != receiver_id || v.stored == StoredState::Settled {
            // Receiver already moved it on, or settlement took over: keep.
            return true;
        }
        self.move_owner(id, &mut v, &owner_id, Some("nft_transfer_call reverted"));
        false
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        let id = token_id.parse::<u64>().ok()?;
        self.vaults.get(&id).map(|v| token_view(id, &v))
    }

    // ----- NEP-177 metadata -----

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "Dead Man's Wallet".to_string(),
            symbol: "WILL".to_string(),
            icon: Some(ICON.to_string()),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    // ----- NEP-181 enumeration -----

    pub fn nft_total_supply(&self) -> U128 {
        U128(u128::from(self.vaults.len()))
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let keys = self.vaults.keys_as_vector();
        let vals = self.vaults.values_as_vector();
        let from = from_index.map(|f| f.0 as u64).unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..keys.len().min(from.saturating_add(limit)))
            .filter_map(|i| Some(token_view(keys.get(i)?, &vals.get(i)?)))
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.owner_index.get(&account_id).map(|v| v.len() as u128).unwrap_or(0))
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let ids = self.owner_index.get(&account_id).unwrap_or_default();
        let from = from_index.map(|f| f.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100) as usize;
        ids.into_iter()
            .skip(from)
            .take(limit)
            .filter_map(|id| self.vaults.get(&id).map(|v| token_view(id, &v)))
            .collect()
    }
}

impl Contract {
    /// Returns the previous owner.
    fn internal_nft_transfer(
        &mut self,
        id: u64,
        receiver_id: &AccountId,
        approval_id: Option<u64>,
        memo: Option<&str>,
    ) -> AccountId {
        require!(approval_id.is_none(), "approvals not supported");
        let mut v = self.vault(id);
        let sender = env::predecessor_account_id();
        require!(sender == v.owner_id, "only the will nft owner can transfer");
        let state = v.state_at(env::block_timestamp_ms());
        require!(
            matches!(state, VaultState::Alive | VaultState::Warning),
            "will nft is locked once triggered"
        );
        require!(receiver_id != &v.owner_id, "receiver is already the owner");
        let prev = v.owner_id.clone();
        self.move_owner(id, &mut v, receiver_id, memo);
        prev
    }
}
