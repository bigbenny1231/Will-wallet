//! Step 3: foreign-chain payouts via NEAR Chain Signatures (SPEC §2.4).
//!
//! Flow per payout (`execute_step` at step 3 calls `request_foreign_signature`):
//!
//! ```text
//! Base   : build EIP-1559 tx -> keccak256 -> signer.sign{Ecdsa, domain 0} -> on_foreign_signed
//! Solana : signer.derived_public_key(sol-<id>, domain 1) -> on_foreign_sol_key
//!          -> build legacy transfer message -> signer.sign{Eddsa, domain 1} -> on_foreign_signed
//! ```
//!
//! `on_foreign_signed` assembles the fully signed raw tx (EVM: `0x` hex, Solana: base64)
//! and calls `finish_foreign`, which advances `foreign_index`. Every failure (MPC error,
//! bad payout, unexpected response) marks the payout `failed` and still advances, so
//! settlement never blocks. A caller that omits the chain's `args` gets a panic instead:
//! that reverts the in-flight guard, so a permissionless caller can't burn a payout by
//! leaving out its args.
//!
//! `resign_foreign` re-requests a signature for a payout step 3 already handled. It never
//! touches `foreign_index`/`step`. Every extra signature over a payout is a potential
//! second payment, so re-signing is constrained (docs/SECURITY_REVIEW.md C-1):
//!
//! - **EVM**: the nonce is never taken from the caller. Base payout `i` always uses nonce
//!   = number of Base payouts before it (the derived address has no other signer, so its
//!   nonce starts at 0). Every signature for a payout shares one nonce, so at most one
//!   of them can ever be mined. A re-sign of a `signed`/`broadcast` payout must raise
//!   both fee fields by >= 10% (no downgrade griefing); fees and gas are capped.
//! - **Solana**: there is no nonce, so two signatures with two live blockhashes are two
//!   payments. Every Solana re-sign waits `RESIGN_COOLDOWN_MS` after the last request, so
//!   the old blockhash has expired. Anyone may then re-sign a `failed` payout; a
//!   `signed`/`broadcast` one may be re-signed only by the contract owner or the configured
//!   keeper, who must first check off-chain that the old signature never landed.
//! - One re-sign per payout may be in flight at a time.
//!
//! Wire format verified against live `v1.signer-prod.testnet` 3.18.0; see
//! docs/chainsig-notes.md. The unsigned tx params are held in a raw storage slot between
//! request and callback so `on_foreign_signed` keeps its original signature.

use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, Gas, GasWeight, NearToken, Promise, PromiseError, PromiseOrValue,
};
use serde_json::json;

use crate::{record, Contract, ContractExt, StoredState, TokenRef};

use self::chainsig::*;

/// Minimum gas attached to the MPC `sign` call; all unused gas is added on top via
/// `GasWeight(1)` (so ~250 TGas on a 300 TGas `execute_step`). The live signer only
/// requires >= 15 TGas (`config.sign_call_gas_attachment_requirement_tera_gas`).
pub const GAS_MPC_SIGN: Gas = Gas::from_tgas(50);
/// Gas for `on_foreign_signed` / `on_foreign_resigned`.
pub const GAS_ON_FOREIGN_SIGNED: Gas = Gas::from_tgas(30);
/// Gas for the cross-contract `derived_public_key` view (Solana source pubkey).
pub const GAS_DERIVED_KEY: Gas = Gas::from_tgas(10);
/// Minimum gas for `on_foreign_sol_key` (it schedules sign + callback); gets unused gas too.
pub const GAS_ON_SOL_KEY: Gas = Gas::from_tgas(100);
/// Gas for the self-call that records an unbuildable payout as failed.
const GAS_FOREIGN_FAIL: Gas = Gas::from_tgas(10);
/// Cap on caller-supplied EIP-1559 fees on Base (100 gwei). Bounds how much of the derived
/// address's ETH a permissionless caller can burn as gas (H-2). Each registry chain has
/// its own cap (`EvmChain::max_fee_per_gas`).
pub const MAX_EVM_FEE_PER_GAS: u128 = 100_000_000_000;
/// Monad testnet fee cap (1000 gwei). Monad's base fee floor is 100 gwei, so the Base cap
/// would reject every honest Monad step. 21000 gas x 1000 gwei = 0.021 MON worst case.
pub const MAX_MONAD_FEE_PER_GAS: u128 = 1_000_000_000_000;
/// Caller-supplied gas limit range for a native transfer.
pub const MIN_EVM_GAS_LIMIT: u128 = 21_000;
pub const MAX_EVM_GAS_LIMIT: u128 = 100_000;
/// Re-signing a `signed`/`broadcast` EVM payout needs both fee fields >= 110% of the last request.
pub const EVM_FEE_BUMP_PCT: u128 = 110;
/// Minimum age of the last signature request before a `signed`/`broadcast` payout may be
/// re-signed (Solana: the old blockhash is long expired; EVM: rate limit on status flips).
pub const RESIGN_COOLDOWN_MS: u64 = 5 * 60 * 1000;
/// MPC signer contract (SPEC §1).
pub const MPC_SIGNER: &str = "v1.signer-prod.testnet";
/// Deposit required by the MPC `sign` method.
pub const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// Wire values `"base"`, `"solana"`, `"monad"`. New variants go at the END: the borsh
/// discriminant of existing stored payouts must not change.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForeignChain {
    Base,
    Solana,
    Monad,
}

/// One EVM chain in the registry (SPEC §1). Every EVM chain shares the step-3 path:
/// EIP-1559 native transfer, secp256k1 (domain 0), nonce pinned per chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvmChain {
    pub chain_id: u64,
    pub path_prefix: &'static str,
    pub rpc: &'static str,
    pub explorer_tx: &'static str,
    /// Upper bound on caller-supplied `max_fee_per_gas` (wei).
    pub max_fee_per_gas: u128,
}

pub const BASE_SEPOLIA: EvmChain = EvmChain {
    chain_id: 84532,
    path_prefix: "base",
    rpc: "https://sepolia.base.org",
    explorer_tx: "https://sepolia.basescan.org/tx/",
    max_fee_per_gas: MAX_EVM_FEE_PER_GAS,
};

pub const MONAD_TESTNET: EvmChain = EvmChain {
    chain_id: 10143,
    path_prefix: "monad",
    rpc: "https://testnet-rpc.monad.xyz",
    explorer_tx: "https://testnet.monadexplorer.com/tx/",
    max_fee_per_gas: MAX_MONAD_FEE_PER_GAS,
};

