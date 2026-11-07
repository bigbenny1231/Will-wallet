//! Dead Man's Wallet (`dmw`): heartbeat-triggered inheritance vaults, each one a
//! NEP-171 "Will NFT". See SPEC.md §2 for the authoritative description.

use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
};
use serde_json::json;

pub mod foreign;
mod nft;
pub mod types;

#[cfg(test)]
mod tests;

pub use foreign::{EvmArgs, ForeignChain, ForeignPayout, ForeignStatus, SolanaArgs, StepArgs};
pub use types::*;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// `milli` thousandths of a NEAR, in yoctoNEAR (1 milliNEAR = 10^21 yocto).
const fn near(milli: u128) -> u128 {
    milli * 1_000_000_000_000_000_000_000
}

/// Flat storage fee taken from the `create_vault` deposit (SPEC §2.3).
pub const STORAGE_FEE: u128 = near(100); // 0.1 NEAR
/// Default poke bounty when `create_vault` omits it.
pub const DEFAULT_BOUNTY: u128 = near(10); // 0.01 NEAR
/// Gas allowance of every pulse/agent function-call key (paid by the contract account).
pub const KEY_ALLOWANCE: u128 = near(1000); // 1 NEAR (~90 heartbeats at 10 TGas)
/// Step-1 reserve kept in the vault when a DAO is set (1 NEAR bond + gas).
pub const RESERVE_WITH_DAO: u128 = near(1500);
/// Step-1 reserve kept in the vault without a DAO.
pub const RESERVE_NO_DAO: u128 = near(100);
/// Proposal bond attached to Sputnik v2 `add_proposal`.
pub const DAO_BOND: u128 = near(1000);

pub const MAX_HEIRS: usize = 10;
pub const MAX_KEYS_PER_KIND: usize = 5;
pub const MAX_FOREIGN: usize = 4;
pub const MAX_ALLOWLIST: usize = 10;
pub const MAX_LOG: usize = 40;
pub const MAX_DETAIL: usize = 400;
pub const MIN_INTERVAL_S: u64 = 10;
pub const MAX_INTERVAL_S: u64 = 10 * 365 * 24 * 3600;
pub const MAX_GRACE: u32 = 1000;
pub const DAY_MS: u64 = 86_400_000;
/// A step-3 request older than this is considered lost and may be retried as failed.
pub const FOREIGN_INFLIGHT_TIMEOUT_MS: u64 = 10 * 60 * 1000;

const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(100);
const GAS_ON_DAO: Gas = Gas::from_tgas(10);
const GAS_ON_TRANSFER: Gas = Gas::from_tgas(5);
const GAS_ON_KEY: Gas = Gas::from_tgas(10);
const GAS_MARK_BROADCAST_DAO: u64 = 10_000_000_000_000;
/// Raw storage slot for the optional keeper account (kept out of `Contract` so the
/// stored contract layout is unchanged across this upgrade).
const KEEPER_SLOT: &[u8] = b"cfg:keeper";
/// Shortest and longest guardian pause (SPEC §2.8).
pub const MIN_PAUSE_S: u64 = 10;
pub const MAX_PAUSE_S: u64 = 90 * 24 * 3600;

/// Raw storage slot of a vault's `Guard` (outside the stored `Vault` bytes).
fn guard_key(token_id: u64) -> Vec<u8> {
    format!("guard:{token_id}").into_bytes()
}

pub(crate) fn read_guard(token_id: u64) -> Guard {
    env::storage_read(&guard_key(token_id))
        .and_then(|raw| near_sdk::borsh::from_slice(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn write_guard(token_id: u64, g: &Guard) {
    if g == &Guard::default() {
        env::storage_remove(&guard_key(token_id));
    } else {
        env::storage_write(&guard_key(token_id), &near_sdk::borsh::to_vec(g).unwrap());
    }
}

pub const EVENT_STANDARD: &str = "dmw";
pub const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Vaults,
    OwnerIndex,
    KeyIndex,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[near(
    contract_state,
    contract_metadata(
        standard(standard = "nep171", version = "1.2.0"),
        standard(standard = "nep177", version = "2.0.0"),
        standard(standard = "nep181", version = "1.0.0"),
        standard(standard = "nep297", version = "1.0.0"),
        standard(standard = "dmw", version = "1.0.0"),
    )
)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub vaults: UnorderedMap<u64, Vault>,
    /// NEP-181 owner index: account -> token ids.
    pub owner_index: LookupMap<AccountId, Vec<u64>>,
    /// Global registry public key -> token id. A key can belong to one vault only,
    /// and only keys registered here (and confirmed added) are ever deleted.
    pub key_index: LookupMap<PublicKey, u64>,
    pub next_id: u64,
}

/// Emit a NEP-297 event with standard `dmw`.
pub(crate) fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": data})
    ));
}

