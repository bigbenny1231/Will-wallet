# Chain Signatures: verified notes (2026-11-07)

All facts below were checked against the **live** signer, not just docs.

## 1. Live signer `v1.signer-prod.testnet`

| Item | Value |
| --- | --- |
| Contract version | `3.18.0` (`version`, `contract_source_metadata`: near/mpc @ `e691bdb9`, cargo-near 0.22, rust 1.97.1) |
| State | `Running`, epoch 27, threshold 11 |
| Domains | `0` CaitSith secp256k1 **Sign** · `1` Frost ed25519 **Sign** · `2` CKD (bls12381) · `3` CaitSith **ForeignTx** (not for us) |
| Root keys | `public_key {}` → `secp256k1:4NfTiv3U…Fwx3`; `public_key {"domain_id":1}` → `ed25519:6vSEtQxr…3Un2` |
| `sign` gas requirement | config `sign_call_gas_attachment_requirement_tera_gas = 15` (min attached), yield callback costs 7 TGas |
| `sign` deposit | `payable`; 1 yoctoNEAR works (used by us and chainsig.js) |

### View methods (from the embedded ABI, `__contract_abi`, zstd JSON)

```
public_key({ domain_id?: u64 }) -> "secp256k1:<b58 64B x||y>" | "ed25519:<b58 32B>"
derived_public_key({ path: string, predecessor?: AccountId, domain_id?: u64 }) -> same format
```

Examples:

```
derived_public_key {"path":"base-1","predecessor":"dmw-1.testnet","domain_id":0}
  -> secp256k1:35JDvLu3prMACNn5cBVY7Ljnv2ofcwhjGcTMF7Vn2ExAJyV8Ks69MToSUmsPSJBwxN3ft2Wx7FhPyVLsipdun8yZ
derived_public_key {"path":"sol-1","predecessor":"dmw-1.testnet","domain_id":1}
  -> ed25519:GbSpP1GVyvXVRuNcKYaDerCeW3QwMudqzkDL5T3yPxe8
```

### `sign` (ABI + `near-mpc-contract-interface` 0.0.1 `types/sign.rs`)

```jsonc
// args
{ "request": {
    "path": "base-1",
    "payload_v2": { "Ecdsa": "<64 hex chars = 32-byte hash>" }   // domain 0
             // | { "Eddsa": "<hex of full message, 32..1232 bytes>" } // domain 1 (Solana: message bytes, NOT a hash)
    "domain_id": 0 } }
// (deprecated aliases still accepted: `payload` as [u8;32], `key_version` for domain_id)

// result: SignatureResponse, internally tagged by "scheme"
{ "scheme": "Secp256k1",
  "big_r": { "affine_point": "<33-byte compressed point hex>" },  // r = big_r[1..33]
  "s": { "scalar": "<32-byte hex>" },
  "recovery_id": 0 | 1 }                                            // = EIP-1559 yParity
{ "scheme": "Ed25519", "signature": [64 numbers] }                  // JSON array, not hex/base58
```

The signer logs the decoded request, which is a handy debugging aid:
`sign: predecessor=AccountId("…"), request=SignRequestArgs { path: "base-1", payload: Ecdsa(…), domain_id: DomainId(0) }`.

## 2. chainsig.js (npm `chainsig.js` 1.1.16, the current package name)

- Default testnet contract `v1.signer-prod.testnet`, mainnet `v1.signer`.
- `sign` call: `functionCall("sign", {request:{payload_v2:{[Ecdsa|Eddsa]: hex}, path, domain_id: Eddsa?1:0}}, gas 300 TGas, deposit 1 yocto)`.
- `deriveAddressAndPublicKey(predecessor, path)`: for the known contract ids it derives **locally**
  from hard-coded root keys (no RPC); for other ids it calls `derived_public_key` with `domain_id 0|1`.
  The hard-coded testnet root keys **match** the live `public_key` output (checked), and local
  derivation gave byte-identical keys to the live view for both curves.
  - EVM: `keccak256(uncompressed x||y)[12..]`, checksummed.
  - Solana: base58 of the ed25519 derived key.

## 3. Gotchas found

1. **omni-transaction `0.3` has no `solana` feature.** We use `0.5.0` with
   `default-features = false, features = ["evm","solana"]`; it compiles to wasm (Solana support only needs `bs58`).
2. **Non-canonical RLP:** `EVMTransaction::build_with_signature` appends `r`/`s` as raw byte strings.
   When `r` or `s` starts with `0x00` (1 in 128 signatures), the result is rejected by nodes. We strip leading
   zeros first; there's a regression vector (`nonce 204`, `r = 0x0082…`) in the tests.
3. The Ed25519 signature arrives as a **JSON number array**; don't parse it as hex.
4. **Solana source pubkey:** the fee payer must be in the signed message, so the contract needs the derived
   ed25519 key. We fetch it cross-contract with `derived_public_key` (trust-minimized) instead of trusting
   `from_address`. That adds one ~10 TGas hop.
