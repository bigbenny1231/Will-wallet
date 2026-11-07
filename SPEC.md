# Dead Man's Wallet — Technical Spec (v1, hackathon)

This is the single source of truth for every component. Agents code against this file.
If you must deviate, update this file in the same change and say why in the commit.

## 0. One-paragraph summary

A NEAR contract (`dmw`) holds "vaults". A vault is a NEP-171 token (the **Will NFT**) that
owns a NEAR balance, a list of heirs, a list of foreign-chain payouts, and the public keys of
two kinds of function-call access keys that live **on the contract's own account**:
*pulse keys* (may only call `heartbeat`) and *agent keys* (may only call `agent_pay`).
While heartbeats arrive, nothing happens. When `grace_missed + 1` intervals pass with no
heartbeat, anyone may `poke` the vault into `Triggered`, earn a bounty, and then drive a
resumable five-step settlement with repeated `execute_step` calls:

1. transfer NEAR to heirs by basis points
2. delete every pulse and agent key from the contract account
3. request MPC signatures (`v1.signer-prod.testnet`) for each foreign payout (one per call)
4. `add_proposal` on the vault's Sputnik DAO (if set)
5. `nft_transfer` the Will NFT to the primary heir, state → `Settled`

The keeper (off-chain) relays the signed foreign transactions and records their hashes.

## 1. Accounts and networks

| Thing | Value |
| --- | --- |
| NEAR network | testnet, RPC `https://rpc.testnet.near.org` |
| Contract account | `$DMW_CONTRACT` (e.g. `dmw-1.testnet`); set in `.env` |
| MPC signer | `v1.signer-prod.testnet` |
| EVM target | Base Sepolia, chain id `84532`, RPC `https://sepolia.base.org` |
| Solana target | devnet, RPC `https://api.devnet.solana.com` |
| Sputnik factory | `sputnik-v2.testnet` (DAO created by dashboard/CLI; contract only needs the DAO account id) |
| Derivation paths | `base-<token_id>` (secp256k1, domain 0), `sol-<token_id>` (ed25519, domain 1) |

The foreign *source* addresses are derived from `(contract_account_id, path)` and are
computed **off-chain** (keeper `derive` command, dashboard) with chainsig.js
`deriveAddressAndPublicKey`. The owner funds those addresses while alive. No private key
for them exists anywhere; the contract requests signatures at settlement time.

## 2. Contract: `contracts/dmw` (Rust, near-sdk 5.x, cargo-near)

### 2.1 Types (JSON wire form)

```jsonc
// Heir
{ "account_id": "sarah.testnet", "bps": 6000 }            // bps sum must be 10000

// ForeignPayout (set by owner while Alive)
{
  "chain": "base" | "solana",
  "to": "0xabc..." | "<base58 pubkey>",
  "amount": "1000000000000000",   // string integer in the chain's smallest unit (wei / lamports)
  "from_address": "0x...",         // derived address, informational, set by dashboard
  "status": "pending" | "signed" | "broadcast" | "failed",
  "signed_tx": null | "<hex of raw signed tx>",  // filled in step 3 callback
  "tx_hash": null | "<hash>"      // filled by keeper via mark_broadcast
}

// Policy for agent keys
{
  "per_tx_max": "1000000000000000000000000",   // yoctoNEAR string
  "daily_max":  "5000000000000000000000000",
  "allowlist":  ["api.provider.testnet"]        // empty = any receiver allowed
}

// StepArgs (keeper supplies ONLY chain-environment fields; never to/value/chain)
{
  "evm": { "nonce": 3, "max_fee_per_gas": "1500000000", "max_priority_fee_per_gas": "1000000", "gas_limit": "21000" },
  "solana": { "recent_blockhash": "<base58>" }
}

// VaultView (returned by get_vault)
{
  "token_id": "1",
  "owner_id": "andrew.testnet",
  "state": "Alive" | "Warning" | "Triggered" | "Settled",
  "heartbeat_interval_s": 60,
  "grace_missed": 2,
  "last_beat_ms": 1731000000000,
  "warning_at_ms": ..., "trigger_at_ms": ...,          // derived
  "balance": "yocto string",
  "bounty": "yocto string",
  "heirs": [Heir],
  "foreign": [ForeignPayout],
  "pulse_keys": ["ed25519:..."],
  "agent_keys": ["ed25519:..."],
  "policy": Policy,
  "daily_spent": "yocto string", "daily_window_start_ms": ...,
  "dao_id": null | "estate.sputnik-v2.testnet",
  "dao_proposal_id": null | 7,
  "step": 0..5,                 // next step to execute when Triggered
  "foreign_index": 0,           // next foreign payout to sign within step 3
  "log": [ { "ms": ..., "event": "heartbeat"|"agent_pay_allowed"|"agent_pay_denied"|"triggered"|"step_1"|...|"settled", "detail": "..." } ]
}
```