impl ForeignChain {
    pub const ALL: [ForeignChain; 3] = [
        ForeignChain::Base,
        ForeignChain::Monad,
        ForeignChain::Solana,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            ForeignChain::Base => "base",
            ForeignChain::Solana => "solana",
            ForeignChain::Monad => "monad",
        }
    }
    /// Registry entry for EVM chains, `None` for Solana.
    pub fn evm(&self) -> Option<EvmChain> {
        match self {
            ForeignChain::Base => Some(BASE_SEPOLIA),
            ForeignChain::Monad => Some(MONAD_TESTNET),
            ForeignChain::Solana => None,
        }
    }
    pub fn is_evm(&self) -> bool {
        self.evm().is_some()
    }
}

/// Chain registry as JSON (exposed through `get_config().chains`).
pub fn chain_registry() -> Vec<serde_json::Value> {
    ForeignChain::ALL
        .iter()
        .map(|c| match c.evm() {
            Some(e) => json!({
                "chain": c.as_str(), "kind": "evm", "chain_id": e.chain_id,
                "path": format!("{}-<token_id>", e.path_prefix), "domain_id": DOMAIN_ECDSA,
                "rpc": e.rpc, "explorer_tx": e.explorer_tx,
                "max_fee_per_gas": U128(e.max_fee_per_gas),
            }),
            None => json!({
                "chain": c.as_str(), "kind": "solana", "cluster": "devnet",
                "path": "sol-<token_id>", "domain_id": DOMAIN_EDDSA,
                "rpc": "https://api.devnet.solana.com",
                "explorer_tx": "https://explorer.solana.com/tx/",
            }),
        })
        .collect()
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForeignStatus {
    Pending,
    Signed,
    Broadcast,
    Failed,
}

impl ForeignStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ForeignStatus::Pending => "pending",
            ForeignStatus::Signed => "signed",
            ForeignStatus::Broadcast => "broadcast",
            ForeignStatus::Failed => "failed",
        }
    }
}

/// SPEC §2.1 ForeignPayout. Set by the owner while Alive (status forced to
/// `pending`, `signed_tx`/`tx_hash` forced to null on `set_foreign_payouts`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignPayout {
    pub chain: ForeignChain,
    /// `0x...` (base) or base58 pubkey (solana).
    pub to: String,
    /// Integer string in the chain's smallest unit (wei / lamports).
    pub amount: U128,
    /// Derived source address, informational (set by dashboard).
    #[serde(default)]
    pub from_address: String,
    #[serde(default = "pending")]
    pub status: ForeignStatus,
    /// Hex of the raw signed tx (EVM) / base64 serialized tx (Solana); filled in step 3 callback.
    #[serde(default)]
    pub signed_tx: Option<String>,
    /// Filled by the keeper via `mark_broadcast`.
    #[serde(default)]
    pub tx_hash: Option<String>,
}

fn pending() -> ForeignStatus {
    ForeignStatus::Pending
}

/// SPEC §2.1 StepArgs: keeper supplies ONLY chain-environment fields.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StepArgs {
    #[serde(default)]
    pub evm: Option<EvmArgs>,
    #[serde(default)]
    pub solana: Option<SolanaArgs>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmArgs {
    pub nonce: u64,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub gas_limit: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolanaArgs {
    pub recent_blockhash: String,
}

/// Derivation path for a vault's foreign source address (SPEC §1).
pub fn derivation_path(chain: ForeignChain, token_id: u64) -> String {
    match chain.evm() {
        Some(e) => format!("{}-{token_id}", e.path_prefix),
        None => format!("sol-{token_id}"),
    }
}

/// Unsigned tx parameters, kept from sign request to callback.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingTx {
    Evm(EvmTransfer),
    Solana(SolanaTransfer),
}

fn pending_key(token_id: u64, index: usize) -> Vec<u8> {
    // Distinct from every collection prefix (single borsh enum bytes) and "STATE".
    format!("chainsig:pending:{token_id}:{index}").into_bytes()
}

fn write_pending(token_id: u64, index: usize, p: &PendingTx) {
    env::storage_write(
        &pending_key(token_id, index),
        &near_sdk::borsh::to_vec(p).unwrap(),
    );
}

fn take_pending(token_id: u64, index: usize) -> Option<PendingTx> {
    let key = pending_key(token_id, index);
    let raw = env::storage_read(&key)?;
    env::storage_remove(&key);
    near_sdk::borsh::from_slice(&raw).ok()
}

/// Per-payout signing record, kept in a raw storage slot so the stored `Vault` layout of
/// existing vaults is unchanged. A payout with no record reads as `SignTrack::default()`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignTrack {
    /// Block time (ms) of the most recent signature request (step 3 or re-sign).
    pub last_request_ms: u64,
    /// A `resign_foreign` request is outstanding.
    pub inflight: bool,
    /// EVM fees of the most recent request (0 for Solana).
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
}

fn track_key(token_id: u64, index: usize) -> Vec<u8> {
    format!("chainsig:track:{token_id}:{index}").into_bytes()
}

