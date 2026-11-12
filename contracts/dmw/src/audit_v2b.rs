//! Second adversarial pass over contract v2 (after fb279cd). Tests named `audit2_` assert the
//! SAFE behaviour and FAIL against the current code (findings). `cargo test --locked audit2_`.

#![allow(dead_code)]
use super::*;
use near_sdk::test_utils::VMContextBuilder;
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
    gas_tgas: u64,
}

impl Ctx {
    fn new() -> Self {
        Self {
            now_ms: T0,
            pred: owner(),
            signer: owner(),
            signer_pk: pk(200),
            deposit: 0,
            gas_tgas: 300,
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
            .prepaid_gas(Gas::from_tgas(self.gas_tgas))
            .account_balance(NearToken::from_near(1000));
        b
    }
    fn set(&self) {
        testing_env!(self.builder().build());
    }
    fn cb(&self) {
        testing_env!(
            self.builder().build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
    }
    fn by(mut self, a: &str) -> Self {
        self.pred = acc(a);
        self.signer = acc(a);
        self
    }
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
    fn gas(mut self, tgas: u64) -> Self {
        self.gas_tgas = tgas;
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

fn open_policy() -> Policy {
    Policy {
        per_tx_max: U128(NEAR1),
        daily_max: U128(5 * NEAR1),
        allowlist: vec![],
    }
}

/// Contract (locked: owner_id is the contract itself) + vault 1 with 10 NEAR balance.
fn setup() -> Contract {
    Ctx::new().set();
    let mut c = Contract::new(contract_id(), Some(acc("keeper.testnet")), None);
    Ctx::new().dep(10 * NEAR1 + STORAGE_FEE).set();
    let id = c.create_vault(
        20,
        1,
        heirs2(),
        Some(open_policy()),
        Some(U128(NEAR1 / 100)),
    );
    assert_eq!(id.0, 1);
    c
}

fn add_confirmed_key(c: &mut Contract, k: PublicKey, kind: KeyKind) {
    Ctx::new().dep(1).set();
    let _ = match kind {
        KeyKind::Pulse => c.add_pulse_key(1.into(), k.clone()),
        KeyKind::Agent => c.add_agent_key(1.into(), k.clone()),
    };
    Ctx::new().by("dmw.testnet").cb();
    assert!(c.on_key_added(1, k, kind, Some(owner())));
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

/// Some(panic message) if `f` panicked, None if it returned.
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

/// The key `mpc_secp_response()` recovers to over pending tx `index` of vault 1, in the
/// signer's `derived_public_key` format (so the contract's ecrecover check passes).
fn evm_key(index: usize) -> Option<String> {
    use foreign::chainsig::{ecrecover64, evm_sighash, evm_tx};
    let raw = env::storage_read(format!("chainsig:pending:1:{index}").as_bytes())?;
    let foreign::PendingTx::Evm(t) = near_sdk::borsh::from_slice(&raw).ok()? else {
        return None;
    };
    let r = mpc_secp_response();
    let mut rs = [0u8; 64];
    rs[..32]
        .copy_from_slice(&hex::decode(&r["big_r"]["affine_point"].as_str().unwrap()[2..]).unwrap());
    rs[32..].copy_from_slice(&hex::decode(r["s"]["scalar"].as_str().unwrap()).unwrap());
    let k = ecrecover64(&evm_sighash(&evm_tx(&t).unwrap()), &rs, 1)?;
    Some(format!(
        "secp256k1:{}",
        near_sdk::bs58::encode(k).into_string()
    ))
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

// ------------------------------------------------------------------------------------------
// G1 (low; F4 is only partly closed). The EVM fee ratchet still only goes UP. A non-keeper
// heir may sign the first step-3 signature during the operator window (racing the keeper right
// after step 2), or anyone may after the hour; the clamp still lets them pick 50% of the cap
// (Base: 50 gwei max fee, 10 gwei priority, 50k gas => the node demands value + 0.0025 ETH).
// The keeper can then only re-sign at >= 110% of those fees or at the cap, never at an honest
// fee, so unless someone tops up the derived address the payout cannot be mined.
// ------------------------------------------------------------------------------------------

#[test]
fn audit2_heir_preempts_keeper_and_keeper_cannot_lower_fees() {
    let mut c = at_step3(vec![base_payout()]);
    let cap = foreign::MAX_EVM_FEE_PER_GAS;
    // heir tom.testnet signs first, inside the operator window, asking for the cap (clamped)
    Ctx::new().by("tom.testnet").at(T0 + 41_000).set();
    let _ = c.execute_step(1.into(), Some(evm(cap, cap, 100_000)));
    Ctx::new().by("dmw.testnet").at(T0 + 41_500).cb();
    let key = evm_key(0);
    assert_eq!(c.on_foreign_signed(1, 0, key, Ok(mpc_secp_response())), 4);
    let t = foreign::read_track(1, 0);
    // (G1 fix: the non-keeper clamp is now 10% of the Base cap; the reviewer's original line
    // asserted the old 50% clamp, `cap / 2`)
    assert_eq!(t.max_fee_per_gas, cap / 10);
    assert_eq!(t.max_priority_fee_per_gas, cap / 10);
    // the keeper wants the honest Base fee (1.5 gwei / 0.001 gwei) after the cooldown
    Ctx::new()
        .by("keeper.testnet")
        .at(T0 + 41_500 + foreign::RESIGN_COOLDOWN_MS)
        .set();
    let r = try_call(|| {
        let _ = c.resign_foreign(1.into(), 0, evm(1_500_000_000, 1_000_000, 21_000));
    });
    assert!(
        r.is_none(),
        "FINDING G1: after an heir's clamped 50 gwei / 10 gwei signature the keeper cannot re-sign \
         at an honest fee: {r:?}"
    );
}