fn yocto(v: u128) -> String {
    v.to_string()
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            vaults: UnorderedMap::new(StorageKey::Vaults),
            owner_index: LookupMap::new(StorageKey::OwnerIndex),
            key_index: LookupMap::new(StorageKey::KeyIndex),
            next_id: 1,
        }
    }

    // -----------------------------------------------------------------------
    // Vault lifecycle
    // -----------------------------------------------------------------------

    /// Mint a Will NFT to the caller. Deposit = 0.1 NEAR storage + vault balance.
    #[payable]
    pub fn create_vault(
        &mut self,
        heartbeat_interval_s: u64,
        grace_missed: u32,
        heirs: Vec<Heir>,
        policy: Option<Policy>,
        bounty: Option<U128>,
    ) -> U128 {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= STORAGE_FEE,
            "deposit must be >= 0.1 NEAR (storage)"
        );
        validate_timing(heartbeat_interval_s, grace_missed);
        validate_heirs(&heirs);
        let policy = policy.unwrap_or_default();
        validate_policy(&policy);

        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let token_id = self.next_id;
        self.next_id += 1;
        let mut vault = Vault {
            owner_id: owner.clone(),
            heartbeat_interval_s,
            grace_missed,
            last_beat_ms: now,
            stored: StoredState::Live,
            balance: deposit - STORAGE_FEE,
            bounty: bounty.map(|b| b.0).unwrap_or(DEFAULT_BOUNTY),
            heirs,
            foreign: vec![],
            pulse_keys: vec![],
            agent_keys: vec![],
            policy,
            daily_spent: 0,
            daily_window_start_ms: now,
            dao_id: None,
            dao_proposal_id: None,
            step: 0,
            foreign_index: 0,
            foreign_inflight_since_ms: None,
            created_ms: now,
            log: vec![],
            guard: Guard::default(),
        };
        let data = json!({
            "token_id": token_id.to_string(), "owner_id": owner,
            "balance": yocto(vault.balance), "heartbeat_interval_s": heartbeat_interval_s,
            "grace_missed": grace_missed,
        });
        // Detail = original owner: the dashboard still needs it after settlement moves the NFT.
        record(&mut vault, token_id, "vault_created", owner.as_ref(), data);
        self.vaults.insert(&token_id, &vault);
        self.index_add(&owner, token_id);
        nft::emit_mint(&owner, token_id);
        U128(u128::from(token_id))
    }

    /// Add NEAR to a vault's balance. Anyone may top up.
    #[payable]
    pub fn deposit(&mut self, token_id: TokenRef) -> U128 {
        let id = token_id.id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "deposit must be > 0");
        let mut v = self.vault(id);
        v.balance += amount;
        let data = json!({"token_id": id.to_string(), "amount": yocto(amount), "from": env::predecessor_account_id()});
        record(&mut v, id, "deposit", &yocto(amount), data);
        self.vaults.insert(&id, &v);
        U128(v.balance)
    }

    /// Proof of life. Callable by the vault owner directly, or by a pulse key on the
    /// contract account (predecessor == contract && signer_pk ∈ pulse_keys).
    pub fn heartbeat(&mut self, token_id: TokenRef) -> u64 {
        let id = token_id.id();
        let mut v = self.vault(id);
        let pred = env::predecessor_account_id();
        let via_key = signed_by_own_key(&pred) && v.pulse_keys.contains(&env::signer_account_pk());
        require!(
            pred == v.owner_id || via_key,
            "unauthorized: not owner or pulse key"
        );
        require!(v.stored == StoredState::Live, "vault_triggered");
        let now = env::block_timestamp_ms();
        let was = v.state_at(now);
        v.last_beat_ms = now;
        // Only a heartbeat clears a pause (and re-arms the one pause per cycle).
        let was_paused = v.guard.paused_at_ms != 0 || v.guard.paused_until_ms != 0;
        if was_paused {
            v.guard.paused_at_ms = 0;
            v.guard.paused_until_ms = 0;
            write_guard(id, &v.guard);
        }
        let by = if via_key { "pulse_key" } else { "owner" };
        let data = json!({"token_id": id.to_string(), "by": by, "was": was.as_str(), "next_due_ms": v.warning_at_ms(), "pause_cleared": was_paused});
        record(&mut v, id, "heartbeat", by, data);
        self.vaults.insert(&id, &v);
        now
    }

    /// Store a pulse key and add it to the contract account as a function-call key
    /// limited to `heartbeat`. The key's gas allowance is reserved from the vault.
    pub fn add_pulse_key(&mut self, token_id: TokenRef, public_key: PublicKey) -> Promise {
        self.add_key(token_id.id(), public_key, KeyKind::Pulse)
    }

    /// Same as `add_pulse_key` but the key may only call `agent_pay`.
    pub fn add_agent_key(&mut self, token_id: TokenRef, public_key: PublicKey) -> Promise {
        self.add_key(token_id.id(), public_key, KeyKind::Agent)
    }

    /// Remove a pulse or agent key from the vault and delete it from the contract account.
    pub fn remove_key(&mut self, token_id: TokenRef, public_key: PublicKey) {
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        let before = v.pulse_keys.len() + v.agent_keys.len();
        v.pulse_keys.retain(|k| k != &public_key);
        v.agent_keys.retain(|k| k != &public_key);
        require!(
            v.pulse_keys.len() + v.agent_keys.len() < before,
            "key not in vault"
        );
        self.key_index.remove(&public_key);
        let pk_str = String::from(&public_key);
        record(
            &mut v,
            id,
            "key_removed",
            &pk_str,
            json!({"token_id": id.to_string(), "public_key": pk_str}),
        );
        self.vaults.insert(&id, &v);
        Promise::new(env::current_account_id())
            .delete_key(public_key)
            .detach();
    }

    /// Agent spend under the vault policy. Authorized only for agent keys on the
    /// contract account. Policy denials are logged and returned, never panicked.
    pub fn agent_pay(
        &mut self,
        token_id: TokenRef,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> AgentPayResult {
        let id = token_id.id();
        let mut v = self.vault(id);
        require!(
            signed_by_own_key(&env::predecessor_account_id())
                && v.agent_keys.contains(&env::signer_account_pk()),
            "unauthorized: not an agent key of this vault"
        );
        require!(amount.0 > 0, "amount must be > 0");
        // A transfer to the contract itself would move vault NEAR into the unallocated pool.
        require!(
            receiver_id != env::current_account_id(),
            "receiver cannot be the dmw contract"
        );
        let now = env::block_timestamp_ms();
        if now >= v.daily_window_start_ms.saturating_add(DAY_MS) {
            v.daily_window_start_ms = now;
            v.daily_spent = 0;
        }
        let reason = policy_check(&v, now, &receiver_id, amount.0);
        let memo = memo.map(|m| truncate(&m, 64)).unwrap_or_default();
        let res = match reason {
            Some(r) => {
                let data = json!({"token_id": id.to_string(), "receiver_id": receiver_id, "amount": amount, "reason": r, "memo": memo});
                record(
                    &mut v,
                    id,
                    "agent_pay_denied",
                    &format!("{r} {receiver_id} {}", amount.0),
                    data,
                );
                AgentPayResult {
                    allowed: false,
                    reason: Some(r.to_string()),
                    receiver_id,
                    amount,
                    daily_spent: U128(v.daily_spent),
                    balance: U128(v.balance),
                }
            }
            None => {
                v.balance -= amount.0;
                v.daily_spent += amount.0;
                let data = json!({"token_id": id.to_string(), "receiver_id": receiver_id, "amount": amount, "daily_spent": yocto(v.daily_spent), "memo": memo});
                record(
                    &mut v,
                    id,
                    "agent_pay_allowed",
                    &format!("{receiver_id} {}", amount.0),
                    data,
                );
                self.transfer_with_refund(id, &receiver_id, amount.0, "agent_pay");
                AgentPayResult {
                    allowed: true,
                    reason: None,
                    receiver_id,
                    amount,
                    daily_spent: U128(v.daily_spent),
                    balance: U128(v.balance),
                }
            }
        };
        self.vaults.insert(&id, &v);
        res
    }

    pub fn set_heirs(&mut self, token_id: TokenRef, heirs: Vec<Heir>) {
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        validate_heirs(&heirs);
        let data = json!({"token_id": id.to_string(), "heirs": heirs});
        v.heirs = heirs;
        let detail = format!("{} heirs", v.heirs.len());
        record(&mut v, id, "heirs_set", &detail, data);
        self.vaults.insert(&id, &v);
    }

    pub fn set_policy(&mut self, token_id: TokenRef, policy: Policy) {
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        validate_policy(&policy);
        let data = json!({"token_id": id.to_string(), "policy": policy});
        v.policy = policy;
        record(&mut v, id, "policy_set", "", data);
        self.vaults.insert(&id, &v);
    }

    /// Replace the foreign payout list. Status is forced to `pending`.
    pub fn set_foreign_payouts(&mut self, token_id: TokenRef, payouts: Vec<ForeignPayout>) {
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        require!(
            payouts.len() <= MAX_FOREIGN,
            "too many foreign payouts (max 4)"
        );
        let payouts: Vec<ForeignPayout> = payouts
            .into_iter()
            .map(|mut p| {
                require!(!p.to.is_empty() && p.to.len() <= 64, "invalid foreign `to`");
                require!(p.from_address.len() <= 64, "invalid foreign `from_address`");
                require!(p.amount.0 > 0, "foreign amount must be > 0");
                if p.chain.is_evm() {
                    require!(
                        p.to.starts_with("0x")
                            && foreign::chainsig::parse_evm_address(&p.to).is_ok(),
                        "evm `to` must be 0x + 40 hex"
                    );
                }
                p.status = ForeignStatus::Pending;
                p.signed_tx = None;
                p.tx_hash = None;
                p
            })
            .collect();
        // Per-chain payout limit (Monad: 1, review 2 H-4).
        for c in ForeignChain::ALL {
            if let Some(e) = c.evm() {
                let n = payouts.iter().filter(|p| p.chain == c).count();
                require!(
                    n <= e.max_payouts,
                    &format!(
                        "too many {} payouts (max {} per vault)",
                        c.as_str(),
                        e.max_payouts
                    )
                );
            }
        }
        let data = json!({"token_id": id.to_string(), "foreign": payouts});
        v.foreign = payouts;
        let detail = format!("{} payouts", v.foreign.len());
        record(&mut v, id, "foreign_set", &detail, data);
        self.vaults.insert(&id, &v);
    }

    pub fn set_dao(&mut self, token_id: TokenRef, dao_id: Option<AccountId>) {
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        let data = json!({"token_id": id.to_string(), "dao_id": dao_id});
        v.dao_id = dao_id;
        let detail = v.dao_id.as_ref().map(|d| d.to_string()).unwrap_or_default();
        record(&mut v, id, "dao_set", &detail, data);
        self.vaults.insert(&id, &v);
    }

    pub fn set_timing(&mut self, token_id: TokenRef, heartbeat_interval_s: u64, grace_missed: u32) {
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        validate_timing(heartbeat_interval_s, grace_missed);
        v.heartbeat_interval_s = heartbeat_interval_s;
        v.grace_missed = grace_missed;
        let data = json!({"token_id": id.to_string(), "heartbeat_interval_s": heartbeat_interval_s, "grace_missed": grace_missed});
        record(
            &mut v,
            id,
            "timing_set",
            &format!("{heartbeat_interval_s}s x{grace_missed}"),
            data,
        );
        self.vaults.insert(&id, &v);
    }

    /// Owner, while not Triggered: appoint (or clear, with `guardian_id: null`) a guardian
    /// who may `pause` the vault once per heartbeat cycle for `max_pause_s` (SPEC §2.8).
    /// Changing the guardian does not touch a pause that is already running.
    pub fn set_guardian(
        &mut self,
        token_id: TokenRef,
        guardian_id: Option<AccountId>,
        max_pause_s: Option<u64>,
    ) {
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        match &guardian_id {
            Some(g) => {
                require!(
                    g != &env::current_account_id(),
                    "guardian cannot be the dmw contract"
                );
                let s = max_pause_s.unwrap_or_else(|| env::panic_str("max_pause_s is required"));
                require!(
                    (MIN_PAUSE_S..=MAX_PAUSE_S).contains(&s),
                    "max_pause_s out of range (10s..90d)"
                );
                v.guard.max_pause_s = s;
            }
            None => v.guard.max_pause_s = 0,
        }
        v.guard.guardian_id = guardian_id.clone();
        write_guard(id, &v.guard);
        let detail = guardian_id
            .as_ref()
            .map(|g| format!("{g} {}s", v.guard.max_pause_s))
            .unwrap_or_else(|| "cleared".into());
        let data = json!({"token_id": id.to_string(), "guardian_id": guardian_id, "max_pause_s": v.guard.max_pause_s});
        record(&mut v, id, "guardian_set", &detail, data);
        self.vaults.insert(&id, &v);
    }

    /// Guardian or owner, while Alive/Warning and before the deadline: hold off the trigger
    /// until `now + max_pause_s` (SPEC §2.8). One pause per heartbeat cycle: a second pause
    /// is rejected until a heartbeat lands. While paused the vault reads as `Warning`, so
    /// `agent_pay` is denied. Returns the new effective `trigger_at_ms`.
    pub fn pause(&mut self, token_id: TokenRef) -> u64 {
        let id = token_id.id();
        let mut v = self.vault(id);
        let pred = env::predecessor_account_id();
        let Some(guardian) = v.guard.guardian_id.clone() else {
            env::panic_str("no guardian set");
        };
        require!(
            pred == guardian || pred == v.owner_id,
            "unauthorized: not guardian or owner"
        );
        require!(v.stored == StoredState::Live, "vault_triggered");
        let now = env::block_timestamp_ms();
        require!(!v.is_due(now), "deadline_passed");
        require!(
            v.guard.paused_at_ms == 0,
            "already_paused: a heartbeat must land before the next pause"
        );
        let before = v.trigger_at_ms();
        v.guard.paused_at_ms = now;
        v.guard.paused_until_ms = now.saturating_add(v.guard.max_pause_s.saturating_mul(1000));
        write_guard(id, &v.guard);
        let after = v.trigger_at_ms();
        let by = if pred == guardian {
            "guardian"
        } else {
            "owner"
        };
        let until = v.guard.paused_until_ms;
        let data = json!({
            "token_id": id.to_string(), "by": by, "account_id": pred,
            "paused_until_ms": until, "trigger_at_ms": after,
            "previous_trigger_at_ms": before,
        });
        record(
            &mut v,
            id,
            "paused",
            &format!("{by} {pred} until {until}"),
            data,
        );
        self.vaults.insert(&id, &v);
        after
    }

    /// Anyone: move an overdue vault to `Triggered` and earn the bounty.
    pub fn poke(&mut self, token_id: TokenRef) -> U128 {
        let id = token_id.id();
        let mut v = self.vault(id);
        require!(v.stored == StoredState::Live, "already_triggered");
        let now = env::block_timestamp_ms();
        require!(v.is_due(now), "not_due");
        v.stored = StoredState::Triggered;
        v.step = 1;
        let pay = v.bounty.min(v.balance);
        v.balance -= pay;
        let poker = env::predecessor_account_id();
        let data = json!({"token_id": id.to_string(), "by": poker, "bounty": yocto(pay), "trigger_at_ms": v.trigger_at_ms()});
        record(
            &mut v,
            id,
            "triggered",
            &format!("by {poker}, bounty {pay}"),
            data,
        );
        self.vaults.insert(&id, &v);
        if pay > 0 {
            self.transfer_with_refund(id, &poker, pay, "bounty");
        }
        U128(pay)
    }

    /// Anyone: run the current settlement step (SPEC §2.4). Returns the new `step`
    /// (directly, or as the result of the step's callback for steps 3 and 4).
    pub fn execute_step(
        &mut self,
        token_id: TokenRef,
        args: Option<StepArgs>,
    ) -> PromiseOrValue<u8> {
        let id = token_id.id();
        let mut v = self.vault(id);
        require!(v.stored != StoredState::Settled, "already_settled");
        require!(v.stored == StoredState::Triggered, "not_triggered");
        let me = env::current_account_id();
        match v.step {
            1 => {
                let reserve = if v.dao_id.is_some() {
                    RESERVE_WITH_DAO
                } else {
                    RESERVE_NO_DAO
                };
                let distributable = v.balance.saturating_sub(reserve);
                let mut paid_total = 0u128;
                let mut payouts = vec![];
                for h in &v.heirs {
                    let amt = distributable * u128::from(h.bps) / 10_000;
                    if amt > 0 {
                        paid_total += amt;
                        payouts.push((h.account_id.clone(), amt));
                    }
                }
                v.balance -= paid_total;
                v.step = 2;
                let data = json!({
                    "token_id": id.to_string(),
                    "payouts": payouts.iter().map(|(a, amt)| json!({"account_id": a, "amount": yocto(*amt)})).collect::<Vec<_>>(),
                    "reserve": yocto(v.balance),
                });
                // Dashboard heir page parses "<account> <amount> NEAR" items.
                let detail = payouts
                    .iter()
                    .map(|(a, amt)| format!("{a} {} NEAR", fmt_near(*amt)))
                    .collect::<Vec<_>>()
                    .join(", ");
                record(&mut v, id, "step_1", &detail, data);
                self.vaults.insert(&id, &v);
                for (acc, amt) in payouts {
                    self.transfer_with_refund(id, &acc, amt, "heir");
                }
                PromiseOrValue::Value(2)
            }
            2 => {
                let keys = self.take_keys(&mut v);
                v.step = 3;
                v.foreign_index = 0;
                let data = json!({"token_id": id.to_string(), "deleted_keys": keys});
                record(
                    &mut v,
                    id,
                    "step_2",
                    &format!("{} keys deleted", keys.len()),
                    data,
                );
                self.vaults.insert(&id, &v);
                delete_keys(keys);
                PromiseOrValue::Value(3)
            }
            3 => {
                let idx = v.foreign_index as usize;
                if idx >= v.foreign.len() {
                    v.step = 4;
                    let data = json!({"token_id": id.to_string(), "foreign": v.foreign.len()});
                    record(&mut v, id, "step_3", "foreign payouts done", data);
                    self.vaults.insert(&id, &v);
                    return PromiseOrValue::Value(4);
                }
                let now = env::block_timestamp_ms();
                if let Some(since) = v.foreign_inflight_since_ms {
                    if now < since.saturating_add(FOREIGN_INFLIGHT_TIMEOUT_MS) {
                        // Re-entry while a signature is in flight: do nothing (idempotent).
                        env::log_str("step 3 signature in flight; nothing to do");
                        return PromiseOrValue::Value(3);
                    }
                    // Lost request: fail it and move on, never block settlement.
                    return PromiseOrValue::Value(self.finish_foreign(
                        id,
                        idx,
                        ForeignStatus::Failed,
                        None,
                        "signature request timed out",
                    ));
                }
                v.foreign_inflight_since_ms = Some(now);
                self.vaults.insert(&id, &v);
                PromiseOrValue::Promise(self.request_foreign_signature(id, idx, args))
            }
            4 => {
                v.step = 5;
                let Some(dao) = v.dao_id.clone() else {
                    record(
                        &mut v,
                        id,
                        "step_4",
                        "no dao; skipped",
                        json!({"token_id": id.to_string(), "dao_id": null}),
                    );
                    self.vaults.insert(&id, &v);
                    return PromiseOrValue::Value(5);
                };
                if v.balance < DAO_BOND {
                    record(
                        &mut v,
                        id,
                        "step_4",
                        "insufficient balance for dao bond; skipped",
                        json!({"token_id": id.to_string(), "dao_id": dao, "skipped": true}),
                    );
                    self.vaults.insert(&id, &v);
                    return PromiseOrValue::Value(5);
                }
                v.balance -= DAO_BOND;
                let description = format!(
                    "Dead Man's Wallet: vault {id} settled; heirs: {}",
                    v.heirs
                        .iter()
                        .map(|h| format!("{} {}bps", h.account_id, h.bps))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                let inner =
                    json!({"token_id": id, "index": 0, "tx_hash": "dao-ratified"}).to_string();
                let proposal = json!({"proposal": {
                    "description": description,
                    "kind": {"FunctionCall": {
                        "receiver_id": me,
                        "actions": [{
                            "method_name": "mark_broadcast",
                            "args": Base64VecU8::from(inner.into_bytes()),
                            "deposit": "0",
                            "gas": GAS_MARK_BROADCAST_DAO.to_string(),
                        }]
                    }}
                }});
                record(
                    &mut v,
                    id,
                    "step_4",
                    &format!("add_proposal on {dao}"),
                    json!({"token_id": id.to_string(), "dao_id": dao, "description": description}),
                );
                self.vaults.insert(&id, &v);
                PromiseOrValue::Promise(
                    Promise::new(dao)
                        .function_call(
                            "add_proposal",
                            proposal.to_string().into_bytes(),
                            NearToken::from_yoctonear(DAO_BOND),
                            GAS_ADD_PROPOSAL,
                        )
                        .then(
                            Self::ext(me)
                                .with_static_gas(GAS_ON_DAO)
                                .on_dao_proposal(id),
                        ),
                )
            }
            5 => {
                let heir = v.primary_heir();
                let old = v.owner_id.clone();
                v.owner_id = heir.clone();
                v.stored = StoredState::Settled;
                v.step = 6;
                let data = json!({"token_id": id.to_string(), "old_owner_id": old, "new_owner_id": heir, "remaining": yocto(v.balance)});
                record(
                    &mut v,
                    id,
                    "step_5",
                    &format!("will nft -> {heir}"),
                    data.clone(),
                );
                record(&mut v, id, "settled", heir.as_ref(), data);
                self.vaults.insert(&id, &v);
                self.index_remove(&old, id);
                self.index_add(&heir, id);
                nft::emit_transfer(&old, &heir, id, Some("settlement"));
                PromiseOrValue::Value(6)
            }
            s => env::panic_str(&format!("invalid step {s}")),
        }
    }

    /// Keeper records a relayed foreign tx. Also accepts the DAO ratification call
    /// (`tx_hash == "dao-ratified"` from the vault's DAO), which only logs.
    pub fn mark_broadcast(&mut self, token_id: TokenRef, index: u32, tx_hash: String) {
        let id = token_id.id();
        let mut v = self.vault(id);
        require!(
            !tx_hash.is_empty() && tx_hash.len() <= 128,
            "invalid tx_hash"
        );
        let pred = env::predecessor_account_id();
        if tx_hash == "dao-ratified" {
            require!(
                v.dao_id.as_ref() == Some(&pred),
                "only the vault dao may ratify"
            );
            record(
                &mut v,
                id,
                "dao_ratified",
                pred.as_ref(),
                json!({"token_id": id.to_string(), "dao_id": pred}),
            );
            self.vaults.insert(&id, &v);
            return;
        }
        let i = index as usize;
        require!(i < v.foreign.len(), "index out of range");
        let p = &v.foreign[i];
        if p.status == ForeignStatus::Broadcast && p.tx_hash.as_deref() == Some(tx_hash.as_str()) {
            return; // idempotent re-report
        }
        require!(p.status == ForeignStatus::Signed, "payout is not signed");
        // The hash must be the id of the stored signed tx (H-1): nobody can record a fake
        // hash. "broadcast" means "relayed", not "confirmed"; the signed tx stays public and
        // relayable, and `resign_foreign` still works from `broadcast` after the cooldown.
        let signed = p
            .signed_tx
            .as_deref()
            .unwrap_or_else(|| env::panic_str("payout has no signed tx"));
        let expected =
            foreign::expected_tx_id(p.chain, signed).unwrap_or_else(|e| env::panic_str(&e));
        let tx_hash = if p.chain.is_evm() {
            tx_hash.to_ascii_lowercase()
        } else {
            tx_hash
        };
        require!(tx_hash == expected, "tx_hash does not match the signed tx");
        v.foreign[i].status = ForeignStatus::Broadcast;
        v.foreign[i].tx_hash = Some(tx_hash.clone());
        let data = json!({"token_id": id.to_string(), "index": index, "chain": v.foreign[i].chain, "tx_hash": tx_hash, "by": pred});
        record(
            &mut v,
            id,
            "foreign_broadcast",
            &format!("#{index} {tx_hash}"),
            data,
        );
        self.vaults.insert(&id, &v);
    }

    /// Current NFT owner withdraws the remaining reserve after settlement.
    pub fn claim(&mut self, token_id: TokenRef) -> U128 {
        let id = token_id.id();
        let mut v = self.vault(id);
        require!(v.stored == StoredState::Settled, "not_settled");
        let caller = env::predecessor_account_id();
        require!(caller == v.owner_id, "only the will nft owner can claim");
        let amount = v.balance;
        require!(amount > 0, "nothing to claim");
        v.balance = 0;
        record(
            &mut v,
            id,
            "claim",
            &format!("{caller} {amount}"),
            json!({"token_id": id.to_string(), "account_id": caller, "amount": yocto(amount)}),
        );
        self.vaults.insert(&id, &v);
        self.transfer_with_refund(id, &caller, amount, "claim");
        U128(amount)
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    pub fn get_vault(&self, token_id: TokenRef) -> Option<VaultView> {
        let id = token_id.id();
        self.load(id).map(|v| view(id, &v))
    }

    pub fn get_vaults(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<VaultView> {
        let keys = self.vaults.keys_as_vector();
        let vals = self.vaults.values_as_vector();
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..keys.len().min(from.saturating_add(limit)))
            .filter_map(|i| {
                let id = keys.get(i)?;
                Some(view(id, &hydrate(id, vals.get(i)?)))
            })
            .collect()
    }

    pub fn get_vaults_for_owner(&self, account_id: AccountId) -> Vec<VaultView> {
        self.owner_index
            .get(&account_id)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|id| self.load(id).map(|v| view(id, &v)))
            .collect()
    }

    pub fn get_config(&self) -> serde_json::Value {
        json!({
            "owner_id": self.owner_id,
            "next_id": self.next_id,
            "storage_fee": yocto(STORAGE_FEE),
            "key_allowance": yocto(KEY_ALLOWANCE),
            "reserve_with_dao": yocto(RESERVE_WITH_DAO),
            "reserve_no_dao": yocto(RESERVE_NO_DAO),
            "dao_bond": yocto(DAO_BOND),
            "mpc_signer": foreign::MPC_SIGNER,
            "keeper": self.keeper(),
            "chains": foreign::chain_registry(),
            "min_pause_s": MIN_PAUSE_S,
            "max_pause_s": MAX_PAUSE_S,
        })
    }

    /// Contract owner only: set (or clear) the keeper account. Besides the contract owner,
    /// only the keeper may re-sign a Solana payout that already has a signature, because
    /// that is only safe after checking off-chain that the old signature never landed.
    pub fn set_keeper(&mut self, account_id: Option<AccountId>) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the contract owner"
        );
        match &account_id {
            Some(a) => {
                env::storage_write(KEEPER_SLOT, a.as_bytes());
            }
            None => {
                env::storage_remove(KEEPER_SLOT);
            }
        }
        emit("keeper_set", json!({"keeper": account_id}));
    }

    // -----------------------------------------------------------------------
    // Callbacks
    // -----------------------------------------------------------------------

    /// After AddKey: confirm the key into the vault list, or release the reservation.
    #[private]
    pub fn on_key_added(
        &mut self,
        token_id: u64,
        public_key: PublicKey,
        kind: KeyKind,
        owner: Option<AccountId>,
    ) -> bool {
        let ok = promise_ok();
        let Some(mut v) = self.load(token_id) else {
            return false;
        };
        let pk_str = String::from(&public_key);
        if !ok {
            self.key_index.remove(&public_key);
            v.balance += KEY_ALLOWANCE;
            record(
                &mut v,
                token_id,
                "key_add_failed",
                &pk_str,
                json!({"token_id": token_id.to_string(), "public_key": pk_str, "kind": kind}),
            );
            self.vaults.insert(&token_id, &v);
            return false;
        }
        let owner_changed = owner.as_ref().is_some_and(|o| o != &v.owner_id);
        if v.stored != StoredState::Live || owner_changed {
            // Vault triggered, or the Will NFT changed hands, while the key was being
            // added: the requester no longer controls the vault, so delete it right away.
            self.key_index.remove(&public_key);
            let why = if owner_changed {
                "owner changed"
            } else {
                "vault triggered"
            };
            record(
                &mut v,
                token_id,
                "key_add_revoked",
                &format!("{pk_str} {why}"),
                json!({"token_id": token_id.to_string(), "public_key": pk_str, "reason": why}),
            );
            self.vaults.insert(&token_id, &v);
            Promise::new(env::current_account_id())
                .delete_key(public_key)
                .detach();
            return false;
        }
        match kind {
            KeyKind::Pulse => v.pulse_keys.push(public_key),
            KeyKind::Agent => v.agent_keys.push(public_key),
        }
        record(
            &mut v,
            token_id,
            "key_added",
            &format!("{} {pk_str}", kind.method()),
            json!({"token_id": token_id.to_string(), "public_key": pk_str, "kind": kind, "method": kind.method()}),
        );
        self.vaults.insert(&token_id, &v);
        true
    }

    /// After a NEAR transfer out of a vault: re-credit the vault if it failed.
    #[private]
    pub fn on_transfer_done(
        &mut self,
        token_id: u64,
        receiver_id: AccountId,
        amount: U128,
        kind: String,
    ) -> bool {
        if promise_ok() {
            return true;
        }
        if let Some(mut v) = self.load(token_id) {
            v.balance += amount.0;
            if kind == "agent_pay" {
                v.daily_spent = v.daily_spent.saturating_sub(amount.0);
            }
            record(
                &mut v,
                token_id,
                "transfer_failed",
                &format!("{kind} {receiver_id} {}", amount.0),
                json!({"token_id": token_id.to_string(), "receiver_id": receiver_id, "amount": amount, "kind": kind}),
            );
            self.vaults.insert(&token_id, &v);
        }
        false
    }

    /// After Sputnik `add_proposal`: store the proposal id, or log and continue.
    #[private]
    pub fn on_dao_proposal(
        &mut self,
        token_id: u64,
        #[callback_result] result: Result<u64, near_sdk::PromiseError>,
    ) -> u8 {
        let mut v = self.vault(token_id);
        match result {
            Ok(pid) => {
                v.dao_proposal_id = Some(pid);
                let data = json!({"token_id": token_id.to_string(), "dao_id": v.dao_id, "proposal_id": pid});
                record(
                    &mut v,
                    token_id,
                    "dao_proposal",
                    &format!("proposal {pid}"),
                    data,
                );
            }
            Err(_) => {
                // The bond is refunded to the contract account on failure; give it back to the vault.
                v.balance += DAO_BOND;
                let data = json!({"token_id": token_id.to_string(), "dao_id": v.dao_id});
                record(
                    &mut v,
                    token_id,
                    "dao_proposal_failed",
                    "add_proposal failed; continuing",
                    data,
                );
            }
        }
        self.vaults.insert(&token_id, &v);
        v.step
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

impl Contract {
    pub(crate) fn vault(&self, id: u64) -> Vault {
        self.load(id)
            .unwrap_or_else(|| env::panic_str("vault not found"))
    }

    /// Read a vault with its raw-slot `Guard` filled in. Use this, never `vaults.get`.
    pub(crate) fn load(&self, id: u64) -> Option<Vault> {
        self.vaults.get(&id).map(|v| hydrate(id, v))
    }

    fn require_owner_mutable(&self, v: &Vault) {
        require!(
            env::predecessor_account_id() == v.owner_id,
            "only the vault owner"
        );
        require!(v.stored == StoredState::Live, "vault_triggered");
    }

    fn add_key(&mut self, id: u64, pk: PublicKey, kind: KeyKind) -> Promise {
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        let list = match kind {
            KeyKind::Pulse => &v.pulse_keys,
            KeyKind::Agent => &v.agent_keys,
        };
        require!(
            list.len() < MAX_KEYS_PER_KIND,
            "too many keys of this kind (max 5)"
        );
        require!(
            !self.key_index.contains_key(&pk),
            "public key already registered"
        );
        require!(
            v.balance >= KEY_ALLOWANCE,
            "vault balance must cover the 1 NEAR key gas allowance"
        );
        v.balance -= KEY_ALLOWANCE;
        self.key_index.insert(&pk, &id);
        let pk_str = String::from(&pk);
        record(
            &mut v,
            id,
            "key_add_requested",
            &format!("{} {pk_str}", kind.method()),
            json!({"token_id": id.to_string(), "public_key": pk_str, "kind": kind}),
        );
        self.vaults.insert(&id, &v);
        let me = env::current_account_id();
        let allowance = near_sdk::Allowance::limited(NearToken::from_yoctonear(KEY_ALLOWANCE))
            .unwrap_or_else(|| env::panic_str("zero allowance"));
        Promise::new(me.clone())
            .add_access_key_allowance(pk.clone(), allowance, me.clone(), kind.method())
            .then(Self::ext(me).with_static_gas(GAS_ON_KEY).on_key_added(
                id,
                pk,
                kind,
                Some(v.owner_id.clone()),
            ))
    }

    fn transfer_with_refund(&self, id: u64, to: &AccountId, amount: u128, kind: &str) {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_TRANSFER)
                    .on_transfer_done(id, to.clone(), U128(amount), kind.to_string()),
            )
            .detach();
    }

    /// Shared completion for one step-3 payout (used by the stub and the real
    /// chainsig implementation). Clears the in-flight guard, records status,
    /// advances `foreign_index`, moves to step 4 when done. Returns the new step.
    pub(crate) fn finish_foreign(
        &mut self,
        token_id: u64,
        index: usize,
        status: ForeignStatus,
        signed_tx: Option<String>,
        detail: &str,
    ) -> u8 {
        let mut v = self.vault(token_id);
        // Ignore stale callbacks (e.g. after a timeout already advanced past it).
        if v.step != 3 || v.foreign_index as usize != index || index >= v.foreign.len() {
            env::log_str("stale foreign callback ignored");
            return v.step;
        }
        v.foreign[index].status = status;
        v.foreign[index].signed_tx = signed_tx;
        v.foreign_inflight_since_ms = None;
        v.foreign_index += 1;
        let event = if status == ForeignStatus::Signed {
            "foreign_signed"
        } else {
            "foreign_failed"
        };
        let data = json!({"token_id": token_id.to_string(), "index": index, "chain": v.foreign[index].chain, "status": status.as_str(), "detail": detail});
        record(&mut v, token_id, event, &format!("#{index} {detail}"), data);
        if v.foreign_index as usize >= v.foreign.len() {
            v.step = 4;
            let data = json!({"token_id": token_id.to_string(), "foreign": v.foreign.len()});
            record(&mut v, token_id, "step_3", "foreign payouts done", data);
        }
        self.vaults.insert(&token_id, &v);
        v.step
    }

    /// Drain both key lists and release them from the global registry.
    fn take_keys(&mut self, v: &mut Vault) -> Vec<PublicKey> {
        let keys: Vec<PublicKey> = v
            .pulse_keys
            .drain(..)
            .chain(v.agent_keys.drain(..))
            .collect();
        for k in &keys {
            self.key_index.remove(k);
        }
        keys
    }

    pub(crate) fn keeper(&self) -> Option<AccountId> {
        env::storage_read(KEEPER_SLOT).and_then(|b| String::from_utf8(b).ok()?.parse().ok())
    }

    fn index_add(&mut self, owner: &AccountId, id: u64) {
        let mut ids = self.owner_index.get(owner).unwrap_or_default();
        if !ids.contains(&id) {
            ids.push(id);
        }
        self.owner_index.insert(owner, &ids);
    }

    fn index_remove(&mut self, owner: &AccountId, id: u64) {
        let mut ids = self.owner_index.get(owner).unwrap_or_default();
        ids.retain(|x| *x != id);
        if ids.is_empty() {
            self.owner_index.remove(owner);
        } else {
            self.owner_index.insert(owner, &ids);
        }
    }

    /// Move NFT ownership (used by NEP-171 transfers and their resolution).
    /// While Live, every pulse/agent key is revoked: keys belong to whoever set them up,
    /// and must not keep heartbeat/spend power over a vault the NFT buyer now owns (H-3).
    pub(crate) fn move_owner(
        &mut self,
        id: u64,
        v: &mut Vault,
        to: &AccountId,
        memo: Option<&str>,
    ) {
        let old = v.owner_id.clone();
        v.owner_id = to.clone();
        let revoked = if v.stored == StoredState::Live {
            self.take_keys(v)
        } else {
            vec![]
        };
        // The guardian was appointed by the previous owner: it goes with the keys. A running
        // pause stays (it only delays; the new owner clears it with a heartbeat).
        if v.stored == StoredState::Live && v.guard.guardian_id.is_some() {
            v.guard.guardian_id = None;
            v.guard.max_pause_s = 0;
            write_guard(id, &v.guard);
        }
        record(
            v,
            id,
            "owner_changed",
            &format!("{old} -> {to}"),
            json!({"token_id": id.to_string(), "old_owner_id": old, "new_owner_id": to, "revoked_keys": revoked}),
        );
        self.vaults.insert(&id, v);
        delete_keys(revoked);
        self.index_remove(&old, id);
        self.index_add(to, id);
        nft::emit_transfer(&old, to, id, memo);
    }
}

