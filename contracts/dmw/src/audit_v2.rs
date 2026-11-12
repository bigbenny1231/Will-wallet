//! Adversarial audit of contract v2 (Nov 12 2026). Every test here asserts the SAFE
//! behaviour and FAILS against the current code: each failure is a finding.
//! `cargo test --locked audit_` runs only these.

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
// F1 (high): any heir may re-sign a Solana payout that is already signed / broadcast.
// A Solana transfer has no nonce: each new blockhash gives a second, independently valid
// payment from the shared `sol-<id>-<salt>` address. v1 allowed this only for the contract
// owner / keeper; v2 lets every heir (and the vault keeper) do it every 5 minutes.
// ------------------------------------------------------------------------------------------

#[test]
fn audit_heir_can_resign_broadcast_solana_payout() {
    let mut c = at_step3(vec![sol_payout(1_000_000)]);
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
    let resp = serde_json::json!({"scheme": "Ed25519", "signature": hex::decode(SOL_SIG).unwrap()});
    assert_eq!(c.on_foreign_signed(1, 0, None, Ok(resp)), 4);
    // the keeper relays it and records the hash: the heir has been paid on Solana
    let txid = near_sdk::bs58::encode(hex::decode(SOL_SIG).unwrap()).into_string();
    Ctx::new().by("keeper.testnet").at(T0 + 42_000).set();
    c.mark_broadcast(1.into(), 0, txid);
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Broadcast);

    // 5 minutes later an heir asks for a fresh signature over the same transfer with a new
    // blockhash: a second valid payment out of the same derived address.
    Ctx::new()
        .by("tom.testnet")
        .at(T0 + 41_000 + foreign::RESIGN_COOLDOWN_MS)
        .set();
    let r = try_call(|| {
        let _ = c.resign_foreign(1.into(), 0, sol_args());
    });
    assert!(
        r.is_some(),
        "FINDING F1: heir tom.testnet re-signed an already broadcast Solana payout \
         (a second live payment); v1 limited this to the contract owner / keeper"
    );
}

// ------------------------------------------------------------------------------------------
// F2 (medium): the key-allowance refund only counts key calls that SUCCEED. A key-signed call
// that panics burns gas from the 1 NEAR allowance (paid by the contract account, i.e. every
// vault's pooled NEAR) but its `note_key_gas` write is reverted. So an owner (or a rogue agent
// key) can burn the whole allowance with failing calls, and `remove_key` / step 2 / a sale
// still credits ~0.99 NEAR "unspent" back to the vault out of other vaults' NEAR. Repeatable.
// ------------------------------------------------------------------------------------------

#[test]
fn audit_key_refund_ignores_reverted_key_calls() {
    let mut c = setup();
    add_confirmed_key(&mut c, pk(2), KeyKind::Agent);
    let calls = 200u128;
    for _ in 0..calls {
        // signed by the vault's own agent key, 300 TGas prepaid, panics (no such vault):
        // the protocol charges the key's allowance, the contract records nothing
        Ctx::new().key(pk(2)).gas(300).at(T0 + 1_000).set();
        let r = try_call(|| {
            c.agent_pay(999.into(), acc("x.testnet"), U128(1), None);
        });
        assert!(r.is_some());
    }
    let before = v(&c).balance;
    Ctx::new().dep(1).at(T0 + 2_000).set();
    c.remove_key(1.into(), pk(2));
    let refund = v(&c).balance - before;
    // even at the protocol's minimum burn (~2.4 TGas tx conversion per call, 1e8 yocto/gas)
    // these calls cost the pool at least this much of the allowance
    let min_burn = calls * 2_400_000_000_000 * KEY_GAS_PRICE;
    assert!(
        refund + min_burn <= KEY_ALLOWANCE,
        "FINDING F2: refund {refund} yocto ignores >= {min_burn} yocto of allowance burnt by \
         reverted key calls; the difference comes out of other vaults' NEAR"
    );
}

// ------------------------------------------------------------------------------------------
// F3 (low): key-allowance refunds (step 2) and the storage release (step 5) are credited to
// the vault balance AFTER step 1 split it by bps, so they all go to the primary heir via
// `claim` (up to ~9.9 NEAR with 10 keys). Secondary heirs lose their share.
// ------------------------------------------------------------------------------------------

#[test]
fn audit_post_step1_credits_skip_the_heir_split() {
    let mut c = setup();
    add_confirmed_key(&mut c, pk(1), KeyKind::Pulse);
    add_confirmed_key(&mut c, pk(2), KeyKind::Agent);
    trigger(&mut c);
    Ctx::new().by("keeper.testnet").at(T0 + 41_000).set();
    assert_eq!(step(&mut c), 2); // heirs paid 60/40 from (balance - 0.1 NEAR reserve)
    let after_step1 = v(&c).balance;
    assert_eq!(step(&mut c), 3); // keys deleted, allowances refunded into the balance
    assert_eq!(step(&mut c), 4);
    assert_eq!(step(&mut c), 5);
    assert_eq!(step(&mut c), 6); // storage released into the balance; sarah owns the NFT
    let claimable = v(&c).balance;
    Ctx::new().by("sarah.testnet").at(T0 + 50_000).set();
    assert_eq!(c.claim(1.into()).0, claimable);
    let missed = claimable - after_step1;
    assert!(
        missed < NEAR1 / 100,
        "FINDING F3: {missed} yocto credited after step 1 went 100% to the primary heir \
         (tom.testnet's 40% share of it was never paid)"
    );
}

// ------------------------------------------------------------------------------------------
// F4 (low): once the 1-hour operator window of a step-3 payout is over, a stranger may sign an
// EVM payout at the fee cap and the 100k gas limit. A signed payout can only be re-signed
// with both fees >= 110% of the last request, which is above the cap, so nobody (not even
// the keeper) can ever re-sign it cheaper. If the derived address holds less than
// value + gas_limit x max_fee the tx can never be mined: the payout is stuck until somebody
// tops the derived address up.
// ------------------------------------------------------------------------------------------

#[test]
fn audit_stranger_cap_fee_signature_blocks_every_resign() {
    let mut c = at_step3(vec![base_payout()]);
    let cap = foreign::MAX_EVM_FEE_PER_GAS;
    Ctx::new()
        .by("mallory.testnet")
        .at(T0 + 41_000 + STEP3_OPEN_AFTER_MS)
        .set();
    let _ = c.execute_step(1.into(), Some(evm(cap, cap, 100_000)));
    Ctx::new()
        .by("dmw.testnet")
        .at(T0 + 41_500 + STEP3_OPEN_AFTER_MS)
        .cb();
    let key = evm_key(0);
    assert!(key.is_some());
    assert_eq!(c.on_foreign_signed(1, 0, key, Ok(mpc_secp_response())), 4);
    assert_eq!(v(&c).foreign[0].status, ForeignStatus::Signed);

    // the keeper tries to re-sign at a normal fee, and then at the cap: both refused
    let t = T0 + 41_500 + STEP3_OPEN_AFTER_MS + foreign::RESIGN_COOLDOWN_MS;
    let mut refused = vec![];
    for args in [evm(1_500_000_000, 1_000_000, 21_000), evm(cap, cap, 50_000)] {
        Ctx::new().by("keeper.testnet").at(t).set();
        refused.push(try_call(|| {
            let _ = c.resign_foreign(1.into(), 0, args);
        }));
    }
    assert!(
        refused.iter().any(|r| r.is_none()),
        "FINDING F4: after a stranger's cap-fee signature no re-sign is possible: {refused:?}"
    );
}
