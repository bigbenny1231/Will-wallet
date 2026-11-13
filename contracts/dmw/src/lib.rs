//! Lastword (`dmw`): heartbeat-triggered inheritance vaults, each one a
//! NEP-171 "Will NFT". See SPEC.md §2 for the authoritative description.

use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue, PublicKey,
};
use serde_json::json;

pub mod foreign;
mod nft;
pub mod types;

#[cfg(test)]
mod audit_v2;
#[cfg(test)]
mod audit_v2b;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_v3;

pub use foreign::{EvmArgs, ForeignChain, ForeignPayout, ForeignStatus, SolanaArgs, StepArgs};
pub use types::*;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// `milli` thousandths of a NEAR, in yoctoNEAR (1 milliNEAR = 10^21 yocto).
const fn near(milli: u128) -> u128 {
    milli * 1_000_000_000_000_000_000_000
}

/// Storage deposit moved out of the `create_vault` deposit into the vault's storage account
/// (SPEC §2.3). v2 (L-9): the vault's real storage use is measured on every call; this deposit
/// covers it, the vault balance tops it up when a vault outgrows it, and whatever the vault does
/// not need is returned to the vault balance at settlement (claimable).
pub const STORAGE_FEE: u128 = near(100); // 0.1 NEAR
/// Default poke bounty when `create_vault` omits it.
pub const DEFAULT_BOUNTY: u128 = near(10); // 0.01 NEAR
/// Highest bounty a vault may set (v2, finding B).
pub const MAX_BOUNTY: u128 = near(1000); // 1 NEAR
/// `poke` never pays more than this share of the vault balance (basis points; v2, finding B).
pub const MAX_BOUNTY_BPS: u128 = 1_000; // 10%
/// Smallest `deposit` accepted from anyone but the vault owner (v2, finding D).
pub const MIN_DEPOSIT: u128 = near(10); // 0.01 NEAR
/// Gas allowance of every pulse/agent function-call key (paid by the contract account).
pub const KEY_ALLOWANCE: u128 = near(1000); // 1 NEAR (~90 heartbeats at 10 TGas)
/// The protocol's minimum gas price (yocto per gas). Only for reasoning about the allowance: a key
/// call burns at least its gas at this price from the allowance, whether or not the call succeeds.
/// v2 second review (F2): the allowance is the cost of the key and is never refunded; a contract
/// cannot see the gas of key calls that panicked, so any refund estimate could pay a vault out of
/// the other vaults' NEAR.
pub const KEY_GAS_PRICE: u128 = 100_000_000;
/// Storage an access key takes on the contract account (not visible to `env::storage_usage` in
/// the call that adds it; charged to the vault explicitly).
pub const ACCESS_KEY_STORAGE_BYTES: u64 = 200;
/// Storage left covered when settlement releases the rest of the storage deposit.
pub const STORAGE_RELEASE_HEADROOM_BYTES: u64 = 2_000;
/// During the first hour of step 3 (and of each payout in it) only an operator may supply the
/// chain params of a signature (v2, finding C); afterwards anyone may, so settlement never stalls.
pub const STEP3_OPEN_AFTER_MS: u64 = 60 * 60 * 1000;
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
pub const MAX_HISTORY: usize = 40;
pub const MAX_SPENDS: usize = 24;
pub const MAX_DETAIL: usize = 400;
pub const MIN_INTERVAL_S: u64 = 10;
pub const MAX_INTERVAL_S: u64 = 10 * 365 * 24 * 3600;
pub const MAX_GRACE: u32 = 1000;
pub const DAY_MS: u64 = 86_400_000;
/// A step-3 request older than this is considered lost and may be retried as failed.
pub const FOREIGN_INFLIGHT_TIMEOUT_MS: u64 = 10 * 60 * 1000;

/// `keeper_admin` proposals take effect this long after they are made (v3, H-1): 48 h.
pub const ADMIN_TIMELOCK_MS: u64 = 48 * 60 * 60 * 1000;
/// A Will NFT sale raises the vault timing to at least this interval and grace (v3, L-6), so the
/// seller cannot hand over a vault that is due seconds later.
pub const SALE_MIN_INTERVAL_S: u64 = 86_400;
pub const SALE_MIN_GRACE: u32 = 1;
/// Default and largest page of `get_vaults_for_owner` (v3, L-5).
pub const OWNER_PAGE_DEFAULT: u64 = 50;
pub const OWNER_PAGE_MAX: u64 = 100;

const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(100);
/// v3 (M-2): 10 -> 15 TGas. `on_dao_proposal` reads and writes the vault once (`save_vault_once`).
/// Step 4 attaches 100 + 15 TGas plus ~30 TGas of receipt fees: < 150 TGas of a 300 TGas step.
const GAS_ON_DAO: Gas = Gas::from_tgas(15);
/// v3 (M-2). Budget of the transfer callback: 5 -> 10 TGas. Worst case is the failure path on a
/// maximal vault (~40 KB of borsh: both 40-entry rings full of 400-byte details, 10 heirs with
/// 64-char names, 4 signed payouts). Since v3 that path writes the vault ONCE (`save_vault_once`
/// folds the storage charge into the write instead of a second read + write in
/// `charge_storage`). Measured host gas (storage, logs; the mock does not meter wasm): 2.56 TGas
/// (v2's insert + charge_storage: 4.96 TGas, i.e. v2's 5 TGas was already exceeded before any
/// wasm work). With ~2-3 TGas of wasm (borsh of 40 KB, I-11 measured 3.17 TGas in all on a v1
/// vault) the need is ~5.5 TGas, so 10 TGas leaves ~2x on the worst case.
///
/// Why not more (the review suggested 20): the callers must still fit 300 TGas. Measured on the
/// maximal vault, each heir costs 14.8 TGas of receipt fees (transfer receipt, callback
/// receipt, its data dependency: 0.45 + 4.86 + 9.39) plus the attached callback gas, and step 1
/// itself burns ~4.9 TGas of host gas:
///   step 1 / step 5, 10 heirs: 4.9 + 10 x (14.8 + 10) = 252.9 TGas (+ wasm, < 10) of 300.
///   (15 TGas: 302.9, does not fit; 20 TGas: 352.9.)
///   poke / claim / agent_pay (one transfer): ~29.7 TGas on a maximal vault (+ wasm): callers
///   should attach >= 50 TGas (the keeper uses 60 for poke).
/// `v3_m2_*` tests measure these numbers.
const GAS_ON_TRANSFER: Gas = Gas::from_tgas(10);
/// v3 (M-2): 10 -> 15 TGas. `on_key_added` reads and writes the vault once (`save_vault_once`).
/// The key methods attach 15 TGas plus ~15 TGas of receipt fees: callers attach 100 TGas.
const GAS_ON_KEY: Gas = Gas::from_tgas(15);
const GAS_MARK_BROADCAST_DAO: u64 = 10_000_000_000_000;
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
        standard(standard = "dmw", version = "2.0.0"),
    )
)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub vaults: UnorderedMap<u64, Vault>,
    /// NEP-181 owner index: account -> token ids.
    pub owner_index: LookupMap<AccountId, Vec<u64>>,
    /// Global registry public key -> (token id, gas spent). A key can belong to one vault only,
    /// and only keys registered here (and confirmed added) are ever deleted.
    pub key_index: LookupMap<PublicKey, KeyRecord>,
    pub next_id: u64,
    /// Contract-wide keeper. May re-sign foreign payouts, `mark_broadcast` and drive step 3 for
    /// every vault. Handed over in two steps (`set_keeper` then `accept_keeper`, v3) by the
    /// contract owner or by the keeper itself, so it still works after the contract account is
    /// locked (v2, finding C), and replaceable by the `keeper_admin` after a timelock (v3, H-1).
    pub keeper_id: Option<AccountId>,
    /// Chain Signatures MPC signer (set at init, v2 L-8; replaceable by `keeper_admin`, v3 I-1).
    pub mpc_signer: AccountId,
    /// v3 (H-1): recovery role. Its ONLY powers are timelocked proposals to replace the contract
    /// keeper, the MPC signer or itself. It is never an operator or a keeper.
    pub keeper_admin: Option<AccountId>,
    /// v3: account named by `set_keeper` that has not called `accept_keeper` yet.
    pub pending_keeper: Option<AccountId>,
    /// v3: the one pending `keeper_admin` proposal.
    pub admin_proposal: Option<AdminProposal>,
    /// v3: bumped each time a `keeper_admin` proposal replaces the contract keeper. A payout's
    /// keeper re-sign count (Solana cap) only counts re-signs of the current epoch, so a keeper the
    /// admin installs after a compromise can still re-sign payouts the old keeper used up.
    pub keeper_epoch: u32,
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

