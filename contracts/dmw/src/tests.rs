//! Unit tests (SPEC §2.6) using `near_sdk::testing_env!`.

use super::*;
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};

const NEAR1: u128 = 1_000_000_000_000_000_000_000_000;
const T0: u64 = 1_700_000_000_000; // ms

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract_id() -> AccountId {
    acc("dmw.testnet")
}
fn owner() -> AccountId {
    acc("alice.testnet")
}
fn pk(n: u8) -> PublicKey {
    let mut bytes = vec![0u8];
    bytes.extend([n; 32]);
    PublicKey::try_from(bytes).unwrap()
}

struct Ctx {
    now_ms: u64,
    pred: AccountId,
    signer: AccountId,
    signer_pk: PublicKey,
    deposit: u128,
}

impl Ctx {
    fn new() -> Self {
        Self { now_ms: T0, pred: owner(), signer: owner(), signer_pk: pk(200), deposit: 0 }
    }
    fn builder(&self) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(self.pred.clone())
            .signer_account_id(self.signer.clone())
            .signer_account_pk(self.signer_pk.clone())
            .block_timestamp(self.now_ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(self.deposit))
            .account_balance(NearToken::from_near(1000));
        b
    }
    fn set(&self) {
        testing_env!(self.builder().build());
    }
    fn set_with_result(&self, r: PromiseResult) {
        testing_env!(
            self.builder().build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![r],
        );
    }
    fn by(mut self, a: &str) -> Self {
        self.pred = acc(a);
        self.signer = acc(a);
        self
    }
    /// A tx signed by a function-call key on the contract account.
    fn key(mut self, k: PublicKey) -> Self {
        self.pred = contract_id();
        self.signer = contract_id();
        self.signer_pk = k;
        self
    }
    fn at(mut self, ms: u64) -> Self {
        self.now_ms = ms;
        self
    }
    fn dep(mut self, d: u128) -> Self {
        self.deposit = d;
        self
    }
}

fn heirs2() -> Vec<Heir> {
    vec![
        Heir { account_id: acc("sarah.testnet"), bps: 6000 },
        Heir { account_id: acc("tom.testnet"), bps: 4000 },
    ]
}

fn policy() -> Policy {
    Policy {
        per_tx_max: U128(NEAR1),
        daily_max: U128(3 * NEAR1 / 2),
        allowlist: vec![acc("api.provider.testnet")],
    }
}

/// Contract + vault 1 (interval 20 s, grace 1, 10.1 NEAR deposit => 10 NEAR balance).
fn setup() -> Contract {
    Ctx::new().set();
    let mut c = Contract::new(acc("deployer.testnet"));
    Ctx::new().dep(10 * NEAR1 + STORAGE_FEE).set();
    let id = c.create_vault(20, 1, heirs2(), Some(policy()), Some(U128(NEAR1 / 100)));
    assert_eq!(id.0, 1);
    c
}

fn confirm_key(c: &mut Contract, k: PublicKey, kind: KeyKind) {
    Ctx::new().by("dmw.testnet").set_with_result(PromiseResult::Successful(vec![]));
    assert!(c.on_key_added(1, k, kind));
}

fn with_agent_key(c: &mut Contract) {
    Ctx::new().set();
    let _ = c.add_agent_key(1.into(), pk(2));
    confirm_key(c, pk(2), KeyKind::Agent);
}

fn v(c: &Contract) -> Vault {
    c.vaults.get(&1).unwrap()
}

fn step_value(r: PromiseOrValue<u8>) -> u8 {
    match r {
        PromiseOrValue::Value(s) => s,
        PromiseOrValue::Promise(_) => panic!("expected value"),
    }
}

// ---------------------------------------------------------------- state machine

