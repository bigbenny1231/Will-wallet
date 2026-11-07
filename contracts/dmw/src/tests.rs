//! Unit tests (SPEC §2.6) using `near_sdk::testing_env!`.

use super::*;
use crate::nft::{COLOR_ALIVE, COLOR_SETTLED, COLOR_TRIGGERED, COLOR_WARNING};
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
        Self {
            now_ms: T0,
            pred: owner(),
            signer: owner(),
            signer_pk: pk(200),
            deposit: 0,
        }
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
        Heir {
            account_id: acc("sarah.testnet"),
            bps: 6000,
        },
        Heir {
            account_id: acc("tom.testnet"),
            bps: 4000,
        },
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
    Ctx::new()
        .by("dmw.testnet")
        .set_with_result(PromiseResult::Successful(vec![]));
    assert!(c.on_key_added(1, k, kind, Some(owner())));
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
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"standard\":\"nep171\"") && l.contains("nft_mint")));
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
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"standard\":\"dmw\"") && l.contains("\"event\":\"heartbeat\"")));
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
    assert!(
        v(&c).pulse_keys.is_empty(),
        "not usable until AddKey confirmed"
    );
    Ctx::new()
        .by("dmw.testnet")
        .set_with_result(PromiseResult::Failed);
    assert!(!c.on_key_added(1, pk(1), KeyKind::Pulse, Some(owner())));
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
    let r = c.agent_pay(
        1.into(),
        acc("api.provider.testnet"),
        U128(NEAR1 / 2),
        Some("gpu".into()),
    );
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
    assert!(
        c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1), None)
            .allowed
    );
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
    c.set_policy(
        1.into(),
        Policy {
            per_tx_max: U128(100 * NEAR1),
            daily_max: U128(100 * NEAR1),
            allowlist: vec![],
        },
    );
    let r = deny(&mut c, "anyone.testnet", 20 * NEAR1, T0);
    assert_eq!(r.reason.as_deref(), Some("insufficient_balance"));
}