pub(crate) fn hydrate(id: u64, mut v: Vault) -> Vault {
    v.guard = read_guard(id);
    v
}

/// One DeleteKey promise per key so a single failure cannot block the others.
fn delete_keys(keys: Vec<PublicKey>) {
    for k in keys {
        Promise::new(env::current_account_id())
            .delete_key(k)
            .detach();
    }
}

/// A tx signed by a function-call key that lives on this contract's own account.
fn signed_by_own_key(pred: &AccountId) -> bool {
    let me = env::current_account_id();
    pred == &me && env::signer_account_id() == me
}

/// Order matters: the first failing rule is the reported reason.
pub(crate) fn policy_check(
    v: &Vault,
    now: u64,
    receiver: &AccountId,
    amount: u128,
) -> Option<&'static str> {
    if v.state_at(now) != VaultState::Alive {
        return Some("vault_not_alive");
    }
    if !v.policy.allowlist.is_empty() && !v.policy.allowlist.contains(receiver) {
        return Some("receiver_not_allowlisted");
    }
    if amount > v.policy.per_tx_max.0 {
        return Some("over_per_tx_max");
    }
    if v.daily_spent.saturating_add(amount) > v.policy.daily_max.0 {
        return Some("over_daily_max");
    }
    if amount > v.balance {
        return Some("insufficient_balance");
    }
    None
}

