//! v3 regression tests: one or more per finding of the v3 adversarial review
//! (docs/SECURITY_FIXES_V3.md). The `v3_poc_*` tests are the reviewer's proof-of-concept tests,
//! turned around: each asserts the safe behaviour that now holds. `cargo test --locked v3_`.

use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};

const NEAR1: u128 = 1_000_000_000_000_000_000_000_000;
const T0: u64 = 1_700_000_000_000; // ms

const SOL_FROM: &str = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const SOL_TO: &str = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
const SOL_BH: &str = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const SOL_SIG: &str = "378a35a6527e8c1288d9695546a6fed45b7cc89a92b5c8c5978c3c69a4cf2b21d90e6a9fffb2f0aa07124e9df0e337f8e67415067bec9c307c9c680f5a51dc00";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn contract_id() -> AccountId {
    acc("dmw.testnet")
}
fn owner() -> AccountId {
    acc("alice.testnet")
}
fn admin() -> AccountId {
    acc("admin.testnet")
}

struct Ctx {
    now_ms: u64,
    pred: AccountId,
    deposit: u128,
    tgas: u64,
}

impl Ctx {
    fn new() -> Self {
        Self {
            now_ms: T0,
            pred: owner(),
            deposit: 0,
            tgas: 300,
        }
    }
    fn builder(&self) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(self.pred.clone())
            .signer_account_id(self.pred.clone())
            .block_timestamp(self.now_ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(self.deposit))
            .prepaid_gas(Gas::from_tgas(self.tgas))
            .account_balance(NearToken::from_near(100_000));
        b
    }
    fn set(&self) {
        testing_env!(self.builder().build());
    }
    fn with_result(&self, r: PromiseResult) {
        testing_env!(
            self.builder().build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![r],
        );
    }
    /// A `.then()` callback context: exactly one (successful) promise result.
    fn cb(&self) {
        self.with_result(PromiseResult::Successful(vec![]));
    }
    fn by(mut self, a: &str) -> Self {
        self.pred = acc(a);
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

/// Locked contract (owner_id is the contract itself) with keeper and keeper admin, plus vault 1
/// (interval 20 s, grace 1, 10 NEAR balance).
fn setup() -> Contract {
    Ctx::new().set();
    let mut c = Contract::new(
        contract_id(),
        Some(acc("keeper.testnet")),
        None,
        Some(admin()),
    );
    Ctx::new().dep(10 * NEAR1 + STORAGE_FEE).set();
    assert_eq!(c.create_vault(20, 1, heirs2(), None, None).0, 1);
    c
}

fn v(c: &Contract) -> Vault {
    c.load(1).unwrap()
}

fn trigger(c: &mut Contract) {
    Ctx::new().by("bob.testnet").at(T0 + 40_000).set();
    c.poke(1.into());
}

fn step(c: &mut Contract) -> u8 {
    match c.execute_step(1.into(), None) {
        PromiseOrValue::Value(s) => s,
        PromiseOrValue::Promise(_) => panic!("expected value"),
    }
}

/// The panic message of `f`, or None if it returned.
fn try_call(f: impl FnOnce()) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .err()
        .map(|e| {
            e.downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        })
}