#[test]
fn agent_pay_daily_window_resets() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().key(pk(2)).set();
    assert!(
        c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1), None)
            .allowed
    );
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
    assert!(
        c.agent_pay(1.into(), acc("api.provider.testnet"), U128(NEAR1), None)
            .allowed
    );
    Ctx::new()
        .by("dmw.testnet")
        .set_with_result(PromiseResult::Failed);
    assert!(!c.on_transfer_done(
        1,
        acc("api.provider.testnet"),
        U128(NEAR1),
        "agent_pay".into()
    ));
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
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"triggered\"") && l.contains("bob.testnet")));
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

    // step 3: one payout -> promise (MPC sign), guard set
    match c.execute_step(1.into(), Some(base_args())) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(_) => panic!("expected promise"),
    }
    assert!(v(&c).foreign_inflight_since_ms.is_some());
    // re-entry while in flight does nothing
    assert_eq!(step_value(c.execute_step(1.into(), None)), 3);
    assert_eq!(v(&c).foreign_index, 0);
    // MPC callback (live response shape) -> raw signed EIP-1559 tx stored
    Ctx::new().by("dmw.testnet").at(T0 + 42_000).set();
    let s = c.on_foreign_signed(1, 0, Ok(mpc_secp_response()));
    assert_eq!(s, 4);
    let vault = v(&c);
    assert_eq!(vault.foreign[0].status, ForeignStatus::Signed);
    assert!(vault.foreign[0]
        .signed_tx
        .as_deref()
        .unwrap()
        .starts_with("0x02f8"));
    assert_eq!(vault.foreign_index, 1);
    assert!(vault.foreign_inflight_since_ms.is_none());
    assert!(vault
        .log
        .iter()
        .any(|l| l.detail.starts_with("#0 signed 0x")));

    // step 4: no DAO -> skipped
    Ctx::new().by("keeper.testnet").at(T0 + 43_000).set();
    assert_eq!(step_value(c.execute_step(1.into(), None)), 5);
    // step 5: NFT to primary heir, Settled
    assert_eq!(step_value(c.execute_step(1.into(), None)), 6);
    let vault = v(&c);
    assert_eq!(vault.stored, StoredState::Settled);
    assert_eq!(vault.owner_id, acc("sarah.testnet"));
    assert_eq!(
        c.nft_token("1".into()).unwrap().owner_id,
        acc("sarah.testnet")
    );
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
    c.set_foreign_payouts(
        1.into(),
        vec![ForeignPayout {
            chain: ForeignChain::Solana,
            to: "11111111111111111111111111111111".into(),
            amount: U128(5),
            from_address: String::new(),
            status: ForeignStatus::Pending,
            signed_tx: None,
            tx_hash: None,
        }],
    );
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), None);
    let _ = c.execute_step(1.into(), None);
    let _ = c.execute_step(1.into(), Some(sol_args())); // in flight
    Ctx::new()
        .by("keeper.testnet")
        .at(T0 + 41_000 + FOREIGN_INFLIGHT_TIMEOUT_MS)
        .set();
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
    assert_eq!(
        v(&c).balance,
        bal - (dist * 6000 / 10_000 + dist * 4000 / 10_000)
    );
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
    c.set_foreign_payouts(
        1.into(),
        vec![ForeignPayout {
            chain: ForeignChain::Base,
            to: format!("0x{}", "cd".repeat(20)),
            amount: U128(1),
            from_address: String::new(),
            status: ForeignStatus::Pending,
            signed_tx: None,
            tx_hash: None,
        }],
    );
    // not signed yet -> rejected
    Ctx::new().by("keeper.testnet").set();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.mark_broadcast(1.into(), 0, "0xhash".into());
    }));
    assert!(r.is_err(), "pending payout cannot be marked");
    // simulate a signed payout
    let raw = "0x02f8aabbcc";
    let real = format!(
        "0x{}",
        hex::encode(foreign::chainsig::keccak256(
            &hex::decode(&raw[2..]).unwrap()
        ))
    );
    let mut vault = v(&c);
    vault.foreign[0].status = ForeignStatus::Signed;
    vault.foreign[0].signed_tx = Some(raw.into());
    c.vaults.insert(&1, &vault);
    c.mark_broadcast(1.into(), 0, real.to_uppercase().replace("0X", "0x"));
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Broadcast);
    assert_eq!(v(&c).foreign[0].tx_hash.as_deref(), Some(real.as_str()));
    // re-reporting the same hash is a no-op; a different one is rejected
    c.mark_broadcast(1.into(), 0, real.clone());
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
        vec![Heir {
            account_id: acc("a.testnet"),
            bps: 9999,
        }],
        vec![
            Heir {
                account_id: acc("a.testnet"),
                bps: 10_000,
            },
            Heir {
                account_id: acc("b.testnet"),
                bps: 0,
            },
        ],
        vec![
            Heir {
                account_id: acc("a.testnet"),
                bps: 5000,
            },
            Heir {
                account_id: acc("a.testnet"),
                bps: 5000,
            },
        ],
        (0..11)
            .map(|i| Heir {
                account_id: acc(&format!("h{i}.testnet")),
                bps: 1,
            })
            .collect(),
    ];
    for heirs in bad {
        Ctx::new().set();
        let r = std::panic::catch_unwind(|| validate_heirs(&heirs));
        assert!(r.is_err(), "should reject {heirs:?}");
    }
    validate_heirs(&heirs2());
    validate_heirs(&[Heir {
        account_id: acc("a.testnet"),
        bps: 10_000,
    }]);
}

#[test]
fn primary_heir_highest_bps_first_on_tie() {
    let mut c = setup();
    Ctx::new().set();
    c.set_heirs(
        1.into(),
        vec![
            Heir {
                account_id: acc("x.testnet"),
                bps: 2000,
            },
            Heir {
                account_id: acc("y.testnet"),
                bps: 4000,
            },
            Heir {
                account_id: acc("z.testnet"),
                bps: 4000,
            },
        ],
    );
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
    Ctx::new()
        .by("dmw.testnet")
        .set_with_result(PromiseResult::Successful(b"true".to_vec()));
    assert!(!c.nft_resolve_transfer(owner(), acc("market.testnet"), "1".into(), None));
    assert_eq!(v(&c).owner_id, owner());
}

// ---------------------------------------------------------------- media

fn media_svg(c: &Contract) -> String {
    let media = c
        .nft_token("1".into())
        .unwrap()
        .metadata
        .unwrap()
        .media
        .unwrap();
    let b64 = media
        .strip_prefix("data:image/svg+xml;base64,")
        .expect("data uri");
    String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap()
}

