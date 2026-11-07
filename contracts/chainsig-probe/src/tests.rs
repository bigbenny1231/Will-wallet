//! Known-answer tests. EVM vectors come from viem 2.x `signTransaction` (private key
//! 0x4c08...2318, address 0x2c7536E3605D9C16a7a3D7b1898e529396a65c23); the Solana vector
//! from @solana/web3.js 1.99 (Keypair.fromSeed([7; 32])). Our builder must reproduce
//! the exact sighash / message bytes and, given the reference signature, the exact raw tx.

use super::chainsig::*;
use near_sdk::json_types::{U128, U64};

fn evm_transfer(nonce: u64) -> EvmTransfer {
    EvmTransfer {
        to: "0x000000000000000000000000000000000000dEaD".into(),
        value: U128(1_000_000_000_000_000),
        nonce,
        max_fee_per_gas: U128(1_500_000_000),
        max_priority_fee_per_gas: U128(1_000_000),
        gas_limit: U128(21_000),
        chain_id: BASE_SEPOLIA_CHAIN_ID,
    }
}

struct EvmVector {
    nonce: u64,
    sighash: &'static str,
    r: &'static str,
    s: &'static str,
    y: u8,
    raw: &'static str,
}

const EVM_VECTORS: [EvmVector; 2] = [
    EvmVector {
        nonce: 3,
        sighash: "d2de2b2afb7f3733b7c15f33ede52c4cbe03e6d35c16e0f5afb19f6c739073d3",
        r: "f0fbff08e0e86c9e19272264915b8246a4e3a06dd37d18edf94dcc0d38a5d308",
        s: "39e0ecf2ca35bf30bfa495dae35f7770d13d3a1db7777668c87fbeb6f830b858",
        y: 1,
        raw: "02f87383014a3403830f42408459682f0082520894000000000000000000000000000000000000dead87038d7ea4c6800080c001a0f0fbff08e0e86c9e19272264915b8246a4e3a06dd37d18edf94dcc0d38a5d308a039e0ecf2ca35bf30bfa495dae35f7770d13d3a1db7777668c87fbeb6f830b858",
    },
    // r has a leading 0x00 byte: must be RLP-encoded as 31 bytes (0x9f prefix).
    EvmVector {
        nonce: 204,
        sighash: "1c9eb4eb642749000d2f5064aa63d62cdf336fb9b72aebaf95cd38f79067c950",
        r: "0082367146ea5b58bed67086e0b74d82022ebb609a5b083d9dd782f2687b8d8a",
        s: "71aaef89b5106b73172403a5f9d9cf19df46844b32fb950b4fce05e69ee52ad9",
        y: 1,
        raw: "02f87383014a3481cc830f42408459682f0082520894000000000000000000000000000000000000dead87038d7ea4c6800080c0019f82367146ea5b58bed67086e0b74d82022ebb609a5b083d9dd782f2687b8d8aa071aaef89b5106b73172403a5f9d9cf19df46844b32fb950b4fce05e69ee52ad9",
    },
];

#[test]
fn evm_sighash_matches_viem() {
    for v in &EVM_VECTORS {
        let tx = evm_tx(&evm_transfer(v.nonce)).unwrap();
        assert_eq!(hex::encode(evm_sighash(&tx)), v.sighash, "nonce {}", v.nonce);
    }
}

#[test]
fn evm_assembly_matches_viem_including_leading_zero_r() {
    for v in &EVM_VECTORS {
        let tx = evm_tx(&evm_transfer(v.nonce)).unwrap();
        // MPC returns big_r as a 33-byte compressed point; the prefix byte is dropped.
        let big_r = format!("02{}", v.r);
        let (r, s, y) = evm_rsv(&big_r, v.s, v.y).unwrap();
        let raw = evm_assemble(&tx, &r, &s, y);
        assert_eq!(hex::encode(raw), v.raw, "nonce {}", v.nonce);
    }
}

#[test]
fn evm_ecrecover_gives_signer_address() {
    let v = &EVM_VECTORS[0];
    let hash = hex::decode(v.sighash).unwrap();
    let mut rs = [0u8; 64];
    rs[..32].copy_from_slice(&hex::decode(v.r).unwrap());
    rs[32..].copy_from_slice(&hex::decode(v.s).unwrap());
    let pk = near_sdk::env::ecrecover(&hash, &rs, v.y, true).unwrap();
    assert_eq!(
        hex::encode(evm_address_from_pubkey64(&pk)),
        "2c7536e3605d9c16a7a3d7b1898e529396a65c23"
    );
}

#[test]
fn evm_rejects_bad_inputs() {
    assert!(parse_evm_address("0x1234").is_err());
    assert!(parse_evm_address("0xzz0000000000000000000000000000000000dead").is_err());
    assert!(evm_rsv("02ab", &"00".repeat(32), 0).is_err());
    assert!(evm_rsv(&"02".repeat(33), &"00".repeat(32), 2).is_err());
}