### 2.2 State machine

- `Alive`: `now < last_beat + interval`
- `Warning`: `last_beat + interval <= now < last_beat + interval*(grace_missed+1)` (derived, not stored)
- `Triggered`: stored, set by `poke` when `now >= last_beat + interval*(grace_missed+1)`
- `Settled`: stored, set when step 5 completes

`heartbeat` is rejected once `Triggered`. Owner-only mutators (`set_*`, `add_*_key`) are rejected once `Triggered`.

### 2.3 Methods

| Method | Caller | Deposit | Effect |
| --- | --- | --- | --- |
| `new(owner_id)` | deployer | — | init; sets contract owner, NFT metadata |
| `create_vault({heartbeat_interval_s, grace_missed, heirs, policy?, bounty?})` → `token_id` | anyone | ≥ 0.1 NEAR (storage) + vault balance | mints Will NFT to caller; `last_beat = now`; `balance = deposit − storage` |
| `deposit({token_id})` | anyone | > 0 | adds to vault balance |
| `heartbeat({token_id})` | owner, or pulse key (predecessor == contract && signer_pk ∈ pulse_keys) | — | `last_beat = now`; event |
| `add_pulse_key({token_id, public_key})` | owner | — | stores pk; `Promise::new(current).add_access_key_allowance(pk, 1 NEAR, current, "heartbeat")` (see §2.7) |
| `add_agent_key({token_id, public_key})` | owner | — | stores pk; FC key scoped to `agent_pay` |
| `remove_key({token_id, public_key})` | owner | — | removes from vault + `delete_key` |
| `agent_pay({token_id, receiver_id, amount, memo?})` | agent key only | — | policy check; on allow: `balance -= amount`, `Promise::new(receiver).transfer(amount)`; event `agent_pay_allowed` / `agent_pay_denied` with `reason` in {`over_per_tx_max`, `over_daily_max`, `receiver_not_allowlisted`, `vault_not_alive`, `insufficient_balance`}. Denied calls **do not panic** (so the log entry persists) |
| `set_heirs`, `set_policy`, `set_foreign_payouts`, `set_dao({token_id, dao_id})`, `set_timing({token_id, heartbeat_interval_s, grace_missed})` | owner, while not Triggered | — | update |
| `poke({token_id})` | anyone | — | if deadline passed: state=Triggered, step=1, pay `bounty` to predecessor from balance, event `triggered`. Else panic `not_due` |
| `execute_step({token_id, args?})` | anyone | — | runs the current step (see §2.4), advances `step`; idempotent on re-entry; panics if not Triggered or already Settled |
| `mark_broadcast({token_id, index, tx_hash})` | anyone | — | sets foreign[index].status=broadcast, tx_hash |
| `claim({token_id})` | current NFT owner, only when Settled | — | transfers remaining balance to caller |
| `get_vault({token_id})` → VaultView | view | | |
| `get_vaults({from_index, limit})` → [VaultView] | view | | for keeper polling |
| `get_vaults_for_owner({account_id})` | view | | |
| `nft_token`, `nft_transfer`, `nft_transfer_call`, `nft_metadata`, `nft_total_supply`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner` | NEP-171 / NEP-177 / NEP-181 | | `nft_transfer` by owner only while Alive/Warning (transfers ownership of the vault); `media` is an on-chain SVG data URI |
| `contract_source_metadata` | NEP-330 | | |

Events are NEP-297: `EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"<name>","data":{...}}`.

### 2.4 Settlement steps (`execute_step`)

Each call does **one** unit of work and returns the new `step`. Gas budget per call ≤ 300 TGas.

| step | work | advance rule |
| --- | --- | --- |
| 1 | For each heir: `Promise::new(heir).transfer(balance * bps / 10000)`; keep 0.05 NEAR + bounty reserve in balance for later steps | step=2 |
| 2 | For each pulse + agent key: `Promise::new(current).delete_key(pk)` batched; clear lists | step=3, foreign_index=0 |
| 3 | If `foreign_index < foreign.len()`: build the tx for `foreign[foreign_index]` with `omni-transaction` using `args`, hash it, call `v1.signer-prod.testnet.sign` (1 yocto, 250 TGas) with `{request:{payload_v2:{Ecdsa:hex}|{Eddsa:hex}, path, domain_id}}`; in callback store signature + `signed_tx` (fully serialized raw tx) and status=`signed`, `foreign_index += 1`. If the MPC call fails: status=`failed`, `foreign_index += 1` (never block settlement). When `foreign_index == foreign.len()`: step=4 | per call: one payout |
| 4 | If `dao_id` set: `add_proposal` on it with 1 NEAR bond from balance, kind `Vote`-style text proposal (fallback: `FunctionCall` to `dmw.mark_broadcast` no-op) describing the settlement and the heir list; store returned id. Else skip | step=5 |
| 5 | `nft_transfer` Will NFT to heir with highest bps (owner_id = heir); state=Settled; event `settled` | step=6 |

Foreign tx construction (chainsig conventions to verify against the live signer on day 1):
- **EVM**: EIP-1559 `TransactionBuilder::new::<EVM>()` with `to`, `value`, `chain_id=84532`, `nonce`, fees, `gas_limit`, empty input. `build_for_signing()` → keccak256 → `payload_v2: {Ecdsa: hex}`, `domain_id: 0`. Callback: signature `{big_r:{affine_point}, s:{scalar}, recovery_id}` → `build_with_signature(...)` → raw RLP hex stored in `signed_tx`.
- **Solana**: `SystemProgram::transfer` from derived pubkey to `to`, `recent_blockhash` from args. Message bytes → `payload_v2: {Eddsa: hex of message bytes}`, `domain_id: 1`. Callback: 64-byte signature → serialized tx (base64) stored in `signed_tx`.
- The MPC `sign` returns through a yield/resume; budget 250 TGas for the call and 30 TGas for the callback.

### 2.5 Will NFT image

`nft_token.metadata.media` = `data:image/svg+xml;base64,...` built from state at read time:
a 400×400 SVG, dark background, a ring stroke (green `#2ecc71` Alive, amber `#f39c12` Warning,
red `#e74c3c` Triggered, grey `#7f8c8d` Settled), vault id, state word, "next beat in Xs" or
"settled", and the heir count. `extra` carries the JSON `{state, trigger_at_ms, heirs}`.