#[test]
fn svg_media_color_per_state() {
    let mut c = setup();
    Ctx::new().at(T0 + 1_000).set();
    let svg = media_svg(&c);
    assert!(
        svg.contains(COLOR_ALIVE) && svg.contains(">Alive<") && svg.contains("next beat in 19s")
    );
    assert!(
        svg.contains("2 HEIRS")
            && svg.contains("VAULT 1 \u{b7} ALIVE")
            && svg.contains("width=\"400\"")
    );
    assert!(
        svg.contains("<textPath") && svg.len() < 6 * 1024,
        "seal is {} bytes",
        svg.len()
    );
    let extra = c
        .nft_token("1".into())
        .unwrap()
        .metadata
        .unwrap()
        .extra
        .unwrap();
    let extra: serde_json::Value = serde_json::from_str(&extra).unwrap();
    assert_eq!(extra["state"], "Alive");
    assert_eq!(extra["trigger_at_ms"], T0 + 40_000);
    assert_eq!(extra["heirs"], 2);

    Ctx::new().at(T0 + 25_000).set();
    let svg = media_svg(&c);
    assert!(svg.contains(COLOR_WARNING) && svg.contains(">Warning<") && !svg.contains(COLOR_ALIVE));

    trigger(&mut c);
    let svg = media_svg(&c);
    assert!(
        svg.contains(COLOR_TRIGGERED) && svg.contains(">Triggered<") && svg.contains("M92 200h216")
    );

    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    for _ in 0..5 {
        let _ = c.execute_step(1.into(), None);
    }
    let svg = media_svg(&c);
    assert!(svg.contains(COLOR_SETTLED) && svg.contains(">Settled<") && svg.contains("settled"));
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

// ---------------------------------------------------------------- chain signatures (step 3)

const SOL_FROM: &str = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const SOL_TO: &str = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
const SOL_BH: &str = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const SOL_SIG: &str = "378a35a6527e8c1288d9695546a6fed45b7cc89a92b5c8c5978c3c69a4cf2b21d90e6a9fffb2f0aa07124e9df0e337f8e67415067bec9c307c9c680f5a51dc00";
const SOL_RAW_B64: &str = "ATeKNaZSfowSiNlpVUam/tRbfMiakrXIxZeMPGmkzysh2Q5qn/+y8KoHEk6d8OM3+OZ0FQZ77JwwfJxoD1pR3AABAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzEkOkozS44c7s0P8ldozF5ymD02/RsLDbpEpnVXU5rkBAgIAAQwCAAAAQEIPAAAAAAA=";

fn base_args() -> StepArgs {
    StepArgs {
        evm: Some(EvmArgs {
            nonce: 0,
            max_fee_per_gas: U128(1_500_000_000),
            max_priority_fee_per_gas: U128(1_000_000),
            gas_limit: U128(21_000),
        }),
        solana: None,
    }
}

fn sol_args() -> StepArgs {
    StepArgs {
        evm: None,
        solana: Some(SolanaArgs {
            recent_blockhash: SOL_BH.into(),
        }),
    }
}

fn mpc_secp_response() -> serde_json::Value {
    serde_json::json!({
        "scheme": "Secp256k1",
        "big_r": {"affine_point": "02f0fbff08e0e86c9e19272264915b8246a4e3a06dd37d18edf94dcc0d38a5d308"},
        "s": {"scalar": "39e0ecf2ca35bf30bfa495dae35f7770d13d3a1db7777668c87fbeb6f830b858"},
        "recovery_id": 1
    })
}

fn mpc_ed_response(sig_hex: &str) -> serde_json::Value {
    serde_json::json!({"scheme": "Ed25519", "signature": hex::decode(sig_hex).unwrap()})
}

/// Vault 1 triggered with the given payouts and steps 1-2 done (next: step 3).
fn at_step3(payouts: Vec<ForeignPayout>) -> Contract {
    let mut c = setup();
    Ctx::new().set();
    c.set_foreign_payouts(1.into(), payouts);
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), None);
    let _ = c.execute_step(1.into(), None);
    assert_eq!(v(&c).step, 3);
    c
}

fn sol_payout(amount: u128) -> ForeignPayout {
    ForeignPayout {
        chain: ForeignChain::Solana,
        to: SOL_TO.into(),
        amount: U128(amount),
        from_address: String::new(),
        status: ForeignStatus::Pending,
        signed_tx: None,
        tx_hash: None,
    }
}

fn base_payout() -> ForeignPayout {
    ForeignPayout {
        chain: ForeignChain::Base,
        to: format!("0x{}", "ab".repeat(20)),
        ..sol_payout(1_000)
    }
}