pub fn read_track(token_id: u64, index: usize) -> SignTrack {
    env::storage_read(&track_key(token_id, index))
        .and_then(|raw| near_sdk::borsh::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn write_track(token_id: u64, index: usize, t: &SignTrack) {
    env::storage_write(
        &track_key(token_id, index),
        &near_sdk::borsh::to_vec(t).unwrap(),
    );
}

/// The EVM nonce of payout `index`: the number of payouts on the SAME chain before it.
/// Each EVM chain has its own derived address (`base-<id>`, `monad-<id>`) that only this
/// contract can sign for, and only in settlement, so its nonce starts at 0 and that
/// chain's payouts consume nonces in list order.
pub fn evm_nonce_for(foreign: &[ForeignPayout], index: usize) -> u64 {
    let chain = foreign[index].chain;
    foreign[..index].iter().filter(|p| p.chain == chain).count() as u64
}

/// Reject out-of-range caller-supplied EVM params (panics, so nothing is burned or stored).
pub fn validate_evm_args(a: &EvmArgs, chain: ForeignChain) {
    let cap = chain
        .evm()
        .unwrap_or_else(|| env::panic_str("not an evm chain"))
        .max_fee_per_gas;
    require!(
        (MIN_EVM_GAS_LIMIT..=MAX_EVM_GAS_LIMIT).contains(&a.gas_limit.0),
        "evm gas_limit out of range (21000..=100000)"
    );
    require!(
        a.max_fee_per_gas.0 > 0 && a.max_fee_per_gas.0 <= cap,
        &format!(
            "evm max_fee_per_gas out of range (1..={} gwei)",
            cap / 1_000_000_000
        )
    );
    require!(
        a.max_priority_fee_per_gas.0 <= a.max_fee_per_gas.0,
        "evm max_priority_fee_per_gas above max_fee_per_gas"
    );
}

/// The chain's transaction id for a stored `signed_tx`: EVM `0x` + keccak256(raw) (lower
/// hex), Solana base58 of the first signature. `mark_broadcast` only accepts this value.
pub fn expected_tx_id(chain: ForeignChain, signed_tx: &str) -> Result<String, String> {
    match chain {
        ForeignChain::Base | ForeignChain::Monad => {
            let h = signed_tx.strip_prefix("0x").unwrap_or(signed_tx);
            let raw = hex::decode(h).map_err(|_| "signed_tx is not hex".to_string())?;
            Ok(format!("0x{}", hex::encode(keccak256(&raw))))
        }
        ForeignChain::Solana => {
            use near_sdk::base64::Engine;
            let raw = near_sdk::base64::engine::general_purpose::STANDARD
                .decode(signed_tx)
                .map_err(|_| "signed_tx is not base64".to_string())?;
            // compact-u16 signature count (1 => one byte 0x01), then 64-byte signatures.
            if raw.len() < 65 || raw[0] != 1 {
                return Err("unexpected solana tx layout".into());
            }
            Ok(near_sdk::bs58::encode(&raw[1..65]).into_string())
        }
    }
}

/// Build the EVM transfer for `payout` from keeper-supplied chain params. The chain id
/// comes from the registry entry of `payout.chain`, never from the caller.
pub fn evm_transfer_for(
    payout: &ForeignPayout,
    a: &EvmArgs,
) -> Result<(EvmTransfer, [u8; 32]), String> {
    let chain = payout
        .chain
        .evm()
        .ok_or_else(|| "not an evm payout".to_string())?;
    let t = EvmTransfer {
        to: payout.to.clone(),
        value: payout.amount,
        nonce: a.nonce,
        max_fee_per_gas: a.max_fee_per_gas,
        max_priority_fee_per_gas: a.max_priority_fee_per_gas,
        gas_limit: a.gas_limit,
        chain_id: chain.chain_id,
    };
    let hash = evm_sighash(&evm_tx(&t)?);
    Ok((t, hash))
}

/// Build the Solana transfer for `payout` from the derived source key and a blockhash.
pub fn solana_transfer_for(
    payout: &ForeignPayout,
    from_b58: String,
    recent_blockhash: String,
) -> Result<(SolanaTransfer, Vec<u8>), String> {
    let lamports =
        u64::try_from(payout.amount.0).map_err(|_| "amount exceeds u64 lamports".to_string())?;
    let t = SolanaTransfer {
        from: from_b58,
        to: payout.to.clone(),
        lamports: near_sdk::json_types::U64(lamports),
        recent_blockhash,
    };
    let msg = solana_message(&solana_tx(&t)?);
    Ok((t, msg))
}

/// Turn an MPC `sign` result + the pending unsigned tx into `(raw_signed_tx, tx_id)`.
/// EVM: `0x` hex + keccak tx hash. Solana: base64 + base58 signature (the tx id).
pub fn assemble_signed(
    pending: &PendingTx,
    response: &serde_json::Value,
) -> Result<(String, String), String> {
    let sig: SignatureResponse = serde_json::from_value(response.clone())
        .map_err(|_| "unexpected signature response".to_string())?;
    match (pending, sig) {
        (
            PendingTx::Evm(t),
            SignatureResponse::Secp256k1 {
                big_r,
                s,
                recovery_id,
            },
        ) => {
            let tx = evm_tx(t)?;
            let (r, s, v) = evm_rsv(&big_r.affine_point, &s.scalar, recovery_id)?;
            let raw = evm_assemble(&tx, &r, &s, v);
            Ok((
                format!("0x{}", hex::encode(&raw)),
                format!("0x{}", hex::encode(keccak256(&raw))),
            ))
        }
        (PendingTx::Solana(t), SignatureResponse::Ed25519 { signature }) => {
            let tx = solana_tx(t)?;
            if signature.len() != 64 {
                return Err("bad ed25519 signature length".into());
            }
            let mut sig64 = [0u8; 64];
            sig64.copy_from_slice(&signature);
            let mut pk = [0u8; 32];
            pk.copy_from_slice(
                &near_sdk::bs58::decode(&t.from)
                    .into_vec()
                    .map_err(|e| e.to_string())?,
            );
            if !env::ed25519_verify(&sig64, solana_message(&tx), &pk) {
                return Err("ed25519 signature does not verify".into());
            }
            let raw = solana_assemble(&tx, &signature)?;
            Ok((
                base64_encode(&raw),
                near_sdk::bs58::encode(&signature).into_string(),
            ))
        }
        _ => Err("signature scheme does not match chain".into()),
    }
}

fn mpc_signer() -> near_sdk::AccountId {
    MPC_SIGNER.parse().unwrap()
}

fn sign_call(args: &SignArgs) -> Promise {
    Promise::new(mpc_signer()).function_call_weight(
        "sign".to_string(),
        serde_json::to_vec(args).unwrap(),
        MPC_SIGN_DEPOSIT,
        GAS_MPC_SIGN,
        GasWeight(1),
    )
}

fn derived_key_call(path: &str) -> Promise {
    Promise::new(mpc_signer()).function_call(
        "derived_public_key".to_string(),
        serde_json::to_vec(&json!({
            "path": path,
            "predecessor": env::current_account_id(),
            "domain_id": DOMAIN_EDDSA,
        }))
        .unwrap(),
        NearToken::from_yoctonear(0),
        GAS_DERIVED_KEY,
    )
}

fn clear_inflight(token_id: u64, index: usize, req_ms: Option<u64>) {
    let mut t = read_track(token_id, index);
    if t.inflight && req_ms.is_none_or(|r| r == t.last_request_ms) {
        t.inflight = false;
        write_track(token_id, index, &t);
    }
}

fn require_blockhash(a: &SolanaArgs) {
    if omni_transaction::solana::types::Blockhash::from_base58(&a.recent_blockhash).is_err() {
        env::panic_str("args.solana.recent_blockhash is not a base58 32-byte hash");
    }
}

impl Contract {
    /// Start signing `vault.foreign[index]`. Caller (`execute_step`) has already
    /// checked `index < foreign.len()` and set the in-flight guard.
    pub(crate) fn request_foreign_signature(
        &mut self,
        token_id: u64,
        index: usize,
        args: Option<StepArgs>,
    ) -> Promise {
        let foreign = self.vault(token_id).foreign;
        let payout = foreign[index].clone();
        let me = env::current_account_id();
        let path = derivation_path(payout.chain, token_id);
        let now = env::block_timestamp_ms();
        match payout.chain {
            ForeignChain::Base | ForeignChain::Monad => {
                let mut a = args.and_then(|a| a.evm).unwrap_or_else(|| {
                    env::panic_str("step 3: args.evm is required for an evm payout")
                });
                validate_evm_args(&a, payout.chain);
                a.nonce = evm_nonce_for(&foreign, index);
                write_track(
                    token_id,
                    index,
                    &SignTrack {
                        last_request_ms: now,
                        inflight: false,
                        max_fee_per_gas: a.max_fee_per_gas.0,
                        max_priority_fee_per_gas: a.max_priority_fee_per_gas.0,
                    },
                );
                match evm_transfer_for(&payout, &a) {
                    Err(e) => self.fail_later(token_id, index, &e),
                    Ok((t, hash)) => {
                        write_pending(token_id, index, &PendingTx::Evm(t));
                        sign_call(&sign_args_ecdsa(&path, &hash)).then(
                            Self::ext(me)
                                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                                .with_unused_gas_weight(0)
                                .on_foreign_signed(token_id, index),
                        )
                    }
                }
            }
            ForeignChain::Solana => {
                let a = args.and_then(|a| a.solana).unwrap_or_else(|| {
                    env::panic_str("step 3: args.solana is required for a solana payout")
                });
                require_blockhash(&a);
                // Validate the payout itself before spending a cross-contract hop.
                if let Err(e) = solana_transfer_for(
                    &payout,
                    SYSTEM_PROGRAM_B58.into(),
                    a.recent_blockhash.clone(),
                ) {
                    return self.fail_later(token_id, index, &e);
                }
                write_track(
                    token_id,
                    index,
                    &SignTrack {
                        last_request_ms: now,
                        ..Default::default()
                    },
                );
                derived_key_call(&path).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_SOL_KEY)
                        .with_unused_gas_weight(1)
                        .on_foreign_sol_key(token_id, index, a.recent_blockhash, None, None),
                )
            }
        }
    }

    fn fail_later(&mut self, token_id: u64, index: usize, detail: &str) -> Promise {
        Self::ext(env::current_account_id())
            .with_static_gas(GAS_FOREIGN_FAIL)
            .foreign_fail(token_id, index, detail.to_string())
    }
}