#[test]
fn create_vault_mints_and_sets_balance() {
    let c = setup();
    let vault = v(&c);
    assert_eq!(vault.balance, 10 * NEAR1);
    assert_eq!(vault.owner_id, owner());
    assert_eq!(vault.last_beat_ms, T0);
    assert_eq!(c.nft_total_supply().0, 1);
    assert_eq!(c.nft_supply_for_owner(owner()).0, 1);
    assert_eq!(c.nft_token("1".into()).unwrap().owner_id, owner());
    assert!(get_logs().iter().any(|l| l.contains("\"standard\":\"nep171\"") && l.contains("nft_mint")));
}

#[test]
#[should_panic(expected = "deposit must be >= 0.1 NEAR")]
fn create_vault_requires_storage_deposit() {
    Ctx::new().set();
    let mut c = Contract::new(acc("deployer.testnet"));
    Ctx::new().dep(STORAGE_FEE - 1).set();
    c.create_vault(20, 1, heirs2(), None, None);
}

#[test]
fn state_derivation_boundaries() {
    let c = setup();
    let vault = v(&c);
    // interval 20 s, grace 1 => warning at +20 s, trigger at +40 s
    assert_eq!(vault.state_at(T0), VaultState::Alive);
    assert_eq!(vault.state_at(T0 + 19_999), VaultState::Alive);
    assert_eq!(vault.state_at(T0 + 20_000), VaultState::Warning);
    assert_eq!(vault.state_at(T0 + 39_999), VaultState::Warning);
    assert!(!vault.is_due(T0 + 39_999));
    assert!(vault.is_due(T0 + 40_000));
    // Warning stays derived until poke stores Triggered.
    assert_eq!(vault.state_at(T0 + 1_000_000), VaultState::Warning);
    Ctx::new().at(T0 + 20_000).set();
    let view = c.get_vault(1.into()).unwrap();
    assert_eq!(view.state, VaultState::Warning);
    assert_eq!(view.warning_at_ms, T0 + 20_000);
    assert_eq!(view.trigger_at_ms, T0 + 40_000);
}

#[test]
fn token_ref_accepts_number_and_string() {
    let a: TokenRef = serde_json::from_str("7").unwrap();
    let b: TokenRef = serde_json::from_str("\"7\"").unwrap();
    assert_eq!(a.id(), 7);
    assert_eq!(b.id(), 7);
}

#[test]
fn heartbeat_by_owner_resets_clock() {
    let mut c = setup();
    Ctx::new().at(T0 + 30_000).set();
    c.heartbeat(1.into());
    let vault = v(&c);
    assert_eq!(vault.last_beat_ms, T0 + 30_000);
    assert_eq!(vault.state_at(T0 + 49_999), VaultState::Alive);
    assert!(get_logs().iter().any(|l| l.contains("\"standard\":\"dmw\"") && l.contains("\"event\":\"heartbeat\"")));
}

#[test]
fn heartbeat_by_pulse_key() {
    let mut c = setup();
    Ctx::new().set();
    let _ = c.add_pulse_key(1.into(), pk(1));
    confirm_key(&mut c, pk(1), KeyKind::Pulse);
    assert_eq!(v(&c).pulse_keys, vec![pk(1)]);
    Ctx::new().key(pk(1)).at(T0 + 5_000).set();
    c.heartbeat(1.into());
    assert_eq!(v(&c).last_beat_ms, T0 + 5_000);
}

#[test]
#[should_panic(expected = "unauthorized")]
fn heartbeat_rejects_unknown_key() {
    let mut c = setup();
    Ctx::new().key(pk(9)).set();
    c.heartbeat(1.into());
}

#[test]
#[should_panic(expected = "unauthorized")]
fn heartbeat_rejects_stranger() {
    let mut c = setup();
    Ctx::new().by("mallory.testnet").set();
    c.heartbeat(1.into());
}

#[test]
#[should_panic(expected = "vault_triggered")]
fn heartbeat_rejected_once_triggered() {
    let mut c = setup();
    Ctx::new().by("bob.testnet").at(T0 + 40_000).set();
    c.poke(1.into());
    Ctx::new().at(T0 + 41_000).set();
    c.heartbeat(1.into());
}