#[test]
fn step3_solana_flow_stores_base64_tx() {
    let mut c = at_step3(vec![sol_payout(1_000_000)]);
    assert!(matches!(
        c.execute_step(1.into(), Some(sol_args())),
        PromiseOrValue::Promise(_)
    ));
    // signer answered derived_public_key for sol-1 -> sign request scheduled
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).set();
    let key = format!("ed25519:{SOL_FROM}");
    assert!(matches!(
        c.on_foreign_sol_key(1, 0, SOL_BH.into(), None, None, Ok(key)),
        PromiseOrValue::Promise(_)
    ));
    let s = c.on_foreign_signed(1, 0, Ok(mpc_ed_response(SOL_SIG)));
    assert_eq!(s, 4);
    let p = &v(&c).foreign[0];
    assert_eq!(p.status, ForeignStatus::Signed);
    assert_eq!(p.signed_tx.as_deref(), Some(SOL_RAW_B64));
}

#[test]
fn step3_mpc_error_fails_payout_and_advances() {
    let mut c = at_step3(vec![base_payout(), sol_payout(5)]);
    let _ = c.execute_step(1.into(), Some(base_args()));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).set();
    assert_eq!(
        c.on_foreign_signed(1, 0, Err(near_sdk::PromiseError::Failed)),
        3
    );
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Failed);
    assert_eq!(v(&c).foreign_index, 1);
    // derived key lookup failure on the solana payout also fails + advances
    Ctx::new().by("keeper.testnet").at(T0 + 42_000).set();
    let _ = c.execute_step(1.into(), Some(sol_args()));
    Ctx::new().by("dmw.testnet").at(T0 + 42_500).set();
    let r = c.on_foreign_sol_key(
        1,
        1,
        SOL_BH.into(),
        None,
        None,
        Err(near_sdk::PromiseError::Failed),
    );
    assert!(matches!(r, PromiseOrValue::Value(4)));
    assert_eq!(v(&c).foreign[1].status, ForeignStatus::Failed);
}

#[test]
#[should_panic(expected = "args.evm is required")]
fn step3_without_chain_args_panics_so_payout_is_not_burned() {
    let mut c = at_step3(vec![base_payout()]);
    let _ = c.execute_step(1.into(), None);
}

#[test]
fn step3_unbuildable_payout_fails_via_self_call() {
    let mut c = at_step3(vec![sol_payout(u128::from(u64::MAX) + 1)]);
    assert!(matches!(
        c.execute_step(1.into(), Some(sol_args())),
        PromiseOrValue::Promise(_)
    ));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).set();
    assert_eq!(
        c.foreign_fail(1, 0, "amount exceeds u64 lamports".into()),
        4
    );
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Failed);
}

#[test]
fn resign_after_failure_stores_new_tx_without_moving_steps() {
    let mut c = at_step3(vec![base_payout()]);
    let _ = c.execute_step(1.into(), Some(base_args()));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).set();
    assert_eq!(
        c.on_foreign_signed(1, 0, Err(near_sdk::PromiseError::Failed)),
        4
    );
    Ctx::new().by("keeper.testnet").at(T0 + 42_000).set();
    let _ = c.resign_foreign(1.into(), 0, base_args());
    // simulate callback: rebuild the same pending tx the contract scheduled
    let payout = v(&c).foreign[0].clone();
    let (t, _) = foreign::evm_transfer_for(&payout, base_args().evm.as_ref().unwrap()).unwrap();
    Ctx::new().by("dmw.testnet").at(T0 + 42_500).set();
    let st = c.on_foreign_resigned(
        1,
        0,
        foreign::PendingTx::Evm(t),
        Some(T0 + 42_000),
        Ok(mpc_secp_response()),
    );
    assert_eq!(st, "signed");
    let vault = v(&c);
    assert!(vault.foreign[0]
        .signed_tx
        .as_deref()
        .unwrap()
        .starts_with("0x02f8"));
    assert_eq!(vault.step, 4);
    assert_eq!(vault.foreign_index, 1);
}

#[test]
#[should_panic(expected = "payout not processed yet")]
fn resign_rejects_unprocessed_payout() {
    let mut c = at_step3(vec![base_payout()]);
    let _ = c.resign_foreign(1.into(), 0, base_args());
}

