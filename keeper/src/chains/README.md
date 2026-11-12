# keeper/src/chains: foreign-chain helpers (owned by the chainsig agent)

Pure functions (global `fetch` only) that the keeper imports via `src/chainsApi.ts`. The funder modules (`evmTx.ts`, `solanaTx.ts`, `funderKeys.ts`) also use `@noble/curves` (already in the lock file through near-api-js; now listed in package.json) for secp256k1 and ed25519 signing.

| Module | Export | Returns |
| --- | --- | --- |
| `derive.ts` | `deriveAddresses(contractId, paths, opts?)`, `vaultPaths(view)` | `{ base: "0x…", monad: "0x…", solana: "<base58>" }` for the vault's `derivation_paths` (contract v2: `base-<id>-<salt>` / `monad-<id>-<salt>` / `sol-<id>-<salt>`; v1 fallback `base-<id>` …) |
| | `deriveAddressFor(chain, contractId, tokenId)`, `derivationPath(chain, tokenId)` | source address / path for one payout chain |
| | `deriveEvmAddress(chain, …)`, `deriveBaseAddress`, `deriveMonadAddress`, `deriveSolanaAddress` | `{ address, publicKey, path }` |
| `evm.ts` | `chainConfig(chain)` | `{ chain, chainId, rpc, pathPrefix, maxFeePerGas, explorerTx(h), explorerAddress(a) }` for `base` (84532) / `monad` (10143); `BASE_RPC` / `MONAD_RPC` override the RPC |
| | `getEvmStepArgs(fromAddress, rpcOrChain?)` | `{ nonce, max_fee_per_gas, max_priority_fee_per_gas, gas_limit }` (StepArgs.evm), fee clamped to the contract's per-chain cap |
| | `broadcastEvm(rawHex, rpcOrChain?)`, `evmTxKnown(hash, rpcOrChain?)` | tx hash (idempotent on "already known") / lookup |
| | `getEvmStepArgsFor(chain, from)`, `broadcastEvmFor(chain, raw)`, `evmTxKnownFor(chain, hash)` | chain-keyed wrappers |
| | `evmTxHash(rawHex)`, `evmTxLink(chain, hash)`, `basescanTx(hash)` | tx hash before broadcast, explorer link |
| `solana.ts` | `getSolanaStepArgs(solanaRpc?)` | `{ recent_blockhash }` (StepArgs.solana) |
| | `broadcastSolana(rawBase64, solanaRpc?)` | signature (tx id) |
| | `isBlockhashExpired(err)`, `solanaTxSignature(raw)`, `solscanTx(sig)` | helpers |
| `codec.ts` | `rlpEncode` / `rlpDecode`, `base58Encode` / `base58Decode`, `keccak256` | encoders |
| `evmTx.ts` | `signEip1559(fields, key)`, `decodeEip1559(raw)`, `evmTxMaxCost(tx)` | type-2 native transfer: raw 0x hex + hash; decoded fields + recovered sender; value + gasLimit x maxFee |
| `solanaTx.ts` | `transferMessage(t)`, `signSolTransfer(t, seed)`, `parseSolTransfer(raw)` | one SystemProgram transfer (legacy message), signed base64 + signature; parsed and verified |
| `funderKeys.ts` | `deriveFunderKeys(seed)` | the funder's EVM key/address and Solana seed/address from `KEEPER_SEED` (HKDF-SHA256, salt `dmw-keeper`, info `evm funder key v1` / `solana funder key v1`) |
| `funderRpc.ts` | `realFundingRpc(opts)` | the balance, nonce, fee, send, receipt and status calls the funder makes (`FundingRpc`, replaced by a fake in tests) |

`opts` for `deriveAddresses` may be the keeper `Config` (its `rpcUrl` is used). The signer defaults to
`v1.signer-prod.testnet` (`MPC_SIGNER` env overrides).

## How it fits step 3

```
for each foreign payout (contract's foreign_index):
  base | monad -> args = { evm: await getEvmStepArgs(payout.from_address || derived[chain], chain) }
  solana -> args = { solana: await getSolanaStepArgs(cfg.solanaRpc) }   // fetch right before the call
  dmw.execute_step({ token_id, args })        // 300 TGas; the MPC round trip takes ~18 s
then for each payout with status "signed":
  base | monad -> hash = await broadcastEvm(payout.signed_tx, chain)   (0x hex)
  solana -> sig  = await broadcastSolana(payout.signed_tx)  (base64)
  dmw.mark_broadcast({ token_id, index, tx_hash })
```

`execute_step` at step 3 **panics** if the args for that payout's chain are missing, so send `evm` for a
base/monad payout and `solana` for a solana payout (sending both every time is fine). The EVM path is
shared: the contract picks the chain id (84532 / 10143), the path and the nonce from the payout's `chain`.
Each EVM chain has its own derived address and its own nonce sequence.

Wired: the keeper loop passes the payout's `chain` to `getEvmStepArgs`, `broadcastEvm` and `evmTxKnown` (Monad payouts relay like Base ones; fee cap per chain in `resign.ts`).

If a relay fails because the Solana blockhash expired (`isBlockhashExpired(e)`) or the EVM nonce went
stale, call `dmw.resign_foreign({ token_id, index, args })` with fresh args (300 TGas). It re-signs a
`signed`/`failed` payout without moving the step machine; then relay the new `signed_tx`.

## Notes

- Derivation uses the live `derived_public_key` view. It's byte-identical to chainsig.js
  `deriveAddressAndPublicKey` (checked in `selfcheck.ts` and docs/chainsig-notes.md), with no extra npm deps.
- EVM fees: `max_fee = 2 * baseFee + priority`. The contract signs every EVM payout with at least 50,000 gas
  (`EVM_GAS_LIMIT_FLOOR` in `foreign.rs`, final audit H-5), so a source must hold value + 50,000 × max fee. Monad
  testnet's base fee floor is 100 gwei, so its contract cap is 1000 gwei (Base: 100 gwei). Monad bills `gas_limit`,
  not gas used.
- The derived source addresses hold no funds of their own. `dmw fund-sources --token <id>` (or `dmw keeper
  --fund-sources`) tops them up from the funder wallet derived from `KEEPER_SEED`; see "Funding payout sources" in
  `keeper/README.md`. The funder itself is filled once by hand from the faucets (Base Sepolia: Coinbase CDP / Alchemy;
  Monad: faucet.monad.xyz; Solana devnet: faucet.solana.com).

Self-check: `npx tsx src/chains/selfcheck.ts` (add `--offline` to skip network).
