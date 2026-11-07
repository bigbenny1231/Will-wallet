# Dead Man's Wallet dashboard

Vite + React 18 + TypeScript + Tailwind (PostCSS). Wallets via `@near-wallet-selector` v10 (MyNearWallet, Meteor).

## Run

```bash
cd dashboard
npm install
cp .env.example .env        # set VITE_DMW_CONTRACT to the deployed contract (DMW_CONTRACT in the repo .env)
npm run dev                 # http://localhost:5173
npm run build               # tsc + vite build, must have zero type errors
npm test                    # vitest: call builders vs lib.rs arg names, gas, deposits; log parsers
```

## Mock mode (no contract needed)

```bash
VITE_DMW_MOCK=1 npm run dev
```

A fake vault `#1` owned by `demo.testnet` cycles Alive, Warning, Triggered, Settled every 20 s, with the same seal SVG the contract draws.
Vaults 2 and 3 exist so the Heir page has content. In the browser console, `__dmwMock.jumpTo("Warning")` jumps the cycle.

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `VITE_DMW_CONTRACT` | `dmw-x8cx.testnet` | contract account |
| `VITE_NEAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `VITE_NEAR_RPC` | public RPC | RPC override |
| `VITE_DMW_MOCK` | `0` | `1` = mock data |
| `VITE_BASE_RPC` / `VITE_SOLANA_RPC` | public Base Sepolia / Solana devnet | step-3 args and broadcast |
| `VITE_DEBUG_ACCOUNT` | empty | display-only fake signed-in account for screenshots; calls still need a wallet |
| `VITE_SPUTNIK_UI` | empty | Astro UI base; empty links the DAO account on nearblocks |

## Routes

`/` my vaults, `/create` wizard, `/vault/:id` live vault, `/heir` vaults where the connected account is an heir.

## Design

Follows `DESIGN.md`. Tokens are CSS variables in `src/index.css` (Tailwind is themed to them); fonts are self-hosted
through `@fontsource` (Instrument Serif, Inter Tight, JetBrains Mono). The vault seal is the contract's on-chain
`media` SVG with a client overlay (`components/Seal.tsx`) that sweeps the trace and flashes on every new
`last_beat_ms`. The pulse strip (`components/PulseStrip.tsx`) flatlines into the settlement timeline. Trace geometry
is shared with `contracts/dmw/src/nft.rs` through `src/lib/pulse.ts`; `src/lib/seal.ts` ports the seal for mock mode.
The heir page uses the inverted (bone) palette. Screenshots: `shots/v2-*.png`.

## Notes

- Redirect wallets (MyNearWallet) leave the page. The create wizard and the keys panel save their state first
  (`localStorage` pending create, `sessionStorage` new private key) and resume on return.
- Foreign source addresses are derived in the browser with chainsig.js (`deriveChildPublicKey*`) from the MPC root keys.
  The path uses the vault id, so the wizard shows the address for the next expected id and recomputes after minting.
- Deploy: `vercel.json` rewrites everything to `index.html`.
- Vault page buttons: Heartbeat (10 TGas), Poke (anyone, enabled once `now >= trigger_at_ms`), Execute next step (anyone, 300 TGas, only
  while Triggered; step 3 fetches the Base nonce/fees or Solana blockhash first), Claim, Deposit, Transfer (nft_transfer, 1 yocto).
  Signed foreign payouts get a "Broadcast and record" button (RPC send, then `mark_broadcast`).
- Each pulse/agent key reserves 1 NEAR of the vault balance, so keep the balance above that before adding keys.
