//! Step 3: foreign-chain payouts via NEAR Chain Signatures (SPEC §2.4).
//!
//! Flow per payout (`execute_step` at step 3 calls `request_foreign_signature`):
//!
//! ```text
//! EVM    : build EIP-1559 tx -> signer.derived_public_key(<path>, domain 0) -> on_foreign_evm_key
//!          -> keccak256 -> signer.sign{Ecdsa, domain 0} -> on_foreign_signed (ecrecover == key)
//! Solana : signer.derived_public_key(<path>, domain 1) -> on_foreign_sol_key
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
//!   payments. Every re-sign waits `RESIGN_COOLDOWN_MS` after the last request, so the old
//!   blockhash has expired.
//! - **Who** (v2, findings C/E): only an operator (contract keeper, the vault's own keeper,
//!   the vault owner or an heir) may re-sign any payout, and the cooldown applies to every
//!   re-sign on every chain. Operators must check off-chain that an old signature never landed.
//! - One re-sign per payout may be in flight at a time.
//!
//! Every derivation path carries a per-vault random salt (`<prefix>-<id>-<salt>`), so the
//! source address can't be predicted before the vault exists, and an EVM signature is only
//! stored after it recovers to the derived key the signer reports for that path.
//!
//! Wire format verified against live `v1.signer-prod.testnet` 3.18.0; see
//! docs/chainsig-notes.md. The unsigned tx params are held in a raw storage slot between
//! request and callback.

use near_sdk::json_types::U128;
use near_sdk::{
    env, near, require, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError, PromiseOrValue,
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
/// Gas for the cross-contract `derived_public_key` view (source key for the payout's path).
pub const GAS_DERIVED_KEY: Gas = Gas::from_tgas(10);
/// Minimum gas for `on_foreign_sol_key` / `on_foreign_evm_key` (each schedules sign +
/// callback); gets unused gas too.
pub const GAS_ON_SOL_KEY: Gas = Gas::from_tgas(100);
/// Gas for the self-call that records an unbuildable payout as failed.
const GAS_FOREIGN_FAIL: Gas = Gas::from_tgas(10);
/// Cap on caller-supplied EIP-1559 fees on Base (100 gwei). Bounds how much of the derived
/// address's ETH a permissionless caller can burn as gas (H-2). Each registry chain has
/// its own cap (`EvmChain::max_fee_per_gas`).
pub const MAX_EVM_FEE_PER_GAS: u128 = 100_000_000_000;
/// Monad testnet fee cap (1000 gwei). Monad's base fee floor is 100 gwei, so the Base cap
/// would reject every honest Monad step. Monad bills the full gas LIMIT, not gas used, so
/// the worst case per payout is MAX_EVM_GAS_LIMIT x 1000 gwei = 0.1 MON (review 2, M-5); an
/// honest step at the 50 000 gas floor (H-5) and 202 gwei pays about 0.01 MON.
pub const MAX_MONAD_FEE_PER_GAS: u128 = 1_000_000_000_000;
/// Caller-supplied gas limit range for a native transfer.
pub const MIN_EVM_GAS_LIMIT: u128 = 21_000;
pub const MAX_EVM_GAS_LIMIT: u128 = 100_000;
/// Gas limit the contract actually signs with when the caller asks for less (final audit H-5).
/// 21 000 is exactly the intrinsic cost of a value transfer, so a recipient with ANY code
/// (Safe, ERC-4337 smart wallet, EIP-7702-delegated EOA, WETH-like contract) runs out of gas.
/// The tx is still mined, uses the payout's pinned nonce, and the payout can then never be
/// signed again: its ETH/MON is stuck in the derived address. 50 000 covers a Safe or smart
/// wallet `receive` (~26-30k) and a fresh WETH deposit (~45k). Base bills gas used, so a
/// transfer to an EOA still costs 21 000; Monad bills the limit (50 000 x 202 gwei ~ 0.01 MON).
pub const EVM_GAS_LIMIT_FLOOR: u128 = 50_000;
/// A non-keeper's re-sign of a `signed`/`broadcast` EVM payout needs both fee fields >= 110% of
/// the last request, or at the chain's cap (second review F4). A keeper may re-sign at any fee and
/// gas limit within the caps (G1): the nonce is pinned, so a re-sign only ever replaces the tx.
pub const EVM_FEE_BUMP_PCT: u128 = 110;
/// Minimum age of the last signature request before any payout may be re-signed (Solana: the
/// old blockhash is long expired; EVM: rate limit on fee ratchets and status flips).
pub const RESIGN_COOLDOWN_MS: u64 = 5 * 60 * 1000;
/// Default MPC signer contract (SPEC §1). The signer actually used is set once in `new`
/// (`Contract::mpc_signer`, shown by `get_config`), so a sandbox or mainnet deploy can point
/// at its own signer (finding L-8).
pub const DEFAULT_MPC_SIGNER: &str = "v1.signer-prod.testnet";
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
    /// Upper bound on the `max_fee_per_gas` (and priority fee) of a non-keeper's signature: an heir,
    /// the vault owner, or anyone once step 3 is open (second review F4, G1). Larger values are
    /// clamped, not rejected, so settlement never stalls on them. Chosen so that the balance a node
    /// demands at the chain's gas floor stays near an honest buffer.
    pub non_keeper_max_fee_per_gas: u128,
    /// Most payouts of this chain one vault may hold (they all leave one derived address).
    /// Monad: 1. Its reserve-balance rule reverts a value transfer that leaves an EOA below
    /// 10 MON unless it is an "emptying" tx (no other tx from the sender in the last 3
    /// blocks). A second payout from `monad-<id>` can be relayed right behind the first by
    /// anyone (both signed txs are public), reverts, and burns its pinned nonce: the payout
    /// can then never be signed again and its MON is stuck (SECURITY_REVIEW_2 H-4). With
    /// one payout the address only ever sends one tx (nonce 0), which is always emptying.
    pub max_payouts: usize,
    /// Smallest gas limit the contract signs with (caller values below it are raised).
    pub min_gas_limit: u128,
}

