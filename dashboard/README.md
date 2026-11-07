# Dead Man's Wallet dashboard

Vite + React 18 + TypeScript + Tailwind (PostCSS). Wallets via `@near-wallet-selector` v10 (MyNearWallet, Meteor).

## Run

```bash
cd dashboard
npm install
cp .env.example .env        # set VITE_DMW_CONTRACT to the deployed contract (DMW_CONTRACT in the repo .env)
npm run dev                 # http://localhost:5173
npm run build               # tsc + vite build, must have zero type errors
```

## Mock mode (no contract needed)

```bash
VITE_DMW_MOCK=1 npm run dev
```

A fake vault `#1` owned by `demo.testnet` cycles Alive, Warning, Triggered, Settled every 20 s, with the SPEC 2.5 SVG.
Vaults 2 and 3 exist so the Heir page has content. In the browser console, `__dmwMock.jumpTo("Warning")` jumps the cycle.

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `VITE_DMW_CONTRACT` | `dmw-1.testnet` | contract account |
| `VITE_NEAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `VITE_NEAR_RPC` | public RPC | RPC override |
| `VITE_DMW_MOCK` | `0` | `1` = mock data |
| `VITE_SPUTNIK_UI` | empty | Astro UI base; empty links the DAO account on nearblocks |

## Routes

`/` my vaults, `/create` wizard, `/vault/:id` live vault, `/heir` vaults where the connected account is an heir.

## Notes

- Redirect wallets (MyNearWallet) leave the page. The create wizard and the keys panel save their state first
  (`localStorage` pending create, `sessionStorage` new private key) and resume on return.
- Foreign source addresses are derived in the browser with chainsig.js (`deriveChildPublicKey*`) from the MPC root keys.
  The path uses the vault id, so the wizard shows the address for the next expected id and recomputes after minting.
- Deploy: `vercel.json` rewrites everything to `index.html`.
