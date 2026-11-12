# Showcase vault

Live on testnet, contract `dmw-885364.testnet` (since Nov 12 2026; see [`docs/LIVE_CONTRACT.md`](../docs/LIVE_CONTRACT.md)).
The vault is **Alive**; the project's hosted keeper sends its heartbeat. Dashboard route: `/vault/1`. The site's live
estate graph reads it.

| | |
| --- | --- |
| Token id | **1** |
| Owner | `dmw-andrew-13bf.testnet` (a throwaway account made by the `testnet` workflow; its key never left the runner) |
| Heirs | `dmw-sarah-13bf.testnet` 6000 bps (primary, gets the Will NFT), `dmw-ben-13bf.testnet` 4000 bps |
| Agent allowlist | `dmw-api-13bf.testnet` |
| Timing | 60-day interval (5,184,000 s), grace 1 |
| Balance | 5 NEAR (+0.1 storage) |
| Policy | per_tx_max 0.5 NEAR, daily_max 1 NEAR, allowlist `[dmw-api-13bf.testnet]` |
| Bounty | 0.05 NEAR |
| Payout 0 (Base Sepolia) | 0.0005 ETH (`500000000000000` wei) to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` |
| Payout 1 (Monad testnet) | 0.01 MON (`10000000000000000` wei) to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` |
| Payout 2 (Solana devnet) | 0.01 SOL (`10000000` lamports) to `HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr` |

Setup transactions: [create_vault](https://testnet.nearblocks.io/txns/2LDbKGY6tV3PWuKNNUtUhYodVofyUFo9TMtxmbJN9tLf),
[set_foreign_payouts](https://testnet.nearblocks.io/txns/3M5rJw47q9zRghyZPQSJTLr2LekjtWKs1CYjkotwNY3i)
(`scripts/showcase.sh`, run by the `testnet` workflow, run 43288158721).

## Source addresses

The MPC-derived source addresses for vault 1. Contract v2 salts each vault's derivation paths (`get_vault` returns them
as `derivation_paths`). No private key exists for these addresses; the contract asks the signer at settlement, and a
keeper relays each signed transaction from its address once the address holds the value and the fee.

| Chain | Address | Send at least | Faucet | Explorer |
| --- | --- | --- | --- | --- |
| Base Sepolia | `0x7F985ce93d5A3fa32519F3be334d61d93d275f3b` | 0.001 ETH (payout 0.0005 + gas ~0.00025) | [Alchemy](https://www.alchemy.com/faucets/base-sepolia), [Coinbase CDP](https://portal.cdp.coinbase.com/products/faucet) | [basescan](https://sepolia.basescan.org/address/0x7F985ce93d5A3fa32519F3be334d61d93d275f3b) |
| Monad testnet | `0xa8fdcc94b902c32E2aF0788A48A4d082adbE4b91` | **0.05 MON** or more (payout 0.01 + gas). See the reserve rule below | [faucet.monad.xyz](https://faucet.monad.xyz) | [monadexplorer](https://testnet.monadexplorer.com/address/0xa8fdcc94b902c32E2aF0788A48A4d082adbE4b91) |
| Solana devnet | `CPRMvCbJ8uebgt4BsNhm94eNB8cfsSXsN1ffKMUMhZdc` | 0.05 SOL (payout 0.01 + fee) | [faucet.solana.com](https://faucet.solana.com) (GitHub login) | [explorer](https://explorer.solana.com/address/CPRMvCbJ8uebgt4BsNhm94eNB8cfsSXsN1ffKMUMhZdc?cluster=devnet) |

Monad's 10 MON reserve rule: an account may not dip below the reserve (10 MON) except by a transaction that empties it,
and the vault's single Monad payout is the first transaction from its Monad source address, nonce 0, so it is an emptying transaction
and is allowed. Fund at least 0.05 MON; the payout sends exactly 0.01 MON and whatever is left stays at the address.

Re-check any time: `cd keeper && DMW_CONTRACT=dmw-885364.testnet npm run derive -- --token 1`.

## Heir-controlled recipient addresses

The Base and Monad payouts go to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` and the Solana payout to
`HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr`, fresh keypairs held by the demo heir ("Sarah") since Nov 7 2026.

## The earlier showcase

Earlier contracts had their own showcase vaults; they are described in [`docs/history/`](../docs/history/README.md).
