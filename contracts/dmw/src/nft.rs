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

// State colours (DESIGN.md tokens: life, warn, dead, still).
pub const COLOR_ALIVE: &str = "#3DDC84";
pub const COLOR_WARNING: &str = "#F5B942";
pub const COLOR_TRIGGERED: &str = "#FF4D4D";
pub const COLOR_SETTLED: &str = "#7A7F87";

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
    NftMint {
        owner_id: owner,
        token_ids: &[tid.as_str()],
        memo: None,
    }
    .emit();
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
    token_id
        .parse()
        .unwrap_or_else(|_| env::panic_str("invalid token_id"))
}

pub fn state_color(s: VaultState) -> &'static str {
    match s {
        VaultState::Alive => COLOR_ALIVE,
        VaultState::Warning => COLOR_WARNING,
        VaultState::Triggered => COLOR_TRIGGERED,
        VaultState::Settled => COLOR_SETTLED,
    }
}

// ECG traces drawn inside the seal (x 92..308, baseline y 200). The dashboard overlays the same
// geometry (dashboard/src/lib/pulse.ts) to animate live beats, so keep the two in sync.
const BEAT: &str = "h10q4-6 8 0h6l3 5l5-48l5 58l4-15h8q7-11 14 0h9";
const TRACE_WARNING: &str = "M92 200h46l3 4l4-26l4 32l3-10h52q4-4 8 0h18l2 3l3-14l3 17l2-6h68";
const TRACE_FLAT: &str = "M92 200h216";

/// "19s", "4m 05s", "23h 59m", "2d 04h".
fn fmt_secs(s: u64) -> String {
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m {:02}s", s / 60, s % 60),
        3600..=86_399 => format!("{}h {:02}m", s / 3600, (s % 3600) / 60),
        _ => format!("{}d {:02}h", s / 86_400, (s % 86_400) / 3600),
    }
}

/// The Will seal (DESIGN.md): 400x400, ink ground, brass double ring with the rim inscription on a
/// textPath, a state-coloured ECG trace, the state word and a status line. Contains no user strings.
pub fn render_svg(id: u64, v: &Vault, now_ms: u64) -> String {
    let state = v.state_at(now_ms);
    let color = state_color(state);
    let status = match state {
        VaultState::Alive => format!(
            "next beat in {}",
            fmt_secs(v.warning_at_ms().saturating_sub(now_ms).div_ceil(1000))
        ),
        VaultState::Warning => format!(
            "overdue, settles in {}",
            fmt_secs(v.trigger_at_ms().saturating_sub(now_ms).div_ceil(1000))
        ),
        VaultState::Triggered => format!("settling, step {} of 5", v.step.min(5)),
        VaultState::Settled => "settled".to_string(),
    };
    let trace = match state {
        VaultState::Alive => format!("M92 200{BEAT}{BEAT}{BEAT}"),
        VaultState::Warning => TRACE_WARNING.to_string(),
        _ => TRACE_FLAT.to_string(),
    };
    let glow = match state {
        VaultState::Alive | VaultState::Warning => "0.22",
        VaultState::Triggered => "0.14",
        VaultState::Settled => "0",
    };
    let heirs = v.heirs.len();
    let plural = if heirs == 1 { "" } else { "S" };
    let word = state.as_str();
    let rim = format!(
        "DEAD MAN\u{2019}S WALLET \u{b7} VAULT {id} \u{b7} {}",
        word.to_uppercase()
    );
    format!(
        concat!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="400" viewBox="0 0 400 400">"##,
            r##"<defs><radialGradient id="g"><stop offset="0" stop-color="{c}" stop-opacity="{glow}"/><stop offset="1" stop-color="{c}" stop-opacity="0"/></radialGradient>"##,
            r##"<path id="t" d="M37 200a163 163 0 0 1 326 0"/><path id="b" d="M28 200a172 172 0 0 0 344 0"/></defs>"##,
            r##"<rect width="400" height="400" fill="#0B0C0F"/>"##,
            r##"<circle cx="200" cy="200" r="150" fill="url(#g)"/>"##,
            r##"<g fill="none" stroke="#C8A96A"><circle cx="200" cy="200" r="186" stroke-width="1.5"/><circle cx="200" cy="200" r="180" stroke-width=".75"/></g>"##,
            r##"<circle cx="200" cy="200" r="148" fill="none" stroke="#8C7446" stroke-width=".75"/>"##,
            r##"<g font-family="Inter Tight,Helvetica,Arial,sans-serif" font-size="12.5" letter-spacing="3.2" text-anchor="middle" fill="#C8A96A"><text><textPath xlink:href="#t" startOffset="50%">{rim}</textPath></text>"##,
            r##"<text><textPath xlink:href="#b" startOffset="50%">{heirs} HEIR{plural} · NEAR</textPath></text></g>"##,
            r##"<path d="{trace}" fill="none" stroke="{c}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>"##,
            r##"<text x="200" y="266" text-anchor="middle" font-family="Instrument Serif,Georgia,serif" font-style="italic" font-size="36" fill="#EDE7DC">{word}</text>"##,
            r##"<text x="200" y="292" text-anchor="middle" font-family="JetBrains Mono,Menlo,monospace" font-size="11" fill="#A9A399">{status}</text>"##,
            "</svg>"
        ),
        c = color,
        glow = glow,
        rim = rim,
        heirs = heirs,
        plural = plural,
        trace = trace,
        word = word,
        status = status,
    )
}

