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
| `VITE_DMW_CONTRACT` | `dmw-885364.testnet` | contract account (see `docs/LIVE_CONTRACT.md`) |
| `VITE_NEAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `VITE_NEAR_RPC` | public RPC | RPC override |
| `VITE_DMW_MOCK` | `0` | `1` = mock data |
| `VITE_BASE_RPC` / `VITE_MONAD_RPC` / `VITE_SOLANA_RPC` | public Base Sepolia / Monad testnet / Solana devnet | step-3 args and broadcast |
| `VITE_PUBLIC_ORIGIN` | this page's origin | origin put in the phone pairing link; set it when the dashboard runs on localhost |
| `VITE_DEBUG_ACCOUNT` | empty | display-only fake signed-in account for screenshots; calls still need a wallet |
| `VITE_SPUTNIK_UI` | empty | Astro UI base; empty links the DAO account on nearblocks |

## Routes

`/` my vaults, `/try` the guest run (no wallet), `/create` wizard, `/vault/:id` live vault, `/heir` vaults where the
connected account is an heir, `/pulse` the owner's phone.

## The phone (`/pulse`)

On the vault page, Keys, **Pair a phone** makes an ed25519 key, registers it with `add_pulse_key` through the wallet,
then shows a QR code. The QR opens `/pulse#c=<contract>&t=<token>&k=<secret>` (the key is in the fragment, so it never
reaches a server); "Show app link" switches it to `dmw://pulse?c=…&t=…&k=…`. The phone stores the key in
`localStorage`, removes it from the address bar, and beats while the page is open: every `min(interval / 3, 20 s)`
(Settings can override it), signer = the contract account + the pulse key, 10 TGas, one beat in flight at a time.
**Hold to stop** (two seconds) ends the beats and draws the flatline. Hidden pages stop beating unless "keep beating in
the background" is on (best effort; phones throttle background tabs). The page is an installable PWA (manifest, seal
icons, `public/sw.js` offline shell, registered only on `/pulse` in production builds). On iPhone a Home Screen app has
its own storage: paste the pairing link inside it once. Tested with Playwright's iPhone 13 and Pixel 7 emulation
(`shots/v3-pulse-*.png`).

## Guest run

`/try` runs a whole estate without a wallet. It exists on testnet only (`guestAvailable()` in `src/lib/guest.ts`).

1. **Account.** The browser generates an ed25519 key and asks the public testnet faucet
   (`https://helper.nearprotocol.com/account`) to create `dmw-guest-<8 hex>.testnet` with it, about 10 NEAR.
2. **Vault.** `create_vault` with a 30 s interval, grace 1, two heirs (60 / 40), a policy (0.5 NEAR a payment, 1 NEAR
   a day, one allowed receiver) and a 0.05 NEAR bounty. The heirs and the allowed receiver are NEAR implicit accounts
   (the hex of a public key generated here), so no second faucet call is needed and the heir's key can sign `claim`.
3. **Keys and payouts.** One transaction with three actions: `add_pulse_key`, `add_agent_key`, `set_foreign_payouts`
   (0.0001 ETH on Base Sepolia, 0.001 SOL on devnet, to example addresses).
4. **The guide** (`src/components/GuestGuide.tsx`) sits on top of the real vault page and drives it:
   the pulse key beats every 12 s; the agent key signs an allowed `agent_pay`, a denied one, and a plain transfer the
   node refuses; hold to stop; when the deadline passes, the guest account pokes and calls `execute_step` until
   `Settled` (fetching fees and a blockhash for step III exactly as the wallet path does); the heir key claims.

What to know:

- Everything is in `localStorage` under `dmw-guest`: the guest account's full-access key, the heir keys, the pulse and
  agent keys, and a list of the transactions the page signed. It is a throwaway testnet account holding faucet funds.
  "Guest" in the header forgets it. Unlike `/pulse`, this page loads the wallet SDK next to those keys.
- A connected wallet always wins; guest signing is used only when no wallet is connected.
- The faucet limits requests per address. When it refuses, the page says so and nothing is half-created: a retry
  resumes from the step that failed.
- An abandoned run leaves an overdue vault. The register folds unfinished guest vaults into "Guest runs in progress",
  and the project's hosted keeper (`.github/workflows/keeper.yml`, see `keeper/README.md`) settles every due vault on
  the contract, guest vaults included.
- The foreign payouts are signed by the MPC network in step III; the vault page shows each payout's status, and an
  explorer link once a keeper has relayed it and recorded the hash with `mark_broadcast`.
- Tested with Playwright (Chromium) at 1440 and 390 px: begin, three agent actions, hold to stop, poke, five steps,
  claim, heir page.

## The record

`src/components/Record.tsx` turns `get_vault().log` into the Will NFT's history, newest first: creation, keys,
agent payments allowed and denied (with the reason), pause, trigger, each settlement step, the holder. Runs of
heartbeats are folded into one line. The contract keeps the last 40 entries, so on a long-lived vault the oldest
scroll out; the page says so.

## Guardian

The vault page's Guardian section calls `set_guardian({token_id, guardian_id, max_pause_s})` (owner, 10 s to 90 days)
and `pause({token_id})` (guardian or owner, once per heartbeat cycle, before the deadline). While `now <
paused_until_ms` the console reads "Paused." with an amber "paused until" line under the pulse strip.

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
  while Triggered; step 3 fetches the Base/Monad nonce and fees, capped at the per-chain max_fee_per_gas from get_config (Base 100 gwei, Monad 1000 gwei); an empty payout from_address is derived in the browser, or the Solana blockhash first), Claim, Deposit, Transfer (nft_transfer, 1 yocto).
  Every owner edit (heirs, policy, payouts, DAO, timing, guardian, add/remove key) and Pause attach exactly 1 yocto (contract
  `assert_one_yocto`, review 2 M-6), so they always open a wallet confirmation; Heartbeat, Poke, Execute and Claim attach nothing.
  Signed foreign payouts get a "Broadcast and record" button (RPC send, then `mark_broadcast`).
- Each pulse/agent key reserves 1 NEAR of the vault balance, so keep the balance above that before adding keys.