fn panics(f: impl FnOnce()) -> String {
    try_call(f).expect("expected a panic")
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

fn sol_args() -> StepArgs {
    StepArgs {
        evm: None,
        solana: Some(SolanaArgs {
            recent_blockhash: SOL_BH.into(),
        }),
    }
}

fn evm(max_fee: u128, prio: u128, gas: u128) -> StepArgs {
    StepArgs {
        evm: Some(EvmArgs {
            nonce: 0,
            max_fee_per_gas: U128(max_fee),
            max_priority_fee_per_gas: U128(prio),
            gas_limit: U128(gas),
        }),
        solana: None,
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

fn mpc_ed_response() -> serde_json::Value {
    serde_json::json!({"scheme": "Ed25519", "signature": hex::decode(SOL_SIG).unwrap()})
}

/// The key `mpc_secp_response()` recovers to over `p`'s sighash, as the signer would report it.
fn key_for(p: &foreign::PendingTx) -> Option<String> {
    use foreign::chainsig::{ecrecover64, evm_sighash, evm_tx};
    let foreign::PendingTx::Evm(t) = p else {
        return None;
    };
    let r = mpc_secp_response();
    let mut rs = [0u8; 64];
    rs[..32]
        .copy_from_slice(&hex::decode(&r["big_r"]["affine_point"].as_str().unwrap()[2..]).unwrap());
    rs[32..].copy_from_slice(&hex::decode(r["s"]["scalar"].as_str().unwrap()).unwrap());
    let k = ecrecover64(&evm_sighash(&evm_tx(t).unwrap()), &rs, 1)?;
    Some(format!(
        "secp256k1:{}",
        near_sdk::bs58::encode(k).into_string()
    ))
}

fn step3_evm_key() -> Option<String> {
    key_for(&foreign::read_pending(1, 0).expect("pending tx"))
}

/// JSON args of the function calls named `method` among the receipts created so far.
fn created_calls(method: &str) -> Vec<serde_json::Value> {
    use near_sdk::mock::MockAction;
    get_created_receipts()
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

/// Receivers of the function calls named `method` among the receipts created so far.
fn call_receivers(method: &str) -> Vec<AccountId> {
    use near_sdk::mock::MockAction;
    get_created_receipts()
        .into_iter()
        .filter(|r| {
            r.actions.iter().any(|a| {
                matches!(a, MockAction::FunctionCallWeight { method_name, .. }
                    if method_name == method.as_bytes())
            })
        })
        .map(|r| r.receiver_id)
        .collect()
}

/// Vault 1 triggered with `payouts`, steps 1-2 done (step 3 next, its window opened at T0+41s).
fn at_step3(payouts: Vec<ForeignPayout>) -> Contract {
    let mut c = setup();
    Ctx::new().dep(1).set();
    c.set_foreign_payouts(1.into(), payouts);
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    step(&mut c);
    step(&mut c);
    assert_eq!(v(&c).step, 3);
    c
}

/// Step 3 signs Solana payout 0 for `who` at `at` (key lookup + MPC answer). Returns the step.
fn sol_sign_step3(c: &mut Contract, who: &str, at: u64) -> u8 {
    Ctx::new().by(who).at(at).set();
    let _ = c.execute_step(1.into(), Some(sol_args()));
    Ctx::new().by("dmw.testnet").at(at + 500).cb();
    let _ = c.on_foreign_sol_key(
        1,
        0,
        SOL_BH.into(),
        None,
        None,
        Ok(format!("ed25519:{SOL_FROM}")),
    );
    c.on_foreign_signed(1, 0, None, Ok(mpc_ed_response()))
}

fn sol_pending() -> foreign::PendingTx {
    foreign::PendingTx::Solana(foreign::chainsig::SolanaTransfer {
        from: SOL_FROM.into(),
        to: SOL_TO.into(),
        lamports: near_sdk::json_types::U64(1_000_000),
        recent_blockhash: SOL_BH.into(),
    })
}

/// A keeper (`who`) re-signs signed Solana payout 0 at `t`; `ok` = the MPC answers.
fn keeper_sol_resign(c: &mut Contract, who: &str, t: u64, ok: bool) -> Option<String> {
    Ctx::new().by(who).at(t).set();
    if let Some(m) = try_call(|| {
        let _ = c.resign_foreign(1.into(), 0, sol_args());
    }) {
        return Some(m);
    }
    Ctx::new().by("dmw.testnet").at(t + 500).cb();
    let _ = c.on_foreign_sol_key(
        1,
        0,
        SOL_BH.into(),
        Some(true),
        Some(t),
        Ok(format!("ed25519:{SOL_FROM}")),
    );
    let r = if ok {
        Ok(mpc_ed_response())
    } else {
        Err(near_sdk::PromiseError::Failed)
    };
    let _ = c.on_foreign_resigned(1, 0, sol_pending(), Some(t), None, r);
    None
}

/// Admin proposes `f`; the proposal is executed after the timelock by a stranger.
fn admin_executes(c: &mut Contract, at: u64, f: impl FnOnce(&mut Contract)) {
    Ctx::new().by("admin.testnet").dep(1).at(at).set();
    f(c);
    Ctx::new()
        .by("anyone.testnet")
        .at(at + ADMIN_TIMELOCK_MS)
        .set();
    c.execute_admin_proposal();
}

// ------------------------------------------------------------------------------------------
// H-1: keeper_admin recovery path
// ------------------------------------------------------------------------------------------

#[test]
fn v3_h1_admin_replaces_keeper_after_timelock() {
    let mut c = setup();
    // a compromised keeper has queued a handover to an attacker account
    Ctx::new().by("keeper.testnet").dep(1).set();
    c.set_keeper(Some(acc("attacker.testnet")));
    Ctx::new().by("admin.testnet").dep(1).set();
    c.propose_keeper(Some(acc("keeper2.testnet")));
    let cfg = c.get_config();
    assert_eq!(cfg["admin_proposal"]["action"], "keeper");
    assert_eq!(cfg["admin_proposal"]["account_id"], "keeper2.testnet");
    assert_eq!(cfg["admin_proposal"]["eta_ms"], T0 + ADMIN_TIMELOCK_MS);
    assert!(get_logs().iter().any(|l| l.contains("\"admin_proposal\"")));
    // not before the timelock
    Ctx::new()
        .by("anyone.testnet")
        .at(T0 + ADMIN_TIMELOCK_MS - 1)
        .set();
    let m = panics(|| c.execute_admin_proposal());
    assert!(m.contains("timelock has not passed"), "{m}");
    assert_eq!(c.get_config()["keeper"], "keeper.testnet");
    // anyone executes it afterwards; the queued handover is dropped
    Ctx::new()
        .by("anyone.testnet")
        .at(T0 + ADMIN_TIMELOCK_MS)
        .set();
    c.execute_admin_proposal();
    let cfg = c.get_config();
    assert_eq!(cfg["keeper"], "keeper2.testnet");
    assert!(cfg["pending_keeper"].is_null());
    assert!(cfg["admin_proposal"].is_null());
    assert_eq!(cfg["keeper_epoch"], 1);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("admin_proposal_executed")));
    Ctx::new().by("attacker.testnet").dep(1).set();
    let m = panics(|| c.accept_keeper());
    assert!(m.contains("only the pending keeper"), "{m}");
    // and it is gone once executed
    let m = panics(|| c.execute_admin_proposal());
    assert!(m.contains("no pending admin proposal"), "{m}");
}

#[test]
fn v3_h1_admin_methods_need_the_admin_and_one_yocto() {
    let mut c = setup();
    for who in [
        "keeper.testnet",
        "alice.testnet",
        "dmw.testnet",
        "mallory.testnet",
    ] {
        Ctx::new().by(who).dep(1).set();
        let m = panics(|| c.propose_keeper(Some(acc("x.testnet"))));
        assert!(m.contains("only the keeper admin"), "{who}: {m}");
        let m = panics(|| c.propose_mpc_signer(acc("x.testnet")));
        assert!(m.contains("only the keeper admin"), "{who}: {m}");
        let m = panics(|| c.set_keeper_admin(Some(acc("x.testnet"))));
        assert!(m.contains("only the keeper admin"), "{who}: {m}");
        let m = panics(|| c.cancel_admin_proposal());
        assert!(m.contains("only the keeper admin"), "{who}: {m}");
    }
    // a function-call key of the admin (no deposit) cannot propose
    Ctx::new().by("admin.testnet").set();
    let m = panics(|| c.propose_keeper(Some(acc("x.testnet"))));
    assert!(m.contains("exactly 1 yoctoNEAR"), "{m}");
    Ctx::new().by("admin.testnet").dep(1).set();
    let m = panics(|| c.propose_keeper(Some(contract_id())));
    assert!(m.contains("keeper cannot be the dmw contract"), "{m}");
    let m = panics(|| c.propose_mpc_signer(contract_id()));
    assert!(m.contains("cannot be the dmw contract"), "{m}");
    let m = panics(|| c.set_keeper_admin(Some(contract_id())));
    assert!(m.contains("cannot be the dmw contract"), "{m}");
    let m = panics(|| c.propose_keeper(Some(admin())));
    assert!(m.contains("must be different accounts"), "{m}");
    let m = panics(|| c.set_keeper_admin(Some(acc("keeper.testnet"))));
    assert!(m.contains("must be different accounts"), "{m}");
    // without an admin nobody has these powers
    Ctx::new().set();
    let mut c = Contract::new(contract_id(), Some(acc("keeper.testnet")), None, None);
    Ctx::new().by("admin.testnet").dep(1).set();
    let m = panics(|| c.propose_keeper(Some(acc("x.testnet"))));
    assert!(m.contains("only the keeper admin"), "{m}");
    assert!(c.get_config()["keeper_admin"].is_null());
}

#[test]
fn v3_h1_admin_cancels_and_replaces_proposals() {
    let mut c = setup();
    Ctx::new().by("admin.testnet").dep(1).set();
    c.propose_keeper(Some(acc("keeper2.testnet")));
    // a new proposal replaces the pending one and restarts the timelock
    Ctx::new().by("admin.testnet").dep(1).at(T0 + 1_000).set();
    c.propose_mpc_signer(acc("signer2.testnet"));
    assert_eq!(c.get_config()["admin_proposal"]["action"], "mpc_signer");
    assert_eq!(
        c.get_config()["admin_proposal"]["eta_ms"],
        T0 + 1_000 + ADMIN_TIMELOCK_MS
    );
    c.cancel_admin_proposal();
    assert!(c.get_config()["admin_proposal"].is_null());
    let m = panics(|| c.cancel_admin_proposal());
    assert!(m.contains("no pending admin proposal"), "{m}");
    Ctx::new()
        .by("anyone.testnet")
        .at(T0 + 2 * ADMIN_TIMELOCK_MS)
        .set();
    let m = panics(|| c.execute_admin_proposal());
    assert!(m.contains("no pending admin proposal"), "{m}");
    assert_eq!(c.get_config()["keeper"], "keeper.testnet");
    assert_eq!(c.get_config()["mpc_signer"], foreign::DEFAULT_MPC_SIGNER);
}

/// Review v3 I-1: the MPC signer is replaceable through the timelocked admin proposal, and step 3
/// then asks the new signer.
#[test]
fn v3_h1_admin_replaces_mpc_signer() {
    let mut c = setup();
    admin_executes(&mut c, T0, |c| {
        c.propose_mpc_signer(acc("v2.signer-prod.testnet"))
    });
    assert_eq!(c.get_config()["mpc_signer"], "v2.signer-prod.testnet");
    assert_eq!(c.get_config()["keeper_epoch"], 0, "no keeper change");
    Ctx::new().dep(1).set();
    c.set_foreign_payouts(1.into(), vec![sol_payout(1_000_000)]);
    // the vault was due long ago (the timelock is 48 h)
    Ctx::new()
        .by("bob.testnet")
        .at(T0 + ADMIN_TIMELOCK_MS + 1)
        .set();
    c.poke(1.into());
    Ctx::new()
        .by("keeper.testnet")
        .at(T0 + ADMIN_TIMELOCK_MS + 2)
        .set();
    step(&mut c);
    step(&mut c);
    let _ = c.execute_step(1.into(), Some(sol_args()));
    assert_eq!(
        call_receivers("derived_public_key"),
        vec![acc("v2.signer-prod.testnet")]
    );
}

/// The admin hands its role on through the same timelock; the old admin loses every power.
#[test]
fn v3_h1_set_keeper_admin_is_timelocked() {
    let mut c = setup();
    Ctx::new().by("admin.testnet").dep(1).set();
    c.set_keeper_admin(Some(acc("multisig.testnet")));
    assert_eq!(c.get_config()["keeper_admin"], "admin.testnet");
    assert_eq!(c.get_config()["admin_proposal"]["action"], "keeper_admin");
    Ctx::new()
        .by("anyone.testnet")
        .at(T0 + ADMIN_TIMELOCK_MS)
        .set();
    c.execute_admin_proposal();
    assert_eq!(c.get_config()["keeper_admin"], "multisig.testnet");
    Ctx::new().by("admin.testnet").dep(1).set();
    let m = panics(|| c.propose_keeper(Some(acc("x.testnet"))));
    assert!(m.contains("only the keeper admin"), "{m}");
    // the new admin may give the role up (also timelocked)
    admin_executes_as(&mut c, "multisig.testnet", T0 + ADMIN_TIMELOCK_MS, |c| {
        c.set_keeper_admin(None)
    });
    assert!(c.get_config()["keeper_admin"].is_null());
}

fn admin_executes_as(c: &mut Contract, who: &str, at: u64, f: impl FnOnce(&mut Contract)) {
    Ctx::new().by(who).dep(1).at(at).set();
    f(c);
    Ctx::new()
        .by("anyone.testnet")
        .at(at + ADMIN_TIMELOCK_MS)
        .set();
    c.execute_admin_proposal();
}

/// The keeper admin is never an operator or a keeper: it cannot drive step 3 in the operator
/// hour, re-sign or record a broadcast.
#[test]
fn v3_h1_admin_is_not_an_operator() {
    let mut c = at_step3(vec![base_payout()]);
    let vault = v(&c);
    assert!(!c.is_operator(&vault, &admin()));
    assert!(!c.is_keeper(&vault, &admin()));
    Ctx::new().by("admin.testnet").at(T0 + 42_000).set();
    let m = panics(|| {
        let _ = c.execute_step(1.into(), Some(evm(1_500_000_000, 1_000_000, 21_000)));
    });
    assert!(m.contains("during the first hour only"), "{m}");
    Ctx::new().by("keeper.testnet").at(T0 + 42_000).set();
    let _ = c.execute_step(1.into(), Some(evm(1_500_000_000, 1_000_000, 21_000)));
    let key = step3_evm_key();
    Ctx::new().by("dmw.testnet").at(T0 + 42_500).cb();
    assert_eq!(c.on_foreign_signed(1, 0, key, Ok(mpc_secp_response())), 4);
    let t = T0 + 42_000 + foreign::RESIGN_COOLDOWN_MS;
    Ctx::new().by("admin.testnet").at(t).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, evm(2_000_000_000, 2_000_000, 21_000));
    });
    assert!(
        m.contains("only the keeper, the vault owner or an heir"),
        "{m}"
    );
    let txid = foreign::expected_tx_id(
        ForeignChain::Base,
        v(&c).foreign[0].signed_tx.as_deref().unwrap(),
    )
    .unwrap();
    let m = panics(|| c.mark_broadcast(1.into(), 0, txid));
    assert!(m.contains("may mark a payout broadcast"), "{m}");
}