#[near]
impl Contract {
    /// Records a payout that can never be built (bad `to`, amount out of range) as failed.
    #[private]
    pub fn foreign_fail(&mut self, token_id: u64, index: usize, detail: String) -> u8 {
        self.finish_foreign(token_id, index, ForeignStatus::Failed, None, &detail)
    }

    /// Solana leg: got this contract's derived ed25519 key for `sol-<token_id>`;
    /// build the transfer message and request the signature.
    #[private]
    pub fn on_foreign_sol_key(
        &mut self,
        token_id: u64,
        index: usize,
        recent_blockhash: String,
        resign: Option<bool>,
        req_ms: Option<u64>,
        #[callback_result] key: Result<String, PromiseError>,
    ) -> PromiseOrValue<u8> {
        let resign = resign.unwrap_or(false);
        let v = self.vault(token_id);
        if !resign && (v.step != 3 || v.foreign_index as usize != index) {
            env::log_str("stale foreign callback ignored");
            return PromiseOrValue::Value(v.step);
        }
        let payout = v.foreign[index].clone();
        let built = key
            .map_err(|_| "derived_public_key failed".to_string())
            .and_then(|k| ed25519_key_to_base58(&k))
            .and_then(|from| solana_transfer_for(&payout, from, recent_blockhash));
        let (t, msg) = match built {
            Ok(x) => x,
            Err(e) if resign => {
                env::log_str(&format!("resign #{index} failed: {e}"));
                clear_inflight(token_id, index, req_ms);
                return PromiseOrValue::Value(v.step);
            }
            Err(e) => {
                return PromiseOrValue::Value(self.finish_foreign(
                    token_id,
                    index,
                    ForeignStatus::Failed,
                    None,
                    &e,
                ))
            }
        };
        if !payout.from_address.is_empty() && payout.from_address != t.from {
            env::log_str(&format!(
                "note: from_address {} != derived {}",
                payout.from_address, t.from
            ));
        }
        let path = derivation_path(ForeignChain::Solana, token_id);
        let me = env::current_account_id();
        let cb = if resign {
            Self::ext(me)
                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                .with_unused_gas_weight(0)
                .on_foreign_resigned(token_id, index, PendingTx::Solana(t), req_ms)
        } else {
            write_pending(token_id, index, &PendingTx::Solana(t));
            Self::ext(me)
                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                .with_unused_gas_weight(0)
                .on_foreign_signed(token_id, index)
        };
        PromiseOrValue::Promise(sign_call(&sign_args_eddsa(&path, &msg)).then(cb))
    }

    /// Callback for the step-3 signature request. Returns the vault's new `step`.
    #[private]
    pub fn on_foreign_signed(
        &mut self,
        token_id: u64,
        index: usize,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) -> u8 {
        let pending = take_pending(token_id, index);
        let outcome = match (result, pending) {
            (Err(_), _) => Err("mpc sign call failed".to_string()),
            (Ok(_), None) => Err("no pending tx for this payout".to_string()),
            (Ok(value), Some(p)) => assemble_signed(&p, &value),
        };
        match outcome {
            Ok((raw, txid)) => self.finish_foreign(
                token_id,
                index,
                ForeignStatus::Signed,
                Some(raw),
                &format!("signed {txid}"),
            ),
            Err(e) => self.finish_foreign(token_id, index, ForeignStatus::Failed, None, &e),
        }
    }