pub const BASE_SEPOLIA: EvmChain = EvmChain {
    chain_id: 84532,
    path_prefix: "base",
    rpc: "https://sepolia.base.org",
    explorer_tx: "https://sepolia.basescan.org/tx/",
    max_fee_per_gas: MAX_EVM_FEE_PER_GAS,
    // 10 gwei = 10% of the cap: 50 000 gas x 10 gwei = 0.0005 ETH on top of the value. Honest Base
    // Sepolia fees are ~0.001-0.01 gwei.
    non_keeper_max_fee_per_gas: MAX_EVM_FEE_PER_GAS / 10,
    max_payouts: crate::MAX_FOREIGN,
    min_gas_limit: EVM_GAS_LIMIT_FLOOR,
};

pub const MONAD_TESTNET: EvmChain = EvmChain {
    chain_id: 10143,
    path_prefix: "monad",
    rpc: "https://testnet-rpc.monad.xyz",
    explorer_tx: "https://testnet.monadexplorer.com/tx/",
    max_fee_per_gas: MAX_MONAD_FEE_PER_GAS,
    // 200 gwei = 20% of the cap. 10% (100 gwei) would equal Monad's base-fee floor and leave no
    // headroom at all; 200 gwei x the 50 000 gas floor = 0.01 MON, the honest buffer (an honest
    // keeper signs 2 x base fee + priority, about 202 gwei).
    non_keeper_max_fee_per_gas: MAX_MONAD_FEE_PER_GAS / 5,
    max_payouts: 1,
    min_gas_limit: EVM_GAS_LIMIT_FLOOR,
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
                "path": format!("{}-<token_id>-<salt>", e.path_prefix), "domain_id": DOMAIN_ECDSA,
                "rpc": e.rpc, "explorer_tx": e.explorer_tx,
                "max_fee_per_gas": U128(e.max_fee_per_gas),
                "non_keeper_max_fee_per_gas": U128(e.non_keeper_max_fee_per_gas),
                "max_payouts": e.max_payouts,
                "min_gas_limit": U128(e.min_gas_limit),
            }),
            None => json!({
                "chain": c.as_str(), "kind": "solana", "cluster": "devnet",
                "path": "sol-<token_id>-<salt>", "domain_id": DOMAIN_EDDSA,
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

/// Derivation path for a vault's foreign source address (SPEC §1): `<prefix>-<id>-<salt>`.
/// The salt is 16 hex chars fixed at `create_vault` from the block's random seed, the owner
/// and the id, so nobody can pre-compute (and pre-fund, or pre-sign for) a vault's address
/// before it exists. An empty salt gives the legacy v1 path `<prefix>-<id>`.
pub fn derivation_path(chain: ForeignChain, token_id: u64, salt: &str) -> String {
    let prefix = match chain.evm() {
        Some(e) => e.path_prefix,
        None => "sol",
    };
    if salt.is_empty() {
        format!("{prefix}-{token_id}")
    } else {
        format!("{prefix}-{token_id}-{salt}")
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

pub(crate) fn read_pending(token_id: u64, index: usize) -> Option<PendingTx> {
    let raw = env::storage_read(&pending_key(token_id, index))?;
    near_sdk::borsh::from_slice(&raw).ok()
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

/// Validate caller EVM params and return them with the contract-chosen nonce and the gas
/// limit raised to the chain floor (H-5). Used by step 3 and `resign_foreign` alike.
pub fn effective_evm_args(mut a: EvmArgs, foreign: &[ForeignPayout], index: usize) -> EvmArgs {
    let chain = foreign[index].chain;
    validate_evm_args(&a, chain);
    let floor = chain
        .evm()
        .unwrap_or_else(|| env::panic_str("not an evm chain"))
        .min_gas_limit;
    a.gas_limit = U128(a.gas_limit.0.max(floor));
    a.nonce = evm_nonce_for(foreign, index);
    a
}

/// Clamp validated EVM args into what a non-keeper may choose: max fee and priority fee at most
/// `EvmChain::non_keeper_max_fee_per_gas` (priority <= max fee), gas limit = the chain floor
/// (50 000: covers a Safe / smart-wallet `receive` and a WETH-like deposit, final audit H-5; a
/// higher non-keeper limit would raise the balance a node demands above the honest buffer on
/// Monad, which bills the full limit). A keeper can re-sign with a higher limit (G1).
pub fn limit_non_keeper_evm_args(mut a: EvmArgs, chain: ForeignChain) -> EvmArgs {
    let c = chain
        .evm()
        .unwrap_or_else(|| env::panic_str("not an evm chain"));
    let max_fee = c.non_keeper_max_fee_per_gas;
    a.max_fee_per_gas = U128(a.max_fee_per_gas.0.min(max_fee));
    a.max_priority_fee_per_gas = U128(a.max_priority_fee_per_gas.0.min(a.max_fee_per_gas.0));
    a.gas_limit = U128(c.min_gas_limit);
    a
}

/// True when `new` is a valid replacement fee for `last`: >= 110% of it, or at the chain cap
/// (a signature already at the cap can still be replaced; second review F4).
pub fn is_fee_bump(new: u128, last: u128, cap: u128) -> bool {
    new >= cap || new.saturating_mul(100) >= last.saturating_mul(EVM_FEE_BUMP_PCT)
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
///
/// v2: an EVM signature is only accepted when it recovers (ecrecover, low-s enforced) to
/// `evm_key`, the vault's derived secp256k1 key as the MPC signer reported it for this path. A
/// signature for any other key, or no key to check against, is an error: nothing unverified is
/// ever stored as broadcastable. Solana signatures are verified against the derived ed25519 key.
pub fn assemble_signed(
    pending: &PendingTx,
    response: &serde_json::Value,
    evm_key: Option<&[u8; 64]>,
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
            let expected = evm_key.ok_or_else(|| "no derived key to verify against".to_string())?;
            let mut rs = [0u8; 64];
            rs[..32].copy_from_slice(&r);
            rs[32..].copy_from_slice(&s);
            match ecrecover64(&evm_sighash(&tx), &rs, v) {
                Some(k) if &k == expected => {}
                Some(_) => return Err("evm signature is not from the derived address".into()),
                None => return Err("evm signature does not recover".into()),
            }
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

/// The source address a pending tx is sent from: EVM from the derived key, Solana from the tx.
fn source_address(pending: &PendingTx, evm_key: Option<&[u8; 64]>) -> Option<String> {
    match pending {
        PendingTx::Evm(_) => evm_key.map(evm_address_from_key),
        PendingTx::Solana(t) => Some(t.from.clone()),
    }
}

fn sign_call(signer: &AccountId, args: &SignArgs) -> Promise {
    Promise::new(signer.clone()).function_call_weight(
        "sign".to_string(),
        serde_json::to_vec(args).unwrap(),
        MPC_SIGN_DEPOSIT,
        GAS_MPC_SIGN,
        GasWeight(1),
    )
}

fn derived_key_call(signer: &AccountId, path: &str, domain_id: u64) -> Promise {
    Promise::new(signer.clone()).function_call(
        "derived_public_key".to_string(),
        serde_json::to_vec(&json!({
            "path": path,
            "predecessor": env::current_account_id(),
            "domain_id": domain_id,
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

/// A callback's single promise result, or `Err` when the callback did not get exactly one.
fn single_result<T>(r: Result<T, PromiseError>) -> Result<T, PromiseError> {
    if env::promise_results_count() == 1 {
        r
    } else {
        Err(PromiseError::Failed)
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
        let v = self.vault(token_id);
        let foreign = v.foreign.clone();
        let payout = foreign[index].clone();
        let me = env::current_account_id();
        let path = v.path(token_id, payout.chain);
        let now = env::block_timestamp_ms();
        let keeper = self.is_keeper(&v, &env::predecessor_account_id());
        match payout.chain {
            ForeignChain::Base | ForeignChain::Monad => {
                let a = args.and_then(|a| a.evm).unwrap_or_else(|| {
                    env::panic_str("step 3: args.evm is required for an evm payout")
                });
                let mut a = effective_evm_args(a, &foreign, index);
                if !keeper {
                    a = limit_non_keeper_evm_args(a, payout.chain);
                }
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
                    Ok((t, _)) => {
                        write_pending(token_id, index, &PendingTx::Evm(t));
                        // Ask the signer for the derived key first: the signature is verified
                        // against it before it is stored (v2).
                        derived_key_call(&self.mpc_signer, &path, DOMAIN_ECDSA).then(
                            Self::ext(me)
                                .with_static_gas(GAS_ON_SOL_KEY)
                                .with_unused_gas_weight(1)
                                .on_foreign_evm_key(token_id, index, None, None, None),
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
                derived_key_call(&self.mpc_signer, &path, DOMAIN_EDDSA).then(
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

    /// `finish_foreign` with the storage it causes charged to the vault (callback entry points).
    fn finish_foreign_charged(
        &mut self,
        token_id: u64,
        index: usize,
        status: ForeignStatus,
        signed_tx: Option<String>,
        from_address: Option<String>,
        detail: &str,
    ) -> u8 {
        let before = env::storage_usage();
        let step = self.finish_foreign(token_id, index, status, signed_tx, from_address, detail);
        self.charge_storage(token_id, before, false);
        step
    }
}

#[near]
impl Contract {
    /// Records a payout that can never be built (bad `to`, amount out of range) as failed.
    #[private]
    pub fn foreign_fail(&mut self, token_id: u64, index: usize, detail: String) -> u8 {
        self.finish_foreign_charged(token_id, index, ForeignStatus::Failed, None, None, &detail)
    }

    /// EVM leg: got this contract's derived secp256k1 key for the payout's path; request the
    /// signature over the pending tx and pass the key on so the callback can verify it.
    #[private]
    pub fn on_foreign_evm_key(
        &mut self,
        token_id: u64,
        index: usize,
        resign: Option<bool>,
        req_ms: Option<u64>,
        pending: Option<PendingTx>,
        #[callback_result] key: Result<String, PromiseError>,
    ) -> PromiseOrValue<u8> {
        let key = single_result(key);
        let resign = resign.unwrap_or(false);
        let v = self.vault(token_id);
        if !resign && (v.step != 3 || v.foreign_index as usize != index) {
            env::log_str("stale foreign callback ignored");
            return PromiseOrValue::Value(v.step);
        }
        let pending = if resign {
            pending
        } else {
            read_pending(token_id, index)
        };
        let built = key
            .map_err(|_| "derived_public_key failed".to_string())
            .and_then(|k| parse_secp256k1_key(&k).map(|_| k))
            .and_then(|k| match &pending {
                Some(PendingTx::Evm(t)) => Ok((k, evm_sighash(&evm_tx(t)?))),
                _ => Err("no pending evm tx for this payout".to_string()),
            });
        let (key, hash) = match built {
            Ok(x) => x,
            Err(e) if resign => {
                env::log_str(&format!("resign #{index} failed: {e}"));
                clear_inflight(token_id, index, req_ms);
                return PromiseOrValue::Value(v.step);
            }
            Err(e) => {
                take_pending(token_id, index);
                return PromiseOrValue::Value(self.finish_foreign_charged(
                    token_id,
                    index,
                    ForeignStatus::Failed,
                    None,
                    None,
                    &e,
                ));
            }
        };
        let path = v.path(token_id, v.foreign[index].chain);
        let me = env::current_account_id();
        let cb = if resign {
            Self::ext(me)
                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                .with_unused_gas_weight(0)
                .on_foreign_resigned(
                    token_id,
                    index,
                    pending.unwrap_or_else(|| env::panic_str("unreachable")),
                    req_ms,
                    Some(key),
                )
        } else {
            Self::ext(me)
                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                .with_unused_gas_weight(0)
                .on_foreign_signed(token_id, index, Some(key))
        };
        PromiseOrValue::Promise(
            sign_call(&self.mpc_signer, &sign_args_ecdsa(&path, &hash)).then(cb),
        )
    }

    /// Solana leg: got this contract's derived ed25519 key for the payout's path;
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
        let key = single_result(key);
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
                return PromiseOrValue::Value(self.finish_foreign_charged(
                    token_id,
                    index,
                    ForeignStatus::Failed,
                    None,
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
        let path = v.path(token_id, ForeignChain::Solana);
        let me = env::current_account_id();
        let before = env::storage_usage();
        let cb = if resign {
            Self::ext(me)
                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                .with_unused_gas_weight(0)
                .on_foreign_resigned(token_id, index, PendingTx::Solana(t), req_ms, None)
        } else {
            write_pending(token_id, index, &PendingTx::Solana(t));
            Self::ext(me)
                .with_static_gas(GAS_ON_FOREIGN_SIGNED)
                .with_unused_gas_weight(0)
                .on_foreign_signed(token_id, index, None)
        };
        self.charge_storage(token_id, before, false);
        PromiseOrValue::Promise(sign_call(&self.mpc_signer, &sign_args_eddsa(&path, &msg)).then(cb))
    }

    /// Callback for the step-3 signature request. Returns the vault's new `step`.
    #[private]
    pub fn on_foreign_signed(
        &mut self,
        token_id: u64,
        index: usize,
        evm_key: Option<String>,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) -> u8 {
        let result = single_result(result);
        let before = env::storage_usage();
        let pending = take_pending(token_id, index);
        let key = match evm_key.as_deref().map(parse_secp256k1_key) {
            Some(Ok(k)) => Some(k),
            _ => None,
        };
        let outcome = match (result, &pending) {
            (Err(_), _) => Err("mpc sign call failed".to_string()),
            (Ok(_), None) => Err("no pending tx for this payout".to_string()),
            (Ok(value), Some(p)) => assemble_signed(p, &value, key.as_ref()),
        };
        let step = match outcome {
            Ok((raw, txid)) => self.finish_foreign(
                token_id,
                index,
                ForeignStatus::Signed,
                Some(raw),
                pending
                    .as_ref()
                    .and_then(|p| source_address(p, key.as_ref())),
                &format!("signed {txid}"),
            ),
            Err(e) => self.finish_foreign(token_id, index, ForeignStatus::Failed, None, None, &e),
        };
        self.charge_storage(token_id, before, false);
        step
    }

    /// Request a fresh signature for a payout that step 3 already handled (expired Solana
    /// blockhash, underpriced EVM tx, MPC failure). Does not change `step`/`foreign_index`.
    ///
    /// v2 rules (findings C and E): only an operator (contract keeper, vault keeper, vault owner,
    /// heir) may re-sign; every re-sign waits `RESIGN_COOLDOWN_MS` after the last request (a fee
    /// ratchet or status flipping can't be spammed, and an old Solana blockhash has expired); an
    /// EVM payout that has a signature needs, from a non-keeper, both fees >= 110% of the last
    /// request (or at the chain cap); a keeper may pick any fees and gas limit within the caps
    /// (G1); the EVM nonce stays pinned per payout, so a re-sign only replaces. One re-sign per
    /// payout in flight.
    ///
    /// Second review: a Solana transfer has no nonce, so a fresh signature over a new blockhash is
    /// a second valid payment from the same derived address. A Solana payout that is already
    /// `signed` or `broadcast` may therefore only be re-signed by a keeper (contract owner while
    /// unlocked, contract keeper, vault keeper), as in v1; heirs and the vault owner may only
    /// re-sign a `failed` one (F1). A non-keeper's EVM fees are clamped like in step 3 (F4).
    pub fn resign_foreign(&mut self, token_id: TokenRef, index: u32, args: StepArgs) -> Promise {
        let before = env::storage_usage();
        let id = token_id.id();
        let v = self.vault(id);
        let i = index as usize;
        require!(v.stored != StoredState::Live, "not_triggered");
        require!(i < v.foreign.len(), "index out of range");
        require!(
            v.step > 3 || (v.step == 3 && i < v.foreign_index as usize),
            "payout not processed yet"
        );
        let pred = env::predecessor_account_id();
        require!(
            self.is_operator(&v, &pred),
            "only the keeper, the vault owner or an heir may re-sign a payout"
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
        require!(
            now >= track.last_request_ms.saturating_add(RESIGN_COOLDOWN_MS),
            "resign cooldown: wait 5 min after the last request"
        );
        let has_sig = matches!(
            payout.status,
            ForeignStatus::Signed | ForeignStatus::Broadcast
        );
        let keeper = self.is_keeper(&v, &pred);
        require!(
            !(has_sig && payout.chain == ForeignChain::Solana) || keeper,
            "only the keeper may re-sign a signed or broadcast solana payout (no nonce: a new signature is a second payment)"
        );
        let me = env::current_account_id();
        let path = v.path(id, payout.chain);
        let promise = match payout.chain {
            ForeignChain::Base | ForeignChain::Monad => {
                let a = args
                    .evm
                    .unwrap_or_else(|| env::panic_str("args.evm is required for an evm payout"));
                let mut a = effective_evm_args(a, &v.foreign, i);
                if !keeper {
                    a = limit_non_keeper_evm_args(a, payout.chain);
                }
                // A keeper may lower fees (second review G1): an heir or a stranger who signed first
                // must not be able to lock the payout above an honest fee. Only non-keepers ratchet.
                if has_sig && !keeper {
                    // Fees are capped per chain (validated above), so real products are small;
                    // saturating math keeps an absurd stored value from overflowing.
                    let cap = payout
                        .chain
                        .evm()
                        .unwrap_or_else(|| env::panic_str("not an evm chain"))
                        .max_fee_per_gas;
                    require!(
                        is_fee_bump(a.max_fee_per_gas.0, track.max_fee_per_gas, cap)
                            && is_fee_bump(
                                a.max_priority_fee_per_gas.0,
                                track.max_priority_fee_per_gas,
                                cap
                            ),
                        "re-sign of a signed evm payout must raise both fees by >= 10% (or to the chain cap)"
                    );
                }
                let (t, _) = evm_transfer_for(&payout, &a).unwrap_or_else(|e| env::panic_str(&e));
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
                derived_key_call(&self.mpc_signer, &path, DOMAIN_ECDSA).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_SOL_KEY)
                        .with_unused_gas_weight(1)
                        .on_foreign_evm_key(id, i, Some(true), Some(now), Some(PendingTx::Evm(t))),
                )
            }
            ForeignChain::Solana => {
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
                derived_key_call(&self.mpc_signer, &path, DOMAIN_EDDSA).then(
                    Self::ext(me)
                        .with_static_gas(GAS_ON_SOL_KEY)
                        .with_unused_gas_weight(1)
                        .on_foreign_sol_key(id, i, a.recent_blockhash, Some(true), Some(now)),
                )
            }
        };
        self.charge_storage(id, before, false);
        promise
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
        evm_key: Option<String>,
        #[callback_result] result: Result<serde_json::Value, PromiseError>,
    ) -> String {
        let result = single_result(result);
        let before = env::storage_usage();
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
            self.charge_storage(token_id, before, false);
            return current.as_str().to_string();
        }
        let key = match evm_key.as_deref().map(parse_secp256k1_key) {
            Some(Ok(k)) => Some(k),
            _ => None,
        };
        let outcome = result
            .map_err(|_| "mpc sign call failed".to_string())
            .and_then(|value| assemble_signed(&pending, &value, key.as_ref()));
        let chain = v.foreign[index].chain;
        match outcome {
            Ok((raw, txid)) => {
                v.foreign[index].status = ForeignStatus::Signed;
                v.foreign[index].signed_tx = Some(raw);
                v.foreign[index].tx_hash = None;
                if let Some(from) = source_address(&pending, key.as_ref()) {
                    v.foreign[index].from_address = from;
                }
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
        self.charge_storage(token_id, before, false);
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

    mod host {
        #[cfg_attr(target_arch = "wasm32", link(wasm_import_module = "env"))]
        unsafe extern "C-unwind" {
            pub fn read_register(register_id: u64, ptr: u64);
            pub fn register_len(register_id: u64) -> u64;
            pub fn ecrecover(
                hash_len: u64,
                hash_ptr: u64,
                sig_len: u64,
                sig_ptr: u64,
                v: u64,
                malleability_flag: u64,
                register_id: u64,
            ) -> u64;
        }
    }

    /// Parse a signer `derived_public_key` answer `secp256k1:<base58 x||y>` into 64 bytes.
    pub fn parse_secp256k1_key(near_pk: &str) -> Result<[u8; 64], String> {
        let b58 = near_pk
            .strip_prefix("secp256k1:")
            .ok_or("expected secp256k1: key")?;
        let raw = near_sdk::bs58::decode(b58)
            .into_vec()
            .map_err(|_| "bad base58 key".to_string())?;
        if raw.len() != 64 {
            return Err("secp256k1 key must be 64 bytes".into());
        }
        let mut k = [0u8; 64];
        k.copy_from_slice(&raw);
        Ok(k)
    }

    /// EVM address (`0x` + 40 lowercase hex) of an uncompressed secp256k1 key `x||y`.
    pub fn evm_address_from_key(key: &[u8; 64]) -> String {
        format!("0x{}", hex::encode(&keccak256(key)[12..]))
    }

    /// Host `ecrecover` with malleability checks on (high-s and r/s out of range rejected).
    /// Returns the 64-byte public key, or `None` when the signature does not recover.
    /// Declared here because `env::ecrecover` (and `near_sdk::sys`) need the sdk's `unstable`
    /// feature; the host function itself is stable protocol API. The declaration matches
    /// `near-sys` 0.4 (and the sdk's native unit-test shims).
    pub fn ecrecover64(hash: &[u8; 32], rs: &[u8; 64], v: u8) -> Option<[u8; 64]> {
        const REG: u64 = u64::MAX - 2;
        // SAFETY: pointers/lengths describe live local buffers; the host writes the 64-byte
        // key into register REG only when it returns 1, and the register is then read into a
        // 64-byte buffer.
        unsafe {
            let ok = host::ecrecover(
                hash.len() as u64,
                hash.as_ptr() as u64,
                rs.len() as u64,
                rs.as_ptr() as u64,
                v as u64,
                1,
                REG,
            );
            if ok != 1 || host::register_len(REG) != 64 {
                return None;
            }
            let mut out = [0u8; 64];
            host::read_register(REG, out.as_mut_ptr() as u64);
            Some(out)
        }
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

    fn rs_of(r: &str, s: &str) -> [u8; 64] {
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&hex::decode(r).unwrap());
        rs[32..].copy_from_slice(&hex::decode(s).unwrap());
        rs
    }

    /// Public key of the viem test account, recovered from vector 0 and checked against its
    /// published address.
    pub(crate) fn viem_key() -> [u8; 64] {
        let (_, sighash, r, s, y, _) = EVM[0];
        let mut h = [0u8; 32];
        h.copy_from_slice(&hex::decode(sighash).unwrap());
        ecrecover64(&h, &rs_of(r, s), y).unwrap()
    }

    #[test]
    fn ecrecover_matches_viem_address() {
        let key = viem_key();
        assert_eq!(
            evm_address_from_key(&key),
            "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23".to_lowercase()
        );
        // both vectors recover to the same key
        let (_, sighash, r, s, y, _) = EVM[1];
        let mut h = [0u8; 32];
        h.copy_from_slice(&hex::decode(sighash).unwrap());
        assert_eq!(ecrecover64(&h, &rs_of(r, s), y), Some(key));
        // parse round trip of the signer's key format
        let wire = format!("secp256k1:{}", near_sdk::bs58::encode(key).into_string());
        assert_eq!(parse_secp256k1_key(&wire).unwrap(), key);
        assert!(parse_secp256k1_key("ed25519:11111111111111111111111111111111").is_err());
        assert!(parse_secp256k1_key("secp256k1:1111").is_err());
    }

    /// v2: a well-formed signature by any key other than the vault's derived key is rejected,
    /// and so is a signature with nothing to verify it against.
    #[test]
    fn evm_signature_must_recover_to_derived_key() {
        let (nonce, _, r, s, y, _) = EVM[0];
        let (t, _) = evm_transfer_for(&payout_base(), &evm_args(nonce)).unwrap();
        let p = PendingTx::Evm(t);
        let resp = mpc_secp(r, s, y);
        assert!(assemble_signed(&p, &resp, Some(&viem_key())).is_ok());
        let mut other = viem_key();
        other[63] ^= 1;
        let e = assemble_signed(&p, &resp, Some(&other)).unwrap_err();
        assert!(e.contains("not from the derived address"), "{e}");
        assert!(assemble_signed(&p, &resp, None).is_err());
        // flipped recovery id recovers a different key
        assert!(assemble_signed(&p, &mpc_secp(r, s, 1 - y), Some(&viem_key())).is_err());
        // high-s (malleated) form of the same signature is rejected by the host check
        let n = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
        let hi = {
            let (nb, sb) = (hex::decode(n).unwrap(), hex::decode(s).unwrap());
            let mut out = [0u8; 32];
            let mut borrow = 0i16;
            for i in (0..32).rev() {
                let d = nb[i] as i16 - sb[i] as i16 - borrow;
                borrow = if d < 0 { 1 } else { 0 };
                out[i] = (d + 256 * borrow) as u8;
            }
            hex::encode(out)
        };
        assert!(assemble_signed(&p, &mpc_secp(r, &hi, 1 - y), Some(&viem_key())).is_err());
    }

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
            let (got, txid) =
                assemble_signed(&PendingTx::Evm(t), &mpc_secp(r, s, y), Some(&viem_key())).unwrap();
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
        let (raw, txid) = assemble_signed(&PendingTx::Solana(t.clone()), &resp, None).unwrap();
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
            &json!({"scheme":"Ed25519","signature":bad}),
            None
        )
        .is_err());
    }

    #[test]
    fn rejects_mismatched_or_malformed_responses() {
        let (t, _) = evm_transfer_for(&payout_base(), &evm_args(3)).unwrap();
        let p = PendingTx::Evm(t);
        assert!(assemble_signed(
            &p,
            &json!({"scheme":"Ed25519","signature": vec![0u8; 64]}),
            Some(&viem_key())
        )
        .is_err());
        assert!(assemble_signed(&p, &json!({"stub": true}), Some(&viem_key())).is_err());
        assert!(assemble_signed(&p, &mpc_secp("00", "11", 0), Some(&viem_key())).is_err());
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
        assert_eq!(
            derivation_path(ForeignChain::Base, 12, "0011223344556677"),
            "base-12-0011223344556677"
        );
        assert_eq!(derivation_path(ForeignChain::Solana, 12, "ab"), "sol-12-ab");
        assert_eq!(
            derivation_path(ForeignChain::Monad, 12, "ab"),
            "monad-12-ab"
        );
        // legacy (unsalted) form
        assert_eq!(derivation_path(ForeignChain::Base, 12, ""), "base-12");
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
        // the Base vector's signature over the Monad hash recovers to some other key; verify
        // against that key so only assembly is under test here
        let monad_key = ecrecover64(&hash, &rs_of(EVM[0].2, EVM[0].3), 1).unwrap();
        let (raw, txid) = assemble_signed(
            &PendingTx::Evm(t),
            &mpc_secp(EVM[0].2, EVM[0].3, 1),
            Some(&monad_key),
        )
        .unwrap();
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