#[test]
fn v3_h1_init_checks_keeper_admin() {
    Ctx::new().set();
    let m = panics(|| {
        Contract::new(
            contract_id(),
            Some(acc("k.testnet")),
            None,
            Some(contract_id()),
        );
    });
    assert!(m.contains("keeper_admin cannot be the dmw contract"), "{m}");
    let m = panics(|| {
        Contract::new(
            contract_id(),
            Some(acc("k.testnet")),
            None,
            Some(acc("k.testnet")),
        );
    });
    assert!(m.contains("must be different accounts"), "{m}");
    let c = Contract::new(contract_id(), None, None, Some(admin()));
    let cfg = c.get_config();
    assert_eq!(cfg["keeper_admin"], "admin.testnet");
    assert_eq!(cfg["admin_timelock_ms"], ADMIN_TIMELOCK_MS);
    assert!(cfg["admin_proposal"].is_null());
    assert!(cfg["pending_keeper"].is_null());
    assert_eq!(cfg["max_keeper_solana_resigns"], 3);
    // the admin can still appoint a keeper on a locked contract that started without one
    let mut c = c;
    admin_executes(&mut c, T0, |c| c.propose_keeper(Some(acc("k.testnet"))));
    assert_eq!(c.get_config()["keeper"], "k.testnet");
}

