//! Wire and storage types for Dead Man's Wallet (SPEC §2.1).

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, PublicKey};

use crate::foreign::ForeignPayout;

/// Token id accepted by every `{token_id}` method: a JSON number (`1`) or a
/// JSON string (`"1"`). Views always return it as a string, like NEP-171.
#[near(serializers = [json])]
#[serde(untagged)]
#[derive(Clone, Debug)]
pub enum TokenRef {
    Num(u64),
    Str(U64),
}

impl TokenRef {
    pub fn id(&self) -> u64 {
        match self {
            TokenRef::Num(n) => *n,
            TokenRef::Str(s) => s.0,
        }
    }
}

impl From<u64> for TokenRef {
    fn from(v: u64) -> Self {
        TokenRef::Num(v)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Heir {
    pub account_id: AccountId,
    pub bps: u16,
}

/// Spending policy for agent keys. Amounts are yoctoNEAR strings.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub per_tx_max: U128,
    pub daily_max: U128,
    /// Empty = any receiver allowed.
    pub allowlist: Vec<AccountId>,
}

impl Default for Policy {
    /// Deny-by-default: an agent key with the default policy cannot spend.
    fn default() -> Self {
        Self {
            per_tx_max: U128(0),
            daily_max: U128(0),
            allowlist: vec![],
        }
    }
}

/// Externally visible state (SPEC §2.2). `Alive`/`Warning` are derived.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultState {
    Alive,
    Warning,
    Triggered,
    Settled,
}

impl VaultState {
    pub fn as_str(&self) -> &'static str {
        match self {
            VaultState::Alive => "Alive",
            VaultState::Warning => "Warning",
            VaultState::Triggered => "Triggered",
            VaultState::Settled => "Settled",
        }
    }
}

/// What is actually persisted. `Live` covers both Alive and Warning.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoredState {
    Live,
    Triggered,
    Settled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry {
    pub ms: u64,
    pub event: String,
    pub detail: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Vault {
    pub owner_id: AccountId,
    pub heartbeat_interval_s: u64,
    pub grace_missed: u32,
    pub last_beat_ms: u64,
    pub stored: StoredState,
    pub balance: u128,
    pub bounty: u128,
    pub heirs: Vec<Heir>,
    pub foreign: Vec<ForeignPayout>,
    pub pulse_keys: Vec<PublicKey>,
    pub agent_keys: Vec<PublicKey>,
    pub policy: Policy,
    pub daily_spent: u128,
    pub daily_window_start_ms: u64,
    pub dao_id: Option<AccountId>,
    pub dao_proposal_id: Option<u64>,
    /// Next settlement step (1..=5) while Triggered; 0 before, 6 after Settled.
    pub step: u8,
    /// Next foreign payout to sign within step 3.
    pub foreign_index: u32,
    /// Set while a step-3 signature request is in flight (re-entry guard).
    pub foreign_inflight_since_ms: Option<u64>,
    pub created_ms: u64,
    pub log: Vec<LogEntry>,
}

impl Vault {
    pub fn interval_ms(&self) -> u64 {
        self.heartbeat_interval_s.saturating_mul(1000)
    }
    pub fn warning_at_ms(&self) -> u64 {
        self.last_beat_ms.saturating_add(self.interval_ms())
    }
    pub fn trigger_at_ms(&self) -> u64 {
        self.last_beat_ms.saturating_add(
            self.interval_ms()
                .saturating_mul(u64::from(self.grace_missed) + 1),
        )
    }
    /// SPEC §2.2 state derivation.
    pub fn state_at(&self, now_ms: u64) -> VaultState {
        match self.stored {
            StoredState::Triggered => VaultState::Triggered,
            StoredState::Settled => VaultState::Settled,
            StoredState::Live => {
                if now_ms < self.warning_at_ms() {
                    VaultState::Alive
                } else {
                    VaultState::Warning
                }
            }
        }
    }
    pub fn is_due(&self, now_ms: u64) -> bool {
        self.stored == StoredState::Live && now_ms >= self.trigger_at_ms()
    }
    /// Heir with the highest bps (first one wins ties).
    pub fn primary_heir(&self) -> AccountId {
        let mut best = &self.heirs[0];
        for h in &self.heirs[1..] {
            if h.bps > best.bps {
                best = h;
            }
        }
        best.account_id.clone()
    }
}

/// `get_vault` response (SPEC §2.1).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultView {
    pub token_id: String,
    pub owner_id: AccountId,
    pub state: VaultState,
    pub heartbeat_interval_s: u64,
    pub grace_missed: u32,
    pub last_beat_ms: u64,
    pub warning_at_ms: u64,
    pub trigger_at_ms: u64,
    pub balance: U128,
    pub bounty: U128,
    pub heirs: Vec<Heir>,
    pub foreign: Vec<ForeignPayout>,
    pub pulse_keys: Vec<PublicKey>,
    pub agent_keys: Vec<PublicKey>,
    pub policy: Policy,
    pub daily_spent: U128,
    pub daily_window_start_ms: u64,
    pub dao_id: Option<AccountId>,
    pub dao_proposal_id: Option<u64>,
    pub step: u8,
    pub foreign_index: u32,
    pub foreign_inflight: bool,
    pub created_ms: u64,
    pub log: Vec<LogEntry>,
}

/// Result of `agent_pay`. Denials are returned (and logged), never panicked.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPayResult {
    pub allowed: bool,
    /// One of `over_per_tx_max`, `over_daily_max`, `receiver_not_allowlisted`,
    /// `vault_not_alive`, `insufficient_balance` when denied.
    pub reason: Option<String>,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub daily_spent: U128,
    pub balance: U128,
}

/// Which list a function-call key belongs to.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    Pulse,
    Agent,
}

impl KeyKind {
    pub fn method(&self) -> &'static str {
        match self {
            KeyKind::Pulse => "heartbeat",
            KeyKind::Agent => "agent_pay",
        }
    }
}