/// Append to the bounded on-chain log and emit the matching NEP-297 event.
pub(crate) fn record(v: &mut Vault, _id: u64, event: &str, detail: &str, data: serde_json::Value) {
    v.log.push(LogEntry {
        ms: env::block_timestamp_ms(),
        event: event.to_string(),
        detail: truncate(detail, MAX_DETAIL),
    });
    if v.log.len() > MAX_LOG {
        let excess = v.log.len() - MAX_LOG;
        v.log.drain(..excess);
    }
    emit(event, data);
}

/// Exact decimal NEAR string from yoctoNEAR, trailing zeros trimmed ("5.34", "1").
pub(crate) fn fmt_near(yocto: u128) -> String {
    const ONE: u128 = 1_000_000_000_000_000_000_000_000;
    let whole = yocto / ONE;
    let frac = yocto % ONE;
    if frac == 0 {
        return whole.to_string();
    }
    let f = format!("{frac:024}");
    format!("{whole}.{}", f.trim_end_matches('0'))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn promise_ok() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok()
}

pub(crate) fn validate_heirs(heirs: &[Heir]) {
    require!(
        !heirs.is_empty() && heirs.len() <= MAX_HEIRS,
        "1..=10 heirs required"
    );
    let mut sum: u32 = 0;
    for (i, h) in heirs.iter().enumerate() {
        require!(h.bps > 0, "heir bps must be > 0");
        require!(
            !heirs[..i].iter().any(|o| o.account_id == h.account_id),
            "duplicate heir"
        );
        sum += u32::from(h.bps);
    }
    require!(sum == 10_000, "heir bps must sum to 10000");
}

