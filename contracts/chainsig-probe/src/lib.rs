//! chainsig-probe: the smallest contract that proves NEAR Chain Signatures end to end
//! for the two Lastword payout chains.
//!
//! - `sign_evm_transfer`   -> EIP-1559 native transfer on Base Sepolia (domain 0, secp256k1)
//! - `sign_solana_transfer`-> SystemProgram::transfer on Solana devnet (domain 1, ed25519)
//!
//! Each returns (through the callback) a fully signed raw transaction that anyone can
//! broadcast, plus an on-chain self-check of the signature (ecrecover / ed25519_verify).

pub mod chainsig;

use chainsig::*;
use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError};

/// `sign` only requires >= 15 TGas attached (live `config`); we attach this
/// minimum plus all unused gas via weight, so a 300 TGas call gives it ~250 TGas.
const SIGN_MIN_GAS: Gas = Gas::from_tgas(50);
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(30);
const DERIVE_VIEW_GAS: Gas = Gas::from_tgas(10);
const SOL_KEY_CALLBACK_MIN_GAS: Gas = Gas::from_tgas(100);

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignedEvm {
    pub raw_tx: String,
    pub tx_hash: String,
    pub sighash: String,
    pub recovered_signer: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignedSolana {
    pub raw_tx_base64: String,
    pub signature: String,
    pub from: String,
    pub signature_valid: bool,
}

#[near(contract_state)]
#[derive(Default)]
pub struct Probe {
    signer: Option<AccountId>,
}

#[near]
impl Probe {
    fn signer_id(&self) -> AccountId {
        self.signer
            .clone()
            .unwrap_or_else(|| MPC_SIGNER_TESTNET.parse().unwrap())
    }

    fn call_sign(&self, args: &SignArgs) -> Promise {
        Promise::new(self.signer_id()).function_call_weight(
            "sign".to_string(),
            near_sdk::serde_json::to_vec(args).unwrap(),
            NearToken::from_yoctonear(1),
            SIGN_MIN_GAS,
            GasWeight(1),
        )
    }

    /// Point the probe at a different MPC signer (defaults to v1.signer-prod.testnet).
    pub fn set_signer(&mut self, signer: AccountId) {
        assert_eq!(env::predecessor_account_id(), env::current_account_id(), "self only");
        self.signer = Some(signer);
    }

    /// Request an MPC signature for an EIP-1559 native transfer.
    #[allow(clippy::too_many_arguments)]
    pub fn sign_evm_transfer(
        &mut self,
        to: String,
        value: U128,
        nonce: u64,
        max_fee: U128,
        prio_fee: U128,
        gas_limit: U128,
        chain_id: Option<u64>,
        path: Option<String>,
    ) -> Promise {
        let path = path.unwrap_or_else(|| "base-1".to_string());
        let t = EvmTransfer {
            to,
            value,
            nonce,
            max_fee_per_gas: max_fee,
            max_priority_fee_per_gas: prio_fee,
            gas_limit,
            chain_id: chain_id.unwrap_or(BASE_SEPOLIA_CHAIN_ID),
        };
        let tx = evm_tx(&t).unwrap_or_else(|e| env::panic_str(&e));
        let hash = evm_sighash(&tx);
        env::log_str(&format!("evm sighash 0x{} path {}", hex::encode(hash), path));
        self.call_sign(&sign_args_ecdsa(&path, &hash)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(SIGN_CALLBACK_GAS)
                .with_unused_gas_weight(0)
                .on_evm_signed(t),
        )
    }

    #[private]
    pub fn on_evm_signed(
        &self,
        t: EvmTransfer,
        #[callback_result] res: Result<SignatureResponse, PromiseError>,
    ) -> SignedEvm {
        let sig = res.unwrap_or_else(|_| env::panic_str("mpc sign failed"));
        let (big_r, s, rid) = match sig {
            SignatureResponse::Secp256k1 { big_r, s, recovery_id } => (big_r.affine_point, s.scalar, recovery_id),
            other => env::panic_str(&format!("unexpected scheme: {other:?}")),
        };
        let tx = evm_tx(&t).unwrap();
        let hash = evm_sighash(&tx);
        let (r, s, v) = evm_rsv(&big_r, &s, rid).unwrap_or_else(|e| env::panic_str(&e));
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&r);
        rs[32..].copy_from_slice(&s);
        let recovered = env::ecrecover(&hash, &rs, v, true)
            .map(|pk: [u8; 64]| format!("0x{}", hex::encode(evm_address_from_pubkey64(&pk))));
        let raw = evm_assemble(&tx, &r, &s, v);
        SignedEvm {
            tx_hash: format!("0x{}", hex::encode(keccak256(&raw))),
            raw_tx: format!("0x{}", hex::encode(&raw)),
            sighash: format!("0x{}", hex::encode(hash)),
            recovered_signer: recovered,
        }
    }

    /// Request an MPC signature for a Solana SystemProgram transfer from this
    /// contract's derived ed25519 key. The source pubkey is looked up on-chain
    /// from the signer (`derived_public_key`), never trusted from the caller.
    pub fn sign_solana_transfer(
        &mut self,
        to: String,
        lamports: U64,
        recent_blockhash: String,
        path: Option<String>,
    ) -> Promise {
        let path = path.unwrap_or_else(|| "sol-1".to_string());
        Promise::new(self.signer_id())
            .function_call(
                "derived_public_key".to_string(),
                near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({
                    "path": path,
                    "predecessor": env::current_account_id(),
                    "domain_id": DOMAIN_EDDSA,
                }))
                .unwrap(),
                NearToken::from_yoctonear(0),
                DERIVE_VIEW_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SOL_KEY_CALLBACK_MIN_GAS)
                    .with_unused_gas_weight(1)
                    .on_sol_key(path, to, lamports, recent_blockhash),
            )
    }

    #[private]
    pub fn on_sol_key(
        &mut self,
        path: String,
        to: String,
        lamports: U64,
        recent_blockhash: String,
        #[callback_result] key: Result<String, PromiseError>,
    ) -> Promise {
        let key = key.unwrap_or_else(|_| env::panic_str("derived_public_key failed"));
        let from = ed25519_key_to_base58(&key).unwrap_or_else(|e| env::panic_str(&e));
        let t = SolanaTransfer { from, to, lamports, recent_blockhash };
        let tx = solana_tx(&t).unwrap_or_else(|e| env::panic_str(&e));
        let msg = solana_message(&tx);
        env::log_str(&format!("solana from {} msg {} bytes path {}", t.from, msg.len(), path));
        self.call_sign(&sign_args_eddsa(&path, &msg)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(SIGN_CALLBACK_GAS)
                .with_unused_gas_weight(0)
                .on_sol_signed(t),
        )
    }

    #[private]
    pub fn on_sol_signed(
        &self,
        t: SolanaTransfer,
        #[callback_result] res: Result<SignatureResponse, PromiseError>,
    ) -> SignedSolana {
        let sig = match res.unwrap_or_else(|_| env::panic_str("mpc sign failed")) {
            SignatureResponse::Ed25519 { signature } => signature,
            other => env::panic_str(&format!("unexpected scheme: {other:?}")),
        };
        let tx = solana_tx(&t).unwrap();
        let msg = solana_message(&tx);
        let raw = solana_assemble(&tx, &sig).unwrap_or_else(|e| env::panic_str(&e));
        let mut sig64 = [0u8; 64];
        sig64.copy_from_slice(&sig);
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&near_sdk::bs58::decode(&t.from).into_vec().unwrap());
        SignedSolana {
            raw_tx_base64: base64_encode(&raw),
            signature: near_sdk::bs58::encode(&sig).into_string(),
            signature_valid: env::ed25519_verify(&sig64, &msg, &pk),
            from: t.from,
        }
    }
}

#[cfg(test)]
mod tests;