    /// Request a fresh signature for a payout that step 3 already handled (expired Solana
    /// blockhash, underpriced EVM tx, MPC failure). Does not change `step`/`foreign_index`.
    /// Rules (see module docs): EVM nonce is fixed per payout and a re-sign of a
    /// `signed`/`broadcast` payout must bump fees >= 10% (`broadcast`: also after the
    /// cooldown); Solana always waits for the cooldown, and `signed`/`broadcast` Solana
    /// payouts can only be re-signed by the contract owner or keeper. One re-sign per
    /// payout in flight at a time.
    pub fn resign_foreign(&mut self, token_id: TokenRef, index: u32, args: StepArgs) -> Promise {
        let id = token_id.id();
        let v = self.vault(id);
        let i = index as usize;
        require!(v.stored != StoredState::Live, "not_triggered");
        require!(i < v.foreign.len(), "index out of range");
        require!(
            v.step > 3 || (v.step == 3 && i < v.foreign_index as usize),
            "payout not processed yet"
        );
        let payout = v.foreign[i].clone();
        require!(payout.status != ForeignStatus::Pending, "payout is pending");
        let now = env::block_timestamp_ms();
        let track = read_track(id, i);
        require!(
            !(track.inflight
                && now
                    < track
                        .last_request_ms
                        .saturating_add(crate::FOREIGN_INFLIGHT_TIMEOUT_MS)),
            "a re-sign for this payout is already in flight"
        );
        let has_sig = matches!(
            payout.status,
            ForeignStatus::Signed | ForeignStatus::Broadcast
        );
        let cooled = now >= track.last_request_ms.saturating_add(RESIGN_COOLDOWN_MS);
        let me = env::current_account_id();
        let path = derivation_path(payout.chain, id);
        match payout.chain {
            ForeignChain::Base | ForeignChain::Monad => {
                let mut a = args
                    .evm
                    .unwrap_or_else(|| env::panic_str("args.evm is required for an evm payout"));
                validate_evm_args(&a, payout.chain);
                if has_sig {
                    require!(
                        a.max_fee_per_gas.0 * 100 >= track.max_fee_per_gas * EVM_FEE_BUMP_PCT
                            && a.max_priority_fee_per_gas.0 * 100
                                >= track.max_priority_fee_per_gas * EVM_FEE_BUMP_PCT,
                        "re-sign of a signed evm payout must raise both fees by >= 10%"
                    );
                }
                if payout.status == ForeignStatus::Broadcast {
                    require!(cooled, "resign cooldown: wait 5 min after the last request");
                }
                a.nonce = evm_nonce_for(&v.foreign, i);
                let (t, hash) =
                    evm_transfer_for(&payout, &a).unwrap_or_else(|e| env::panic_str(&e));
                write_track(
                    id,
                    i,
                    &SignTrack {
                        last_request_ms: now,
                        inflight: true,
                        max_fee_per_gas: a.max_fee_per_gas.0,
                        max_priority_fee_per_gas: a.max_priority_fee_per_gas.0,
                    },
                );
                sign_call(&sign_args_ecdsa(&path, &hash)).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                        .with_unused_gas_weight(0)
                        .on_foreign_resigned(id, i, PendingTx::Evm(t), Some(now)),
                )
            }
            ForeignChain::Solana => {
                // Even a `failed` payout may have a signature out there (e.g. the MPC answered
                // but assembly failed), so always wait until the last blockhash has expired.
                require!(cooled, "resign cooldown: wait 5 min after the last request");
                if has_sig {
                    let pred = env::predecessor_account_id();
                    require!(
                        pred == self.owner_id || Some(&pred) == self.keeper().as_ref(),
                        "only the contract owner or keeper may re-sign a signed solana payout"
                    );
                }
                let a = args.solana.unwrap_or_else(|| {
                    env::panic_str("args.solana is required for a solana payout")
                });
                require_blockhash(&a);
                solana_transfer_for(
                    &payout,
                    SYSTEM_PROGRAM_B58.into(),
                    a.recent_blockhash.clone(),
                )
                .unwrap_or_else(|e| env::panic_str(&e));
                write_track(
                    id,
                    i,
                    &SignTrack {
                        last_request_ms: now,
                        inflight: true,
                        ..Default::default()
                    },
                );
                derived_key_call(&path).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_SOL_KEY)
                        .with_unused_gas_weight(1)
                        .on_foreign_sol_key(id, i, a.recent_blockhash, Some(true), Some(now)),
                )
            }
        }
    }

    /// View: signing record of a payout (keeper uses it to size an EVM fee bump and to
    /// know when the re-sign cooldown ends).
    pub fn get_sign_track(&self, token_id: TokenRef, index: u32) -> serde_json::Value {
        let t = read_track(token_id.id(), index as usize);
        json!({
            "last_request_ms": t.last_request_ms,
            "inflight": t.inflight,
            "max_fee_per_gas": U128(t.max_fee_per_gas),
            "max_priority_fee_per_gas": U128(t.max_priority_fee_per_gas),
            "resign_allowed_after_ms": t.last_request_ms.saturating_add(RESIGN_COOLDOWN_MS),
        })
    }

    /// Callback for `resign_foreign`. Returns the payout's resulting status.
    #[private]
    pub fn on_foreign_resigned(
        &mut self,
        token_id: u64,
        index: usize,
        pending: PendingTx,
        req_ms: Option<u64>,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) -> String {
        let mut v = self.vault(token_id);
        let current = v.foreign[index].status;
        // Only the latest request may land (a request that timed out and was superseded is stale).
        if req_ms.is_some()
            && read_track(token_id, index).last_request_ms != req_ms.unwrap_or_default()
        {
            env::log_str("stale resign result ignored");
            return current.as_str().to_string();
        }
        clear_inflight(token_id, index, req_ms);
        if current == ForeignStatus::Pending {
            env::log_str("resign result ignored: payout pending");
            return current.as_str().to_string();
        }
        let outcome = result
            .map_err(|_| "mpc sign call failed".to_string())
            .and_then(|value| assemble_signed(&pending, &value));
        let chain = v.foreign[index].chain;
        match outcome {
            Ok((raw, txid)) => {
                v.foreign[index].status = ForeignStatus::Signed;
                v.foreign[index].signed_tx = Some(raw);
                v.foreign[index].tx_hash = None;
                let data = json!({"token_id": token_id.to_string(), "index": index, "chain": chain, "status": "signed", "detail": format!("resigned {txid}")});
                record(
                    &mut v,
                    token_id,
                    "foreign_signed",
                    &format!("#{index} resigned {txid}"),
                    data,
                );
            }
            Err(e) => {
                let data = json!({"token_id": token_id.to_string(), "index": index, "chain": chain, "detail": e});
                record(
                    &mut v,
                    token_id,
                    "foreign_resign_failed",
                    &format!("#{index} {e}"),
                    data,
                );
            }
        }
        let status = v.foreign[index].status.as_str().to_string();
        self.vaults.insert(&token_id, &v);
        status
    }
}