// ------------------------------------------------------------------------------------------
// H-1(4): two-step keeper handover
// ------------------------------------------------------------------------------------------

/// Reviewer PoC `poc_locked_keeper_handover_is_irreversible`, turned around: handing the role to
/// an account nobody controls no longer takes effect, the keeper keeps the role and can cancel.
#[test]
fn v3_poc_locked_keeper_handover_needs_acceptance() {
    let mut c = setup();
    let void = "0000000000000000000000000000000000000000000000000000000000000000";
    Ctx::new().by("keeper.testnet").dep(1).set();
    c.set_keeper(Some(acc(void)));
    assert_eq!(c.get_config()["keeper"], "keeper.testnet");
    assert_eq!(c.get_config()["pending_keeper"], void);
    assert!(get_logs().iter().any(|l| l.contains("keeper_proposed")));
    // the keeper still acts and can withdraw the offer by naming itself
    Ctx::new().by("keeper.testnet").dep(1).set();
    c.set_keeper(Some(acc("keeper.testnet")));
    assert!(c.get_config()["pending_keeper"].is_null());
    // a real successor must accept, with 1 yocto, and only it
    c.set_keeper(Some(acc("keeper2.testnet")));
    for who in ["mallory.testnet", "keeper.testnet", "dmw.testnet"] {
        Ctx::new().by(who).dep(1).set();
        let m = panics(|| c.accept_keeper());
        assert!(m.contains("only the pending keeper"), "{who}: {m}");
    }
    Ctx::new().by("keeper2.testnet").set();
    let m = panics(|| c.accept_keeper());
    assert!(m.contains("exactly 1 yoctoNEAR"), "{m}");
    Ctx::new().by("keeper2.testnet").dep(1).set();
    c.accept_keeper();
    assert_eq!(c.get_config()["keeper"], "keeper2.testnet");
    assert!(c.get_config()["pending_keeper"].is_null());
    // the old keeper has no say any more; the keeper may not hand over to the admin
    Ctx::new().by("keeper.testnet").dep(1).set();
    let m = panics(|| c.set_keeper(Some(acc("keeper.testnet"))));
    assert!(
        m.contains("only the contract owner or the current keeper"),
        "{m}"
    );
    Ctx::new().by("keeper2.testnet").dep(1).set();
    let m = panics(|| c.set_keeper(Some(admin())));
    assert!(m.contains("must be different accounts"), "{m}");
}

/// Unlocked deployment: the contract owner's appointment is two-step too; clearing is immediate.
#[test]
fn v3_owner_set_keeper_is_two_step_and_clear_is_immediate() {
    Ctx::new().set();
    let mut c = Contract::new(acc("deployer.testnet"), None, None, None);
    Ctx::new().by("deployer.testnet").dep(1).set();
    c.set_keeper(Some(acc("keeper.testnet")));
    assert!(c.get_config()["keeper"].is_null());
    Ctx::new().by("keeper.testnet").dep(1).set();
    c.accept_keeper();
    assert_eq!(c.get_config()["keeper"], "keeper.testnet");
    Ctx::new().by("deployer.testnet").dep(1).set();
    c.set_keeper(Some(acc("keeper2.testnet")));
    c.set_keeper(None);
    assert!(c.get_config()["keeper"].is_null());
    assert!(c.get_config()["pending_keeper"].is_null());
}

// ------------------------------------------------------------------------------------------
// H-1(1) / L-4: one Solana payout per vault, capped keeper re-signs, validated payouts
// ------------------------------------------------------------------------------------------

#[test]
fn v3_l4_at_most_one_solana_payout_per_vault() {
    let mut c = setup();
    Ctx::new().dep(1).set();
    let m = panics(|| {
        c.set_foreign_payouts(1.into(), vec![sol_payout(1), sol_payout(2)]);
    });
    assert!(
        m.contains("too many solana payouts (max 1 per vault)"),
        "{m}"
    );
    c.set_foreign_payouts(1.into(), vec![sol_payout(1), base_payout(), base_payout()]);
    assert_eq!(v(&c).foreign.len(), 3);
    let sol = c.get_config()["chains"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["chain"] == "solana")
        .cloned()
        .unwrap();
    assert_eq!(sol["max_payouts"], 1);
    assert_eq!(sol["max_keeper_resigns"], 3);
}

#[test]
fn v3_l4_foreign_to_and_amount_are_validated() {
    let mut c = setup();
    Ctx::new().dep(1).set();
    let bad_sol = [
        "not-base58-0OIl",
        "11111111111111111111111111111", // 29 chars: decodes to fewer than 32 bytes
        "2NEpo7TZRRrLZSi2U",             // valid base58, too short
        "0x0000000000000000000000000000000000000000",
    ];
    for to in bad_sol {
        let p = ForeignPayout {
            to: to.into(),
            ..sol_payout(1)
        };
        let m = panics(|| c.set_foreign_payouts(1.into(), vec![p]));
        assert!(
            m.contains("solana `to` must be a base58 32-byte"),
            "{to}: {m}"
        );
    }
    let m = panics(|| {
        c.set_foreign_payouts(1.into(), vec![sol_payout(u128::from(u64::MAX) + 1)]);
    });
    assert!(m.contains("solana amount must fit in u64"), "{m}");
    c.set_foreign_payouts(1.into(), vec![sol_payout(u128::from(u64::MAX))]);
    for to in [
        "ab".repeat(20),                  // no 0x
        format!("0x{}", "ab".repeat(19)), // 38 hex
        format!("0x{}", "zz".repeat(20)), // not hex
        format!("0X{}", "ab".repeat(20)), // upper-case prefix
    ] {
        let p = ForeignPayout {
            to: to.clone(),
            ..base_payout()
        };
        let m = panics(|| c.set_foreign_payouts(1.into(), vec![p]));
        assert!(m.contains("evm `to` must be 0x + 40 hex"), "{to}: {m}");
    }
}