### 2.6 Tests

- Unit tests with `near_sdk::testing_env!` for: state derivation, policy allow/deny each reason, poke timing, step ordering and idempotence, bps math, NFT ownership rules.
- Integration: `scripts/e2e.sh` against testnet (create account via faucet, deploy, create vault with 20 s interval, add keys, agent pay allowed + denied, kill, poke, steps, assert final state). Must pass before submission.

### 2.7 Implementation notes (contracts agent, 2026-11-07)

These are the places where the shipped contract (`contracts/dmw`, deployed at `dmw-x8cx.testnet`) differs from or adds to §2.1–2.5:

- **`token_id` input** is accepted as a JSON number (`1`) or a string (`"1"`). Views always return a string.
- **Key gas allowance is 1 NEAR, not 0.25.** Gas burned by function-call keys comes out of the contract account, which pools every vault's NEAR. So `add_*_key` takes the allowance from the vault's own `balance` (the vault needs ≥ 1 NEAR) and gives it back if AddKey fails. A heartbeat at 10 TGas costs ~0.011 NEAR of allowance, so one key covers ~90 beats. Tell the keeper to attach **≤ 10 TGas** for `heartbeat` (the allowance is charged for prepaid gas, not gas actually used).
- **Keys work only after AddKey succeeds** (`on_key_added` callback). There is a global registry `public_key -> token_id`, so one key can belong to only one vault. This stops a vault from listing someone else's key (or the contract's full-access key) and getting it deleted in step 2 or by `remove_key`.
- **`agent_pay` denies with `vault_not_alive` in Warning too.** The agent is disarmed as soon as a beat is missed. Check order: `vault_not_alive`, `receiver_not_allowlisted`, `over_per_tx_max`, `over_daily_max`, `insufficient_balance`. If `policy` is omitted, everything is denied (all limits 0). Authorization failures (not an agent key of this vault) still panic.
- **Step 1 reserve** is 1.5 NEAR when a DAO is set (proposal bond + gas), otherwise 0.1 NEAR. This replaces "0.05 + bounty", since the bounty is already paid at `poke`. Whatever is left is claimable by the NFT owner after Settled. The `step_1` log `detail` is `"<account> <amount> NEAR, ..."` (the dashboard parses it).
- **Failed outgoing transfers** (heir, agent, bounty, claim) go back into the vault balance through a callback.
- **`execute_step`** returns the new `step`. Steps 3 and 4 return it through their callback. Step 3 has an in-flight guard: calling it again while a signature is pending does nothing and returns 3. A request still pending after 10 min is marked `failed` and settlement moves on. With no foreign payouts, step 3 goes straight to 4. The keeper should attach **300 TGas** to every `execute_step`.
- **Step 4** creates a Sputnik v2 `FunctionCall` proposal (text/`Vote` proposals are not valid in v2): `mark_broadcast({token_id, index: 0, tx_hash: "dao-ratified"})` on this contract, 1 NEAR bond, 100 TGas. The proposal id is stored. If it fails, the bond goes back to the vault and settlement continues. `mark_broadcast` with `tx_hash == "dao-ratified"` is accepted only from the vault's `dao_id` and only logs `dao_ratified`.
- **`mark_broadcast`** otherwise requires `status == "signed"`, so a recorded hash cannot be overwritten.
- **Limits:** ≤ 10 heirs, ≤ 5 keys per kind, ≤ 4 foreign payouts, ≤ 10 allowlist entries, interval 10 s..10 y, `grace_missed` ≤ 1000. The log keeps the last 40 entries.
- **Defaults:** bounty 0.01 NEAR; storage fee 0.1 NEAR flat. `set_dao({token_id, dao_id: null})` clears the DAO. `set_foreign_payouts({token_id, payouts})` forces `status: "pending"`.
- **NFT:** approvals (NEP-178) are not supported (`approval_id` must be null). `nft_transfer_call` reverts if the receiver returns `true`. `extra.heirs` is the heir count.
- **Extra views:** `get_config()`. `get_vaults({from_index, limit})` takes JSON numbers (limit ≤ 100).
- **Callbacks:** `on_key_added`, `on_transfer_done`, `on_dao_proposal`, `on_foreign_signed`, `nft_resolve_transfer` (all `#[private]`). `on_foreign_signed` returns the new step.
- **Build:** near-sdk 5.30 needs `--cfg near` for on-chain builds without cargo-near. `contracts/dmw/build.sh` handles it.