const SOL_FROM: &str = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const SOL_TO: &str = "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh";
const SOL_BH: &str = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const SOL_MSG: &str = "01000103ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c02000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cc490e928cd2e3873bb343fc95da33179ca60f4dbf46c2c36e91299d55d4e6b901020200010c0200000040420f0000000000";
const SOL_SIG: &str = "378a35a6527e8c1288d9695546a6fed45b7cc89a92b5c8c5978c3c69a4cf2b21d90e6a9fffb2f0aa07124e9df0e337f8e67415067bec9c307c9c680f5a51dc00";
const SOL_RAW_B64: &str = "ATeKNaZSfowSiNlpVUam/tRbfMiakrXIxZeMPGmkzysh2Q5qn/+y8KoHEk6d8OM3+OZ0FQZ77JwwfJxoD1pR3AABAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzEkOkozS44c7s0P8ldozF5ymD02/RsLDbpEpnVXU5rkBAgIAAQwCAAAAQEIPAAAAAAA=";

fn sol_transfer() -> SolanaTransfer {
    SolanaTransfer {
        from: SOL_FROM.into(),
        to: SOL_TO.into(),
        lamports: U64(1_000_000),
        recent_blockhash: SOL_BH.into(),
    }
}

#[test]
fn solana_message_matches_web3js() {
    let tx = solana_tx(&sol_transfer()).unwrap();
    assert_eq!(hex::encode(solana_message(&tx)), SOL_MSG);
}

#[test]
fn solana_assembly_matches_web3js() {
    let tx = solana_tx(&sol_transfer()).unwrap();
    let raw = solana_assemble(&tx, &hex::decode(SOL_SIG).unwrap()).unwrap();
    assert_eq!(base64_encode(&raw), SOL_RAW_B64);
    assert!(solana_assemble(&tx, &[0u8; 63]).is_err());
}

#[test]
fn solana_signature_verifies_over_message() {
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&hex::decode(SOL_SIG).unwrap());
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&near_sdk::bs58::decode(SOL_FROM).into_vec().unwrap());
    assert!(near_sdk::env::ed25519_verify(&sig, &hex::decode(SOL_MSG).unwrap(), &pk));
}

#[test]
fn ed25519_key_parsing() {
    assert_eq!(
        ed25519_key_to_base58("ed25519:GbSpP1GVyvXVRuNcKYaDerCeW3QwMudqzkDL5T3yPxe8").unwrap(),
        "GbSpP1GVyvXVRuNcKYaDerCeW3QwMudqzkDL5T3yPxe8"
    );
    assert!(ed25519_key_to_base58("secp256k1:abc").is_err());
}

// ---- wire compatibility with the official MPC interface crate ----

#[test]
fn sign_request_roundtrips_through_official_types() {
    use near_mpc_contract_interface::types::{Payload as OPayload, SignRequestArgs};
    let ours = sign_args_ecdsa("base-1", &[0xab; 32]);
    let json = serde_json::to_value(&ours).unwrap();
    assert_eq!(
        json,
        serde_json::json!({"request":{"path":"base-1","payload_v2":{"Ecdsa":"ab".repeat(32)},"domain_id":0}})
    );
    let theirs: SignRequestArgs = serde_json::from_value(json["request"].clone()).unwrap();
    assert!(matches!(theirs.payload_v2, OPayload::Ecdsa(_)));
    assert_eq!(theirs.domain_id.0, 0);

    let ours = sign_args_eddsa("sol-1", &hex::decode(SOL_MSG).unwrap());
    let json = serde_json::to_value(&ours).unwrap();
    let theirs: SignRequestArgs = serde_json::from_value(json["request"].clone()).unwrap();
    assert!(matches!(theirs.payload_v2, OPayload::Eddsa(_)));
    assert_eq!(theirs.domain_id.0, 1);
}

#[test]
fn signature_response_parses_official_serialization() {
    use near_mpc_contract_interface::types::SignatureResponse as OResp;
    let secp = serde_json::json!({
        "scheme": "Secp256k1",
        "big_r": {"affine_point": format!("03{}", "11".repeat(32))},
        "s": {"scalar": "22".repeat(32)},
        "recovery_id": 1
    });
    // official type accepts it, and re-serializes to the same JSON we parse
    let official: OResp = serde_json::from_value(secp.clone()).unwrap();
    let ours: SignatureResponse = serde_json::from_value(serde_json::to_value(&official).unwrap()).unwrap();
    assert!(matches!(ours, SignatureResponse::Secp256k1 { recovery_id: 1, .. }));

    let ed = serde_json::json!({"scheme": "Ed25519", "signature": vec![9u8; 64]});
    let official: OResp = serde_json::from_value(ed).unwrap();
    let ours: SignatureResponse = serde_json::from_value(serde_json::to_value(&official).unwrap()).unwrap();
    match ours {
        SignatureResponse::Ed25519 { signature } => assert_eq!(signature, vec![9u8; 64]),
        _ => panic!(),
    }
}