#[test]
fn constants_are_in_yocto() {
    assert_eq!(STORAGE_FEE, 100_000_000_000_000_000_000_000); // 0.1 NEAR
    assert_eq!(KEY_ALLOWANCE, 1_000_000_000_000_000_000_000_000); // 1 NEAR
    assert_eq!(DEFAULT_BOUNTY, 10_000_000_000_000_000_000_000); // 0.01 NEAR
    assert_eq!(RESERVE_NO_DAO, 100_000_000_000_000_000_000_000);
    assert_eq!(RESERVE_WITH_DAO, 1_500_000_000_000_000_000_000_000);
    assert_eq!(DAO_BOND, NEAR1);
}

#[test]
fn step1_detail_lists_heir_amounts() {
    assert_eq!(fmt_near(NEAR1), "1");
    assert_eq!(fmt_near(5_340_000_000_000_000_000_000_000), "5.34");
    assert_eq!(fmt_near(1), "0.000000000000000000000001");
    let mut c = setup();
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), None);
    // balance 10 - 0.01 bounty = 9.99; minus 0.1 reserve = 9.89 distributable
    let d = v(&c).log.last().unwrap().detail.clone();
    assert_eq!(d, "sarah.testnet 5.934 NEAR, tom.testnet 3.956 NEAR");
}

// ---------------------------------------------------------------- security review regressions
// See docs/SECURITY_REVIEW.md. Each test names the finding it pins down.

use near_sdk::mock::MockAction;

/// JSON args of every FunctionCall receipt for `method` created in the current context.
fn created_calls(method: &str) -> Vec<serde_json::Value> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == method.as_bytes() => serde_json::from_slice(&args).ok(),
            _ => None,
        })
        .collect()
}

fn deleted_keys() -> Vec<PublicKey> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::DeleteKey { public_key, .. } => public_key.to_string().parse().ok(),
            _ => None,
        })
        .collect()
}

fn evm(nonce: u64, max_fee: u128, prio: u128, gas: u128) -> StepArgs {
    StepArgs {
        evm: Some(EvmArgs {
            nonce,
            max_fee_per_gas: U128(max_fee),
            max_priority_fee_per_gas: U128(prio),
            gas_limit: U128(gas),
        }),
        solana: None,
    }
}

fn pending_slot(index: usize) -> foreign::PendingTx {
    let raw =
        env::storage_read(format!("chainsig:pending:1:{index}").as_bytes()).expect("pending tx");
    near_sdk::borsh::from_slice(&raw).unwrap()
}

fn panics(f: impl FnOnce()) -> String {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    match r {
        Ok(()) => panic!("expected a panic"),
        Err(e) => e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    }
}

/// Vault 1 at step 3 with [base, sol, base] payouts; payout 0 signed via the MPC callback.
fn evm_signed() -> Contract {
    let mut c = at_step3(vec![base_payout(), sol_payout(5), base_payout()]);
    let _ = c.execute_step(1.into(), Some(base_args()));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).set();
    assert_eq!(c.on_foreign_signed(1, 0, Ok(mpc_secp_response())), 3);
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Signed);
    c
}

/// Vault 1 with one Solana payout signed at T0 + 41_000 (step 4 next).
fn sol_signed() -> Contract {
    let mut c = at_step3(vec![sol_payout(1_000_000)]);
    let _ = c.execute_step(1.into(), Some(sol_args()));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).set();
    let _ = c.on_foreign_sol_key(
        1,
        0,
        SOL_BH.into(),
        None,
        None,
        Ok(format!("ed25519:{SOL_FROM}")),
    );
    assert_eq!(c.on_foreign_signed(1, 0, Ok(mpc_ed_response(SOL_SIG))), 4);
    c
}

#[test]
fn c1_evm_nonce_is_pinned_per_payout_not_caller_chosen() {
    let mut c = at_step3(vec![base_payout(), sol_payout(5), base_payout()]);
    // caller asks for nonce 999; the contract uses 0 (first base payout)
    let _ = c.execute_step(1.into(), Some(evm(999, 1_500_000_000, 1_000_000, 21_000)));
    match pending_slot(0) {
        foreign::PendingTx::Evm(t) => assert_eq!(t.nonce, 0),
        _ => panic!("expected evm"),
    }
    assert_eq!(
        foreign::evm_nonce_for(&v(&c).foreign, 2),
        1,
        "third payout is the 2nd base payout"
    );
}