/// Reviewer PoC `poc_keeper_resigns_signed_solana_unboundedly`, turned around: a keeper may
/// re-sign a signed Solana payout 3 times (failed MPC calls count too), then never again, until
/// the keeper admin installs a new keeper (new epoch).
#[test]
fn v3_poc_keeper_solana_resigns_capped_at_three() {
    let mut c = at_step3(vec![sol_payout(1_000_000)]);
    assert_eq!(sol_sign_step3(&mut c, "keeper.testnet", T0 + 41_000), 4);
    let mut t = T0 + 41_000;
    for i in 0..3 {
        t += foreign::RESIGN_COOLDOWN_MS;
        // the second one's MPC call fails: it still counts
        assert_eq!(keeper_sol_resign(&mut c, "keeper.testnet", t, i != 1), None);
        assert_eq!(c.get_sign_track(1.into(), 0)["keeper_resigns"], i + 1);
    }
    assert_eq!(c.get_sign_track(1.into(), 0)["keeper_resigns_left"], 0);
    t += foreign::RESIGN_COOLDOWN_MS;
    let m = keeper_sol_resign(&mut c, "keeper.testnet", t, true).expect("4th re-sign refused");
    assert!(m.contains("keeper re-sign limit reached"), "{m}");
    // a vault keeper shares the same per-payout count
    // (only the owner could set one, and only while Live; covered by the epoch rule below)
    // the admin replaces the keeper: the new keeper gets a fresh allowance
    admin_executes(&mut c, t, |c| {
        c.propose_keeper(Some(acc("keeper2.testnet")))
    });
    t += ADMIN_TIMELOCK_MS;
    assert_eq!(c.get_sign_track(1.into(), 0)["keeper_resigns"], 0);
    let m = keeper_sol_resign(&mut c, "keeper.testnet", t, true).expect("old keeper refused");
    assert!(
        m.contains("only the keeper, the vault owner or an heir"),
        "{m}"
    );
    assert_eq!(keeper_sol_resign(&mut c, "keeper2.testnet", t, true), None);
    assert_eq!(c.get_sign_track(1.into(), 0)["keeper_resigns"], 1);
}

/// The count only applies to payouts that already have a signature: heirs re-sign a failed
/// Solana payout without using it up.
#[test]
fn v3_h1_failed_solana_resign_does_not_use_keeper_allowance() {
    let mut c = at_step3(vec![sol_payout(1_000_000)]);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), Some(sol_args()));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).cb();
    let _ = c.on_foreign_sol_key(
        1,
        0,
        SOL_BH.into(),
        None,
        None,
        Ok(format!("ed25519:{SOL_FROM}")),
    );
    assert_eq!(
        c.on_foreign_signed(1, 0, None, Err(near_sdk::PromiseError::Failed)),
        4
    );
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Failed);
    let t = T0 + 41_000 + foreign::RESIGN_COOLDOWN_MS;
    assert_eq!(keeper_sol_resign(&mut c, "sarah.testnet", t, true), None);
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Signed);
    assert_eq!(c.get_sign_track(1.into(), 0)["keeper_resigns"], 0);
}

// ------------------------------------------------------------------------------------------
// M-1: Solana step-3 params only from operators
// ------------------------------------------------------------------------------------------

/// Reviewer PoC `poc_stranger_solana_blockhash_then_heir_cannot_resign`, turned around: after the
/// operator hour a stranger cannot sign a Solana payout. The call only moves settlement on (the
/// payout is recorded failed, with no signature), and an heir can re-sign it at once.
#[test]
fn v3_poc_stranger_cannot_sign_solana_after_the_hour() {
    let mut c = at_step3(vec![sol_payout(1_000_000), base_payout()]);
    let open = T0 + 41_000 + STEP3_OPEN_AFTER_MS;
    Ctx::new().by("mallory.testnet").at(open - 1).set();
    let m = panics(|| {
        let _ = c.execute_step(1.into(), Some(sol_args()));
    });
    assert!(m.contains("during the first hour only"), "{m}");
    Ctx::new().by("mallory.testnet").at(open).set();
    assert!(matches!(
        c.execute_step(1.into(), Some(sol_args())),
        PromiseOrValue::Value(3)
    ));
    assert!(call_receivers("derived_public_key").is_empty());
    assert!(call_receivers("sign").is_empty());
    let p = &v(&c).foreign[0];
    assert_eq!(p.status, ForeignStatus::Failed);
    assert!(p.signed_tx.is_none());
    assert_eq!(v(&c).foreign_index, 1);
    assert!(v(&c).foreign_inflight_since_ms.is_none());
    // an heir re-signs it right away (no cooldown: nothing was ever requested for it)
    Ctx::new().by("sarah.testnet").at(open + 1).set();
    let _ = c.resign_foreign(1.into(), 0, sol_args());
    assert!(foreign::read_track(1, 0).inflight);
    // EVM payouts keep the 1 h opening (a stranger's signature only replaces: pinned nonce)
    Ctx::new()
        .by("mallory.testnet")
        .at(open + 1 + STEP3_OPEN_AFTER_MS)
        .set();
    assert!(matches!(
        c.execute_step(1.into(), Some(evm(1_500_000_000, 1_000_000, 21_000))),
        PromiseOrValue::Promise(_)
    ));
}

// ------------------------------------------------------------------------------------------
// H-1(3): a keeper's high EVM fee no longer locks heirs out
// ------------------------------------------------------------------------------------------

/// Reviewer PoC `poc_keeper_cap_fee_locks_out_heirs`, turned around.
#[test]
fn v3_h1_heir_replaces_keeper_cap_fee_at_clamp() {
    let mut c = at_step3(vec![base_payout()]);
    let cap = foreign::MAX_EVM_FEE_PER_GAS;
    let clamp = foreign::BASE_SEPOLIA.non_keeper_max_fee_per_gas;
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), Some(evm(cap, cap / 2, 100_000)));
    let key = step3_evm_key();
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).cb();
    assert_eq!(c.on_foreign_signed(1, 0, key, Ok(mpc_secp_response())), 4);
    let t = T0 + 41_500 + foreign::RESIGN_COOLDOWN_MS;
    // below the clamp: still refused (no downgrade below what a non-keeper may pick)
    Ctx::new().by("sarah.testnet").at(t).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, evm(1_500_000_000, 1_000_000, 21_000));
    });
    assert!(
        m.contains("max_fee_per_gas must be the non-keeper limit"),
        "{m}"
    );
    // at the clamp: accepted; fees and gas limit are the non-keeper limits, nonce pinned
    let _ = c.resign_foreign(1.into(), 0, evm(cap, cap, 100_000));
    let calls = created_calls("on_foreign_evm_key");
    assert_eq!(calls.len(), 1);
    let pending: foreign::PendingTx = serde_json::from_value(calls[0]["pending"].clone()).unwrap();
    let foreign::PendingTx::Evm(tx) = &pending else {
        panic!("evm")
    };
    assert_eq!(
        (tx.max_fee_per_gas.0, tx.max_priority_fee_per_gas.0),
        (clamp, clamp)
    );
    assert_eq!(tx.gas_limit.0, foreign::EVM_GAS_LIMIT_FLOOR);
    assert_eq!(tx.nonce, 0);
    let key = key_for(&pending);
    Ctx::new().by("dmw.testnet").at(t + 500).cb();
    assert_eq!(
        c.on_foreign_resigned(1, 0, pending, Some(t), key, Ok(mpc_secp_response())),
        "signed"
    );
    assert_eq!(foreign::read_track(1, 0).max_fee_per_gas, clamp);
    // no flip-flopping: the next non-keeper re-sign is back under the bump rule
    Ctx::new()
        .by("tom.testnet")
        .at(t + foreign::RESIGN_COOLDOWN_MS)
        .set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, evm(cap, cap, 100_000));
    });
    assert!(m.contains("raise both fees"), "{m}");
}

