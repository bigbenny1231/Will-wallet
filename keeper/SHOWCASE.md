# Showcase vault (demo video)

Live on testnet, contract `dmw-x8cx.testnet`. The vault is **Alive** and is **not** triggered; nothing is running against it.
Dashboard route: `/vault/6`. Created 2026-11-07.

| | |
| --- | --- |
| Token id | **6** |
| Owner | `dmw-andrew-8d2e.testnet` (key in `keys/dmw-andrew-8d2e.testnet.json`, gitignored) |
| Heirs | `dmw-sarah-8d2e.testnet` 6000 bps (primary, gets the Will NFT), `dmw-ben-8d2e.testnet` 4000 bps |
| Agent allowlist | `dmw-api-8d2e.testnet` |
| Timing | created at 90 s / grace 2; now `set_timing(1209600, 1)` (14 days, set 2026-11-08 right after an owner heartbeat; earlier settings were 86400 s and 604800 s): Warning from 2026-11-22 05:04 UTC, poke legal from 2026-12-06 05:04 UTC unless the owner beats again |
| Balance | 5 NEAR (+0.1 storage). Adding a pulse key and an agent key takes 1 NEAR each from the vault balance |
| Policy | per_tx_max 0.5 NEAR, daily_max 1 NEAR, allowlist `[dmw-api-8d2e.testnet]` |
| Bounty | 0.05 NEAR |
| Payout 0 (Base Sepolia) | 0.0005 ETH (`500000000000000` wei) to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` |
| Payout 1 (Monad testnet) | 0.01 MON (`10000000000000000` wei) to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` (one Monad payout per vault) |
| Payout 2 (Solana devnet) | 0.01 SOL (`10000000` lamports) to `HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr` |

Setup transactions: [create_vault](https://testnet.nearblocks.io/txns/9tQ5JnJyjXZqohxyS2E1BKNxN1SYvp7uVhFc5sajTSGL),
[set_foreign_payouts](https://testnet.nearblocks.io/txns/Gd5TcHycMhUnszvrxDoKq319i8jyfbVGkicXHsXgFPmd),
[set_timing](https://testnet.nearblocks.io/txns/5P7bsCvjXUcfUbxw6282cX4sPdChvgkiPH29E2pXwSgZ),
[set_foreign_payouts with Monad added](https://testnet.nearblocks.io/txns/5coQJ8pDWP4HFNDCGQoES12fr9oDbnb8FJ89reouasDL) (Base and Solana kept; the payouts are now Base, Monad, Solana).

## A human must fund these three addresses (faucets need a login)

These are the MPC-derived source addresses for vault 6 (`base-6`, `monad-6`, `sol-6`). No private key exists for them; the contract asks the
signer at settlement. Without funds the signed transactions are produced (status `signed`) but the relay says insufficient funds.

| Chain | Address | Send at least | Faucet | Explorer |
| --- | --- | --- | --- | --- |
| Base Sepolia | `0x2cC6e278a4f4d5785f52c22cD52a132Fc06928f4` | 0.001 ETH (payout 0.0005 + gas ~0.00025) | [Alchemy](https://www.alchemy.com/faucets/base-sepolia), [Coinbase CDP](https://portal.cdp.coinbase.com/products/faucet) | [basescan](https://sepolia.basescan.org/address/0x2cC6e278a4f4d5785f52c22cD52a132Fc06928f4) |
| Monad testnet | `0x07BF795e809E5064Ab810Cf89991D958A48aBA5b` | **0.05 MON** or more (payout 0.01 + gas). See the reserve rule below | [faucet.monad.xyz](https://faucet.monad.xyz) (other faucets: [docs.monad.xyz](https://docs.monad.xyz)) | [monadexplorer](https://testnet.monadexplorer.com/address/0x07BF795e809E5064Ab810Cf89991D958A48aBA5b) |
| Solana devnet | `5iueWMRjMiVBQHvwqQdHgHvyUckQ9rCoHtPrzFMwpvzc` | 0.05 SOL (payout 0.01 + fee) | [faucet.solana.com](https://faucet.solana.com) (GitHub login) | [explorer](https://explorer.solana.com/address/5iueWMRjMiVBQHvwqQdHgHvyUckQ9rCoHtPrzFMwpvzc?cluster=devnet) |

Monad's 10 MON reserve rule: an account may not dip below the reserve (10 MON) except by a transaction that empties it,
and the vault's single Monad payout is the first transaction from `monad-6`, nonce 0, so it is an emptying transaction
and is allowed. Fund at least 0.05 MON; the payout sends exactly 0.01 MON and whatever is left stays at the address.

Re-check any time: `cd keeper && npm run derive -- --token 6`.

## Running the demo on it

The vault has no keys yet. For the video either add them from the dashboard, or from the CLI as the owner:

```bash
node scripts/near-admin.mjs genkey                      # pulse key; make a second one for the agent key
node contracts/tools/tx.mjs call dmw-andrew-8d2e.testnet dmw-x8cx.testnet add_pulse_key '{"token_id":"6","public_key":"ed25519:..."}' 50 1y
node contracts/tools/tx.mjs call dmw-andrew-8d2e.testnet dmw-x8cx.testnet add_agent_key '{"token_id":"6","public_key":"ed25519:..."}' 50 1y
# shorten the clock right before recording; trigger = 2 x interval after the last beat with grace 1
node contracts/tools/tx.mjs call dmw-andrew-8d2e.testnet dmw-x8cx.testnet set_timing '{"token_id":"6","heartbeat_interval_s":60,"grace_missed":1}' 30 1y
cd keeper && npm run keeper -- --poll 5 --token 6       # --token keeps the keeper off the other test vaults
```

`make demo` creates its own throwaway vault and does not touch vault 6.

## Heir-controlled recipient addresses (set 2026-11-07)

The Base and Monad payouts go to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` and the Solana payout to
`HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr`. Both are fresh keypairs held by the demo heir ("Sarah");
the secrets are in the gitignored `keys/sarah-evm.json` and `keys/sarah-solana.json`. Earlier recipients were
MPC-derived addresses nobody holds a key for (on-chain audit F-3), which would have burned the test funds.
