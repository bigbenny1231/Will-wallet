//! Pure helpers for NEAR Chain Signatures (`v1.signer-prod.testnet`, contract v3.18.0).
//!
//! Wire format verified against the live signer's embedded ABI and the official
//! `near-mpc-contract-interface` crate (see docs/chainsig-notes.md):
//!
//!   sign({"request": {"path": "...", "payload_v2": {"Ecdsa": "<32B hex>"} | {"Eddsa": "<msg hex>"}, "domain_id": 0|1}})
//!   -> {"scheme":"Secp256k1","big_r":{"affine_point":"<33B hex>"},"s":{"scalar":"<32B hex>"},"recovery_id":0|1}
//!   -> {"scheme":"Ed25519","signature":[64 x u8]}
//!
//! Nothing in here touches contract state, so it is unit-testable on the host and
//! shared verbatim by `contracts/dmw/src/foreign.rs`.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use omni_transaction::evm::types::Signature as EvmSignature;
use omni_transaction::evm::EVMTransaction;
use omni_transaction::solana::types::{Blockhash, SolanaAddress, SolanaSignature};
use omni_transaction::solana::utils::system_transfer;
use omni_transaction::solana::{SolanaTransaction, SolanaTransactionBuilder};
use omni_transaction::TxBuilder;

pub const MPC_SIGNER_TESTNET: &str = "v1.signer-prod.testnet";
/// secp256k1 (CaitSith) domain on the live signer.
pub const DOMAIN_ECDSA: u64 = 0;
/// ed25519 (Frost) domain on the live signer.
pub const DOMAIN_EDDSA: u64 = 1;
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;

// ---------------------------------------------------------------- wire types

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SignArgs {
    pub request: SignRequest,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AffinePoint {
    pub affine_point: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Scalar {
    pub scalar: String,
}

/// Response of `sign`, internally tagged by `scheme`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", tag = "scheme")]
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

// ---------------------------------------------------------------- EVM

/// Chain-environment + payout fields for one EIP-1559 native transfer.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
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
        return Err(format!("bad evm address length: {s}"));
    }
    let v = hex::decode(h).map_err(|e| format!("bad evm address hex: {e}"))?;
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

/// keccak256 of the EIP-1559 signing payload (`0x02 || rlp([...])`).
pub fn evm_sighash(tx: &EVMTransaction) -> [u8; 32] {
    keccak256(&tx.build_for_signing())
}

fn strip_leading_zeros(b: &[u8]) -> Vec<u8> {
    // RLP integers must be minimal; omni-transaction appends r/s as raw byte
    // strings, so a leading 0x00 would produce a tx nodes reject as non-canonical.
    let i = b.iter().position(|x| *x != 0).unwrap_or(b.len());
    b[i..].to_vec()
}

/// (r, s, y_parity) from an MPC secp256k1 response.
pub fn evm_rsv(big_r_hex: &str, s_hex: &str, recovery_id: u8) -> Result<([u8; 32], [u8; 32], u8), String> {
    let big_r = hex::decode(big_r_hex).map_err(|e| format!("big_r hex: {e}"))?;
    if big_r.len() != 33 {
        return Err(format!("big_r must be 33 bytes, got {}", big_r.len()));
    }
    let s = hex::decode(s_hex).map_err(|e| format!("s hex: {e}"))?;
    if s.len() != 32 {
        return Err(format!("s must be 32 bytes, got {}", s.len()));
    }
    if recovery_id > 1 {
        return Err(format!("unexpected recovery_id {recovery_id}"));
    }
    let mut r32 = [0u8; 32];
    r32.copy_from_slice(&big_r[1..]);
    let mut s32 = [0u8; 32];
    s32.copy_from_slice(&s);
    Ok((r32, s32, recovery_id))
}

/// Fully signed raw EIP-1559 tx bytes (ready for `eth_sendRawTransaction`).
pub fn evm_assemble(tx: &EVMTransaction, r: &[u8; 32], s: &[u8; 32], y_parity: u8) -> Vec<u8> {
    tx.build_with_signature(&EvmSignature {
        v: y_parity as u64,
        r: strip_leading_zeros(r),
        s: strip_leading_zeros(s),
    })
}

/// Ethereum address of a 64-byte uncompressed (x||y) secp256k1 public key.
pub fn evm_address_from_pubkey64(pk: &[u8]) -> [u8; 20] {
    let h = keccak256(pk);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    a
}

// ---------------------------------------------------------------- Solana

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SolanaTransfer {
    /// base58 derived source pubkey (also fee payer)
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

/// The bytes ed25519 signs on Solana: the serialized legacy message.
pub fn solana_message(tx: &SolanaTransaction) -> Vec<u8> {
    tx.build_for_signing()
}

pub fn solana_assemble(tx: &SolanaTransaction, sig: &[u8]) -> Result<Vec<u8>, String> {
    if sig.len() != 64 {
        return Err(format!("ed25519 signature must be 64 bytes, got {}", sig.len()));
    }
    let mut s = [0u8; 64];
    s.copy_from_slice(sig);
    Ok(tx.build_with_signature(&[SolanaSignature(s)]))
}

/// Parse `"ed25519:<base58>"` (as returned by `derived_public_key`, domain 1) into base58.
pub fn ed25519_key_to_base58(near_pk: &str) -> Result<String, String> {
    let b58 = near_pk.strip_prefix("ed25519:").ok_or("expected ed25519: prefix")?;
    let raw = near_sdk::bs58::decode(b58).into_vec().map_err(|e| format!("bs58: {e}"))?;
    if raw.len() != 32 {
        return Err(format!("ed25519 key must be 32 bytes, got {}", raw.len()));
    }
    Ok(b58.to_string())
}

// ---------------------------------------------------------------- misc

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let v = near_sdk::env::keccak256(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    out
}

pub fn base64_encode(data: &[u8]) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(data)
}