/// The clamp replacement may not lower the priority fee below min(last, clamp).
#[test]
fn v3_h1_clamp_replacement_keeps_priority_fee() {
    let mut c = at_step3(vec![base_payout()]);
    let cap = foreign::MAX_EVM_FEE_PER_GAS;
    let clamp = foreign::BASE_SEPOLIA.non_keeper_max_fee_per_gas;
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), Some(evm(cap, 2_000_000_000, 21_000)));
    let key = step3_evm_key();
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).cb();
    assert_eq!(c.on_foreign_signed(1, 0, key, Ok(mpc_secp_response())), 4);
    let t = T0 + 41_500 + foreign::RESIGN_COOLDOWN_MS;
    Ctx::new().by("sarah.testnet").at(t).set();
    let m = panics(|| {
        let _ = c.resign_foreign(1.into(), 0, evm(clamp, 1_000_000_000, 21_000));
    });
    assert!(m.contains("priority fee may not drop"), "{m}");
    let _ = c.resign_foreign(1.into(), 0, evm(clamp, 2_000_000_000, 21_000));
    assert!(foreign::read_track(1, 0).inflight);
}

// ------------------------------------------------------------------------------------------
// L-3: re-sign fees recorded only on success
// ------------------------------------------------------------------------------------------

#[test]
fn v3_l3_failed_resign_keeps_previous_fees_and_heirs_can_retry() {
    let mut c = at_step3(vec![base_payout()]);
    let clamp = foreign::BASE_SEPOLIA.non_keeper_max_fee_per_gas;
    Ctx::new().by("tom.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), Some(evm(5_000_000_000, 1_000_000_000, 21_000)));
    let key = step3_evm_key();
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).cb();
    assert_eq!(c.on_foreign_signed(1, 0, key, Ok(mpc_secp_response())), 4);
    // an heir re-signs at the clamp; the MPC call fails
    let t = T0 + 41_500 + foreign::RESIGN_COOLDOWN_MS;
    Ctx::new().by("sarah.testnet").at(t).set();
    let _ = c.resign_foreign(1.into(), 0, evm(clamp, clamp, 21_000));
    let tr = foreign::read_track(1, 0);
    assert!(tr.inflight);
    assert_eq!(tr.max_fee_per_gas, 5_000_000_000, "not written up front");
    let pending: foreign::PendingTx =
        serde_json::from_value(created_calls("on_foreign_evm_key")[0]["pending"].clone()).unwrap();
    Ctx::new().by("dmw.testnet").at(t + 500).cb();
    assert_eq!(
        c.on_foreign_resigned(
            1,
            0,
            pending,
            Some(t),
            None,
            Err(near_sdk::PromiseError::Failed)
        ),
        "signed"
    );
    let tr = foreign::read_track(1, 0);
    assert!(!tr.inflight);
    assert_eq!(
        (tr.max_fee_per_gas, tr.max_priority_fee_per_gas),
        (5_000_000_000, 1_000_000_000)
    );
    // v2 would now demand >= 110% of the clamp (impossible for an heir); v3 accepts the retry
    Ctx::new()
        .by("sarah.testnet")
        .at(t + foreign::RESIGN_COOLDOWN_MS)
        .set();
    let _ = c.resign_foreign(1.into(), 0, evm(clamp, clamp, 21_000));
    assert!(foreign::read_track(1, 0).inflight);
    // the failed attempt went to the routine ring, not the key-event history
    assert!(v(&c).log.iter().any(|e| e.event == "foreign_resign_failed"));
    assert!(!v(&c)
        .history
        .iter()
        .any(|e| e.event == "foreign_resign_failed"));
}

// ------------------------------------------------------------------------------------------
// M-2: callback gas
// ------------------------------------------------------------------------------------------

/// Vault 1 grown to the largest size its fields allow: both rings full of 400-byte details, 10
/// heirs and allowlist entries with 64-char names, 5+5 keys, 24 spends, 4 signed payouts.
fn maximal_vault(c: &mut Contract) {
    let long = |i: usize| -> AccountId { acc(&format!("{:0>54}{i:02}.testnet", "h")) };
    let mut vault = v(c);
    vault.heirs = (0..10)
        .map(|i| Heir {
            account_id: long(i),
            bps: 1000,
        })
        .collect();
    vault.policy.allowlist = (0..MAX_ALLOWLIST).map(|i| long(20 + i)).collect();
    let pk = |n: u8| -> PublicKey {
        let mut b = vec![0u8];
        b.extend([n; 32]);
        PublicKey::try_from(b).unwrap()
    };
    vault.pulse_keys = (0..5).map(pk).collect();
    vault.agent_keys = (5..10).map(pk).collect();
    vault.spends = (0..MAX_SPENDS as u64)
        .map(|i| Spend {
            ms: T0 + i,
            amount: U128(u128::MAX),
        })
        .collect();
    vault.foreign = (0..MAX_FOREIGN)
        .map(|_| ForeignPayout {
            from_address: format!("0x{}", "cd".repeat(20)),
            status: ForeignStatus::Broadcast,
            signed_tx: Some(format!("0x{}", "ef".repeat(140))),
            tx_hash: Some(format!("0x{}", "12".repeat(32))),
            ..base_payout()
        })
        .collect();
    let entry = |seq: u64| LogEntry {
        ms: T0,
        event: "foreign_broadcast_padding".into(),
        detail: "x".repeat(MAX_DETAIL),
        seq,
    };
    vault.history = (0..MAX_HISTORY as u64).map(entry).collect();
    vault.log = (0..MAX_LOG as u64).map(|i| entry(100 + i)).collect();
    c.vaults.insert(&1, &vault);
}

fn gas_used_tgas() -> f64 {
    env::used_gas().as_gas() as f64 / 1e12
}