#[test]
fn c1_evm_resign_reuses_nonce_and_requires_fee_bump() {
    let mut c = evm_signed();
    // same fees: rejected (no downgrade/same-fee resign of a signed payout)
    Ctx::new().by("mallory.testnet").at(T0 + 42_000).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, base_args());
    });
    assert!(m.contains("raise both fees"), "{m}");
    // +10% on both fees with a different caller nonce: accepted, nonce still 0
    Ctx::new().by("mallory.testnet").at(T0 + 42_000).set();
    let _ = c.resign_foreign(1.into(), 0, evm(42, 1_650_000_000, 1_100_000, 21_000));
    let calls = created_calls("on_foreign_resigned");
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["pending"]["Evm"]["nonce"], 0);
    assert_eq!(calls[0]["req_ms"], T0 + 42_000);
    let t = c.get_sign_track(1.into(), 0);
    assert_eq!(t["max_fee_per_gas"], "1650000000");
    assert_eq!(t["inflight"], true);
}

#[test]
fn h2_evm_fee_and_gas_caps() {
    for args in [
        evm(0, 101_000_000_000, 1, 21_000), // > 100 gwei
        evm(0, 1_500_000_000, 1, 20_999),   // below intrinsic gas
        evm(0, 1_500_000_000, 1, 100_001),  // above cap
        evm(0, 1_000, 2_000, 21_000),       // priority > max fee
        evm(0, 0, 0, 21_000),               // zero fee
    ] {
        // fresh thread = fresh mocked blockchain per case
        let m = std::thread::spawn(move || {
            let mut c = at_step3(vec![base_payout()]);
            panics(|| {
                let _ = c.execute_step(1.into(), Some(args));
            })
        })
        .join()
        .unwrap();
        // On chain the panic reverts the whole call (incl. the in-flight guard), so the
        // payout is neither burned nor signed with out-of-range params.
        assert!(m.contains("evm "), "{m}");
    }
}

#[test]
fn c1_solana_signed_resign_only_by_operator_after_cooldown() {
    let mut c = sol_signed();
    // anyone, even after the cooldown: rejected (a second live signature = second payment)
    Ctx::new()
        .by("heir.testnet")
        .at(T0 + 41_000 + foreign::RESIGN_COOLDOWN_MS)
        .set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, sol_args());
    });
    assert!(m.contains("only the contract owner or keeper"), "{m}");
    // contract owner configures a keeper
    Ctx::new().by("deployer.testnet").set();
    c.set_keeper(Some(acc("keeper.testnet")));
    assert_eq!(c.get_config()["keeper"], "keeper.testnet");
    // keeper before the cooldown: rejected
    Ctx::new().by("keeper.testnet").at(T0 + 60_000).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, sol_args());
    });
    assert!(m.contains("cooldown"), "{m}");
    // keeper after the cooldown: accepted, and a second request while in flight is rejected
    let t = T0 + 41_000 + foreign::RESIGN_COOLDOWN_MS;
    Ctx::new().by("keeper.testnet").at(t).set();
    let _ = c.resign_foreign(1.into(), 0, sol_args());
    assert_eq!(created_calls("on_foreign_sol_key")[0]["req_ms"], t);
    Ctx::new().by("keeper.testnet").at(t + 1).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, sol_args());
    });
    assert!(m.contains("cooldown") || m.contains("in flight"), "{m}");
}

#[test]
#[should_panic(expected = "only the contract owner")]
fn set_keeper_is_owner_only() {
    let mut c = setup();
    Ctx::new().by("mallory.testnet").set();
    c.set_keeper(Some(acc("mallory.testnet")));
}

#[test]
fn c1_solana_failed_resign_waits_for_cooldown_then_anyone() {
    let mut c = at_step3(vec![sol_payout(1_000_000)]);
    let _ = c.execute_step(1.into(), Some(sol_args()));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).set();
    let _ = c.on_foreign_sol_key(
        1,
        0,
        SOL_BH.into(),
        None,
        None,
        Ok(format!("ed25519:{SOL_FROM}")),
    );
    assert_eq!(
        c.on_foreign_signed(1, 0, Err(near_sdk::PromiseError::Failed)),
        4
    );
    Ctx::new().by("heir.testnet").at(T0 + 42_000).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, sol_args());
    });
    assert!(m.contains("cooldown"), "{m}");
    Ctx::new()
        .by("heir.testnet")
        .at(T0 + 41_000 + foreign::RESIGN_COOLDOWN_MS)
        .set();
    let _ = c.resign_foreign(1.into(), 0, sol_args());
}