## 3. Keeper: `keeper/` (TypeScript, Node 22, ESM)

Commands (`npm run <cmd>` or `npx dmw <cmd>`):

| cmd | does |
| --- | --- |
| `derive --token <id>` | prints derived Base and Solana source addresses for the vault (chainsig.js) |
| `pulse --token <id> --key <ed25519:...> [--interval 60]` | heartbeat daemon; prints a countdown; Ctrl-C = "death" |
| `keeper [--poll 5]` | loop: `get_vaults`, `poke` any vault past deadline, `execute_step` any Triggered vault (fetching nonce/fees from Base RPC and blockhash from Solana for step 3), relay any `signed` payout (eth_sendRawTransaction / sendTransaction), then `mark_broadcast`. Logs every action with explorer links |
| `agent-demo --token <id> --key <agent key>` | runs two `agent_pay` calls: one allowed (small, allowlisted) and one denied (over cap, unknown receiver); prints the on-chain log lines |
| `dao create --name estate-<id>` | creates a Sputnik v2 DAO on testnet with the owner as council and prints its id |

Config via `.env` (`.env.example` committed): `NEAR_NETWORK`, `DMW_CONTRACT`, `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY`, `BASE_RPC`, `SOLANA_RPC`.
Solana blockhashes expire in ~60–90 s; keeper fetches a fresh one right before `execute_step` and retries once with a new blockhash if the sign callback reports failure.

## 4. Dashboard: `dashboard/` (Vite + React + TypeScript, wallet-selector with MyNearWallet + Meteor)

Routes:
- `/` — connect wallet; list my vaults; "Create vault" wizard (interval, grace, heirs with bps, policy, foreign payouts with derived addresses shown + faucet links, optional DAO)
- `/vault/:id` — live Will NFT image (poll every 3 s), state ribbon, countdown, **Heartbeat** button, **Kill (stop daemon)** instructions, agent panel (policy, allow/deny log from events), keys panel (add pulse/agent key: generates keypair in browser, calls `add_*_key`, shows the key for the daemon), settlement timeline (5 steps with explorer links: nearblocks.io/testnet, sepolia.basescan.org, explorer.solana.com?cluster=devnet, Sputnik UI), `claim` button when Settled and I'm the NFT owner
- `/heir` — "Got an email?" — sign in (wallet or NEAR Auth if feasible), shows vaults where I'm an heir and what arrived

Design: dark, calm, one accent; large type (recorded at 125%). No marketing copy in the app.

## 5. Site: `site/` (static, single `index.html` + Tailwind CDN)

Landing page per the mockup in the plan doc: hero "Crypto that arrives.", vault card, trust strip,
three steps, heir claim band, FAQ, waitlist form (Formspree or Supabase; placeholder OK), footer disclaimer
"Not a will. Not a custodian. Configure it with your estate attorney."

## 6. Repo conventions

- Directories are owned: `contracts/` (contract agents), `keeper/`, `dashboard/`, `site/`. Don't edit outside your directory except `SPEC.md` (with a note) and your own entry in `README.md`.
- Conventional commits. No secrets ever; `gitleaks` in CI.
- `make build | test | deploy | demo | kill` at repo root (`Makefile`), each printing what to expect.
- Everything must run from a clean clone on Linux/macOS with Rust, Node 22 and near-cli-rs.
