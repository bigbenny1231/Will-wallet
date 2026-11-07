# keeper/src/chains: foreign-chain helpers (owned by the chainsig agent)

Pure, dependency-free functions (global `fetch` only) that the keeper imports via `src/chainsApi.ts`.

| Module | Export | Returns |
| --- | --- | --- |
| `derive.ts` | `deriveAddresses(contractId, tokenId, opts?)` | `{ base: "0x…", solana: "<base58>" }` for paths `base-<id>` / `sol-<id>` |
| | `deriveBaseAddress`, `deriveSolanaAddress` | `{ address, publicKey, path }` |
| `evm.ts` | `getEvmStepArgs(fromAddress, baseRpc?)` | `{ nonce, max_fee_per_gas, max_priority_fee_per_gas, gas_limit }` (StepArgs.evm) |
| | `broadcastEvm(rawHex, baseRpc?)` | tx hash (idempotent on "already known") |
| | `evmTxHash(rawHex)`, `basescanTx(hash)` | tx hash before broadcast, explorer link |
| `solana.ts` | `getSolanaStepArgs(solanaRpc?)` | `{ recent_blockhash }` (StepArgs.solana) |
| | `broadcastSolana(rawBase64, solanaRpc?)` | signature (tx id) |
| | `isBlockhashExpired(err)`, `solanaTxSignature(raw)`, `solscanTx(sig)` | helpers |

`opts` for `deriveAddresses` may be the keeper `Config` (its `rpcUrl` is used). The signer defaults to
`v1.signer-prod.testnet` (`MPC_SIGNER` env overrides).

## How it fits step 3

```
for each foreign payout (contract's foreign_index):
  base   -> args = { evm: await getEvmStepArgs(payout.from_address || derived.base, cfg.baseRpc) }
  solana -> args = { solana: await getSolanaStepArgs(cfg.solanaRpc) }   // fetch right before the call
  dmw.execute_step({ token_id, args })        // 300 TGas; the MPC round trip takes ~18 s
then for each payout with status "signed":
  base   -> hash = await broadcastEvm(payout.signed_tx)     (0x hex)
  solana -> sig  = await broadcastSolana(payout.signed_tx)  (base64)
  dmw.mark_broadcast({ token_id, index, tx_hash })
```

`execute_step` at step 3 **panics** if the args for that payout's chain are missing, so send `evm` for a
base payout and `solana` for a solana payout (sending both every time is fine).

If a relay fails because the Solana blockhash expired (`isBlockhashExpired(e)`) or the EVM nonce went
stale, call `dmw.resign_foreign({ token_id, index, args })` with fresh args (300 TGas). It re-signs a
`signed`/`failed` payout without moving the step machine; then relay the new `signed_tx`.

## Notes

- Derivation uses the live `derived_public_key` view. It's byte-identical to chainsig.js
  `deriveAddressAndPublicKey` (checked in `selfcheck.ts` and docs/chainsig-notes.md), with no extra npm deps.
- EVM fees: `max_fee = 2 * baseFee + priority`, `gas_limit = 21000` (native transfer).
- The derived source addresses must be funded by the owner. Faucets need a human login
  (Base Sepolia: Coinbase CDP / Alchemy; Solana devnet: faucet.solana.com; the RPC `requestAirdrop` is closed).

Self-check: `npx tsx src/chains/selfcheck.ts` (add `--offline` to skip network).