/// The failure path of `on_transfer_done` on a maximal vault: one vault write, and the host-side
/// gas (storage, logs, promises; the mock does not meter wasm instructions) stays far inside the
/// 10 TGas budget, with room for the wasm work (I-11 measured ~1.5 TGas of it on v1).
#[test]
fn v3_m2_on_transfer_done_failure_path_fits_budget() {
    let mut c = setup();
    maximal_vault(&mut c);
    let len = blob_len(&v(&c));
    assert!(len > 30_000, "maximal vault is {len} bytes");
    let bal = v(&c).balance;
    Ctx::new()
        .by("dmw.testnet")
        .with_result(PromiseResult::Failed);
    let g0 = gas_used_tgas();
    assert!(!c.on_transfer_done(1, acc("ghost.testnet"), U128(NEAR1), "heir".into()));
    let used = gas_used_tgas() - g0;
    println!("on_transfer_done failure path, {len}-byte vault: {used:.2} TGas host gas");
    assert!(used < 6.0, "host gas {used} TGas");
    assert_eq!(v(&c).balance, bal + NEAR1);
}

/// The same work through the v2 path (write + charge_storage re-read and re-write) costs about
/// one more vault write: the measured saving of `save_vault_once`.
#[test]
fn v3_m2_single_write_saves_a_vault_write() {
    let mut c = setup();
    maximal_vault(&mut c);
    Ctx::new().by("dmw.testnet").set();
    let g0 = gas_used_tgas();
    let before = env::storage_usage();
    let mut vault = v(&c);
    record(
        &mut vault,
        1,
        "transfer_failed",
        "heir x 1",
        serde_json::json!({}),
    );
    c.vaults.insert(&1, &vault);
    c.charge_storage(1, before, false);
    let v2_path = gas_used_tgas() - g0;
    Ctx::new().by("dmw.testnet").set();
    let g0 = gas_used_tgas();
    let before = env::storage_usage();
    let mut vault = v(&c);
    let old = blob_len(&vault);
    record(
        &mut vault,
        1,
        "transfer_failed",
        "heir x 12",
        serde_json::json!({}),
    );
    c.save_vault_once(1, &mut vault, old, before);
    let v3_path = gas_used_tgas() - g0;
    println!("v2 write path {v2_path:.2} TGas, v3 single write {v3_path:.2} TGas");
    assert!(v3_path + 1.0 < v2_path, "{v3_path} vs {v2_path}");
}

/// `save_vault_once` charges exactly what `env::storage_usage` reports, including the other
/// writes of the call (the key registry removal in `on_key_added`). The mock counts storage use per
/// context, so each callback is checked inside its own context (plus the test-only assert in
/// `save_vault_once` itself).
#[test]
fn v3_m2_single_write_storage_accounting_is_exact() {
    let mut c = setup();
    Ctx::new().dep(1).set();
    let pkey: PublicKey = {
        let mut b = vec![0u8];
        b.extend([77u8; 32]);
        PublicKey::try_from(b).unwrap()
    };
    let _ = c.add_pulse_key(1.into(), pkey.clone());
    Ctx::new()
        .by("dmw.testnet")
        .with_result(PromiseResult::Failed);
    let (u0, b0) = (env::storage_usage(), v(&c).storage_bytes);
    assert!(!c.on_key_added(1, pkey, KeyKind::Pulse, Some(owner())));
    // the key registry entry is gone (usage shrinks), the history grew, the 200 key bytes released
    let delta = i128::from(env::storage_usage()) - i128::from(u0);
    let charged =
        i128::from(v(&c).storage_bytes) - i128::from(b0) + i128::from(ACCESS_KEY_STORAGE_BYTES);
    assert_eq!(charged, delta);
    Ctx::new()
        .by("dmw.testnet")
        .with_result(PromiseResult::Failed);
    let (u0, b0) = (env::storage_usage(), v(&c).storage_bytes);
    assert!(!c.on_transfer_done(1, acc("ghost.testnet"), U128(1), "claim".into()));
    assert!(env::storage_usage() > u0);
    assert_eq!(v(&c).storage_bytes - b0, env::storage_usage() - u0);
}

/// Steps 1 and 5 with 10 heirs on a maximal vault: everything the call burns or attaches (each
/// heir transfer + its 10 TGas callback, ~24.8 TGas per heir) stays under 300 TGas with room for
/// the wasm work (the mock meters host gas only). With 15 TGas callbacks this was 302.9 TGas.
#[test]
fn v3_m2_step1_and_step5_fit_300_tgas_with_10_heirs() {
    let mut c = setup();
    Ctx::new().by("bob.testnet").dep(100 * NEAR1).set();
    c.deposit(1.into());
    maximal_vault(&mut c);
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    let g0 = gas_used_tgas();
    assert_eq!(step(&mut c), 2);
    let step1 = gas_used_tgas() - g0;
    assert_eq!(created_calls("on_transfer_done").len(), 10);
    // steps 2-4 (all foreign payouts are already broadcast in this synthetic vault: skip them)
    let mut vault = v(&c);
    vault.step = 4;
    c.vaults.insert(&1, &vault);
    Ctx::new().by("keeper.testnet").at(T0 + 42_000).set();
    assert_eq!(step(&mut c), 5);
    Ctx::new()
        .by("bob.testnet")
        .dep(10 * NEAR1)
        .at(T0 + 42_000)
        .set();
    c.deposit(1.into()); // something for step 5 to split
    Ctx::new().by("keeper.testnet").at(T0 + 43_000).set();
    let g0 = gas_used_tgas();
    assert_eq!(step(&mut c), 6);
    let step5 = gas_used_tgas() - g0;
    println!("step 1: {step1:.1} TGas, step 5: {step5:.1} TGas (host gas incl. attached)");
    assert!(step1 < 265.0 && step5 < 265.0, "{step1} / {step5}");
    assert!(
        step1 > 100.0,
        "10 callbacks x 10 TGas are attached: {step1}"
    );
}

/// poke and claim (one transfer + its 10 TGas callback) on a maximal vault: ~29.7 TGas of host gas,
/// so callers must attach more than the 30 TGas the v2 dashboard used; 50 TGas leaves room for the
/// wasm work.
#[test]
fn v3_m2_poke_and_claim_fit_50_tgas() {
    let mut c = setup();
    Ctx::new().by("bob.testnet").dep(100 * NEAR1).set();
    c.deposit(1.into());
    maximal_vault(&mut c);
    Ctx::new().by("bob.testnet").at(T0 + 40_000).set();
    let g0 = gas_used_tgas();
    c.poke(1.into());
    let poke = gas_used_tgas() - g0;
    let mut vault = v(&c);
    vault.stored = StoredState::Settled;
    c.vaults.insert(&1, &vault);
    Ctx::new().by("alice.testnet").at(T0 + 50_000).set();
    let g0 = gas_used_tgas();
    c.claim(1.into());
    let claim = gas_used_tgas() - g0;
    println!("poke: {poke:.1} TGas, claim: {claim:.1} TGas (host gas incl. attached)");
    assert!(poke < 40.0 && claim < 40.0, "{poke} / {claim}");
}