// ---------------------------------------------------------------- keys

#[test]
fn add_key_reserves_allowance_and_failure_refunds() {
    let mut c = setup();
    Ctx::new().set();
    let _ = c.add_pulse_key(1.into(), pk(1));
    assert_eq!(v(&c).balance, 10 * NEAR1 - KEY_ALLOWANCE);
    assert!(v(&c).pulse_keys.is_empty(), "not usable until AddKey confirmed");
    Ctx::new().by("dmw.testnet").set_with_result(PromiseResult::Failed);
    assert!(!c.on_key_added(1, pk(1), KeyKind::Pulse));
    assert_eq!(v(&c).balance, 10 * NEAR1);
    assert!(!c.key_index.contains_key(&pk(1)));
}

#[test]
#[should_panic(expected = "public key already registered")]
fn key_cannot_be_registered_twice() {
    let mut c = setup();
    Ctx::new().set();
    let _ = c.add_pulse_key(1.into(), pk(1));
    let _ = c.add_agent_key(1.into(), pk(1));
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn only_owner_adds_keys() {
    let mut c = setup();
    Ctx::new().by("mallory.testnet").set();
    let _ = c.add_pulse_key(1.into(), pk(1));
}

#[test]
fn remove_key_clears_vault_and_registry() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().set();
    c.remove_key(1.into(), pk(2));
    assert!(v(&c).agent_keys.is_empty());
    assert!(!c.key_index.contains_key(&pk(2)));
}

// ---------------------------------------------------------------- agent policy

#[test]
fn agent_pay_allowed() {
    let mut c = setup();
    with_agent_key(&mut c);
    let before = v(&c).balance;
    Ctx::new().key(pk(2)).set();
    let r = c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1 / 2), Some("gpu".into()));
    assert!(r.allowed);
    assert_eq!(r.reason, None);
    assert_eq!(v(&c).balance, before - NEAR1 / 2);
    assert_eq!(v(&c).daily_spent, NEAR1 / 2);
    assert_eq!(v(&c).log.last().unwrap().event, "agent_pay_allowed");
}

fn deny(c: &mut Contract, receiver: &str, amount: u128, now: u64) -> AgentPayResult {
    let before = v(c).balance;
    Ctx::new().key(pk(2)).at(now).set();
    let r = c.agent_pay(1.into(), acc(receiver), U128(amount), None);
    assert!(!r.allowed);
    assert_eq!(v(c).balance, before, "denied call must not move funds");
    assert_eq!(v(c).log.last().unwrap().event, "agent_pay_denied");
    assert!(get_logs().iter().any(|l| l.contains("agent_pay_denied")));
    r
}

#[test]
fn agent_pay_denied_over_per_tx_max() {
    let mut c = setup();
    with_agent_key(&mut c);
    let r = deny(&mut c, "api.provider.testnet", NEAR1 + 1, T0);
    assert_eq!(r.reason.as_deref(), Some("over_per_tx_max"));
}

#[test]
fn agent_pay_denied_over_daily_max() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().key(pk(2)).set();
    assert!(c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1), None).allowed);
    let r = deny(&mut c, "api.provider.testnet", NEAR1, T0 + 1000);
    assert_eq!(r.reason.as_deref(), Some("over_daily_max"));
}

#[test]
fn agent_pay_denied_receiver_not_allowlisted() {
    let mut c = setup();
    with_agent_key(&mut c);
    let r = deny(&mut c, "evil.testnet", 1, T0);
    assert_eq!(r.reason.as_deref(), Some("receiver_not_allowlisted"));
}

#[test]
fn agent_pay_denied_vault_not_alive() {
    let mut c = setup();
    with_agent_key(&mut c);
    // Warning already disarms the agent.
    let r = deny(&mut c, "api.provider.testnet", 1, T0 + 20_000);
    assert_eq!(r.reason.as_deref(), Some("vault_not_alive"));
}