/// Checked addition of yoctoNEAR amounts (panics instead of wrapping).
pub(crate) fn add_yocto(a: u128, b: u128) -> u128 {
    a.checked_add(b)
        .unwrap_or_else(|| env::panic_str("amount overflow"))
}

#[near]
impl Contract {
    /// Init. `#[private]`: only the contract account itself can call it, so nobody can front-run
    /// the deployer between deploy and init (v2, finding G; `scripts/near-admin.mjs deploy` sends
    /// DeployContract + `new` in one transaction).
    #[init]
    #[private]
    pub fn new(
        owner_id: AccountId,
        keeper_id: Option<AccountId>,
        mpc_signer: Option<AccountId>,
        keeper_admin: Option<AccountId>,
    ) -> Self {
        let me = env::current_account_id();
        require!(
            keeper_id.as_ref() != Some(&me),
            "keeper cannot be the dmw contract"
        );
        require!(
            keeper_admin.as_ref() != Some(&me),
            "keeper_admin cannot be the dmw contract"
        );
        require_separate_roles(keeper_id.as_ref(), keeper_admin.as_ref());
        Self {
            owner_id,
            vaults: UnorderedMap::new(StorageKey::Vaults),
            owner_index: LookupMap::new(StorageKey::OwnerIndex),
            key_index: LookupMap::new(StorageKey::KeyIndex),
            next_id: 1,
            keeper_id,
            mpc_signer: mpc_signer.unwrap_or_else(|| foreign::DEFAULT_MPC_SIGNER.parse().unwrap()),
            keeper_admin,
            pending_keeper: None,
            admin_proposal: None,
            keeper_epoch: 0,
        }
    }

    // -----------------------------------------------------------------------
    // Vault lifecycle
    // -----------------------------------------------------------------------

    /// Mint a Will NFT to the caller. Deposit = 0.1 NEAR storage deposit + vault balance.
    #[payable]
    pub fn create_vault(
        &mut self,
        heartbeat_interval_s: u64,
        grace_missed: u32,
        heirs: Vec<Heir>,
        policy: Option<Policy>,
        bounty: Option<U128>,
    ) -> U128 {
        let before = env::storage_usage();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= STORAGE_FEE,
            "deposit must be >= 0.1 NEAR (storage)"
        );
        validate_timing(heartbeat_interval_s, grace_missed);
        validate_heirs(&heirs);
        let policy = policy.unwrap_or_default();
        validate_policy(&policy);
        let bounty = bounty.map(|b| b.0).unwrap_or(DEFAULT_BOUNTY);
        validate_bounty(bounty);

