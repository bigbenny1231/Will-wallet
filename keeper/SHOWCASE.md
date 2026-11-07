# Showcase vault (demo video)

Live on testnet, contract `dmw-x8cx.testnet`. The vault is **Alive** and is **not** triggered; nothing is running against it.
Dashboard route: `/vault/6`. Created 2026-11-07.

| | |
| --- | --- |
| Token id | **6** |
| Owner | `dmw-andrew-8d2e.testnet` (key in `keys/dmw-andrew-8d2e.testnet.json`, gitignored) |
| Heirs | `dmw-sarah-8d2e.testnet` 6000 bps (primary, gets the Will NFT), `dmw-ben-8d2e.testnet` 4000 bps |
| Agent allowlist | `dmw-api-8d2e.testnet` |
| Timing | created at 90 s / grace 2, then `set_timing(86400, 1)`: stays Alive for 24 h from the creation beat, trigger 48 h after the last beat |
| Balance | 5 NEAR (+0.1 storage). Adding a pulse key and an agent key takes 1 NEAR each from the vault balance |
| Policy | per_tx_max 0.5 NEAR, daily_max 1 NEAR, allowlist `[dmw-api-8d2e.testnet]` |
| Bounty | 0.05 NEAR |
| Payout 0 (Base Sepolia) | 0.0005 ETH (`500000000000000` wei) to `0xcA024adC7cac111339Fe077C739F8085aE705F2F` |
| Payout 1 (Solana devnet) | 0.01 SOL (`10000000` lamports) to `CFdWXa1ean7bBoewSv2SZESrDpWSxeoN1hfLrqaqZQUr` |

Setup transactions: [create_vault](https://testnet.nearblocks.io/txns/9tQ5JnJyjXZqohxyS2E1BKNxN1SYvp7uVhFc5sajTSGL),
[set_foreign_payouts](https://testnet.nearblocks.io/txns/Gd5TcHycMhUnszvrxDoKq319i8jyfbVGkicXHsXgFPmd),
[set_timing](https://testnet.nearblocks.io/txns/5P7bsCvjXUcfUbxw6282cX4sPdChvgkiPH29E2pXwSgZ).

## A human must fund these two addresses (faucets need a login)

These are the MPC-derived source addresses for vault 6 (`base-6`, `sol-6`). No private key exists for them; the contract asks the
signer at settlement. Without funds the signed transactions are produced (status `signed`) but the relay says insufficient funds.

| Chain | Address | Send at least | Faucet | Explorer |
| --- | --- | --- | --- | --- |
| Base Sepolia | `0x2cC6e278a4f4d5785f52c22cD52a132Fc06928f4` | 0.001 ETH (payout 0.0005 + gas ~0.00025) | [Alchemy](https://www.alchemy.com/faucets/base-sepolia), [Coinbase CDP](https://portal.cdp.coinbase.com/products/faucet) | [basescan](https://sepolia.basescan.org/address/0x2cC6e278a4f4d5785f52c22cD52a132Fc06928f4) |
| Solana devnet | `5iueWMRjMiVBQHvwqQdHgHvyUckQ9rCoHtPrzFMwpvzc` | 0.05 SOL (payout 0.01 + fee) | [faucet.solana.com](https://faucet.solana.com) (GitHub login) | [explorer](https://explorer.solana.com/address/5iueWMRjMiVBQHvwqQdHgHvyUckQ9rCoHtPrzFMwpvzc?cluster=devnet) |

Re-check any time: `cd keeper && npm run derive -- --token 6`.

## Running the demo on it

The vault has no keys yet. For the video either add them from the dashboard, or from the CLI as the owner:

```bash
node scripts/near-admin.mjs genkey                      # pulse key; make a second one for the agent key
node contracts/tools/tx.mjs call dmw-andrew-8d2e.testnet dmw-x8cx.testnet add_pulse_key '{"token_id":"6","public_key":"ed25519:..."}' 50
node contracts/tools/tx.mjs call dmw-andrew-8d2e.testnet dmw-x8cx.testnet add_agent_key '{"token_id":"6","public_key":"ed25519:..."}' 50
# shorten the clock right before recording; trigger = 2 x interval after the last beat with grace 1
node contracts/tools/tx.mjs call dmw-andrew-8d2e.testnet dmw-x8cx.testnet set_timing '{"token_id":"6","heartbeat_interval_s":60,"grace_missed":1}' 30
cd keeper && npm run keeper -- --poll 5 --token 6       # --token keeps the keeper off the other test vaults
```

`make demo` creates its own throwaway vault and does not touch vault 6.