#[test]
fn agent_pay_denied_insufficient_balance() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().set();
    c.set_policy(1.into(), Policy { per_tx_max: U128(100 * NEAR1), daily_max: U128(100 * NEAR1), allowlist: vec![] });
    let r = deny(&mut c, "anyone.testnet", 20 * NEAR1, T0);
    assert_eq!(r.reason.as_deref(), Some("insufficient_balance"));
}

#[test]
fn agent_pay_daily_window_resets() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().key(pk(2)).set();
    assert!(c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1), None).allowed);
    // keep the vault alive across the day
    Ctx::new().at(T0 + DAY_MS - 10).set();
    c.heartbeat(1.into());
    let r = deny(&mut c, "api.provider.testnet", NEAR1, T0 + DAY_MS - 5);
    assert_eq!(r.reason.as_deref(), Some("over_daily_max"));
    Ctx::new().key(pk(2)).at(T0 + DAY_MS).set();
    let r = c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1), None);
    assert!(r.allowed);
    assert_eq!(r.daily_spent.0, NEAR1);
    assert_eq!(v(&c).daily_window_start_ms, T0 + DAY_MS);
}

#[test]
#[should_panic(expected = "unauthorized: not an agent key")]
fn agent_pay_requires_agent_key() {
    let mut c = setup();
    with_agent_key(&mut c);
    // the owner calling directly is NOT an agent key
    Ctx::new().set();
    c.agent_pay(1.into(), acc("api.provider.testnet"), U128(1), None);
}

#[test]
fn failed_agent_transfer_is_recredited() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().key(pk(2)).set();
    assert!(c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1), None).allowed);
    Ctx::new().by("dmw.testnet").set_with_result(PromiseResult::Failed);
    assert!(!c.on_transfer_done(1, acc("api.provider.testnet"), U128(NEAR1), "agent_pay".into()));
    assert_eq!(v(&c).balance, 10 * NEAR1 - KEY_ALLOWANCE);
    assert_eq!(v(&c).daily_spent, 0);
}

// ---------------------------------------------------------------- poke / bounty

#[test]
#[should_panic(expected = "not_due")]
fn poke_not_due() {
    let mut c = setup();
    Ctx::new().by("bob.testnet").at(T0 + 39_999).set();
    c.poke(1.into());
}

#[test]
fn poke_due_pays_bounty_and_triggers() {
    let mut c = setup();
    Ctx::new().by("bob.testnet").at(T0 + 40_000).set();
    let paid = c.poke(1.into());
    assert_eq!(paid.0, NEAR1 / 100);
    let vault = v(&c);
    assert_eq!(vault.stored, StoredState::Triggered);
    assert_eq!(vault.step, 1);
    assert_eq!(vault.balance, 10 * NEAR1 - NEAR1 / 100);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"triggered\"") && l.contains("bob.testnet")));
}

#[test]
#[should_panic(expected = "already_triggered")]
fn poke_twice_panics() {
    let mut c = setup();
    Ctx::new().by("bob.testnet").at(T0 + 40_000).set();
    c.poke(1.into());
    c.poke(1.into());
}

// ---------------------------------------------------------------- settlement

fn trigger(c: &mut Contract) {
    Ctx::new().by("bob.testnet").at(T0 + 40_000).set();
    c.poke(1.into());
}