/// Pure Chain Signatures helpers (shared design with `contracts/chainsig-probe`).
///
/// Live wire format (`v1.signer-prod.testnet` 3.18.0):
///   sign({"request":{"path","payload_v2":{"Ecdsa":"<32B hex>"}|{"Eddsa":"<msg hex>"},"domain_id":0|1}})
///   -> {"scheme":"Secp256k1","big_r":{"affine_point":"<33B hex>"},"s":{"scalar":"<32B hex>"},"recovery_id":0|1}
///   -> {"scheme":"Ed25519","signature":[64 x u8]}
pub mod chainsig {
    use near_sdk::json_types::{U128, U64};
    use near_sdk::near;
    use omni_transaction::evm::types::Signature as EvmSignature;
    use omni_transaction::evm::EVMTransaction;
    use omni_transaction::solana::types::{Blockhash, SolanaAddress, SolanaSignature};
    use omni_transaction::solana::utils::system_transfer;
    use omni_transaction::solana::{SolanaTransaction, SolanaTransactionBuilder};
    use omni_transaction::TxBuilder;

    pub const DOMAIN_ECDSA: u64 = 0;
    pub const DOMAIN_EDDSA: u64 = 1;
    pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;
    pub const MONAD_TESTNET_CHAIN_ID: u64 = 10143;
    /// A valid 32-byte base58 key, used only to pre-validate a payout before the key lookup.
    pub const SYSTEM_PROGRAM_B58: &str = "11111111111111111111111111111111";

    #[near(serializers = [json])]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Payload {
        Ecdsa(String),
        Eddsa(String),
    }

    #[near(serializers = [json])]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SignRequest {
        pub path: String,
        pub payload_v2: Payload,
        pub domain_id: u64,
    }

    #[near(serializers = [json])]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SignArgs {
        pub request: SignRequest,
    }

    #[near(serializers = [json])]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct AffinePoint {
        pub affine_point: String,
    }

    #[near(serializers = [json])]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Scalar {
        pub scalar: String,
    }

    #[near(serializers = [json])]
    #[serde(tag = "scheme")]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum SignatureResponse {
        Secp256k1 {
            big_r: AffinePoint,
            s: Scalar,
            recovery_id: u8,
        },
        Ed25519 {
            signature: Vec<u8>,
        },
    }

    pub fn sign_args_ecdsa(path: &str, hash: &[u8; 32]) -> SignArgs {
        SignArgs {
            request: SignRequest {
                path: path.to_string(),
                payload_v2: Payload::Ecdsa(hex::encode(hash)),
                domain_id: DOMAIN_ECDSA,
            },
        }
    }

    pub fn sign_args_eddsa(path: &str, message: &[u8]) -> SignArgs {
        SignArgs {
            request: SignRequest {
                path: path.to_string(),
                payload_v2: Payload::Eddsa(hex::encode(message)),
                domain_id: DOMAIN_EDDSA,
            },
        }
    }

    #[near(serializers = [borsh, json])]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct EvmTransfer {
        pub to: String,
        pub value: U128,
        pub nonce: u64,
        pub max_fee_per_gas: U128,
        pub max_priority_fee_per_gas: U128,
        pub gas_limit: U128,
        pub chain_id: u64,
    }

    pub fn parse_evm_address(s: &str) -> Result<[u8; 20], String> {
        let h = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .unwrap_or(s);
        if h.len() != 40 {
            return Err("bad evm address length".into());
        }
        let v = hex::decode(h).map_err(|_| "bad evm address hex".to_string())?;
        let mut out = [0u8; 20];
        out.copy_from_slice(&v);
        Ok(out)
    }

    pub fn evm_tx(t: &EvmTransfer) -> Result<EVMTransaction, String> {
        Ok(EVMTransaction {
            chain_id: t.chain_id,
            nonce: t.nonce,
            to: Some(parse_evm_address(&t.to)?),
            value: t.value.0,
            input: vec![],
            gas_limit: t.gas_limit.0,
            max_fee_per_gas: t.max_fee_per_gas.0,
            max_priority_fee_per_gas: t.max_priority_fee_per_gas.0,
            access_list: vec![],
        })
    }

    pub fn evm_sighash(tx: &EVMTransaction) -> [u8; 32] {
        keccak256(&tx.build_for_signing())
    }

    fn strip_leading_zeros(b: &[u8]) -> Vec<u8> {
        // omni-transaction RLP-appends r/s as raw byte strings; RLP integers must be
        // minimal or nodes reject the tx as non-canonical (1 in 128 signatures).
        let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
        b[i..].to_vec()
    }

    pub fn evm_rsv(
        big_r_hex: &str,
        s_hex: &str,
        recovery_id: u8,
    ) -> Result<([u8; 32], [u8; 32], u8), String> {
        let big_r = hex::decode(big_r_hex).map_err(|_| "big_r hex".to_string())?;
        let s = hex::decode(s_hex).map_err(|_| "s hex".to_string())?;
        if big_r.len() != 33 || s.len() != 32 || recovery_id > 1 {
            return Err("malformed secp256k1 signature".into());
        }
        let mut r32 = [0u8; 32];
        r32.copy_from_slice(&big_r[1..]);
        let mut s32 = [0u8; 32];
        s32.copy_from_slice(&s);
        Ok((r32, s32, recovery_id))
    }

    pub fn evm_assemble(tx: &EVMTransaction, r: &[u8; 32], s: &[u8; 32], y_parity: u8) -> Vec<u8> {
        tx.build_with_signature(&EvmSignature {
            v: y_parity as u64,
            r: strip_leading_zeros(r),
            s: strip_leading_zeros(s),
        })
    }

    #[near(serializers = [borsh, json])]
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct SolanaTransfer {
        pub from: String,
        pub to: String,
        pub lamports: U64,
        pub recent_blockhash: String,
    }

    pub fn solana_tx(t: &SolanaTransfer) -> Result<SolanaTransaction, String> {
        let from = SolanaAddress::from_base58(&t.from).map_err(|e| format!("from: {e}"))?;
        let to = SolanaAddress::from_base58(&t.to).map_err(|e| format!("to: {e}"))?;
        let bh =
            Blockhash::from_base58(&t.recent_blockhash).map_err(|e| format!("blockhash: {e}"))?;
        Ok(SolanaTransactionBuilder::new()
            .payer(from)
            .instructions(vec![system_transfer(from, to, t.lamports.0)])
            .recent_blockhash(bh)
            .build())
    }

    pub fn solana_message(tx: &SolanaTransaction) -> Vec<u8> {
        tx.build_for_signing()
    }

    pub fn solana_assemble(tx: &SolanaTransaction, sig: &[u8]) -> Result<Vec<u8>, String> {
        if sig.len() != 64 {
            return Err("ed25519 signature must be 64 bytes".into());
        }
        let mut s = [0u8; 64];
        s.copy_from_slice(sig);
        Ok(tx.build_with_signature(&[SolanaSignature(s)]))
    }

    pub fn ed25519_key_to_base58(near_pk: &str) -> Result<String, String> {
        let b58 = near_pk
            .strip_prefix("ed25519:")
            .ok_or("expected ed25519: key")?;
        let raw = near_sdk::bs58::decode(b58)
            .into_vec()
            .map_err(|_| "bad base58 key".to_string())?;
        if raw.len() != 32 {
            return Err("ed25519 key must be 32 bytes".into());
        }
        Ok(b58.to_string())
    }

    pub fn keccak256(data: &[u8]) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&near_sdk::env::keccak256(data));
        out
    }

    pub fn base64_encode(data: &[u8]) -> String {
        use near_sdk::base64::Engine;
        near_sdk::base64::engine::general_purpose::STANDARD.encode(data)
    }
}