#[test]
fn c1_inflight_resign_blocks_second_and_stale_callback_ignored() {
    let mut c = evm_signed();
    Ctx::new().by("keeper.testnet").at(T0 + 42_000).set();
    let _ = c.resign_foreign(1.into(), 0, evm(0, 2_000_000_000, 2_000_000, 21_000));
    Ctx::new().by("keeper.testnet").at(T0 + 43_000).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, evm(0, 3_000_000_000, 3_000_000, 21_000));
    });
    assert!(m.contains("in flight"), "{m}");
    // after the in-flight timeout a new request supersedes the lost one...
    let t2 = T0 + 42_000 + FOREIGN_INFLIGHT_TIMEOUT_MS;
    Ctx::new().by("keeper.testnet").at(t2).set();
    let _ = c.resign_foreign(1.into(), 0, evm(0, 3_000_000_000, 3_000_000, 21_000));
    // ...and the late callback of the old one is ignored
    let before = v(&c).foreign[0].clone();
    let payout = before.clone();
    let (t, _) = foreign::evm_transfer_for(&payout, base_args().evm.as_ref().unwrap()).unwrap();
    Ctx::new().by("dmw.testnet").at(t2 + 10).set();
    assert_eq!(
        c.on_foreign_resigned(
            1,
            0,
            foreign::PendingTx::Evm(t),
            Some(T0 + 42_000),
            Ok(mpc_secp_response())
        ),
        "signed"
    );
    assert_eq!(v(&c).foreign[0], before);
    assert!(
        foreign::read_track(1, 0).inflight,
        "current request still in flight"
    );
}

#[test]
fn h1_mark_broadcast_rejects_fake_hash_and_resign_still_possible() {
    let mut c = sol_signed();
    let raw = v(&c).foreign[0].signed_tx.clone().unwrap();
    let real = near_sdk::bs58::encode(hex::decode(SOL_SIG).unwrap()).into_string();
    assert_eq!(
        foreign::expected_tx_id(ForeignChain::Solana, &raw).unwrap(),
        real
    );
    Ctx::new().by("mallory.testnet").at(T0 + 42_000).set();
    let m = panics(|| c.mark_broadcast(1.into(), 0, "5fakeSignature".into()));
    assert!(m.contains("does not match"), "{m}");
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Signed);
    // the real id is accepted (anyone may report it; the tx itself is public in state)
    c.mark_broadcast(1.into(), 0, real.clone());
    assert_eq!(v(&c).foreign[0].tx_hash.as_deref(), Some(real.as_str()));
    // a `broadcast` payout whose tx never landed is not bricked: the keeper can re-sign
    Ctx::new().by("deployer.testnet").set();
    c.set_keeper(Some(acc("keeper.testnet")));
    Ctx::new()
        .by("keeper.testnet")
        .at(T0 + 41_000 + foreign::RESIGN_COOLDOWN_MS)
        .set();
    let _ = c.resign_foreign(1.into(), 0, sol_args());
}

#[test]
fn h1_evm_broadcast_resign_needs_cooldown_and_clears_hash() {
    let mut c = evm_signed();
    let raw = v(&c).foreign[0].signed_tx.clone().unwrap();
    let id = foreign::expected_tx_id(ForeignChain::Base, &raw).unwrap();
    Ctx::new().by("mallory.testnet").at(T0 + 42_000).set();
    c.mark_broadcast(1.into(), 0, id);
    let bump = evm(0, 2_000_000_000, 2_000_000, 21_000);
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, bump.clone());
    });
    assert!(m.contains("cooldown"), "{m}");
    let t = T0 + 41_000 + foreign::RESIGN_COOLDOWN_MS;
    Ctx::new().by("keeper.testnet").at(t).set();
    let _ = c.resign_foreign(1.into(), 0, bump.clone());
    let payout = v(&c).foreign[0].clone();
    let (tx, _) = foreign::evm_transfer_for(&payout, bump.evm.as_ref().unwrap()).unwrap();
    Ctx::new().by("dmw.testnet").at(t + 10).set();
    assert_eq!(
        c.on_foreign_resigned(
            1,
            0,
            foreign::PendingTx::Evm(tx),
            Some(t),
            Ok(mpc_secp_response())
        ),
        "signed"
    );
    assert_eq!(v(&c).foreign[0].tx_hash, None);
    assert!(!foreign::read_track(1, 0).inflight);
}