#[test]
fn step_ordering_1_to_6_with_stub() {
    let mut c = setup();
    Ctx::new().set();
    let _ = c.add_pulse_key(1.into(), pk(1));
    confirm_key(&mut c, pk(1), KeyKind::Pulse);
    with_agent_key(&mut c);
    Ctx::new().set();
    c.set_foreign_payouts(
        1.into(),
        vec![ForeignPayout {
            chain: ForeignChain::Base,
            to: format!("0x{}", "ab".repeat(20)),
            amount: U128(1_000_000_000_000_000),
            from_address: String::new(),
            status: ForeignStatus::Signed, // forced back to pending
            signed_tx: Some("junk".into()),
            tx_hash: None,
        }],
    );
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Pending);
    assert_eq!(v(&c).foreign[0].signed_tx, None);
    trigger(&mut c);
    let bal = v(&c).balance; // 10 - 0.5 (2 keys) - 0.01 bounty

    // step 1: heirs paid by bps, 0.1 NEAR reserve kept (no DAO)
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    assert_eq!(step_value(c.execute_step(1.into(), None)), 2);
    let dist = bal - RESERVE_NO_DAO;
    let paid = dist * 6000 / 10_000 + dist * 4000 / 10_000;
    assert_eq!(v(&c).balance, bal - paid);
    assert!(v(&c).balance >= RESERVE_NO_DAO);

    // step 2: keys deleted from vault + registry
    assert_eq!(step_value(c.execute_step(1.into(), None)), 3);
    assert!(v(&c).pulse_keys.is_empty() && v(&c).agent_keys.is_empty());
    assert!(!c.key_index.contains_key(&pk(1)) && !c.key_index.contains_key(&pk(2)));

    // step 3: one payout -> promise (stub), guard set
    match c.execute_step(1.into(), None) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(_) => panic!("expected promise"),
    }
    assert!(v(&c).foreign_inflight_since_ms.is_some());
    // re-entry while in flight does nothing
    assert_eq!(step_value(c.execute_step(1.into(), None)), 3);
    assert_eq!(v(&c).foreign_index, 0);
    // stub callback
    Ctx::new().by("dmw.testnet").at(T0 + 42_000).set();
    let s = c.on_foreign_signed(1, 0, Ok(serde_json::json!({"stub": true})));
    assert_eq!(s, 4);
    let vault = v(&c);
    assert_eq!(vault.foreign[0].status, ForeignStatus::Failed);
    assert_eq!(vault.foreign_index, 1);
    assert!(vault.foreign_inflight_since_ms.is_none());
    assert!(vault.log.iter().any(|l| l.detail.contains("chainsig not wired yet")));

    // step 4: no DAO -> skipped
    Ctx::new().by("keeper.testnet").at(T0 + 43_000).set();
    assert_eq!(step_value(c.execute_step(1.into(), None)), 5);
    // step 5: NFT to primary heir, Settled
    assert_eq!(step_value(c.execute_step(1.into(), None)), 6);
    let vault = v(&c);
    assert_eq!(vault.stored, StoredState::Settled);
    assert_eq!(vault.owner_id, acc("sarah.testnet"));
    assert_eq!(c.nft_token("1".into()).unwrap().owner_id, acc("sarah.testnet"));
    assert_eq!(c.nft_supply_for_owner(owner()).0, 0);
    assert_eq!(c.nft_supply_for_owner(acc("sarah.testnet")).0, 1);
    let events: Vec<_> = vault.log.iter().map(|l| l.event.as_str()).collect();
    let pos = |e: &str| events.iter().position(|x| *x == e).unwrap();
    assert!(pos("triggered") < pos("step_1"));
    assert!(pos("step_1") < pos("step_2"));
    assert!(pos("step_2") < pos("step_3"));
    assert!(pos("step_3") < pos("step_4"));
    assert!(pos("step_4") < pos("step_5"));
    assert!(pos("step_5") < pos("settled"));
}

#[test]
fn execute_step_twice_does_not_double_pay() {
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    assert_eq!(step_value(c.execute_step(1.into(), None)), 2);
    let after_first = v(&c).balance;
    // second call runs step 2 (keys), not step 1 again
    assert_eq!(step_value(c.execute_step(1.into(), None)), 3);
    assert_eq!(v(&c).balance, after_first);
    assert_eq!(v(&c).log.iter().filter(|l| l.event == "step_1").count(), 1);
}

