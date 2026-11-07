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
| `VITE_BASE_RPC` / `VITE_MONAD_RPC` / `VITE_SOLANA_RPC` | public Base Sepolia / Monad testnet / Solana devnet | step-3 args and broadcast |
| `VITE_PUBLIC_ORIGIN` | this page's origin | origin put in the phone pairing link; set it when the dashboard runs on localhost |
| `VITE_NEAR_AUTH_CLIENT_ID` / `VITE_NEAR_AUTH_DOMAIN` / `VITE_NEAR_AUTH_ORIGINS` | shared NEAR Auth testnet client, `http://localhost:3000` | heir sign-in with Google, see `docs/near-auth.md` |
| `VITE_DEBUG_ACCOUNT` | empty | display-only fake signed-in account for screenshots; calls still need a wallet |
| `VITE_SPUTNIK_UI` | empty | Astro UI base; empty links the DAO account on nearblocks |

## Routes

`/` my vaults, `/create` wizard, `/vault/:id` live vault, `/heir` vaults where the connected account (or the Google
identity, through NEAR Auth) is an heir, `/pulse` the owner's phone.

## The phone (`/pulse`)

On the vault page, Keys, **Pair a phone** makes an ed25519 key, registers it with `add_pulse_key` through the wallet,
then shows a QR code. The QR opens `/pulse#c=<contract>&t=<token>&k=<secret>` (the key is in the fragment, so it never
reaches a server); "Show app link" switches it to `dmw://pulse?c=…&t=…&k=…`. The phone stores the key in
`localStorage`, removes it from the address bar, and beats while the page is open: every `min(interval / 3, 20 s)`
(Settings can override it), signer = the contract account + the pulse key, 10 TGas, one beat in flight at a time.
**Hold to stop** (two seconds) ends the beats and draws the flatline. Hidden pages stop beating unless "keep beating in
the background" is on (best effort; phones throttle background tabs). The page is an installable PWA (manifest, seal
icons, `public/sw.js` offline shell, registered only on `/pulse` in production builds). On iPhone a Home Screen app has
its own storage: paste the pairing link inside it once. Verified live on 2026-11-07 against `dmw-x8cx.testnet` vault 15
with Playwright's iPhone 13 and Pixel 7 emulation (`shots/v3-pulse-*.png`).

## Guardian

The vault page's Guardian section calls `set_guardian({token_id, guardian_id, max_pause_s})` (owner, 10 s to 90 days)
and `pause({token_id})` (guardian or owner, once per heartbeat cycle, before the deadline). While `now <
paused_until_ms` the console reads "Paused." with an amber "paused until" line under the pulse strip.

## Heir sign-in with Google

`npm run dev:auth` serves on `http://localhost:3000`, the only origin the shared NEAR Auth testnet client accepts.
There "Continue with Google" opens NEAR Auth's Google login, derives the identity's MPC key and shows the implicit
account it controls and that account's inheritances. On other origins the button is disabled and labelled
"NEAR Auth (coming)". Details and limits: `docs/near-auth.md`.

## Design

Follows `DESIGN.md`. Tokens are CSS variables in `src/index.css` (Tailwind is themed to them); fonts are self-hosted
through `@fontsource` (Instrument Serif, Inter Tight, JetBrains Mono). The vault seal is the contract's on-chain
`media` SVG with a client overlay (`components/Seal.tsx`) that sweeps the trace and flashes on every new
`last_beat_ms`. The pulse strip (`components/PulseStrip.tsx`) flatlines into the settlement timeline. Trace geometry
is shared with `contracts/dmw/src/nft.rs` through `src/lib/pulse.ts`; `src/lib/seal.ts` ports the seal for mock mode.
The heir page uses the inverted (bone) palette. Screenshots: `shots/v2-*.png`, `shots/v3-*.png`.

## Notes

- Redirect wallets (MyNearWallet) leave the page. The create wizard and the keys panel save their state first
  (`localStorage` pending create, `sessionStorage` new private key) and resume on return.
- Foreign source addresses are derived in the browser with chainsig.js (`deriveChildPublicKey*`) from the MPC root keys.
  The path uses the vault id, so the wizard shows the address for the next expected id and recomputes after minting.
- Deploy: `vercel.json` rewrites everything except `sw.js`, the manifest and icons to `index.html`, and serves `sw.js` with `no-cache`.
- Vault page buttons: Heartbeat (10 TGas), Poke (anyone, enabled once `now >= trigger_at_ms`), Execute next step (anyone, 300 TGas, only
  while Triggered; step 3 fetches the Base/Monad nonce and fees, capped at the contract's 100 gwei, or the Solana blockhash first), Claim, Deposit, Transfer (nft_transfer, 1 yocto).
  Signed foreign payouts get a "Broadcast and record" button (RPC send, then `mark_broadcast`).
- Each pulse/agent key reserves 1 NEAR of the vault balance, so keep the balance above that before adding keys.
