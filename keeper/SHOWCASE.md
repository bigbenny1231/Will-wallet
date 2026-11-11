# Showcase vault

Live on testnet, contract `dmw-979268.testnet` (since Nov 11 2026; see [`docs/LIVE_CONTRACT.md`](../docs/LIVE_CONTRACT.md)).
The vault is **Alive** and is **not** triggered; nothing is running against it. Dashboard route: `/vault/1`. The site's
live estate graph reads it.

| | |
| --- | --- |
| Token id | **1** |
| Owner | `dmw-andrew-edbc.testnet` (a throwaway account made by the `testnet` workflow; its key never left the runner) |
| Heirs | `dmw-sarah-edbc.testnet` 6000 bps (primary, gets the Will NFT), `dmw-ben-edbc.testnet` 4000 bps |
| Agent allowlist | `dmw-api-edbc.testnet` |
| Timing | 60-day interval (5,184,000 s), grace 1, from Nov 11 2026: Warning from about Jan 10 2027, poke legal from about Mar 11 2027. The owner key is gone, so nobody will beat again; it is a fixed exhibit |
| Balance | 5 NEAR (+0.1 storage) |
| Policy | per_tx_max 0.5 NEAR, daily_max 1 NEAR, allowlist `[dmw-api-edbc.testnet]` |
| Bounty | 0.05 NEAR |
| Payout 0 (Base Sepolia) | 0.0005 ETH (`500000000000000` wei) to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` |
| Payout 1 (Monad testnet) | 0.01 MON (`10000000000000000` wei) to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` |
| Payout 2 (Solana devnet) | 0.01 SOL (`10000000` lamports) to `HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr` |

Setup transactions: [create_vault](https://testnet.nearblocks.io/txns/2vG3BFANPxySTqpmmERViuytftNPQ74cjge9xWgRHNqr),
[set_foreign_payouts](https://testnet.nearblocks.io/txns/9nrbAsnHDHYNPr6cBvTs6mKgfEgnjrkhbuK2h7k4D4eW)
(`scripts/showcase.sh`, run by the `testnet` workflow).

## Source addresses a human can fund (faucets need a login)

The MPC-derived source addresses for vault 1 (`base-1`, `monad-1`, `sol-1`). No private key exists for them; the contract
asks the signer at settlement. Without funds the signed transactions are produced (status `signed`) but the relay says
insufficient funds.

| Chain | Address | Send at least | Faucet | Explorer |
| --- | --- | --- | --- | --- |
| Base Sepolia | `0xe8DCc7d14Cd9d1B313d329f01169cB981FcEDb92` | 0.001 ETH (payout 0.0005 + gas ~0.00025) | [Alchemy](https://www.alchemy.com/faucets/base-sepolia), [Coinbase CDP](https://portal.cdp.coinbase.com/products/faucet) | [basescan](https://sepolia.basescan.org/address/0xe8DCc7d14Cd9d1B313d329f01169cB981FcEDb92) |
| Monad testnet | `0x4103D844081fFBB4354B8D2793157F1FE44f8909` | **0.05 MON** or more (payout 0.01 + gas). See the reserve rule below | [faucet.monad.xyz](https://faucet.monad.xyz) | [monadexplorer](https://testnet.monadexplorer.com/address/0x4103D844081fFBB4354B8D2793157F1FE44f8909) |
| Solana devnet | `Ct9QKUJVn1Ns7v8z1XcpGoiGsakHpCTg9QEqpBBDPFPN` | 0.05 SOL (payout 0.01 + fee) | [faucet.solana.com](https://faucet.solana.com) (GitHub login) | [explorer](https://explorer.solana.com/address/Ct9QKUJVn1Ns7v8z1XcpGoiGsakHpCTg9QEqpBBDPFPN?cluster=devnet) |

Monad's 10 MON reserve rule: an account may not dip below the reserve (10 MON) except by a transaction that empties it,
and the vault's single Monad payout is the first transaction from `monad-1`, nonce 0, so it is an emptying transaction
and is allowed. Fund at least 0.05 MON; the payout sends exactly 0.01 MON and whatever is left stays at the address.

Re-check any time: `cd keeper && DMW_CONTRACT=dmw-979268.testnet npm run derive -- --token 1`.

## Heir-controlled recipient addresses

The Base and Monad payouts go to `0xfd151ad02f573689f235f56059ce6e2f3b64dd89` and the Solana payout to
`HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr`, fresh keypairs held by the demo heir ("Sarah") since Nov 7 2026 (the
same recipients as the earlier showcase vault 6 on `dmw-x8cx.testnet`). Earlier recipients were MPC-derived addresses
nobody holds a key for (on-chain audit F-3), which would have burned the test funds.

## The earlier showcase

Before Nov 11 2026 the showcase was vault 6 on `dmw-x8cx.testnet` (owner `dmw-andrew-8d2e.testnet`). That contract runs
the code with finding C-2 and was replaced, not upgraded; vault 6 is still readable there.