#[test]
fn step3_without_payouts_goes_to_4() {
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), None);
    let _ = c.execute_step(1.into(), None);
    // no foreign payouts: step 3 goes straight to 4
    assert_eq!(step_value(c.execute_step(1.into(), None)), 4);
}

#[test]
fn step3_inflight_timeout_fails_payout_and_ignores_late_callback() {
    let mut c = setup();
    Ctx::new().set();
    c.set_foreign_payouts(1.into(), vec![ForeignPayout {
        chain: ForeignChain::Solana, to: "11111111111111111111111111111111".into(), amount: U128(5),
        from_address: String::new(), status: ForeignStatus::Pending, signed_tx: None, tx_hash: None,
    }]);
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), None);
    let _ = c.execute_step(1.into(), None);
    let _ = c.execute_step(1.into(), None); // in flight
    Ctx::new().by("keeper.testnet").at(T0 + 41_000 + FOREIGN_INFLIGHT_TIMEOUT_MS).set();
    assert_eq!(step_value(c.execute_step(1.into(), None)), 4);
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Failed);
    // a late callback is ignored
    Ctx::new().by("dmw.testnet").set();
    assert_eq!(c.on_foreign_signed(1, 0, Ok(serde_json::json!({}))), 4);
    assert_eq!(v(&c).foreign_index, 1);
}

#[test]
fn step1_keeps_dao_reserve_and_step4_proposes() {
    let mut c = setup();
    Ctx::new().set();
    c.set_dao(1.into(), Some(acc("estate.sputnik-v2.testnet")));
    trigger(&mut c);
    let bal = v(&c).balance;
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), None);
    let dist = bal - RESERVE_WITH_DAO;
    assert_eq!(v(&c).balance, bal - (dist * 6000 / 10_000 + dist * 4000 / 10_000));
    assert!(v(&c).balance >= RESERVE_WITH_DAO);
    let _ = c.execute_step(1.into(), None);
    let _ = c.execute_step(1.into(), None); // step 3, no payouts
    let before = v(&c).balance;
    match c.execute_step(1.into(), None) {
        PromiseOrValue::Promise(_) => {}
        _ => panic!("expected add_proposal promise"),
    }
    assert_eq!(v(&c).step, 5);
    assert_eq!(v(&c).balance, before - DAO_BOND);
    // callback stores the id
    Ctx::new().by("dmw.testnet").set();
    assert_eq!(c.on_dao_proposal(1, Ok(7)), 5);
    assert_eq!(v(&c).dao_proposal_id, Some(7));
    // failure path re-credits the bond and continues
    assert_eq!(c.on_dao_proposal(1, Err(near_sdk::PromiseError::Failed)), 5);
    assert_eq!(v(&c).balance, before);
    // the DAO may ratify via mark_broadcast
    Ctx::new().by("estate.sputnik-v2.testnet").set();
    c.mark_broadcast(1.into(), 0, "dao-ratified".into());
    assert_eq!(v(&c).log.last().unwrap().event, "dao_ratified");
}

#[test]
#[should_panic(expected = "not_triggered")]
fn execute_step_requires_trigger() {
    let mut c = setup();
    Ctx::new().by("keeper.testnet").set();
    let _ = c.execute_step(1.into(), None);
}

#[test]
#[should_panic(expected = "already_settled")]
fn execute_step_after_settled_panics() {
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    for _ in 0..5 {
        let _ = c.execute_step(1.into(), None);
    }
    let _ = c.execute_step(1.into(), None);
}

#[test]
fn claim_by_heir_after_settled() {
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    for _ in 0..5 {
        let _ = c.execute_step(1.into(), None);
    }
    let remaining = v(&c).balance;
    assert!(remaining > 0);
    Ctx::new().by("sarah.testnet").at(T0 + 42_000).set();
    assert_eq!(c.claim(1.into()).0, remaining);
    assert_eq!(v(&c).balance, 0);
}

