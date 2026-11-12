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
    /// Per-vault sequence number: orders entries across the two log rings (v2, finding D).
    #[serde(default)]
    pub seq: u64,
}

/// One allowed `agent_pay` inside the rolling 24 h window (v2: replaces the fixed day bucket).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spend {
    pub ms: u64,
    pub amount: U128,
}

/// A registered pulse/agent key: the vault it serves and the gas it is estimated to have burned
/// from its allowance (v2: `remove_key` and settlement refund the unspent part to the vault).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyRecord {
    pub token_id: u64,
    pub spent: u128,
}

/// Derivation paths of a vault's foreign source addresses (v2: salted, owner-bound).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DerivationPaths {
    pub base: String,
    pub monad: String,
    pub solana: String,
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
    /// Allowed agent spends of the last 24 h (rolling window, at most `MAX_SPENDS` entries).
    pub spends: Vec<Spend>,
    pub dao_id: Option<AccountId>,
    pub dao_proposal_id: Option<u64>,
    /// Next settlement step (1..=5) while Triggered; 0 before, 6 after Settled.
    pub step: u8,
    /// Next foreign payout to sign within step 3.
    pub foreign_index: u32,
    /// Set while a step-3 signature request is in flight (re-entry guard).
    pub foreign_inflight_since_ms: Option<u64>,
    pub created_ms: u64,
    /// Routine events (heartbeats, deposits, agent spends, key changes): ring of `MAX_LOG`.
    pub log: Vec<LogEntry>,
    /// Key events (creation, configuration, trigger, steps, payouts, claims, owner changes): a
    /// separate ring of `MAX_HISTORY` that routine traffic cannot evict (finding D).
    pub history: Vec<LogEntry>,
    /// Next `LogEntry::seq`.
    pub log_seq: u64,
    /// Per-vault salt of the foreign derivation paths (`<prefix>-<id>-<salt>`), from the block's
    /// random seed and the creator account (v2: the paths are not predictable before creation).
    pub salt: String,
    /// Optional keeper chosen by the vault owner; acts like the contract keeper for this vault.
    pub keeper_id: Option<AccountId>,
    /// When step 3 last started or progressed (gates who may supply step-3 chain params).
    pub step3_progress_ms: u64,
    /// Bytes of contract storage attributed to this vault (measured, v2 L-9).
    pub storage_bytes: u64,
    /// yoctoNEAR held for this vault's storage (>= storage_bytes x byte cost).
    pub storage_deposit: u128,
    /// Guardian config and pause state. NOT part of the stored `Vault` bytes (existing
    /// vaults keep their layout): kept in the raw slot `guard:<token_id>` and filled in
    /// by `Contract::load` on every read.
    #[borsh(skip)]
    pub guard: Guard,
}

/// Guardian pause (SPEC §2.8). Persisted in raw storage, see `Vault::guard`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Guard {
    /// Account allowed (besides the owner) to `pause` the vault.
    pub guardian_id: Option<AccountId>,
    /// How far a pause pushes the trigger deadline, counted from the pause.
    pub max_pause_s: u64,
    /// Trigger is held off until this time (0 = no pause since the last heartbeat).
    pub paused_until_ms: u64,
    /// When the current pause was taken (0 = none since the last heartbeat). A second
    /// pause is rejected until a heartbeat clears this.
    pub paused_at_ms: u64,
}

impl Vault {
    pub fn interval_ms(&self) -> u64 {
        self.heartbeat_interval_s.saturating_mul(1000)
    }
    pub fn warning_at_ms(&self) -> u64 {
        self.last_beat_ms.saturating_add(self.interval_ms())
    }
    /// Deadline from heartbeats alone (no pause).
    pub fn base_trigger_at_ms(&self) -> u64 {
        self.last_beat_ms.saturating_add(
            self.interval_ms()
                .saturating_mul(u64::from(self.grace_missed) + 1),
        )
    }
    /// Effective trigger deadline: the heartbeat deadline, pushed out by an active pause.
    pub fn trigger_at_ms(&self) -> u64 {
        self.base_trigger_at_ms().max(self.guard.paused_until_ms)
    }
    /// A guardian/owner pause is holding the vault (SPEC §2.8).
    pub fn is_paused(&self, now_ms: u64) -> bool {
        now_ms < self.guard.paused_until_ms
    }
    /// SPEC §2.2 state derivation. A paused vault reads as `Warning` (agent disarmed).
    pub fn state_at(&self, now_ms: u64) -> VaultState {
        match self.stored {
            StoredState::Triggered => VaultState::Triggered,
            StoredState::Settled => VaultState::Settled,
            StoredState::Live => {
                if now_ms < self.warning_at_ms() && !self.is_paused(now_ms) {
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
    /// All log entries (both rings) in the order they were written.
    pub fn log(&self) -> Vec<LogEntry> {
        let mut all: Vec<LogEntry> = self
            .history
            .iter()
            .chain(self.log.iter())
            .cloned()
            .collect();
        all.sort_by_key(|e| e.seq);
        all
    }
    /// Agent spend inside the rolling 24 h window ending at `now_ms`.
    pub fn spent_in_window(&self, now_ms: u64) -> u128 {
        self.spends
            .iter()
            .filter(|s| s.ms.saturating_add(crate::DAY_MS) > now_ms)
            .fold(0u128, |acc, s| acc.saturating_add(s.amount.0))
    }
    /// Oldest spend still counted at `now_ms` (0 when none).
    pub fn window_start_ms(&self, now_ms: u64) -> u64 {
        self.spends
            .iter()
            .filter(|s| s.ms.saturating_add(crate::DAY_MS) > now_ms)
            .map(|s| s.ms)
            .min()
            .unwrap_or(0)
    }
    /// Derivation path of this vault's source address on `chain`.
    pub fn path(&self, id: u64, chain: crate::foreign::ForeignChain) -> String {
        crate::foreign::derivation_path(chain, id, &self.salt)
    }
    pub fn paths(&self, id: u64) -> DerivationPaths {
        use crate::foreign::ForeignChain;
        DerivationPaths {
            base: self.path(id, ForeignChain::Base),
            monad: self.path(id, ForeignChain::Monad),
            solana: self.path(id, ForeignChain::Solana),
        }
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
    /// Agent spend in the rolling 24 h window ending now.
    pub daily_spent: U128,
    /// Oldest spend still counted in the window (0 when none); it stops counting 24 h later.
    pub daily_window_start_ms: u64,
    /// The spends still in the window.
    pub spends: Vec<Spend>,
    pub dao_id: Option<AccountId>,
    pub dao_proposal_id: Option<u64>,
    pub step: u8,
    pub foreign_index: u32,
    pub foreign_inflight: bool,
    pub created_ms: u64,
    pub log: Vec<LogEntry>,
    /// Guardian who may `pause` (SPEC §2.8); null when none.
    pub guardian_id: Option<AccountId>,
    /// Pause length in seconds (0 when no guardian).
    pub max_pause_s: u64,
    /// Trigger held off until this time; 0 when no pause since the last heartbeat.
    pub paused_until_ms: u64,
    /// Foreign source derivation paths (domain 0 for base/monad, 1 for solana). Clients derive the
    /// addresses from these; never rebuild them from the token id.
    pub derivation_paths: DerivationPaths,
    /// Per-vault keeper override (null when none).
    pub keeper_id: Option<AccountId>,
    /// Measured storage of this vault and the NEAR held for it.
    pub storage_bytes: u64,
    pub storage_deposit: U128,
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