pub fn media_data_uri(id: u64, v: &Vault, now_ms: u64) -> String {
    format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(render_svg(id, v, now_ms))
    )
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
                "Lastword vault {id}. State: {}. Heartbeat every {}s, triggers after {} missed.",
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

    /// Owner-only, only while the vault is Alive (not overdue, not paused); 1 yoctoNEAR.
    /// Transfers ownership of the vault and resets it for the buyer (v2, finding B): the
    /// buyer becomes the sole heir, foreign payouts / DAO / agent keys / guardian / per-vault
    /// keeper are cleared, the bounty and policy go back to defaults and the clock restarts.
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
        let previous_owner_id =
            self.internal_nft_transfer(id, &receiver_id, approval_id, memo.as_deref());
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
        // v3 (review v3 L-1): our own `nft_transfer_call` always chains exactly one promise, so a
        // call with any other number of results is not a real resolution. It is a direct call
        // through some key on the contract account, and it changes nothing (v2 treated it as a
        // revert, which moved a live vault to any `owner_id` the caller named).
        if env::promise_results_count() != 1 {
            env::log_str("nft_resolve_transfer: not a transfer resolution; nothing changed");
            return true;
        }
        let must_revert = match env::promise_result_checked(0, 16) {
            Ok(bytes) => serde_json::from_slice::<bool>(&bytes).unwrap_or(true),
            Err(_) => true,
        };
        if !must_revert {
            return true;
        }
        let id = parse_id(&token_id);
        let Some(mut v) = self.load(id) else {
            return true;
        };
        if v.owner_id != receiver_id || v.stored == StoredState::Settled {
            // Receiver already moved it on, or settlement took over: keep.
            return true;
        }
        // The revert resets the vault again, so nothing the receiver configured while it
        // held the token survives (the original configuration was already cleared on transfer).
        let before = env::storage_usage();
        self.move_owner(id, &mut v, &owner_id, Some("nft_transfer_call reverted"));
        self.charge_storage(id, before, false);
        false
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        let id = token_id.parse::<u64>().ok()?;
        self.load(id).map(|v| token_view(id, &v))
    }

    // ----- NEP-177 metadata -----

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "Lastword".to_string(),
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
            .filter_map(|i| {
                let id = keys.get(i)?;
                Some(token_view(id, &crate::hydrate(id, vals.get(i)?)))
            })
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(
            self.owner_index
                .get(&account_id)
                .map(|v| v.len() as u128)
                .unwrap_or(0),
        )
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
            .filter_map(|id| self.load(id).map(|v| token_view(id, &v)))
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
        require!(
            v.stored == StoredState::Live,
            "will nft is locked once triggered"
        );
        // v2 (finding B): a vault that is overdue (Warning) or paused can't be sold. Otherwise
        // a seller could transfer a vault one block before it triggers (or while a pause holds
        // it) and poke it for the bounty, or sell heirs' claims they never agreed to.
        require!(
            v.state_at(env::block_timestamp_ms()) == VaultState::Alive,
            "will nft can only be transferred while the vault is alive (not overdue or paused)"
        );
        require!(receiver_id != &v.owner_id, "receiver is already the owner");
        // Owned by the contract, the vault could be kept alive by ANY pulse key on the contract
        // account (`heartbeat` accepts predecessor == owner) and never settle (final audit L-10).
        require!(
            receiver_id != &env::current_account_id(),
            "receiver cannot be the dmw contract"
        );
        let prev = v.owner_id.clone();
        let before = env::storage_usage();
        self.move_owner(id, &mut v, receiver_id, memo);
        self.charge_storage(id, before, true);
        prev
    }
}
