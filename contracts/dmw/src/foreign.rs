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
//! `resign_foreign` re-requests a signature for a payout step 3 already handled
//! (`failed`, or `signed` but not broadcast, e.g. an expired Solana blockhash or a stale
//! EVM nonce). It never touches `foreign_index`/`step`.
//!
//! Wire format verified against live `v1.signer-prod.testnet` 3.18.0; see
//! docs/chainsig-notes.md. The unsigned tx params are held in a raw storage slot between
//! request and callback so `on_foreign_signed` keeps its original signature.

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, Gas, GasWeight, NearToken, Promise, PromiseError, PromiseOrValue};
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
/// MPC signer contract (SPEC §1).
pub const MPC_SIGNER: &str = "v1.signer-prod.testnet";
/// Deposit required by the MPC `sign` method.
pub const MPC_SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ForeignChain {
    Base,
    Solana,
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
    match chain {
        ForeignChain::Base => format!("base-{token_id}"),
        ForeignChain::Solana => format!("sol-{token_id}"),
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
    env::storage_write(&pending_key(token_id, index), &near_sdk::borsh::to_vec(p).unwrap());
}

fn take_pending(token_id: u64, index: usize) -> Option<PendingTx> {
    let key = pending_key(token_id, index);
    let raw = env::storage_read(&key)?;
    env::storage_remove(&key);
    near_sdk::borsh::from_slice(&raw).ok()
}

/// Build the EVM transfer for `payout` from keeper-supplied chain params.
pub fn evm_transfer_for(payout: &ForeignPayout, a: &EvmArgs) -> Result<(EvmTransfer, [u8; 32]), String> {
    let t = EvmTransfer {
        to: payout.to.clone(),
        value: payout.amount,
        nonce: a.nonce,
        max_fee_per_gas: a.max_fee_per_gas,
        max_priority_fee_per_gas: a.max_priority_fee_per_gas,
        gas_limit: a.gas_limit,
        chain_id: BASE_SEPOLIA_CHAIN_ID,
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
    let lamports = u64::try_from(payout.amount.0).map_err(|_| "amount exceeds u64 lamports".to_string())?;
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
pub fn assemble_signed(pending: &PendingTx, response: &serde_json::Value) -> Result<(String, String), String> {
    let sig: SignatureResponse =
        serde_json::from_value(response.clone()).map_err(|_| "unexpected signature response".to_string())?;
    match (pending, sig) {
        (PendingTx::Evm(t), SignatureResponse::Secp256k1 { big_r, s, recovery_id }) => {
            let tx = evm_tx(t)?;
            let (r, s, v) = evm_rsv(&big_r.affine_point, &s.scalar, recovery_id)?;
            let raw = evm_assemble(&tx, &r, &s, v);
            Ok((format!("0x{}", hex::encode(&raw)), format!("0x{}", hex::encode(keccak256(&raw)))))
        }
        (PendingTx::Solana(t), SignatureResponse::Ed25519 { signature }) => {
            let tx = solana_tx(t)?;
            if signature.len() != 64 {
                return Err("bad ed25519 signature length".into());
            }
            let mut sig64 = [0u8; 64];
            sig64.copy_from_slice(&signature);
            let mut pk = [0u8; 32];
            pk.copy_from_slice(&near_sdk::bs58::decode(&t.from).into_vec().map_err(|e| e.to_string())?);
            if !env::ed25519_verify(&sig64, &solana_message(&tx), &pk) {
                return Err("ed25519 signature does not verify".into());
            }
            let raw = solana_assemble(&tx, &signature)?;
            Ok((base64_encode(&raw), near_sdk::bs58::encode(&signature).into_string()))
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
        let payout = self.vault(token_id).foreign[index].clone();
        let me = env::current_account_id();
        let path = derivation_path(payout.chain, token_id);
        match payout.chain {
            ForeignChain::Base => {
                let a = args
                    .and_then(|a| a.evm)
                    .unwrap_or_else(|| env::panic_str("step 3: args.evm is required for a base payout"));
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
                let a = args
                    .and_then(|a| a.solana)
                    .unwrap_or_else(|| env::panic_str("step 3: args.solana is required for a solana payout"));
                require_blockhash(&a);
                // Validate the payout itself before spending a cross-contract hop.
                if let Err(e) = solana_transfer_for(&payout, SYSTEM_PROGRAM_B58.into(), a.recent_blockhash.clone()) {
                    return self.fail_later(token_id, index, &e);
                }
                derived_key_call(&path).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_SOL_KEY)
                        .with_unused_gas_weight(1)
                        .on_foreign_sol_key(token_id, index, a.recent_blockhash, None),
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
                return PromiseOrValue::Value(v.step);
            }
            Err(e) => {
                return PromiseOrValue::Value(self.finish_foreign(token_id, index, ForeignStatus::Failed, None, &e))
            }
        };
        if !payout.from_address.is_empty() && payout.from_address != t.from {
            env::log_str(&format!("note: from_address {} != derived {}", payout.from_address, t.from));
        }
        let path = derivation_path(ForeignChain::Solana, token_id);
        let me = env::current_account_id();
        let cb = if resign {
            Self::ext(me)
                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                .with_unused_gas_weight(0)
                .on_foreign_resigned(token_id, index, PendingTx::Solana(t))
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
            Ok((raw, txid)) => {
                self.finish_foreign(token_id, index, ForeignStatus::Signed, Some(raw), &format!("signed {txid}"))
            }
            Err(e) => self.finish_foreign(token_id, index, ForeignStatus::Failed, None, &e),
        }
    }

    /// Anyone: request a fresh signature for a payout that step 3 already handled and
    /// that is `failed` or `signed` (not yet broadcast), e.g. after a Solana blockhash
    /// expired or an EVM nonce went stale. Does not change `step`/`foreign_index`.
    pub fn resign_foreign(&mut self, token_id: TokenRef, index: u32, args: StepArgs) -> Promise {
        let id = token_id.id();
        let v = self.vault(id);
        let i = index as usize;
        require!(v.stored != StoredState::Live, "not_triggered");
        require!(i < v.foreign.len(), "index out of range");
        require!(v.step > 3 || (v.step == 3 && i < v.foreign_index as usize), "payout not processed yet");
        let payout = v.foreign[i].clone();
        require!(
            matches!(payout.status, ForeignStatus::Failed | ForeignStatus::Signed),
            "payout is not failed/signed"
        );
        let me = env::current_account_id();
        let path = derivation_path(payout.chain, id);
        match payout.chain {
            ForeignChain::Base => {
                let a = args.evm.unwrap_or_else(|| env::panic_str("args.evm is required for a base payout"));
                let (t, hash) = evm_transfer_for(&payout, &a).unwrap_or_else(|e| env::panic_str(&e));
                sign_call(&sign_args_ecdsa(&path, &hash)).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                        .with_unused_gas_weight(0)
                        .on_foreign_resigned(id, i, PendingTx::Evm(t)),
                )
            }
            ForeignChain::Solana => {
                let a = args.solana.unwrap_or_else(|| env::panic_str("args.solana is required for a solana payout"));
                require_blockhash(&a);
                solana_transfer_for(&payout, SYSTEM_PROGRAM_B58.into(), a.recent_blockhash.clone())
                    .unwrap_or_else(|e| env::panic_str(&e));
                derived_key_call(&path).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_SOL_KEY)
                        .with_unused_gas_weight(1)
                        .on_foreign_sol_key(id, i, a.recent_blockhash, Some(true)),
                )
            }
        }
    }

    /// Callback for `resign_foreign`. Returns the payout's resulting status.
    #[private]
    pub fn on_foreign_resigned(
        &mut self,
        token_id: u64,
        index: usize,
        pending: PendingTx,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) -> String {
        let mut v = self.vault(token_id);
        let current = v.foreign[index].status;
        if current == ForeignStatus::Broadcast || current == ForeignStatus::Pending {
            env::log_str("resign result ignored: payout already broadcast");
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
                let data = json!({"token_id": token_id.to_string(), "index": index, "chain": chain, "status": "signed", "detail": format!("resigned {txid}")});
                record(&mut v, token_id, "foreign_signed", &format!("#{index} resigned {txid}"), data);
            }
            Err(e) => {
                let data = json!({"token_id": token_id.to_string(), "index": index, "chain": chain, "detail": e});
                record(&mut v, token_id, "foreign_resign_failed", &format!("#{index} {e}"), data);
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
        Secp256k1 { big_r: AffinePoint, s: Scalar, recovery_id: u8 },
        Ed25519 { signature: Vec<u8> },
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
        let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
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

    pub fn evm_rsv(big_r_hex: &str, s_hex: &str, recovery_id: u8) -> Result<([u8; 32], [u8; 32], u8), String> {
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
        let bh = Blockhash::from_base58(&t.recent_blockhash).map_err(|e| format!("blockhash: {e}"))?;
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
        let b58 = near_pk.strip_prefix("ed25519:").ok_or("expected ed25519: key")?;
        let raw = near_sdk::bs58::decode(b58).into_vec().map_err(|_| "bad base58 key".to_string())?;
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
            assert_eq!(txid, format!("0x{}", hex::encode(keccak256(&hex::decode(raw).unwrap()))));
        }
    }

    #[test]
    fn evm_sign_args_wire_shape() {
        let a = serde_json::to_value(sign_args_ecdsa("base-7", &[0xab; 32])).unwrap();
        assert_eq!(a, json!({"request":{"path":"base-7","payload_v2":{"Ecdsa":"ab".repeat(32)},"domain_id":0}}));
    }

    pub(crate) const SOL_FROM: &str = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
    pub(crate) const SOL_TO: &str = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
    pub(crate) const SOL_BH: &str = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
    const SOL_MSG: &str = "01000103ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c02000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cc490e928cd2e3873bb343fc95da33179ca60f4dbf46c2c36e91299d55d4e6b901020200010c0200000040420f0000000000";
    pub(crate) const SOL_SIG: &str = "378a35a6527e8c1288d9695546a6fed45b7cc89a92b5c8c5978c3c69a4cf2b21d90e6a9fffb2f0aa07124e9df0e337f8e67415067bec9c307c9c680f5a51dc00";
    pub(crate) const SOL_RAW_B64: &str = "ATeKNaZSfowSiNlpVUam/tRbfMiakrXIxZeMPGmkzysh2Q5qn/+y8KoHEk6d8OM3+OZ0FQZ77JwwfJxoD1pR3AABAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzEkOkozS44c7s0P8ldozF5ymD02/RsLDbpEpnVXU5rkBAgIAAQwCAAAAQEIPAAAAAAA=";

    fn payout_sol(amount: u128) -> ForeignPayout {
        ForeignPayout { chain: ForeignChain::Solana, to: SOL_TO.into(), amount: U128(amount), ..payout_base() }
    }

    #[test]
    fn solana_payload_matches_web3js() {
        let (_, msg) = solana_transfer_for(&payout_sol(1_000_000), SOL_FROM.into(), SOL_BH.into()).unwrap();
        assert_eq!(hex::encode(msg), SOL_MSG);
        let a = serde_json::to_value(sign_args_eddsa("sol-7", &hex::decode(SOL_MSG).unwrap())).unwrap();
        assert_eq!(a["request"]["payload_v2"]["Eddsa"], SOL_MSG);
        assert_eq!(a["request"]["domain_id"], 1);
    }

    #[test]
    fn solana_assembly_matches_web3js() {
        let (t, _) = solana_transfer_for(&payout_sol(1_000_000), SOL_FROM.into(), SOL_BH.into()).unwrap();
        let resp = json!({"scheme":"Ed25519","signature": hex::decode(SOL_SIG).unwrap()});
        let (raw, txid) = assemble_signed(&PendingTx::Solana(t.clone()), &resp).unwrap();
        assert_eq!(raw, SOL_RAW_B64);
        assert_eq!(txid, near_sdk::bs58::encode(hex::decode(SOL_SIG).unwrap()).into_string());
        // a signature that does not verify over the message is rejected, not stored
        let mut bad = hex::decode(SOL_SIG).unwrap();
        bad[0] ^= 1;
        assert!(assemble_signed(&PendingTx::Solana(t), &json!({"scheme":"Ed25519","signature":bad})).is_err());
    }

    #[test]
    fn rejects_mismatched_or_malformed_responses() {
        let (t, _) = evm_transfer_for(&payout_base(), &evm_args(3)).unwrap();
        let p = PendingTx::Evm(t);
        assert!(assemble_signed(&p, &json!({"scheme":"Ed25519","signature": vec![0u8; 64]})).is_err());
        assert!(assemble_signed(&p, &json!({"stub": true})).is_err());
        assert!(assemble_signed(&p, &mpc_secp("00", "11", 0)).is_err());
    }

    #[test]
    fn unbuildable_payouts_are_errors() {
        assert!(solana_transfer_for(&payout_sol(u64::MAX as u128 + 1), SOL_FROM.into(), SOL_BH.into()).is_err());
        let bad_to = ForeignPayout { to: "0x1234".into(), ..payout_base() };
        assert!(evm_transfer_for(&bad_to, &evm_args(0)).is_err());
    }

    #[test]
    fn paths_follow_spec() {
        assert_eq!(derivation_path(ForeignChain::Base, 12), "base-12");
        assert_eq!(derivation_path(ForeignChain::Solana, 12), "sol-12");
    }
}