        let owner = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let token_id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("token id overflow"));
        let mut vault = Vault {
            owner_id: owner.clone(),
            heartbeat_interval_s,
            grace_missed,
            last_beat_ms: now,
            stored: StoredState::Live,
            balance: deposit - STORAGE_FEE,
            bounty,
            heirs,
            foreign: vec![],
            pulse_keys: vec![],
            agent_keys: vec![],
            policy,
            spends: vec![],
            dao_id: None,
            dao_proposal_id: None,
            step: 0,
            foreign_index: 0,
            foreign_inflight_since_ms: None,
            created_ms: now,
            log: vec![],
            history: vec![],
            log_seq: 0,
            salt: derivation_salt(&owner, token_id),
            keeper_id: None,
            step3_progress_ms: 0,
            storage_bytes: 0,
            storage_deposit: STORAGE_FEE,
            unsplit: 0,
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
        self.charge_storage(token_id, before, true);
        U128(u128::from(token_id))
    }

    /// Add NEAR to a vault's balance. The owner may add any amount; anyone else at least
    /// `MIN_DEPOSIT` (a stranger cannot flood the vault log with dust, finding D).
    #[payable]
    pub fn deposit(&mut self, token_id: TokenRef) -> U128 {
        let before = env::storage_usage();
        let id = token_id.id();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "deposit must be > 0");
        let mut v = self.vault(id);
        let from = env::predecessor_account_id();
        if from != v.owner_id {
            require!(
                amount >= MIN_DEPOSIT,
                "deposits from anyone but the vault owner must be >= 0.01 NEAR"
            );
        }
        credit(&mut v, amount, true);
        let data = json!({"token_id": id.to_string(), "amount": yocto(amount), "from": from});
        record(&mut v, id, "deposit", &yocto(amount), data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, false);
        U128(self.vault(id).balance)
    }

    /// Proof of life. The vault owner directly, with exactly 1 yoctoNEAR (a wallet confirmation,
    /// so a dApp's function-call key on the owner's account cannot beat silently, finding F), or a
    /// pulse key on the contract account (predecessor == contract && signer_pk ∈ pulse_keys),
    /// which cannot attach a deposit and needs none.
    ///
    /// Pause rule (finding F / L-4): an owner beat clears any pause and re-arms it. A pulse-key
    /// beat never ends a pause that is still running (a stolen or stale pulse key cannot re-arm an
    /// agent the guardian disarmed); once the pause has run out it clears the spent pause, which
    /// re-arms the guardian's one pause per cycle.
    #[payable]
    pub fn heartbeat(&mut self, token_id: TokenRef) -> u64 {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        let pred = env::predecessor_account_id();
        let signer_pk = env::signer_account_pk();
        let via_key = signed_by_own_key(&pred) && v.pulse_keys.contains(&signer_pk);
        require!(
            pred == v.owner_id || via_key,
            "unauthorized: not owner or pulse key"
        );
        if !via_key {
            assert_one_yocto();
        }
        require!(v.stored == StoredState::Live, "vault_triggered");
        let now = env::block_timestamp_ms();
        let was = v.state_at(now);
        v.last_beat_ms = now;
        let has_pause = v.guard.paused_at_ms != 0 || v.guard.paused_until_ms != 0;
        let running = v.guard.paused_until_ms > now;
        let clear = has_pause && (!via_key || !running);
        if clear {
            v.guard.paused_at_ms = 0;
            v.guard.paused_until_ms = 0;
            write_guard(id, &v.guard);
        }
        let by = if via_key { "pulse_key" } else { "owner" };
        let data = json!({"token_id": id.to_string(), "by": by, "was": was.as_str(), "next_due_ms": v.warning_at_ms(), "pause_cleared": clear});
        record(&mut v, id, "heartbeat", by, data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, false);
        now
    }

    /// Store a pulse key and add it to the contract account as a function-call key
    /// limited to `heartbeat`. The key's gas allowance is reserved from the vault.
    #[payable]
    pub fn add_pulse_key(&mut self, token_id: TokenRef, public_key: PublicKey) -> Promise {
        self.add_key(token_id.id(), public_key, KeyKind::Pulse)
    }

    /// Same as `add_pulse_key` but the key may only call `agent_pay`.
    #[payable]
    pub fn add_agent_key(&mut self, token_id: TokenRef, public_key: PublicKey) -> Promise {
        self.add_key(token_id.id(), public_key, KeyKind::Agent)
    }

    /// Remove a pulse or agent key from the vault and delete it from the contract account. The
    /// key's gas allowance is not refunded (it is the cost of the key; second review F2).
    #[payable]
    pub fn remove_key(&mut self, token_id: TokenRef, public_key: PublicKey) {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        let n = v.pulse_keys.len() + v.agent_keys.len();
        v.pulse_keys.retain(|k| k != &public_key);
        v.agent_keys.retain(|k| k != &public_key);
        require!(
            v.pulse_keys.len() + v.agent_keys.len() < n,
            "key not in vault"
        );
        self.release_key(&mut v, &public_key);
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
        self.charge_storage(id, before, false);
    }

    /// Agent spend under the vault policy. Authorized only for agent keys on the
    /// contract account. Policy denials are logged and returned, never panicked.
    /// The daily cap is a rolling 24 h window (v2): a cap can never be spent twice within 24 h.
    pub fn agent_pay(
        &mut self,
        token_id: TokenRef,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> AgentPayResult {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        let signer_pk = env::signer_account_pk();
        require!(
            signed_by_own_key(&env::predecessor_account_id()) && v.agent_keys.contains(&signer_pk),
            "unauthorized: not an agent key of this vault"
        );
        require!(amount.0 > 0, "amount must be > 0");
        // A transfer to the contract itself would move vault NEAR into the unallocated pool.
        require!(
            receiver_id != env::current_account_id(),
            "receiver cannot be the dmw contract"
        );
        let now = env::block_timestamp_ms();
        prune_spends(&mut v, now);
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
                    daily_spent: U128(v.spent_in_window(now)),
                    balance: U128(v.balance),
                }
            }
            None => {
                v.balance -= amount.0; // policy_check guarantees amount <= balance
                push_spend(&mut v, now, amount.0);
                let spent = v.spent_in_window(now);
                let data = json!({"token_id": id.to_string(), "receiver_id": receiver_id, "amount": amount, "daily_spent": yocto(spent), "memo": memo});
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
                    daily_spent: U128(spent),
                    balance: U128(v.balance),
                }
            }
        };
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, false);
        res
    }

    #[payable]
    pub fn set_heirs(&mut self, token_id: TokenRef, heirs: Vec<Heir>) {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        validate_heirs(&heirs);
        let data = json!({"token_id": id.to_string(), "heirs": heirs});
        v.heirs = heirs;
        let detail = format!("{} heirs", v.heirs.len());
        record(&mut v, id, "heirs_set", &detail, data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
    }

    #[payable]
    pub fn set_policy(&mut self, token_id: TokenRef, policy: Policy) {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        validate_policy(&policy);
        let data = json!({"token_id": id.to_string(), "policy": policy});
        v.policy = policy;
        record(&mut v, id, "policy_set", "", data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
    }

    /// Replace the foreign payout list. Status is forced to `pending`.
    #[payable]
    pub fn set_foreign_payouts(&mut self, token_id: TokenRef, payouts: Vec<ForeignPayout>) {
        let before = env::storage_usage();
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
                } else {
                    // v3 (review v3 L-4 / prior L-19): a payout that can never be built is refused
                    // here, not discovered at step 3 where it fails for good.
                    require!(
                        foreign::is_solana_address(&p.to),
                        "solana `to` must be a base58 32-byte public key"
                    );
                    require!(
                        p.amount.0 <= u128::from(u64::MAX),
                        "solana amount must fit in u64 lamports"
                    );
                }
                p.status = ForeignStatus::Pending;
                p.signed_tx = None;
                p.tx_hash = None;
                p
            })
            .collect();
        // Per-chain payout limit (Monad: 1, review 2 H-4; Solana: 1, v3 H-1 / L-4: every payout
        // of a chain leaves one derived address, and a Solana transfer has no nonce, so a second
        // landed signature would pay one recipient out of another's funding).
        for c in ForeignChain::ALL {
            let max = c.max_payouts();
            let n = payouts.iter().filter(|p| p.chain == c).count();
            require!(
                n <= max,
                &format!("too many {} payouts (max {max} per vault)", c.as_str())
            );
        }
        let data = json!({"token_id": id.to_string(), "foreign": payouts});
        v.foreign = payouts;
        let detail = format!("{} payouts", v.foreign.len());
        record(&mut v, id, "foreign_set", &detail, data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
    }

    #[payable]
    pub fn set_dao(&mut self, token_id: TokenRef, dao_id: Option<AccountId>) {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        let data = json!({"token_id": id.to_string(), "dao_id": dao_id});
        v.dao_id = dao_id;
        let detail = v.dao_id.as_ref().map(|d| d.to_string()).unwrap_or_default();
        record(&mut v, id, "dao_set", &detail, data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
    }

    #[payable]
    pub fn set_timing(&mut self, token_id: TokenRef, heartbeat_interval_s: u64, grace_missed: u32) {
        let before = env::storage_usage();
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
        self.charge_storage(id, before, true);
    }

    /// Owner, while Alive (not overdue, not paused): change the poke bounty, at most
    /// `MAX_BOUNTY` (v2, finding B). `poke` also caps the payout at 10% of the balance.
    #[payable]
    pub fn set_bounty(&mut self, token_id: TokenRef, bounty: U128) {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        require!(
            v.state_at(env::block_timestamp_ms()) == VaultState::Alive,
            "bounty can only change while the vault is Alive"
        );
        validate_bounty(bounty.0);
        v.bounty = bounty.0;
        let data = json!({"token_id": id.to_string(), "bounty": bounty});
        record(&mut v, id, "bounty_set", &yocto(bounty.0), data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
    }

    /// Owner, while not Triggered: name (or clear, with `null`) a keeper for this vault. It may do
    /// everything the contract keeper may for this vault: drive step 3 in its first hour, re-sign
    /// payouts and `mark_broadcast` (v2, finding C). Cleared when the Will NFT changes hands.
    #[payable]
    pub fn set_vault_keeper(&mut self, token_id: TokenRef, keeper_id: Option<AccountId>) {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        require!(
            keeper_id.as_ref() != Some(&env::current_account_id()),
            "keeper cannot be the dmw contract"
        );
        let data = json!({"token_id": id.to_string(), "keeper_id": keeper_id});
        v.keeper_id = keeper_id;
        let detail = v
            .keeper_id
            .as_ref()
            .map(|k| k.to_string())
            .unwrap_or_else(|| "cleared".into());
        record(&mut v, id, "vault_keeper_set", &detail, data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
    }

    /// Owner, while not Triggered: appoint (or clear, with `guardian_id: null`) a guardian
    /// who may `pause` the vault once per heartbeat cycle for `max_pause_s` (SPEC §2.8).
    /// Changing the guardian does not touch a pause that is already running.
    #[payable]
    pub fn set_guardian(
        &mut self,
        token_id: TokenRef,
        guardian_id: Option<AccountId>,
        max_pause_s: Option<u64>,
    ) {
        let before = env::storage_usage();
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
        self.charge_storage(id, before, true);
    }

    /// Guardian or owner, while Alive/Warning and before the deadline: hold off the trigger
    /// until `now + max_pause_s` (SPEC §2.8). One pause per heartbeat cycle: a second pause
    /// is rejected until a heartbeat lands. While paused the vault reads as `Warning`, so
    /// `agent_pay` is denied. Returns the new effective `trigger_at_ms`.
    #[payable]
    pub fn pause(&mut self, token_id: TokenRef) -> u64 {
        // 1 yocto from the guardian and the owner alike (review 2 M-6): a pause disarms the
        // agent, so a dApp's function-call key must not be able to do it silently.
        assert_one_yocto();
        let before_bytes = env::storage_usage();
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
        self.charge_storage(id, before_bytes, false);
        after
    }

    /// Owner only, exactly 1 yoctoNEAR, while not Triggered: end a running pause now (L-4). A
    /// signed owner call is proof of life, so it also restarts the heartbeat clock (second review):
    /// unpausing can never make the vault due at once. It does NOT re-arm the guardian's pause for
    /// this cycle; only a heartbeat does, so a guardian can never stack pauses through the owner.
    #[payable]
    pub fn unpause(&mut self, token_id: TokenRef) -> u64 {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        self.require_owner_mutable(&v);
        let now = env::block_timestamp_ms();
        require!(v.is_paused(now), "not_paused");
        let previous = v.trigger_at_ms();
        // Ends the pause now, but keeps it on record as spent (paused_until_ms in the past, like a
        // pause that ran out), so clients still read "pause used" until the next heartbeat.
        v.guard.paused_until_ms = now;
        write_guard(id, &v.guard);
        v.last_beat_ms = now;
        let after = v.trigger_at_ms();
        let data = json!({"token_id": id.to_string(), "trigger_at_ms": after, "previous_trigger_at_ms": previous});
        record(&mut v, id, "unpaused", &format!("trigger at {after}"), data);
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
        after
    }

    /// Anyone: move an overdue vault to `Triggered` and earn the bounty, capped at
    /// `MAX_BOUNTY` and at 10% of the balance (v2, finding B).
    pub fn poke(&mut self, token_id: TokenRef) -> U128 {
        let before = env::storage_usage();
        let id = token_id.id();
        let mut v = self.vault(id);
        require!(v.stored == StoredState::Live, "already_triggered");
        let now = env::block_timestamp_ms();
        require!(v.is_due(now), "not_due");
        v.stored = StoredState::Triggered;
        v.step = 1;
        let pay = bounty_payout(v.bounty, v.balance);
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
        self.charge_storage(id, before, false);
        U128(pay)
    }

    /// Anyone: run the current settlement step (SPEC §2.4). Returns the new `step`
    /// (directly, or as the result of the step's callback for steps 3 and 4). In step 3, only an
    /// operator (keeper, vault keeper, vault owner, heir) may supply the chain params of a
    /// signature during the first hour of each payout (v2, finding C).
    pub fn execute_step(
        &mut self,
        token_id: TokenRef,
        args: Option<StepArgs>,
    ) -> PromiseOrValue<u8> {
        let before = env::storage_usage();
        let id = token_id.id();
        let r = self.run_step(id, args);
        self.charge_storage(id, before, false);
        r
    }

    /// Keeper records a relayed foreign tx. Also accepts the DAO ratification call
    /// (`tx_hash == "dao-ratified"` from the vault's DAO), which only logs. v2 (finding E): only
    /// an operator (contract keeper, vault keeper, vault owner, heir) may record a hash.
    pub fn mark_broadcast(&mut self, token_id: TokenRef, index: u32, tx_hash: String) {
        let before = env::storage_usage();
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
            // v3 (L-2): only the first ratification is a key event; repeats go to the routine ring.
            let repeat = v.history.iter().any(|e| e.event == "dao_ratified");
            record_to(
                &mut v,
                "dao_ratified",
                pred.as_ref(),
                json!({"token_id": id.to_string(), "dao_id": pred}),
                repeat,
            );
            self.vaults.insert(&id, &v);
            self.charge_storage(id, before, false);
            return;
        }
        let i = index as usize;
        require!(i < v.foreign.len(), "index out of range");
        let p = &v.foreign[i];
        if p.status == ForeignStatus::Broadcast && p.tx_hash.as_deref() == Some(tx_hash.as_str()) {
            return; // idempotent re-report
        }
        require!(
            self.is_operator(&v, &pred),
            "only the keeper, the vault owner or an heir may mark a payout broadcast"
        );
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
        self.charge_storage(id, before, false);
    }

    /// Current NFT owner withdraws the remaining reserve after settlement.
    pub fn claim(&mut self, token_id: TokenRef) -> U128 {
        let before = env::storage_usage();
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
        self.charge_storage(id, before, false);
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

    /// v3 (L-5): paged. `from_index` (default 0) and `limit` (default 50, at most 100) index the
    /// owner's token list, as in `nft_tokens_for_owner`; old callers that pass only `account_id`
    /// get the first 50.
    pub fn get_vaults_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<VaultView> {
        let from = usize::try_from(from_index.unwrap_or(0)).unwrap_or(usize::MAX);
        let limit = limit.unwrap_or(OWNER_PAGE_DEFAULT).min(OWNER_PAGE_MAX) as usize;
        self.owner_index
            .get(&account_id)
            .unwrap_or_default()
            .into_iter()
            .skip(from)
            .take(limit)
            .filter_map(|id| self.load(id).map(|v| view(id, &v)))
            .collect()
    }

    pub fn get_config(&self) -> serde_json::Value {
        json!({
            "owner_id": self.owner_id,
            "next_id": self.next_id,
            "storage_fee": yocto(STORAGE_FEE),
            "storage_byte_cost": yocto(env::storage_byte_cost().as_yoctonear()),
            "key_allowance": yocto(KEY_ALLOWANCE),
            "reserve_with_dao": yocto(RESERVE_WITH_DAO),
            "reserve_no_dao": yocto(RESERVE_NO_DAO),
            "dao_bond": yocto(DAO_BOND),
            "default_bounty": yocto(DEFAULT_BOUNTY),
            "max_bounty": yocto(MAX_BOUNTY),
            "max_bounty_bps": MAX_BOUNTY_BPS as u64,
            "min_deposit": yocto(MIN_DEPOSIT),
            "mpc_signer": self.mpc_signer,
            "mpc_sign_deposit": yocto(foreign::MPC_SIGN_DEPOSIT.as_yoctonear()),
            "keeper": self.keeper_id,
            "pending_keeper": self.pending_keeper,
            "keeper_admin": self.keeper_admin,
            "admin_timelock_ms": ADMIN_TIMELOCK_MS,
            "admin_proposal": self.admin_proposal.as_ref().map(|p| json!({
                "action": p.action.as_str(),
                "account_id": p.account_id,
                "proposed_ms": p.proposed_ms,
                "eta_ms": p.eta_ms,
            })),
            "keeper_epoch": self.keeper_epoch,
            "max_keeper_solana_resigns": foreign::MAX_KEEPER_SOLANA_RESIGNS,
            "sale_min_interval_s": SALE_MIN_INTERVAL_S,
            "sale_min_grace": SALE_MIN_GRACE,
            "chains": foreign::chain_registry(),
            "min_pause_s": MIN_PAUSE_S,
            "max_pause_s": MAX_PAUSE_S,
            "resign_cooldown_ms": foreign::RESIGN_COOLDOWN_MS,
            "step3_open_after_ms": STEP3_OPEN_AFTER_MS,
        })
    }

    /// v3: the contract owner (while it is a separate account) or the current keeper PROPOSES a
    /// new contract keeper. The named account takes the role only when it calls `accept_keeper`
    /// (two-step: the role can no longer be sent to an account nobody controls, review v3 H-1(4)).
    /// A new call replaces the pending proposal; naming the current keeper cancels it. `null`
    /// clears the role at once (no acceptance needed), except on a locked contract (`owner_id` is
    /// the contract itself), where the keeper may hand over but not leave the role empty.
    /// Exactly 1 yoctoNEAR (second review): a function-call access key cannot do it.
    #[payable]
    pub fn set_keeper(&mut self, account_id: Option<AccountId>) {
        assert_one_yocto();
        let pred = env::predecessor_account_id();
        let me = env::current_account_id();
        require!(
            (pred == self.owner_id && pred != me) || self.keeper_id.as_ref() == Some(&pred),
            "only the contract owner or the current keeper"
        );
        require!(
            account_id.as_ref() != Some(&me),
            "keeper cannot be the dmw contract"
        );
        let Some(next) = account_id else {
            // On a locked contract nobody but the keeper (and, after a timelock, the keeper
            // admin) can appoint a keeper, so the keeper may hand over but not clear the role.
            require!(
                self.owner_id != me,
                "the keeper role cannot be cleared on a locked contract"
            );
            self.keeper_id = None;
            self.pending_keeper = None;
            emit("keeper_set", json!({"keeper": null, "by": pred}));
            return;
        };
        if self.keeper_id.as_ref() == Some(&next) {
            let cancelled = self.pending_keeper.take();
            emit(
                "keeper_proposal_cancelled",
                json!({"pending_keeper": cancelled, "by": pred}),
            );
            return;
        }
        require_separate_roles(Some(&next), self.keeper_admin.as_ref());
        self.pending_keeper = Some(next.clone());
        emit(
            "keeper_proposed",
            json!({"pending_keeper": next, "keeper": self.keeper_id, "by": pred}),
        );
    }

    /// v3: the account named by `set_keeper` takes the contract keeper role. Exactly 1 yoctoNEAR
    /// (a full-access key of the new keeper must sign).
    #[payable]
    pub fn accept_keeper(&mut self) {
        assert_one_yocto();
        let pred = env::predecessor_account_id();
        require!(
            self.pending_keeper.as_ref() == Some(&pred),
            "only the pending keeper may accept"
        );
        require_separate_roles(Some(&pred), self.keeper_admin.as_ref());
        let old = self.keeper_id.replace(pred.clone());
        self.pending_keeper = None;
        emit(
            "keeper_set",
            json!({"keeper": pred, "previous": old, "by": pred}),
        );
    }

    /// v3 (H-1): the keeper admin proposes a new contract keeper (`null` clears the role).
    /// Anyone may execute it with `execute_admin_proposal` after `ADMIN_TIMELOCK_MS` (48 h).
    /// Replaces any pending admin proposal. Exactly 1 yoctoNEAR.
    #[payable]
    pub fn propose_keeper(&mut self, account_id: Option<AccountId>) {
        self.require_keeper_admin();
        require!(
            account_id.as_ref() != Some(&env::current_account_id()),
            "keeper cannot be the dmw contract"
        );
        require_separate_roles(account_id.as_ref(), self.keeper_admin.as_ref());
        self.propose(AdminAction::Keeper, account_id);
    }

    /// v3 (H-1, review v3 I-1): the keeper admin proposes a new Chain Signatures MPC signer.
    /// Timelocked like `propose_keeper`. Exactly 1 yoctoNEAR. Note: a signer with a different root
    /// key derives different foreign addresses; this is for a migration of the same signer.
    #[payable]
    pub fn propose_mpc_signer(&mut self, account_id: AccountId) {
        self.require_keeper_admin();
        require!(
            account_id != env::current_account_id(),
            "mpc signer cannot be the dmw contract"
        );
        self.propose(AdminAction::MpcSigner, Some(account_id));
    }

    /// v3 (H-1): the keeper admin proposes to hand its role to another account (`null` gives it
    /// up). Timelocked like the other admin proposals (it only takes effect through
    /// `execute_admin_proposal` after 48 h, and the admin can cancel it until then). Exactly 1
    /// yoctoNEAR.
    #[payable]
    pub fn set_keeper_admin(&mut self, account_id: Option<AccountId>) {
        self.require_keeper_admin();
        require!(
            account_id.as_ref() != Some(&env::current_account_id()),
            "keeper_admin cannot be the dmw contract"
        );
        require_separate_roles(self.keeper_id.as_ref(), account_id.as_ref());
        require_separate_roles(self.pending_keeper.as_ref(), account_id.as_ref());
        self.propose(AdminAction::KeeperAdmin, account_id);
    }

    /// v3 (H-1): the keeper admin withdraws its pending proposal. Exactly 1 yoctoNEAR.
    #[payable]
    pub fn cancel_admin_proposal(&mut self) {
        self.require_keeper_admin();
        let p = self
            .admin_proposal
            .take()
            .unwrap_or_else(|| env::panic_str("no pending admin proposal"));
        emit(
            "admin_proposal_cancelled",
            json!({"action": p.action.as_str(), "account_id": p.account_id, "by": env::predecessor_account_id()}),
        );
    }

    /// v3 (H-1): anyone carries out the pending admin proposal once its timelock has run out.
    /// A keeper change also drops any pending `set_keeper` handover and starts a new keeper epoch
    /// (fresh Solana re-sign allowance for the new keeper).
    pub fn execute_admin_proposal(&mut self) {
        let now = env::block_timestamp_ms();
        let p = self
            .admin_proposal
            .clone()
            .unwrap_or_else(|| env::panic_str("no pending admin proposal"));
        require!(now >= p.eta_ms, "admin proposal timelock has not passed");
        match p.action {
            AdminAction::Keeper => {
                require_separate_roles(p.account_id.as_ref(), self.keeper_admin.as_ref());
                self.keeper_id = p.account_id.clone();
                self.pending_keeper = None;
                self.keeper_epoch = self.keeper_epoch.saturating_add(1);
            }
            AdminAction::MpcSigner => {
                self.mpc_signer = p
                    .account_id
                    .clone()
                    .unwrap_or_else(|| env::panic_str("mpc signer proposal without account"));
            }
            AdminAction::KeeperAdmin => {
                require_separate_roles(self.keeper_id.as_ref(), p.account_id.as_ref());
                require_separate_roles(self.pending_keeper.as_ref(), p.account_id.as_ref());
                self.keeper_admin = p.account_id.clone();
            }
        }
        self.admin_proposal = None;
        emit(
            "admin_proposal_executed",
            json!({
                "action": p.action.as_str(), "account_id": p.account_id,
                "by": env::predecessor_account_id(), "keeper_epoch": self.keeper_epoch,
            }),
        );
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
        let before = env::storage_usage();
        // Exactly one promise result, and it is a success. Anything else is a failure, and the
        // failure path also deletes the key, in case it does exist.
        let ok = promise_ok();
        let unexpected = env::promise_results_count() != 1;
        let Some(mut v) = self.load(token_id) else {
            return false;
        };
        let old_len = blob_len(&v);
        let pk_str = String::from(&public_key);
        let owner_changed = owner.as_ref().is_some_and(|o| o != &v.owner_id);
        let list_len = match kind {
            KeyKind::Pulse => v.pulse_keys.len(),
            KeyKind::Agent => v.agent_keys.len(),
        };
        // `add_key` checks the cap against confirmed keys only, so concurrent requests could
        // overshoot it; the cap is enforced again here (final audit L-12).
        let over_cap = list_len >= MAX_KEYS_PER_KIND;
        if !ok || v.stored != StoredState::Live || owner_changed || over_cap {
            // AddKey failed, the vault triggered, the Will NFT changed hands, or the kind is full,
            // while the key was being added: the key is deleted right away if it exists. Only when
            // AddKey itself failed (so no key ever existed) does the allowance go back to the vault
            // (final audit L-11). A key that did exist could sign calls until its delete lands, and
            // panicked calls burn allowance gas the contract cannot see: the allowance is the cost of
            // the key (second review F2), so no refund on that path.
            self.key_index.remove(&public_key);
            let refund = if !ok && !unexpected { KEY_ALLOWANCE } else { 0 };
            v.balance = add_yocto(v.balance, refund);
            v.storage_bytes = v.storage_bytes.saturating_sub(ACCESS_KEY_STORAGE_BYTES);
            let (event, why) = if !ok {
                ("key_add_failed", "add key failed")
            } else if owner_changed {
                ("key_add_revoked", "owner changed")
            } else if v.stored != StoredState::Live {
                ("key_add_revoked", "vault triggered")
            } else {
                ("key_add_revoked", "too many keys of this kind")
            };
            let detail = if ok {
                format!("{pk_str} {why}")
            } else {
                pk_str.clone()
            };
            record(
                &mut v,
                token_id,
                event,
                &detail,
                json!({"token_id": token_id.to_string(), "public_key": pk_str, "kind": kind, "reason": why, "allowance_refund": yocto(refund)}),
            );
            self.save_vault_once(token_id, &mut v, old_len, before);
            if ok || unexpected {
                Promise::new(env::current_account_id())
                    .delete_key(public_key)
                    .detach();
            }
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
        self.save_vault_once(token_id, &mut v, old_len, before);
        true
    }

    /// After a NEAR transfer out of a vault: re-credit the vault only when the transfer provably
    /// failed (exactly one promise result, and it is a failure). With any other number of results
    /// nothing is credited: re-crediting without proof would pay twice out of the shared pool.
    #[private]
    pub fn on_transfer_done(
        &mut self,
        token_id: u64,
        receiver_id: AccountId,
        amount: U128,
        kind: String,
    ) -> bool {
        if env::promise_results_count() != 1 {
            env::log_str("on_transfer_done: unexpected promise results; nothing credited");
            return false;
        }
        if env::promise_result_checked(0, 1024).is_ok() {
            return true;
        }
        let before = env::storage_usage();
        if let Some(mut v) = self.load(token_id) {
            let old_len = blob_len(&v);
            // Money that was part of the pre-split balance (an agent spend or a bounty) is split
            // by bps at step 5 when it comes back after step 1. A failed heir or claim transfer is
            // the residual and stays claimable by the NFT owner.
            credit(&mut v, amount.0, kind == "agent_pay" || kind == "bounty");
            if kind == "agent_pay" {
                refund_spend(&mut v, amount.0);
            }
            record(
                &mut v,
                token_id,
                "transfer_failed",
                &format!("{kind} {receiver_id} {}", amount.0),
                json!({"token_id": token_id.to_string(), "receiver_id": receiver_id, "amount": amount, "kind": kind}),
            );
            // One vault write (v3, M-2): this path runs on the GAS_ON_TRANSFER budget.
            self.save_vault_once(token_id, &mut v, old_len, before);
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
        let before = env::storage_usage();
        let result = if env::promise_results_count() == 1 {
            result
        } else {
            Err(near_sdk::PromiseError::Failed)
        };
        let mut v = self.vault(token_id);
        let old_len = blob_len(&v);
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
                // The bond is NOT credited back to the vault. `dao_id` is any account the owner names, and
                // an `Err` here does not prove the bond came back: a contract can accept the deposit
                // (its receipt succeeds, so nothing is refunded) and return a promise that fails, which
                // is what this callback then sees. Crediting the vault in that case paid the bond twice,
                // out of other vaults' NEAR (finding C-2, docs/SECURITY_REVIEW_3.md). When the call
                // really fails, the refund lands in the contract's free balance, as a refunded Sputnik
                // bond already does (M-4).
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
        self.save_vault_once(token_id, &mut v, old_len, before);
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

    /// Owner-only mutators need exactly 1 yoctoNEAR attached (review 2 M-6): a function-call
    /// access key cannot attach a deposit, so only a full-access key (a wallet prompt) can
    /// call them.
    fn require_owner_mutable(&self, v: &Vault) {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == v.owner_id,
            "only the vault owner"
        );
        require!(v.stored == StoredState::Live, "vault_triggered");
    }

    /// v3: the caller is the keeper admin and attached exactly 1 yoctoNEAR.
    fn require_keeper_admin(&self) {
        assert_one_yocto();
        require!(
            self.keeper_admin.as_ref() == Some(&env::predecessor_account_id()),
            "only the keeper admin"
        );
    }

    /// v3: store `action` as the one pending admin proposal, executable after the timelock.
    fn propose(&mut self, action: AdminAction, account_id: Option<AccountId>) {
        let now = env::block_timestamp_ms();
        let eta_ms = now.saturating_add(ADMIN_TIMELOCK_MS);
        let replaced = self.admin_proposal.replace(AdminProposal {
            action,
            account_id: account_id.clone(),
            proposed_ms: now,
            eta_ms,
        });
        emit(
            "admin_proposal",
            json!({
                "action": action.as_str(), "account_id": account_id, "eta_ms": eta_ms,
                "by": env::predecessor_account_id(),
                "replaced": replaced.map(|r| r.action.as_str()),
            }),
        );
    }

    /// Accounts that may act for a vault's settlement beyond the permissionless surface: the
    /// contract owner (while it is not the locked contract itself), the contract keeper, the vault
    /// keeper, the vault owner and every heir (v2, findings C and E).
    pub(crate) fn is_operator(&self, v: &Vault, who: &AccountId) -> bool {
        let me = env::current_account_id();
        if who == &me {
            return false;
        }
        who == &self.owner_id
            || self.keeper_id.as_ref() == Some(who)
            || v.keeper_id.as_ref() == Some(who)
            || who == &v.owner_id
            || v.heirs.iter().any(|h| &h.account_id == who)
    }

    /// The trusted relayers of a vault's settlement: the contract owner (while it is not the
    /// locked contract itself), the contract keeper and the vault keeper. Heirs and the vault owner
    /// are operators but not keepers (second review F1, F4): only a keeper may re-sign a Solana
    /// payout that already has a signature, and only a keeper picks EVM fees beyond the
    /// non-keeper limits.
    pub(crate) fn is_keeper(&self, v: &Vault, who: &AccountId) -> bool {
        let me = env::current_account_id();
        if who == &me {
            return false;
        }
        who == &self.owner_id
            || self.keeper_id.as_ref() == Some(who)
            || v.keeper_id.as_ref() == Some(who)
    }

    /// Attribute the storage change since `before` to vault `id` (v2, L-9). The vault's storage
    /// deposit must cover `storage_bytes x byte cost`; any shortfall moves from the vault balance.
    /// `strict` (owner-initiated growth) panics when the balance cannot cover it; otherwise the
    /// balance covers what it can.
    pub(crate) fn charge_storage(&mut self, id: u64, before: u64, strict: bool) {
        let after = env::storage_usage();
        let Some(mut v) = self.vaults.get(&id) else {
            return;
        };
        if apply_storage(&mut v, i128::from(after) - i128::from(before), strict) {
            // Only fixed-size fields changed, so this write does not change storage use.
            self.vaults.insert(&id, &v);
        }
    }

    /// v3 (M-2): write a vault ONCE with its storage charge folded in, for callbacks that run on a
    /// small static gas budget. `charge_storage` re-reads and re-writes the whole vault (~2 TGas
    /// per write on a maximal vault); here the size change of the vault blob is computed from its
    /// borsh length instead. `old_len` is `blob_len` of the vault as loaded; every storage write
    /// since `before` other than the vault itself must already have happened, and none may follow.
    pub(crate) fn save_vault_once(&mut self, id: u64, v: &mut Vault, old_len: u64, before: u64) {
        let others = i128::from(env::storage_usage()) - i128::from(before);
        let delta = others + i128::from(blob_len(v)) - i128::from(old_len);
        // Only fixed-size fields change here, so the blob length stays `blob_len(v)`.
        apply_storage(v, delta, false);
        self.vaults.insert(&id, v);
        #[cfg(test)]
        assert_eq!(
            i128::from(env::storage_usage()) - i128::from(before),
            delta,
            "save_vault_once: predicted storage change is wrong"
        );
    }

    /// Settlement: hand back to the vault balance the storage deposit the vault no longer needs
    /// (its measured bytes plus headroom for the log rings stay covered).
    fn release_storage(v: &mut Vault) -> u128 {
        let keep = u128::from(
            v.storage_bytes
                .saturating_add(STORAGE_RELEASE_HEADROOM_BYTES),
        )
        .saturating_mul(env::storage_byte_cost().as_yoctonear());
        let excess = v.storage_deposit.saturating_sub(keep);
        v.storage_deposit -= excess;
        v.balance = add_yocto(v.balance, excess);
        excess
    }

    /// Drop a key from the registry and stop charging the vault for its access-key bytes. Nothing
    /// is credited: the gas allowance is the cost of the key (second review F2). Key calls that
    /// panic burn allowance gas the contract never sees, so no refund estimate is safe.
    fn release_key(&mut self, v: &mut Vault, pk: &PublicKey) {
        self.key_index.remove(pk);
        v.storage_bytes = v.storage_bytes.saturating_sub(ACCESS_KEY_STORAGE_BYTES);
    }

    fn add_key(&mut self, id: u64, pk: PublicKey, kind: KeyKind) -> Promise {
        let before = env::storage_usage();
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
        // The access key's own bytes on the contract account (charged here, released on delete).
        v.storage_bytes = v.storage_bytes.saturating_add(ACCESS_KEY_STORAGE_BYTES);
        self.key_index.insert(&pk, &KeyRecord { token_id: id });
        let pk_str = String::from(&pk);
        record(
            &mut v,
            id,
            "key_add_requested",
            &format!("{} {pk_str}", kind.method()),
            json!({"token_id": id.to_string(), "public_key": pk_str, "kind": kind}),
        );
        self.vaults.insert(&id, &v);
        self.charge_storage(id, before, true);
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

    /// The body of `execute_step` (storage is charged by the caller).
    fn run_step(&mut self, id: u64, args: Option<StepArgs>) -> PromiseOrValue<u8> {
        let mut v = self.vault(id);
        require!(v.stored != StoredState::Settled, "already_settled");
        require!(v.stored == StoredState::Triggered, "not_triggered");
        let me = env::current_account_id();
        let now = env::block_timestamp_ms();
        match v.step {
            1 => {
                let reserve = if v.dao_id.is_some() {
                    RESERVE_WITH_DAO
                } else {
                    RESERVE_NO_DAO
                };
                let distributable = v.balance.saturating_sub(reserve);
                let payouts = heir_shares(&v.heirs, distributable);
                let paid_total = payouts.iter().fold(0u128, |t, (_, amt)| add_yocto(t, *amt));
                v.balance -= paid_total; // sum of bps shares of `distributable` <= balance
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
                v.step3_progress_ms = now;
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
                        None,
                        "signature request timed out",
                    ));
                }
                // The chain params (EVM fees, Solana blockhash) shape the signed tx. A junk value
                // from a stranger would leave a useless signature behind, so during the first hour
                // of each payout only an operator may supply them (finding C); after that anyone
                // may, so settlement never depends on one party.
                let pred = env::predecessor_account_id();
                let operator = self.is_operator(&v, &pred);
                let open = now >= v.step3_progress_ms.saturating_add(STEP3_OPEN_AFTER_MS);
                require!(
                    operator || open,
                    "step 3: during the first hour only the keeper, the vault owner or an heir may sign a payout"
                );
                if !operator && v.foreign[idx].chain == ForeignChain::Solana {
                    // v3 (review v3 M-1): a Solana blockhash only ever comes from an operator. A
                    // stranger's stale or junk blockhash would leave a `signed` payout that only a
                    // keeper could re-sign (a second payment risk). After the hour a stranger can
                    // only move settlement on: the payout is recorded `failed` without any
                    // signature, and every operator (heirs included) may re-sign a failed payout
                    // with `resign_foreign` at any time.
                    return PromiseOrValue::Value(self.finish_foreign(
                        id,
                        idx,
                        ForeignStatus::Failed,
                        None,
                        None,
                        "skipped: no operator signed within 1 h; an operator may re-sign it",
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
                    "Lastword: vault {id} settled; heirs: {}",
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
                let released = Self::release_storage(&mut v);
                // Second review F3: everything credited after step 1's split (the released storage
                // deposit, late deposits and refunds) goes to the heirs by bps, like step 1. What
                // stays (the unspent reserve, rounding dust) is claimable by the NFT owner.
                let split = add_yocto(released, v.unsplit).min(v.balance);
                v.unsplit = 0;
                let payouts = heir_shares(&v.heirs, split);
                for (_, amt) in &payouts {
                    v.balance -= *amt; // sum of bps shares of `split` <= split <= balance
                }
                let data = json!({
                    "token_id": id.to_string(), "old_owner_id": old, "new_owner_id": heir,
                    "remaining": yocto(v.balance), "storage_released": yocto(released),
                    "split": payouts.iter().map(|(a, amt)| json!({"account_id": a, "amount": yocto(*amt)})).collect::<Vec<_>>(),
                });
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
                for (acc, amt) in payouts {
                    self.transfer_with_refund(id, &acc, amt, "heir");
                }
                PromiseOrValue::Value(6)
            }
            s => env::panic_str(&format!("invalid step {s}")),
        }
    }

    /// Shared completion for one step-3 payout. Clears the in-flight guard, records status (and
    /// the derived source address the contract signed for), advances `foreign_index`, moves to
    /// step 4 when done. Returns the new step.
    pub(crate) fn finish_foreign(
        &mut self,
        token_id: u64,
        index: usize,
        status: ForeignStatus,
        signed_tx: Option<String>,
        from_address: Option<String>,
        detail: &str,
    ) -> u8 {
        // Storage is charged by the caller (execute_step or the callback).
        let mut v = self.vault(token_id);
        // Ignore stale callbacks (e.g. after a timeout already advanced past it).
        if v.step != 3 || v.foreign_index as usize != index || index >= v.foreign.len() {
            env::log_str("stale foreign callback ignored");
            return v.step;
        }
        v.foreign[index].status = status;
        v.foreign[index].signed_tx = signed_tx;
        if let Some(from) = from_address {
            v.foreign[index].from_address = from;
        }
        v.foreign_inflight_since_ms = None;
        v.foreign_index += 1;
        v.step3_progress_ms = env::block_timestamp_ms();
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

    /// Drain both key lists and release them from the global registry (no allowance refund,
    /// second review F2). Returns the keys to delete.
    fn take_keys(&mut self, v: &mut Vault) -> Vec<PublicKey> {
        let keys: Vec<PublicKey> = v
            .pulse_keys
            .drain(..)
            .chain(v.agent_keys.drain(..))
            .collect();
        for k in &keys {
            self.release_key(v, k);
        }
        keys
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
    ///
    /// While Live the vault starts over for the new owner (v2, finding B; H-3 before): every
    /// pulse/agent key is revoked (unspent allowance back to the vault), the guardian and any
    /// pause, the vault keeper, the DAO, the foreign payouts, the agent policy and its spend
    /// window are cleared, the bounty goes back to the default, the new owner becomes the only
    /// heir, and the heartbeat clock restarts now. Nothing the seller set up survives the sale.
    pub(crate) fn move_owner(
        &mut self,
        id: u64,
        v: &mut Vault,
        to: &AccountId,
        memo: Option<&str>,
    ) {
        let old = v.owner_id.clone();
        v.owner_id = to.clone();
        let live = v.stored == StoredState::Live;
        let revoked = if live { self.take_keys(v) } else { vec![] };
        let mut timing_raised = false;
        if live {
            v.last_beat_ms = env::block_timestamp_ms();
            // v3 (L-6): the seller's timing does not carry over below a safe minimum. A 10 s x 0
            // vault could otherwise be poked 10 s after the sale and settle with no foreign
            // payouts (they are cleared), stranding the derived addresses' balances.
            if v.heartbeat_interval_s < SALE_MIN_INTERVAL_S || v.grace_missed < SALE_MIN_GRACE {
                v.heartbeat_interval_s = v.heartbeat_interval_s.max(SALE_MIN_INTERVAL_S);
                v.grace_missed = v.grace_missed.max(SALE_MIN_GRACE);
                timing_raised = true;
            }
            v.heirs = vec![Heir {
                account_id: to.clone(),
                bps: 10_000,
            }];
            v.foreign = vec![];
            v.dao_id = None;
            v.dao_proposal_id = None;
            v.bounty = DEFAULT_BOUNTY;
            v.policy = Policy::default();
            v.spends = vec![];
            v.keeper_id = None;
            v.guard = Guard::default();
            write_guard(id, &v.guard);
        }
        record(
            v,
            id,
            "owner_changed",
            &format!("{old} -> {to}"),
            json!({
                "token_id": id.to_string(), "old_owner_id": old, "new_owner_id": to,
                "revoked_keys": revoked, "reset": live, "timing_raised": timing_raised,
                "heartbeat_interval_s": v.heartbeat_interval_s, "grace_missed": v.grace_missed,
            }),
        );
        self.vaults.insert(&id, v);
        delete_keys(revoked);
        self.index_remove(&old, id);
        self.index_add(to, id);
        nft::emit_transfer(&old, to, id, memo);
    }
}

/// Each heir's bps share of `amount` (non-zero shares only). bps sum to 10_000, so the shares sum
/// to at most `amount`.
fn heir_shares(heirs: &[Heir], amount: u128) -> Vec<(AccountId, u128)> {
    heirs
        .iter()
        .filter_map(|h| {
            // bps <= 10_000 and amount <= total NEAR supply: no overflow.
            let amt = amount
                .checked_mul(u128::from(h.bps))
                .unwrap_or_else(|| env::panic_str("amount overflow"))
                / 10_000;
            (amt > 0).then(|| (h.account_id.clone(), amt))
        })
        .collect()
}

/// Credit `amount` to the vault balance. `splittable` money that lands after step 1 split the
/// balance (and before settlement) is also counted in `unsplit`, so step 5 splits it (F3).
fn credit(v: &mut Vault, amount: u128, splittable: bool) {
    v.balance = add_yocto(v.balance, amount);
    if splittable && v.stored == StoredState::Triggered && v.step >= 2 {
        v.unsplit = add_yocto(v.unsplit, amount);
    }
}

pub(crate) fn hydrate(id: u64, mut v: Vault) -> Vault {
    v.guard = read_guard(id);
    v
}

/// Per-vault derivation salt: 8 bytes of sha256(random seed || creator || token id), hex. The
/// random seed is unknown before the block, and the creator binds the paths to who made the
/// vault, so nobody can publish a vault's foreign addresses before it exists (v2).
fn derivation_salt(owner: &AccountId, id: u64) -> String {
    let mut buf = env::random_seed();
    buf.extend_from_slice(owner.as_bytes());
    buf.extend_from_slice(&id.to_le_bytes());
    hex::encode(&env::sha256_array(&buf)[..8])
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

/// Bounty actually paid by `poke`: the vault's bounty, capped at `MAX_BOUNTY` and at
/// `MAX_BOUNTY_BPS` of the balance.
pub(crate) fn bounty_payout(bounty: u128, balance: u128) -> u128 {
    let share = balance.saturating_mul(MAX_BOUNTY_BPS) / 10_000;
    bounty.min(MAX_BOUNTY).min(share)
}

/// Drop spends that left the rolling 24 h window.
fn prune_spends(v: &mut Vault, now: u64) {
    v.spends.retain(|s| s.ms.saturating_add(DAY_MS) > now);
}

/// Record an allowed spend. The list is bounded: when full, the two oldest entries merge into
/// one stamped with the newer time, so the merged amount counts at least as long as before (the
/// window can only over-count, never let a cap be spent twice).
fn push_spend(v: &mut Vault, now: u64, amount: u128) {
    if v.spends.len() >= MAX_SPENDS {
        let a = v.spends.remove(0);
        let b = &mut v.spends[0];
        b.amount = U128(add_yocto(a.amount.0, b.amount.0));
    }
    v.spends.push(Spend {
        ms: now,
        amount: U128(amount),
    });
}

/// A failed agent transfer gives the amount back to the window, newest spends first.
fn refund_spend(v: &mut Vault, mut amount: u128) {
    for s in v.spends.iter_mut().rev() {
        if amount == 0 {
            break;
        }
        let take = s.amount.0.min(amount);
        s.amount = U128(s.amount.0 - take);
        amount -= take;
    }
    v.spends.retain(|s| s.amount.0 > 0);
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
    if v.spent_in_window(now).saturating_add(amount) > v.policy.daily_max.0 {
        return Some("over_daily_max");
    }
    if amount > v.balance {
        return Some("insufficient_balance");
    }
    None
}

/// Events that routine traffic produces. They go to the evictable `log` ring; every other event
/// goes to the `history` ring (finding D). v3 (L-2): a failed re-sign changes nothing and an
/// operator can repeat it, so it is routine too.
fn is_routine(event: &str, detail: &str) -> bool {
    matches!(
        event,
        "heartbeat"
            | "deposit"
            | "agent_pay_allowed"
            | "agent_pay_denied"
            | "key_add_requested"
            | "key_added"
            | "key_removed"
            | "key_add_failed"
            | "key_add_revoked"
            | "foreign_resign_failed"
    ) || (event == "transfer_failed" && detail.starts_with("agent_pay "))
}

/// History entries that are never evicted (v3, L-2; `vault_created` since v2). Each happens at
/// most once per vault, so at most 8 of the 40 history slots are pinned.
fn is_pinned(event: &str) -> bool {
    matches!(
        event,
        "vault_created"
            | "triggered"
            | "step_1"
            | "step_2"
            | "step_3"
            | "step_4"
            | "step_5"
            | "settled"
    )
}

/// Append to the right bounded on-chain ring and emit the matching NEP-297 event.
pub(crate) fn record(v: &mut Vault, _id: u64, event: &str, detail: &str, data: serde_json::Value) {
    record_to(v, event, detail, data, is_routine(event, detail));
}

/// `record` with the ring chosen by the caller (`routine`: the evictable `log` ring).
pub(crate) fn record_to(
    v: &mut Vault,
    event: &str,
    detail: &str,
    data: serde_json::Value,
    routine: bool,
) {
    let entry = LogEntry {
        ms: env::block_timestamp_ms(),
        event: event.to_string(),
        detail: truncate(detail, MAX_DETAIL),
        seq: v.log_seq,
    };
    v.log_seq = v.log_seq.saturating_add(1);
    if routine {
        v.log.push(entry);
        if v.log.len() > MAX_LOG {
            let excess = v.log.len() - MAX_LOG;
            v.log.drain(..excess);
        }
    } else {
        v.history.push(entry);
        if v.history.len() > MAX_HISTORY {
            // The oldest entry that is not pinned goes (v3, L-2): operators and the DAO can no
            // longer evict the trigger, the settlement steps or the creation record.
            let at = v
                .history
                .iter()
                .position(|e| !is_pinned(&e.event))
                .unwrap_or(0);
            v.history.remove(at);
        }
    }
    emit(event, data);
}

/// v3 (M-2): the storage accounting of a vault for a storage change of `delta` bytes. The vault's
/// storage deposit must cover `storage_bytes x byte cost`; any shortfall moves from the vault
/// balance. `strict` (owner-initiated growth) panics when the balance cannot cover it; otherwise
/// the balance covers what it can. Touches only fixed-size fields. Returns whether it changed any.
fn apply_storage(v: &mut Vault, delta: i128, strict: bool) -> bool {
    let bytes = if delta >= 0 {
        v.storage_bytes
            .saturating_add(u64::try_from(delta).unwrap_or(u64::MAX))
    } else {
        v.storage_bytes
            .saturating_sub(u64::try_from(-delta).unwrap_or(u64::MAX))
    };
    let need = u128::from(bytes).saturating_mul(env::storage_byte_cost().as_yoctonear());
    let mut changed = bytes != v.storage_bytes;
    v.storage_bytes = bytes;
    if need > v.storage_deposit {
        let short = need - v.storage_deposit;
        if v.balance >= short {
            v.balance -= short;
            v.storage_deposit = add_yocto(v.storage_deposit, short);
        } else {
            require!(
                !strict,
                "vault balance cannot cover the storage this change needs"
            );
            v.storage_deposit = add_yocto(v.storage_deposit, v.balance);
            v.balance = 0;
        }
        changed = true;
    }
    changed
}

/// Length of a vault's stored borsh blob (the raw-slot `guard` is not part of it).
pub(crate) fn blob_len(v: &Vault) -> u64 {
    near_sdk::borsh::to_vec(v)
        .map(|b| b.len() as u64)
        .unwrap_or_else(|_| env::panic_str("vault serialization failed"))
}

/// v3: the keeper and the keeper admin are different accounts, so one leaked key never holds both
/// the keeper's powers and the power to replace the keeper.
fn require_separate_roles(keeper: Option<&AccountId>, admin: Option<&AccountId>) {
    require!(
        keeper.is_none() || keeper != admin,
        "keeper and keeper_admin must be different accounts"
    );
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

/// Exactly one promise result, and it succeeded. Callbacks treat anything else as failure.
pub(crate) fn promise_ok() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok()
}

pub(crate) fn validate_heirs(heirs: &[Heir]) {
    require!(
        !heirs.is_empty() && heirs.len() <= MAX_HEIRS,
        "1..=10 heirs required"
    );
    let me = env::current_account_id();
    let mut sum: u32 = 0;
    for (i, h) in heirs.iter().enumerate() {
        require!(h.bps > 0, "heir bps must be > 0");
        // A share sent to the contract lands in the unallocated pool, and a Will NFT owned by
        // the contract can never be claimed (final audit L-10).
        require!(h.account_id != me, "heir cannot be the dmw contract");
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

fn validate_bounty(b: u128) {
    require!(b <= MAX_BOUNTY, "bounty above the 1 NEAR cap");
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
        daily_spent: U128(v.spent_in_window(now)),
        daily_window_start_ms: v.window_start_ms(now),
        spends: v
            .spends
            .iter()
            .filter(|s| s.ms.saturating_add(DAY_MS) > now)
            .cloned()
            .collect(),
        dao_id: v.dao_id.clone(),
        dao_proposal_id: v.dao_proposal_id,
        step: v.step,
        foreign_index: v.foreign_index,
        foreign_inflight: v.foreign_inflight_since_ms.is_some(),
        created_ms: v.created_ms,
        log: v.log(),
        guardian_id: v.guard.guardian_id.clone(),
        max_pause_s: v.guard.max_pause_s,
        paused_until_ms: v.guard.paused_until_ms,
        derivation_paths: v.paths(id),
        keeper_id: v.keeper_id.clone(),
        storage_bytes: v.storage_bytes,
        storage_deposit: U128(v.storage_deposit),
    }
}