#[cfg(test)]
mod chainsig_tests {
    //! Known-answer vectors: EVM from viem 2.x `signTransaction` (key 0x4c08..2318 =
    //! 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23); Solana from @solana/web3.js 1.99
    //! (Keypair.fromSeed([7;32])). Signatures are fed back in the live MPC response shape.
    use super::chainsig::*;
    use super::*;

    fn payout_base() -> ForeignPayout {
        ForeignPayout {
            chain: ForeignChain::Base,
            to: "0x000000000000000000000000000000000000dEaD".into(),
            amount: U128(1_000_000_000_000_000),
            from_address: String::new(),
            status: ForeignStatus::Pending,
            signed_tx: None,
            tx_hash: None,
        }
    }

    fn evm_args(nonce: u64) -> EvmArgs {
        EvmArgs {
            nonce,
            max_fee_per_gas: U128(1_500_000_000),
            max_priority_fee_per_gas: U128(1_000_000),
            gas_limit: U128(21_000),
        }
    }

    pub(crate) fn mpc_secp(r: &str, s: &str, y: u8) -> serde_json::Value {
        json!({"scheme":"Secp256k1","big_r":{"affine_point":format!("02{r}")},"s":{"scalar":s},"recovery_id":y})
    }

    // (nonce, sighash, r, s, yParity, raw)
    const EVM: [(u64, &str, &str, &str, u8, &str); 2] = [
        (3, "d2de2b2afb7f3733b7c15f33ede52c4cbe03e6d35c16e0f5afb19f6c739073d3",
         "f0fbff08e0e86c9e19272264915b8246a4e3a06dd37d18edf94dcc0d38a5d308",
         "39e0ecf2ca35bf30bfa495dae35f7770d13d3a1db7777668c87fbeb6f830b858", 1,
         "02f87383014a3403830f42408459682f0082520894000000000000000000000000000000000000dead87038d7ea4c6800080c001a0f0fbff08e0e86c9e19272264915b8246a4e3a06dd37d18edf94dcc0d38a5d308a039e0ecf2ca35bf30bfa495dae35f7770d13d3a1db7777668c87fbeb6f830b858"),
        // r has a leading zero byte -> RLP must encode it as 31 bytes (0x9f)
        (204, "1c9eb4eb642749000d2f5064aa63d62cdf336fb9b72aebaf95cd38f79067c950",
         "0082367146ea5b58bed67086e0b74d82022ebb609a5b083d9dd782f2687b8d8a",
         "71aaef89b5106b73172403a5f9d9cf19df46844b32fb950b4fce05e69ee52ad9", 1,
         "02f87383014a3481cc830f42408459682f0082520894000000000000000000000000000000000000dead87038d7ea4c6800080c0019f82367146ea5b58bed67086e0b74d82022ebb609a5b083d9dd782f2687b8d8aa071aaef89b5106b73172403a5f9d9cf19df46844b32fb950b4fce05e69ee52ad9"),
    ];

    #[test]
    fn evm_payload_hash_matches_viem() {
        for (nonce, sighash, ..) in EVM {
            let (_, hash) = evm_transfer_for(&payout_base(), &evm_args(nonce)).unwrap();
            assert_eq!(hex::encode(hash), sighash);
        }
    }

    #[test]
    fn evm_assembly_matches_viem() {
        for (nonce, _, r, s, y, raw) in EVM {
            let (t, _) = evm_transfer_for(&payout_base(), &evm_args(nonce)).unwrap();
            let (got, txid) = assemble_signed(&PendingTx::Evm(t), &mpc_secp(r, s, y)).unwrap();
            assert_eq!(got, format!("0x{raw}"));
            assert_eq!(
                txid,
                format!("0x{}", hex::encode(keccak256(&hex::decode(raw).unwrap())))
            );
        }
    }

    #[test]
    fn evm_sign_args_wire_shape() {
        let a = serde_json::to_value(sign_args_ecdsa("base-7", &[0xab; 32])).unwrap();
        assert_eq!(
            a,
            json!({"request":{"path":"base-7","payload_v2":{"Ecdsa":"ab".repeat(32)},"domain_id":0}})
        );
    }