// ------------------------------------------------------------------------------------------
// L-2: pinned history
// ------------------------------------------------------------------------------------------

/// 300 keeper re-signs (each a `foreign_signed` history entry) and 300 DAO ratifications do not
/// evict the trigger, the settlement steps or the creation record.
#[test]
fn v3_l2_resigns_and_dao_marks_do_not_evict_settlement_history() {
    let mut c = setup();
    Ctx::new().dep(1).set();
    c.set_foreign_payouts(1.into(), vec![base_payout()]);
    c.set_dao(1.into(), Some(acc("estate.sputnik-v2.testnet")));
    Ctx::new().by("bob.testnet").dep(10 * NEAR1).set();
    c.deposit(1.into());
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    step(&mut c);
    step(&mut c);
    let _ = c.execute_step(1.into(), Some(evm(1_500_000_000, 1_000_000, 21_000)));
    let key = step3_evm_key();
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).cb();
    assert_eq!(c.on_foreign_signed(1, 0, key, Ok(mpc_secp_response())), 4);
    Ctx::new().by("keeper.testnet").at(T0 + 42_000).set();
    let _ = c.execute_step(1.into(), None); // step 4: DAO proposal
    Ctx::new().by("dmw.testnet").at(T0 + 42_500).cb();
    assert_eq!(c.on_dao_proposal(1, Ok(7)), 5);
    Ctx::new().by("keeper.testnet").at(T0 + 43_000).set();
    assert_eq!(step(&mut c), 6);
    let mut t = T0 + 43_000;
    for i in 0..300u64 {
        t += foreign::RESIGN_COOLDOWN_MS;
        Ctx::new().by("keeper.testnet").at(t).set();
        let fee = 1_000_000_000 + u128::from(i);
        let _ = c.resign_foreign(1.into(), 0, evm(fee, 1_000_000, 21_000));
        let pending: foreign::PendingTx =
            serde_json::from_value(created_calls("on_foreign_evm_key")[0]["pending"].clone())
                .unwrap();
        let key = key_for(&pending);
        Ctx::new().by("dmw.testnet").at(t + 1).cb();
        assert_eq!(
            c.on_foreign_resigned(1, 0, pending, Some(t), key, Ok(mpc_secp_response())),
            "signed"
        );
        Ctx::new().by("estate.sputnik-v2.testnet").at(t + 2).set();
        c.mark_broadcast(1.into(), 0, "dao-ratified".into());
    }
    let h = v(&c).history;
    assert_eq!(h.len(), MAX_HISTORY);
    for e in [
        "vault_created",
        "triggered",
        "step_1",
        "step_2",
        "step_3",
        "step_4",
        "step_5",
        "settled",
    ] {
        assert!(h.iter().any(|x| x.event == e), "{e} evicted");
    }
    // only the first ratification is a key event
    assert_eq!(h.iter().filter(|x| x.event == "dao_ratified").count(), 1);
    // the view still merges both rings in order
    let log = c.get_vault(1.into()).unwrap().log;
    assert!(log.windows(2).all(|w| w[0].seq < w[1].seq));
}

// ------------------------------------------------------------------------------------------
// L-5: paged get_vaults_for_owner
// ------------------------------------------------------------------------------------------

#[test]
fn v3_l5_get_vaults_for_owner_is_paged() {
    let mut c = setup();
    for _ in 1..120 {
        Ctx::new().dep(STORAGE_FEE).set();
        c.create_vault(20, 1, heirs2(), None, None);
    }
    let all = |c: &Contract, f, l| {
        c.get_vaults_for_owner(owner(), f, l)
            .into_iter()
            .map(|x| x.token_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(all(&c, None, None).len(), OWNER_PAGE_DEFAULT as usize);
    assert_eq!(all(&c, None, Some(1_000)).len(), OWNER_PAGE_MAX as usize);
    assert_eq!(all(&c, Some(100), None).len(), 20);
    assert_eq!(all(&c, Some(118), Some(5)), vec!["119", "120"]);
    assert!(all(&c, Some(u64::MAX), None).is_empty());
    assert_eq!(all(&c, None, None)[0], "1");
}

// ------------------------------------------------------------------------------------------
// L-6: a sale raises the vault timing
// ------------------------------------------------------------------------------------------

#[test]
fn v3_l6_sale_raises_timing_so_buyer_cannot_be_poked() {
    let mut c = setup();
    Ctx::new().dep(1).set();
    c.set_timing(1.into(), 10, 0);
    c.set_foreign_payouts(1.into(), vec![sol_payout(1_000_000)]);
    c.nft_transfer(acc("buyer.testnet"), "1".into(), None, None);
    let vault = v(&c);
    assert_eq!(vault.heartbeat_interval_s, SALE_MIN_INTERVAL_S);
    assert_eq!(vault.grace_missed, SALE_MIN_GRACE);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"timing_raised\":true")));
    for dt in [10_000, 11_000, SALE_MIN_INTERVAL_S * 1000] {
        Ctx::new().by("seller-friend.testnet").at(T0 + dt).set();
        let m = panics(|| {
            c.poke(1.into());
        });
        assert!(m.contains("not_due"), "+{dt} ms: {m}");
    }
    // the buyer may still choose a short timing themselves
    Ctx::new().by("buyer.testnet").dep(1).at(T0 + 1_000).set();
    c.set_timing(1.into(), 10, 0);
    assert_eq!(v(&c).heartbeat_interval_s, 10);
    // a vault already above the minimum keeps its timing
    Ctx::new().by("buyer.testnet").dep(1).at(T0 + 2_000).set();
    c.set_timing(1.into(), 3 * 86_400, 4);
    c.nft_transfer(acc("carol.testnet"), "1".into(), None, None);
    assert_eq!(
        (v(&c).heartbeat_interval_s, v(&c).grace_missed),
        (3 * 86_400, 4)
    );
}

// ------------------------------------------------------------------------------------------
// L-1 (contract side): a resolve call without its promise result changes nothing
// ------------------------------------------------------------------------------------------

/// Reviewer PoC `poc_private_callback_from_contract_key_steals_nft`, turned around.
#[test]
fn v3_poc_resolve_without_result_cannot_move_a_vault() {
    let mut c = setup();
    Ctx::new().by("dmw.testnet").set(); // predecessor == contract, no promise results
    assert!(c.nft_resolve_transfer(acc("mallory.testnet"), owner(), "1".into(), None));
    assert_eq!(v(&c).owner_id, owner());
    assert_eq!(v(&c).heirs, heirs2());
    assert_eq!(v(&c).balance, 10 * NEAR1);
}