#[test]
#[should_panic(expected = "only the will nft owner can claim")]
fn claim_rejects_non_owner() {
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    for _ in 0..5 {
        let _ = c.execute_step(1.into(), None);
    }
    Ctx::new().by("tom.testnet").set();
    c.claim(1.into());
}

#[test]
#[should_panic(expected = "vault_triggered")]
fn owner_mutators_rejected_once_triggered() {
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().at(T0 + 41_000).set();
    c.set_heirs(1.into(), heirs2());
}

#[test]
fn mark_broadcast_requires_signed() {
    let mut c = setup();
    Ctx::new().set();
    c.set_foreign_payouts(1.into(), vec![ForeignPayout {
        chain: ForeignChain::Base, to: format!("0x{}", "cd".repeat(20)), amount: U128(1),
        from_address: String::new(), status: ForeignStatus::Pending, signed_tx: None, tx_hash: None,
    }]);
    // simulate a signed payout
    let mut vault = v(&c);
    vault.foreign[0].status = ForeignStatus::Signed;
    c.vaults.insert(&1, &vault);
    Ctx::new().by("keeper.testnet").set();
    c.mark_broadcast(1.into(), 0, "0xhash".into());
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Broadcast);
    assert_eq!(v(&c).foreign[0].tx_hash.as_deref(), Some("0xhash"));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.mark_broadcast(1.into(), 0, "0xother".into());
    }));
    assert!(r.is_err(), "cannot overwrite a broadcast hash");
}

// ---------------------------------------------------------------- heirs bps

#[test]
fn heir_bps_validation() {
    let bad: Vec<Vec<Heir>> = vec![
        vec![],
        vec![Heir { account_id: acc("a.testnet"), bps: 9999 }],
        vec![Heir { account_id: acc("a.testnet"), bps: 10_000 }, Heir { account_id: acc("b.testnet"), bps: 0 }],
        vec![Heir { account_id: acc("a.testnet"), bps: 5000 }, Heir { account_id: acc("a.testnet"), bps: 5000 }],
        (0..11).map(|i| Heir { account_id: acc(&format!("h{i}.testnet")), bps: 1 }).collect(),
    ];
    for heirs in bad {
        Ctx::new().set();
        let r = std::panic::catch_unwind(|| validate_heirs(&heirs));
        assert!(r.is_err(), "should reject {heirs:?}");
    }
    validate_heirs(&heirs2());
    validate_heirs(&[Heir { account_id: acc("a.testnet"), bps: 10_000 }]);
}

#[test]
fn primary_heir_highest_bps_first_on_tie() {
    let mut c = setup();
    Ctx::new().set();
    c.set_heirs(1.into(), vec![
        Heir { account_id: acc("x.testnet"), bps: 2000 },
        Heir { account_id: acc("y.testnet"), bps: 4000 },
        Heir { account_id: acc("z.testnet"), bps: 4000 },
    ]);
    assert_eq!(v(&c).primary_heir(), acc("y.testnet"));
}

// ---------------------------------------------------------------- NFT rules

#[test]
fn nft_transfer_by_owner_while_alive_and_warning() {
    let mut c = setup();
    Ctx::new().dep(1).set();
    c.nft_transfer(acc("bob.testnet"), "1".into(), None, None);
    assert_eq!(v(&c).owner_id, acc("bob.testnet"));
    assert_eq!(c.nft_supply_for_owner(owner()).0, 0);
    assert_eq!(c.get_vaults_for_owner(acc("bob.testnet")).len(), 1);
    // the new owner can transfer during Warning
    Ctx::new().by("bob.testnet").dep(1).at(T0 + 25_000).set();
    c.nft_transfer(owner(), "1".into(), None, Some("back".into()));
    assert_eq!(v(&c).owner_id, owner());
    assert!(get_logs().iter().any(|l| l.contains("nft_transfer")));
}