5. **Gas:** `sign` needs only ≥15 TGas attached. We attach `50 TGas + all unused gas (weight 1)` so a 300 TGas
   call still gives the signer about 250 TGas, and the Solana path has room for the extra hop.
6. `env::ecrecover` in near-sdk 5.30 is behind the `unstable` feature (the host fn is live). Only the probe uses it.
7. The plain `cargo build --target wasm32-unknown-unknown` with `RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s"`
   on Rust 1.97 produced a wasm that deploys and runs on testnet. (cargo-near needs `libudev-dev` to install.)
8. The Solana devnet **RPC faucet is closed** (`requestAirdrop` → 410). faucet.solana.com requires GitHub login.

## 4. Probe results: `contracts/chainsig-probe`

Probe account: **`dmw-sig-4e3b1c65.testnet`**. Deploy tx `BLpNeyhZfu8MBkXsSeZx346kU6W3g8E9FeQKZMZ1VXiv`.

| Path | Derived address (chainsig.js == live view) |
| --- | --- |
| `base-1` (domain 0) | `0xcA024adC7cac111339Fe077C739F8085aE705F2F` |
| `sol-1` (domain 1) | `CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr` |

### EVM (Base Sepolia, chain 84532)

- NEAR tx [`5kt1qVXvBzUN6nLUjMUwf36wHe9ZTFRikvVJFELwSR3e`](https://testnet.nearblocks.io/txns/5kt1qVXvBzUN6nLUjMUwf36wHe9ZTFRikvVJFELwSR3e)
  `sign_evm_transfer(to=0x…dEaD, value=1e12, nonce=0, max_fee=0.1 gwei, prio=0.001 gwei, gas=21000)`; total ~18 s.
- Callback `ecrecover` → `0xca024adc7cac111339fe077c739f8085ae705f2f` **= derived address** (viem's
  `recoverTransactionAddress` agrees).
- Raw tx `0x02f87183014a3480…72efc1`, hash `0x2079a032ef5d1cf7abdf5eb25638a3d88421e8ba885b409958bb6b672a3a9ce0`.
- `eth_sendRawTransaction` → `insufficient funds for gas * price + value: have 0 want 3100000000000`. The node
  accepted the signature and computed the cost for our derived sender. **Not broadcast: unfunded.**

### Solana (devnet)

- NEAR tx [`8xq6CFwomj8PML4Wdh4HpzzJfSpWVFaL9Z8puFM8Rxcf`](https://testnet.nearblocks.io/txns/8xq6CFwomj8PML4Wdh4HpzzJfSpWVFaL9Z8puFM8Rxcf)
  `sign_solana_transfer(to=8opHz…ScKh, lamports=1e6, blockhash=5C5owu…Fg5)`: 150-byte message, ~18 s.
- Callback `ed25519_verify(sig, msg, derived pk)` → `true`. Signature `63mEzmFR…MMTz`.
- `simulateTransaction{sigVerify:true}` → `AccountNotFound` (unfunded source). A control with one flipped
  signature bit → `SignatureFailure`, so the real signature passes Solana's verifier. **Not broadcast: unfunded.**

### Human funding step (needed to broadcast)

1. Base Sepolia: send ≥0.001 ETH to `0xcA024adC7cac111339Fe077C739F8085aE705F2F` (Coinbase CDP faucet
   https://portal.cdp.coinbase.com/products/faucet, Alchemy https://www.alchemy.com/faucets/base-sepolia, or see
   https://docs.base.org/docs/tools/network-faucets). All of them need a login.
2. Solana devnet: request 1 SOL for `CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr` at https://faucet.solana.com (GitHub login).
3. Re-run (any account can call; the probe signs for its own derived keys):
   ```bash
   near contract call-function as-transaction dmw-sig-4e3b1c65.testnet sign_evm_transfer \
     json-args '{"to":"0x000000000000000000000000000000000000dEaD","value":"1000000000000","nonce":0,"max_fee":"100000000","prio_fee":"1000000","gas_limit":"21000"}' \
     prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as <you>.testnet network-config testnet sign-with-keychain send
   # then eth_sendRawTransaction with result.raw_tx

   near contract call-function as-transaction dmw-sig-4e3b1c65.testnet sign_solana_transfer \
     json-args '{"to":"<dest>","lamports":"1000000","recent_blockhash":"<getLatestBlockhash>"}' \
     prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as <you>.testnet network-config testnet sign-with-keychain send
   # then sendTransaction(result.raw_tx_base64, {encoding:"base64"}) within ~60 s of the blockhash
   ```
   Or, with keeper deps installed: `npx tsx keeper/src/chains/demo-broadcast.ts` (see keeper/src/chains/README.md).

Explorers: https://sepolia.basescan.org/address/0xcA024adC7cac111339Fe077C739F8085aE705F2F ·
https://explorer.solana.com/address/CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr?cluster=devnet