    pub(crate) const SOL_FROM: &str = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
    pub(crate) const SOL_TO: &str = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
    pub(crate) const SOL_BH: &str = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
    const SOL_MSG: &str = "01000103ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c02000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cc490e928cd2e3873bb343fc95da33179ca60f4dbf46c2c36e91299d55d4e6b901020200010c0200000040420f0000000000";
    pub(crate) const SOL_SIG: &str = "378a35a6527e8c1288d9695546a6fed45b7cc89a92b5c8c5978c3c69a4cf2b21d90e6a9fffb2f0aa07124e9df0e337f8e67415067bec9c307c9c680f5a51dc00";
    pub(crate) const SOL_RAW_B64: &str = "ATeKNaZSfowSiNlpVUam/tRbfMiakrXIxZeMPGmkzysh2Q5qn/+y8KoHEk6d8OM3+OZ0FQZ77JwwfJxoD1pR3AABAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzEkOkozS44c7s0P8ldozF5ymD02/RsLDbpEpnVXU5rkBAgIAAQwCAAAAQEIPAAAAAAA=";

    fn payout_sol(amount: u128) -> ForeignPayout {
        ForeignPayout {
            chain: ForeignChain::Solana,
            to: SOL_TO.into(),
            amount: U128(amount),
            ..payout_base()
        }
    }

    #[test]
    fn solana_payload_matches_web3js() {
        let (_, msg) =
            solana_transfer_for(&payout_sol(1_000_000), SOL_FROM.into(), SOL_BH.into()).unwrap();
        assert_eq!(hex::encode(msg), SOL_MSG);
        let a =
            serde_json::to_value(sign_args_eddsa("sol-7", &hex::decode(SOL_MSG).unwrap())).unwrap();
        assert_eq!(a["request"]["payload_v2"]["Eddsa"], SOL_MSG);
        assert_eq!(a["request"]["domain_id"], 1);
    }

    #[test]
    fn solana_assembly_matches_web3js() {
        let (t, _) =
            solana_transfer_for(&payout_sol(1_000_000), SOL_FROM.into(), SOL_BH.into()).unwrap();
        let resp = json!({"scheme":"Ed25519","signature": hex::decode(SOL_SIG).unwrap()});
        let (raw, txid) = assemble_signed(&PendingTx::Solana(t.clone()), &resp).unwrap();
        assert_eq!(raw, SOL_RAW_B64);
        assert_eq!(
            txid,
            near_sdk::bs58::encode(hex::decode(SOL_SIG).unwrap()).into_string()
        );
        // a signature that does not verify over the message is rejected, not stored
        let mut bad = hex::decode(SOL_SIG).unwrap();
        bad[0] ^= 1;
        assert!(assemble_signed(
            &PendingTx::Solana(t),
            &json!({"scheme":"Ed25519","signature":bad})
        )
        .is_err());
    }

    #[test]
    fn rejects_mismatched_or_malformed_responses() {
        let (t, _) = evm_transfer_for(&payout_base(), &evm_args(3)).unwrap();
        let p = PendingTx::Evm(t);
        assert!(
            assemble_signed(&p, &json!({"scheme":"Ed25519","signature": vec![0u8; 64]})).is_err()
        );
        assert!(assemble_signed(&p, &json!({"stub": true})).is_err());
        assert!(assemble_signed(&p, &mpc_secp("00", "11", 0)).is_err());
    }

    #[test]
    fn unbuildable_payouts_are_errors() {
        assert!(solana_transfer_for(
            &payout_sol(u64::MAX as u128 + 1),
            SOL_FROM.into(),
            SOL_BH.into()
        )
        .is_err());
        let bad_to = ForeignPayout {
            to: "0x1234".into(),
            ..payout_base()
        };
        assert!(evm_transfer_for(&bad_to, &evm_args(0)).is_err());
    }

    #[test]
    fn paths_follow_spec() {
        assert_eq!(derivation_path(ForeignChain::Base, 12), "base-12");
        assert_eq!(derivation_path(ForeignChain::Solana, 12), "sol-12");
        assert_eq!(derivation_path(ForeignChain::Monad, 12), "monad-12");
    }

    #[test]
    fn chain_registry_ids_and_wire_names() {
        assert_eq!(
            ForeignChain::Base.evm().unwrap().chain_id,
            BASE_SEPOLIA_CHAIN_ID
        );
        assert_eq!(
            ForeignChain::Monad.evm().unwrap().chain_id,
            MONAD_TESTNET_CHAIN_ID
        );
        assert_eq!(MONAD_TESTNET_CHAIN_ID, 10143);
        assert!(ForeignChain::Solana.evm().is_none());
        assert_eq!(
            serde_json::to_value(ForeignChain::Monad).unwrap(),
            json!("monad")
        );
        let c: ForeignChain = serde_json::from_value(json!("monad")).unwrap();
        assert_eq!(c, ForeignChain::Monad);
        // Borsh discriminants of stored payouts must not move.
        assert_eq!(
            near_sdk::borsh::to_vec(&ForeignChain::Base).unwrap(),
            vec![0]
        );
        assert_eq!(
            near_sdk::borsh::to_vec(&ForeignChain::Solana).unwrap(),
            vec![1]
        );
        assert_eq!(
            near_sdk::borsh::to_vec(&ForeignChain::Monad).unwrap(),
            vec![2]
        );
        let reg = chain_registry();
        assert_eq!(reg.len(), 3);
        assert_eq!(reg[1]["chain"], "monad");
        assert_eq!(reg[1]["chain_id"], 10143);
        assert_eq!(reg[1]["rpc"], "https://testnet-rpc.monad.xyz");
        assert_eq!(
            reg[1]["explorer_tx"],
            "https://testnet.monadexplorer.com/tx/"
        );
    }

    #[test]
    fn monad_tx_uses_chain_id_10143() {
        let p = ForeignPayout {
            chain: ForeignChain::Monad,
            ..payout_base()
        };
        let (t, hash) = evm_transfer_for(&p, &evm_args(0)).unwrap();
        assert_eq!(t.chain_id, 10143);
        let (tb, hb) = evm_transfer_for(&payout_base(), &evm_args(0)).unwrap();
        assert_eq!(tb.chain_id, 84532);
        assert_ne!(hash, hb, "chain id is part of the signed payload");
        // signed tx assembles; RLP starts with type 2 + chain id 10143 (0x279f)
        let (raw, txid) =
            assemble_signed(&PendingTx::Evm(t), &mpc_secp(EVM[0].2, EVM[0].3, 1)).unwrap();
        assert!(raw.starts_with("0x02f8"));
        assert!(raw.contains("82279f"));
        assert_eq!(expected_tx_id(ForeignChain::Monad, &raw).unwrap(), txid);
        let sol = ForeignPayout {
            chain: ForeignChain::Solana,
            ..payout_base()
        };
        assert!(evm_transfer_for(&sol, &evm_args(0)).is_err());
    }
}