fn validate_policy(p: &Policy) {
    require!(
        p.allowlist.len() <= MAX_ALLOWLIST,
        "allowlist too long (max 10)"
    );
}

fn validate_timing(interval_s: u64, grace: u32) {
    require!(
        (MIN_INTERVAL_S..=MAX_INTERVAL_S).contains(&interval_s),
        "heartbeat_interval_s out of range (10s..10y)"
    );
    require!(grace <= MAX_GRACE, "grace_missed too large");
}

pub(crate) fn view(id: u64, v: &Vault) -> VaultView {
    let now = env::block_timestamp_ms();
    VaultView {
        token_id: id.to_string(),
        owner_id: v.owner_id.clone(),
        state: v.state_at(now),
        heartbeat_interval_s: v.heartbeat_interval_s,
        grace_missed: v.grace_missed,
        last_beat_ms: v.last_beat_ms,
        warning_at_ms: v.warning_at_ms(),
        trigger_at_ms: v.trigger_at_ms(),
        balance: U128(v.balance),
        bounty: U128(v.bounty),
        heirs: v.heirs.clone(),
        foreign: v.foreign.clone(),
        pulse_keys: v.pulse_keys.clone(),
        agent_keys: v.agent_keys.clone(),
        policy: v.policy.clone(),
        daily_spent: U128(v.daily_spent),
        daily_window_start_ms: v.daily_window_start_ms,
        dao_id: v.dao_id.clone(),
        dao_proposal_id: v.dao_proposal_id,
        step: v.step,
        foreign_index: v.foreign_index,
        foreign_inflight: v.foreign_inflight_since_ms.is_some(),
        created_ms: v.created_ms,
        log: v.log.clone(),
        guardian_id: v.guard.guardian_id.clone(),
        max_pause_s: v.guard.max_pause_s,
        paused_until_ms: v.guard.paused_until_ms,
    }
}