#[test]
fn h3_nft_transfer_revokes_previous_owner_keys() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().set();
    let _ = c.add_pulse_key(1.into(), pk(1));
    confirm_key(&mut c, pk(1), KeyKind::Pulse);
    Ctx::new().dep(1).set();
    c.nft_transfer(acc("bob.testnet"), "1".into(), None, None);
    let mut del = deleted_keys();
    del.sort_by_key(|k| k.as_bytes().to_vec());
    assert_eq!(del, vec![pk(1), pk(2)]);
    let vault = v(&c);
    assert!(vault.pulse_keys.is_empty() && vault.agent_keys.is_empty());
    assert!(!c.key_index.contains_key(&pk(2)));
    // the seller's agent key can no longer spend the buyer's vault
    Ctx::new().key(pk(2)).at(T0 + 1_000).set();
    let m = panics(|| {
        let _ = c.agent_pay(
            1.into(),
            acc("api.provider.testnet"),
            U128(NEAR1 / 10),
            None,
        );
    });
    assert!(m.contains("unauthorized"), "{m}");
}

#[test]
fn h3_key_add_landing_after_transfer_is_revoked() {
    let mut c = setup();
    Ctx::new().set();
    let _ = c.add_agent_key(1.into(), pk(3));
    Ctx::new().dep(1).set();
    c.nft_transfer(acc("bob.testnet"), "1".into(), None, None);
    // AddKey succeeded, but the requester (alice) no longer owns the vault
    Ctx::new()
        .by("dmw.testnet")
        .set_with_result(PromiseResult::Successful(vec![]));
    assert!(!c.on_key_added(1, pk(3), KeyKind::Agent, Some(owner())));
    assert!(v(&c).agent_keys.is_empty());
    assert!(!c.key_index.contains_key(&pk(3)));
    assert_eq!(deleted_keys(), vec![pk(3)]);
}

#[test]
#[should_panic(expected = "unauthorized: not owner or pulse key")]
fn l4_pulse_key_must_be_signed_by_contract_account() {
    let mut c = setup();
    Ctx::new().set();
    let _ = c.add_pulse_key(1.into(), pk(1));
    confirm_key(&mut c, pk(1), KeyKind::Pulse);
    // same public key, but the tx signer is some other account
    let mut ctx = Ctx::new().key(pk(1));
    ctx.signer = acc("mallory.testnet");
    ctx.set();
    c.heartbeat(1.into());
}

#[test]
#[should_panic(expected = "receiver cannot be the dmw contract")]
fn l5_agent_pay_to_contract_rejected() {
    let mut c = setup();
    with_agent_key(&mut c);
    Ctx::new().key(pk(2)).at(T0 + 1_000).set();
    let _ = c.agent_pay(1.into(), contract_id(), U128(1), None);
}

#[test]
fn m1_storage_of_a_full_vault_vs_flat_fee() {
    // Documents finding M-1: worst-case bytes of one vault vs the 0.1 NEAR (10 kB) fee.
    Ctx::new().set();
    let mut c = Contract::new(acc("deployer.testnet"));
    let before = env::storage_usage();
    Ctx::new().dep(100 * NEAR1).set();
    let heirs: Vec<Heir> = (0..10)
        .map(|i| Heir {
            account_id: acc(&format!("{}{i}.testnet", "h".repeat(54))),
            bps: 1000,
        })
        .collect();
    let pol = Policy {
        per_tx_max: U128(1),
        daily_max: U128(1),
        allowlist: (0..10)
            .map(|i| acc(&format!("{}{i}.testnet", "a".repeat(54))))
            .collect(),
    };
    c.create_vault(60, 1, heirs, Some(pol), None);
    let mut vault = c.vaults.get(&1).unwrap();
    vault.foreign = (0..4)
        .map(|_| ForeignPayout {
            chain: ForeignChain::Solana,
            to: "x".repeat(64),
            amount: U128(u128::MAX),
            from_address: "y".repeat(64),
            status: ForeignStatus::Signed,
            signed_tx: Some("z".repeat(300)),
            tx_hash: Some("t".repeat(128)),
        })
        .collect();
    vault.pulse_keys = (0..5).map(|i| pk(10 + i)).collect();
    vault.agent_keys = (0..5).map(|i| pk(20 + i)).collect();
    vault.log = (0..MAX_LOG)
        .map(|_| LogEntry {
            ms: 0,
            event: "agent_pay_denied".into(),
            detail: "d".repeat(150),
        })
        .collect();
    c.vaults.insert(&1, &vault);
    let used = env::storage_usage() - before;
    println!("full vault storage: {used} bytes");
    // > 10 kB: the flat fee under-collects for a maxed-out vault
    assert!(used > 10_000, "used {used}");
    assert!(used < 20_000, "used {used}");
}