#[test]
#[should_panic(expected = "only the will nft owner can transfer")]
fn nft_transfer_rejects_non_owner() {
    let mut c = setup();
    Ctx::new().by("mallory.testnet").dep(1).set();
    c.nft_transfer(acc("mallory.testnet"), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "will nft is locked once triggered")]
fn nft_transfer_locked_when_triggered() {
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().dep(1).at(T0 + 41_000).set();
    c.nft_transfer(acc("bob.testnet"), "1".into(), None, None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn nft_transfer_requires_one_yocto() {
    let mut c = setup();
    Ctx::new().set();
    c.nft_transfer(acc("bob.testnet"), "1".into(), None, None);
}

#[test]
fn nft_transfer_call_reverts_when_receiver_returns_true() {
    let mut c = setup();
    Ctx::new().dep(1).set();
    let _ = c.nft_transfer_call(acc("market.testnet"), "1".into(), None, None, "".into());
    assert_eq!(v(&c).owner_id, acc("market.testnet"));
    Ctx::new().by("dmw.testnet").set_with_result(PromiseResult::Successful(b"true".to_vec()));
    assert!(!c.nft_resolve_transfer(owner(), acc("market.testnet"), "1".into(), None));
    assert_eq!(v(&c).owner_id, owner());
}

// ---------------------------------------------------------------- media

fn media_svg(c: &Contract) -> String {
    let media = c.nft_token("1".into()).unwrap().metadata.unwrap().media.unwrap();
    let b64 = media.strip_prefix("data:image/svg+xml;base64,").expect("data uri");
    String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap()
}

#[test]
fn svg_media_color_per_state() {
    let mut c = setup();
    Ctx::new().at(T0 + 1_000).set();
    let svg = media_svg(&c);
    assert!(svg.contains("#2ecc71") && svg.contains(">Alive<") && svg.contains("next beat in 19s"));
    assert!(svg.contains("2 heirs") && svg.contains("WILL #1") && svg.contains("width=\"400\""));
    let extra = c.nft_token("1".into()).unwrap().metadata.unwrap().extra.unwrap();
    let extra: serde_json::Value = serde_json::from_str(&extra).unwrap();
    assert_eq!(extra["state"], "Alive");
    assert_eq!(extra["trigger_at_ms"], T0 + 40_000);
    assert_eq!(extra["heirs"], 2);

    Ctx::new().at(T0 + 25_000).set();
    let svg = media_svg(&c);
    assert!(svg.contains("#f39c12") && svg.contains(">Warning<") && !svg.contains("#2ecc71"));

    trigger(&mut c);
    let svg = media_svg(&c);
    assert!(svg.contains("#e74c3c") && svg.contains(">Triggered<"));

    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    for _ in 0..5 {
        let _ = c.execute_step(1.into(), None);
    }
    let svg = media_svg(&c);
    assert!(svg.contains("#7f8c8d") && svg.contains(">Settled<") && svg.contains("settled"));
}

#[test]
fn nft_metadata_and_enumeration() {
    let mut c = setup();
    Ctx::new().dep(NEAR1).set();
    c.create_vault(60, 2, heirs2(), None, None);
    let m = c.nft_metadata();
    assert_eq!(m.spec, "nft-1.0.0");
    assert_eq!(m.symbol, "WILL");
    assert_eq!(c.nft_total_supply().0, 2);
    assert_eq!(c.nft_tokens(Some(U128(1)), Some(10)).len(), 1);
    assert_eq!(c.nft_tokens_for_owner(owner(), None, None).len(), 2);
    assert_eq!(c.get_vaults(Some(0), Some(10)).len(), 2);
    assert_eq!(c.get_vaults(Some(1), Some(10))[0].token_id, "2");
}

#[test]
fn log_is_bounded() {
    let mut c = setup();
    for i in 0..(MAX_LOG as u64 + 10) {
        Ctx::new().at(T0 + i).set();
        c.heartbeat(1.into());
    }
    assert_eq!(v(&c).log.len(), MAX_LOG);
}
