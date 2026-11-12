# Dead Man's Wallet — Technical Spec (v1, hackathon)

This is the single source of truth for every component. Agents code against this file.
If you must deviate, update this file in the same change and say why in the commit.

> **Contract v2 (Nov 12 2026, this source; not deployed yet).** The security fixes in
> [`docs/SECURITY_FIXES_V2.md`](docs/SECURITY_FIXES_V2.md) change the interface; §2.9 lists the changes and the
> sections below are updated where a rule changed. The live contract `dmw-979268.testnet` still runs v1.

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
| NEAR network | testnet, RPC `https://rpc.testnet.fastnear.com` |
| Contract account | `$DMW_CONTRACT` (e.g. `dmw-1.testnet`); set in `.env` |
| MPC signer | `v1.signer-prod.testnet` (v2: set at `new`, shown as `get_config().mpc_signer`) |
| EVM targets (registry) | Base Sepolia, chain id `84532`, RPC `https://sepolia.base.org`, explorer `https://sepolia.basescan.org/tx/<hash>` |
| | Monad testnet, chain id `10143`, RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadexplorer.com/tx/<hash>` |
| Solana target | devnet, RPC `https://api.devnet.solana.com` |
| Sputnik factory | `sputnik-v2.testnet` (DAO created by dashboard/CLI; contract only needs the DAO account id) |
| Derivation paths | v2: `base-<token_id>-<salt>`, `monad-<token_id>-<salt>` (secp256k1, domain 0), `sol-<token_id>-<salt>` (ed25519, domain 1), with a per-vault 16-hex salt drawn at `create_vault` and published in the view as `derivation_paths`. v1: `base-<token_id>` etc. |

The foreign *source* addresses are derived from `(contract_account_id, path)`; clients take `path` from the vault
view's `derivation_paths` (v2) and never rebuild it from the token id, so no address exists before its vault. They are
computed **off-chain**: the keeper `derive` command calls the `derived_public_key` view on the MPC signer, and the
dashboard uses chainsig.js key derivation. Both give the same addresses (byte-identical to chainsig.js
`deriveAddressAndPublicKey`). The owner funds those addresses while alive. No private key
for them exists anywhere; the contract requests signatures at settlement time.

## 2. Contract: `contracts/dmw` (Rust, near-sdk 5.x, cargo-near)

### 2.1 Types (JSON wire form)

```jsonc
// Heir
{ "account_id": "sarah.testnet", "bps": 6000 }            // bps sum must be 10000

// ForeignPayout (set by owner while Alive)
{
  "chain": "base" | "monad" | "solana",
  "to": "0xabc..." | "<base58 pubkey>",
  "amount": "1000000000000000",   // string integer in the chain's smallest unit (wei / lamports)
  "from_address": "0x...",         // informational; v2 overwrites it with the true derived address at signing
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
  "daily_spent": "yocto string",   // v2: agent spend of the rolling 24 h window ending now
  "daily_window_start_ms": ...,    // v2: oldest spend still counted (0 when none)
  "spends": [ { "ms": ..., "amount": "yocto string" } ],   // v2: the spends in the window (≤ 24)
  "dao_id": null | "estate.sputnik-v2.testnet",
  "dao_proposal_id": null | 7,
  "step": 0..6,                 // next step to execute when Triggered; 6 once Settled
  "foreign_index": 0,           // next foreign payout to sign within step 3
  "guardian_id": null | "gina.testnet",   // §2.8
  "max_pause_s": 0,                       // §2.8, 0 when no guardian
  "paused_until_ms": 0,                   // §2.8, 0 when no pause since the last heartbeat
  "derivation_paths": { "base": "base-1-<salt>", "monad": "monad-1-<salt>", "solana": "sol-1-<salt>" },  // v2
  "keeper_id": null | "k.testnet",        // v2: per-vault keeper (an operator)
  "storage_bytes": 1800, "storage_deposit": "yocto string",   // v2: measured storage and the NEAR held for it
  "log": [ { "seq": 7, "ms": ..., "event": "heartbeat"|"agent_pay_allowed"|"agent_pay_denied"|"triggered"|"step_1"|...|"settled", "detail": "..." } ]
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
| `new(owner_id, keeper_id?, mpc_signer?)` | the contract account itself (`#[private]`), in the same transaction as the deploy | — | init; contract owner, keeper, MPC signer (default `v1.signer-prod.testnet`), NFT metadata |
| `create_vault({heartbeat_interval_s, grace_missed, heirs, policy?, bounty?})` → `token_id` | anyone | ≥ 0.1 NEAR (storage) + vault balance | mints Will NFT to caller; `last_beat = now`; `balance = deposit − storage` |
| `deposit({token_id})` | owner: > 0; anyone else: ≥ 0.01 NEAR (v2) | | adds to vault balance |
| `heartbeat({token_id})` | owner, or pulse key (predecessor == contract && signer_pk ∈ pulse_keys) | owner: exactly 1 yocto (v2); pulse key: — | `last_beat = now`; event. A pulse-key beat clears only a pause that has run out; the owner's beat also ends a running pause |
| `add_pulse_key({token_id, public_key})` | owner | exactly 1 yocto | stores pk; `Promise::new(current).add_access_key_allowance(pk, 1 NEAR, current, "heartbeat")` (see §2.7) |
| `add_agent_key({token_id, public_key})` | owner | exactly 1 yocto | stores pk; FC key scoped to `agent_pay` |
| `remove_key({token_id, public_key})` | owner | exactly 1 yocto | removes from vault + `delete_key` |
| `agent_pay({token_id, receiver_id, amount, memo?})` | agent key only | — | policy check; on allow: `balance -= amount`, `Promise::new(receiver).transfer(amount)`; event `agent_pay_allowed` / `agent_pay_denied` with `reason` in {`over_per_tx_max`, `over_daily_max`, `receiver_not_allowlisted`, `vault_not_alive`, `insufficient_balance`}. Denied calls **do not panic** (so the log entry persists) |
| `set_heirs`, `set_policy`, `set_foreign_payouts`, `set_dao({token_id, dao_id})`, `set_timing({token_id, heartbeat_interval_s, grace_missed})` | owner, while not Triggered | exactly 1 yocto | update |
| `set_guardian({token_id, guardian_id, max_pause_s})` | owner, while not Triggered | exactly 1 yocto | appoint (`guardian_id: null` clears) the guardian; `max_pause_s` 10 s..90 d (§2.8) |
| `pause({token_id})` → `trigger_at_ms` | guardian or owner, while Live and before the deadline | exactly 1 yocto (from either) | `paused_until = now + max_pause_s`, once per heartbeat cycle; event `paused` (§2.8) |
| `unpause({token_id})` → `trigger_at_ms` (v2) | owner, while a pause runs | exactly 1 yocto | ends the pause (`paused_until = now`); the guardian is not re-armed until the next heartbeat; event `unpaused` |
| `set_bounty({token_id, bounty})` (v2) | owner, while Alive | exactly 1 yocto | `bounty ≤ 1 NEAR` |
| `set_vault_keeper({token_id, keeper_id})` (v2) | owner, while Live | exactly 1 yocto | per-vault keeper (`null` clears); an operator for this vault |
| `set_keeper({account_id})` | contract owner (when not the contract itself) or the current keeper (hand-over) | — | contract keeper; cannot be cleared on a locked contract (v2) |
| `poke({token_id})` | anyone | — | if deadline passed: state=Triggered, step=1, pay `min(bounty, 1 NEAR, 10% of balance)` to predecessor from balance, event `triggered`. Else panic `not_due` |
| `execute_step({token_id, args?})` | anyone; v2: a step-3 payout during its first hour only by an operator (contract keeper, vault keeper, vault owner, heir) | — | runs the current step (see §2.4), advances `step`; idempotent on re-entry; panics if not Triggered or already Settled |
| `mark_broadcast({token_id, index, tx_hash})` | v2: operator (or the vault's DAO for `dao-ratified`) | — | sets foreign[index].status=broadcast, tx_hash (must equal the stored signed tx's id; §2.7) |
| `resign_foreign({token_id, index, args})` | v2: operator, ≥ 5 min after the last request | — | §2.7 |
| `claim({token_id})` | current NFT owner, only when Settled | — (deliberately) | transfers remaining balance to caller |
| `get_vault({token_id})` → VaultView | view | | |
| `get_vaults({from_index, limit})` → [VaultView] | view | | for keeper polling |
| `get_vaults_for_owner({account_id})` | view | | |
| `nft_token`, `nft_transfer`, `nft_transfer_call`, `nft_metadata`, `nft_total_supply`, `nft_tokens`, `nft_tokens_for_owner`, `nft_supply_for_owner` | NEP-171 / NEP-177 / NEP-181 | exactly 1 yocto on `nft_transfer` / `nft_transfer_call` | `nft_transfer` by owner only while Alive (v2: not overdue, not paused); it transfers ownership of the vault and resets it for the buyer (§2.9); `media` is an on-chain SVG data URI |
| `contract_source_metadata` | NEP-330 | | |

**Deposits (security review 2, M-6).** "exactly 1 yocto" means the call panics with `Requires attached deposit of
exactly 1 yoctoNEAR` on 0 or on any other amount. A function-call access key cannot attach a deposit, so these methods can
only be called with a full-access key, i.e. through a wallet confirmation: a dApp "sign in" key on the owner's account
cannot redirect heirs, swap keys, change timing or appoint a guardian. `pause` asks the same of the guardian as of the
owner, because a pause disarms the agent and holds off settlement; a guardian with only a function-call key cannot
pause. The yocto stays in the contract account and is not added to the vault balance. `create_vault` (≥ 0.1 NEAR) and
`deposit` (> 0) already need a non-zero deposit, so a function-call key cannot call them either. The deposit-free
methods stay deposit-free on purpose: the pulse-key `heartbeat` must work from a pulse key, `agent_pay` from an agent
key, and `poke` / `execute_step` / `mark_broadcast` / `resign_foreign` from a keeper. v2 (finding F): the **owner's**
`heartbeat` needs exactly 1 yocto, so a dApp key on the owner's account cannot beat (and end a guardian pause) silently;
`unpause`, `set_bounty` and `set_vault_keeper` need it too. `claim` stays free so an heir who signed
in to the dashboard with a function-call key can still collect; it only moves the remaining balance to the NFT owner
after Settled, which a function-call key holder cannot redirect. `set_keeper` (contract owner, not a vault owner)
is unchanged.

Events are NEP-297: `EVENT_JSON:{"standard":"dmw","version":"1.0.0","event":"<name>","data":{...}}`.

### 2.4 Settlement steps (`execute_step`)

Each call does **one** unit of work and returns the new `step`. Gas budget per call ≤ 300 TGas.

| step | work | advance rule |
| --- | --- | --- |
| 1 | For each heir: `Promise::new(heir).transfer(balance * bps / 10000)`; keep 0.05 NEAR + bounty reserve in balance for later steps | step=2 |
| 2 | For each pulse + agent key: `Promise::new(current).delete_key(pk)` batched; clear lists | step=3, foreign_index=0 |
| 3 | If `foreign_index < foreign.len()`: build the tx for `foreign[foreign_index]` with `omni-transaction` using `args`, hash it, call `v1.signer-prod.testnet.sign` (1 yocto, 250 TGas) with `{request:{payload_v2:{Ecdsa:hex}|{Eddsa:hex}, path, domain_id}}`; in callback store signature + `signed_tx` (fully serialized raw tx) and status=`signed`, `foreign_index += 1`. If the MPC call fails: status=`failed`, `foreign_index += 1` (never block settlement). When `foreign_index == foreign.len()`: step=4 | per call: one payout |
| 4 | If `dao_id` set: `add_proposal` on it with 1 NEAR bond from balance, kind `Vote`-style text proposal (fallback: `FunctionCall` to `dmw.mark_broadcast` no-op) describing the settlement and the heir list; store returned id. Else skip | step=5 |
| 5 | `nft_transfer` Will NFT to heir with highest bps (owner_id = heir); v2: release the storage deposit above the measured bytes + 2,000 bytes to the balance; state=Settled; event `settled` | step=6 |

Foreign tx construction (chainsig conventions to verify against the live signer on day 1):
- **EVM** (Base and Monad, one shared path): EIP-1559 `TransactionBuilder::new::<EVM>()` with `to`, `value`, `chain_id` from the registry (84532 / 10143), `nonce`, fees, `gas_limit`, empty input. `build_for_signing()` → keccak256 → `payload_v2: {Ecdsa: hex}`, `domain_id: 0`. Callback: signature `{big_r:{affine_point}, s:{scalar}, recovery_id}` → `build_with_signature(...)` → raw RLP hex stored in `signed_tx`.
- **Solana**: `SystemProgram::transfer` from derived pubkey to `to`, `recent_blockhash` from args. Message bytes → `payload_v2: {Eddsa: hex of message bytes}`, `domain_id: 1`. Callback: 64-byte signature → serialized tx (base64) stored in `signed_tx`.
- The MPC `sign` returns through a yield/resume; budget 250 TGas for the call and 30 TGas for the callback.
- **v2, EVM:** before `sign`, step 3 calls `derived_public_key({path, predecessor: contract, domain_id: 0})` on the signer
  (`on_foreign_evm_key`). The callback `ecrecover`s the signature (host function, malleable/high-s refused) and stores it
  only if it recovers to that key; otherwise, or if the key lookup fails, the payout is `failed`. `from_address` is then
  set to the derived address.

### 2.5 Will NFT image

`nft_token.metadata.media` = `data:image/svg+xml;base64,...` built from state at read time:
a 400×400 SVG, dark background, a ring stroke (green `#2ecc71` Alive, amber `#f39c12` Warning,
red `#e74c3c` Triggered, grey `#7f8c8d` Settled), vault id, state word, "next beat in Xs" or
"settled", and the heir count. `extra` carries the JSON `{state, trigger_at_ms, heirs}`.

> Note (dashboard agent, 2026-11-07): the image is now the DESIGN.md seal: brass double ring, rim inscription
> "DEAD MAN'S WALLET · VAULT N · STATE" on a textPath, a static ECG trace per state, the state word and the status line.
> State colours are the DESIGN.md tokens: `#3DDC84` Alive, `#F5B942` Warning, `#FF4D4D` Triggered, `#7A7F87` Settled. About 1.6 KB.

### 2.6 Tests

- Unit tests with `near_sdk::testing_env!` for: state derivation, policy allow/deny each reason, poke timing, step ordering and idempotence, bps math, NFT ownership rules.
- Integration against testnet: `contracts/smoke.sh` (contract-level smoke run) and `scripts/demo.sh` + `make agent` + `make kill` (faucet account, deploy, vault with a short interval, keys, agent pay allowed + denied, kill, poke, steps to Settled). `scripts/e2e.sh` was never written; the judge sequence in `docs/JUDGE_DRY_RUN_*.md` replaces it.

### 2.7 Implementation notes (contracts agent, 2026-11-07)

These are the places where the shipped contract (`contracts/dmw`, deployed at `dmw-979268.testnet` since Nov 11 2026, `docs/LIVE_CONTRACT.md`; before that `dmw-x8cx.testnet`) differs from or adds to §2.1–2.5:

- **`token_id` input** is accepted as a JSON number (`1`) or a string (`"1"`). Views always return a string.
- **Key gas allowance is 1 NEAR, not 0.25.** Gas burned by function-call keys comes out of the contract account, which pools every vault's NEAR. So `add_*_key` takes the allowance from the vault's own `balance` (the vault needs ≥ 1 NEAR) and gives it back if AddKey fails. A heartbeat sent with 10 TGas burns about 0.0003 NEAR (measured on testnet, Nov 10 2026). About 0.011 NEAR of allowance is held for the prepaid gas when the call is sent and the unused part comes back to the key's allowance, so one 1 NEAR key covers a few thousand beats, not ~90 as this note first said. Keep the keeper at **≤ 10 TGas** for `heartbeat`: the prepaid amount must still fit in the remaining allowance when the call is sent.
- **Keys work only after AddKey succeeds** (`on_key_added` callback). There is a global registry `public_key -> token_id`, so one key can belong to only one vault. This stops a vault from listing someone else's key (or the contract's full-access key) and getting it deleted in step 2 or by `remove_key`.
- **`agent_pay` denies with `vault_not_alive` in Warning too.** The agent is disarmed as soon as a beat is missed. Check order: `vault_not_alive`, `receiver_not_allowlisted`, `over_per_tx_max`, `over_daily_max`, `insufficient_balance`. If `policy` is omitted, everything is denied (all limits 0). Authorization failures (not an agent key of this vault) still panic.
- **Step 1 reserve** is 1.5 NEAR when a DAO is set (proposal bond + gas), otherwise 0.1 NEAR. This replaces "0.05 + bounty", since the bounty is already paid at `poke`. Whatever is left is claimable by the NFT owner after Settled. The `step_1` log `detail` is `"<account> <amount> NEAR, ..."` (the dashboard parses it).
- **Failed outgoing transfers** (heir, agent, bounty, claim) go back into the vault balance through a callback.
- **`execute_step`** returns the new `step`. Steps 3 and 4 return it through their callback. Step 3 has an in-flight guard: calling it again while a signature is pending does nothing and returns 3. A request still pending after 10 min is marked `failed` and settlement moves on. With no foreign payouts, step 3 goes straight to 4. The keeper should attach **300 TGas** to every `execute_step`.
- **Step 4** creates a Sputnik v2 `FunctionCall` proposal (text/`Vote` proposals are not valid in v2): `mark_broadcast({token_id, index: 0, tx_hash: "dao-ratified"})` on this contract, 1 NEAR bond, 100 TGas. The proposal id is stored. If the call fails, settlement continues and the 1 NEAR bond is **not** credited back to the vault: `dao_id` is any account the owner names, and a contract can keep the deposit while making the callback see a failure, so a re-credit would pay the bond twice out of other vaults' NEAR (finding C-2, `docs/SECURITY_REVIEW_3.md`; fixed Nov 10 2026). A bond that NEAR does refund lands in the contract's free balance, as a bond refunded by Sputnik does (M-4). `mark_broadcast` with `tx_hash == "dao-ratified"` is accepted only from the vault's `dao_id` and only logs `dao_ratified`.
- **`mark_broadcast`** otherwise requires `status == "signed"`, so a recorded hash cannot be overwritten. v2: only an operator may call it (v1: permissionless), and `tx_hash` must equal the id of the stored `signed_tx` (EVM `0x`+keccak256(raw), Solana base58 of the first signature). Re-reporting the same hash is a no-op. "broadcast" means relayed, not confirmed.
- **Security review changes (2026-11-07, docs/SECURITY_REVIEW.md):**
  - **EVM nonce is set by the contract.** Base payout `i` uses nonce = the number of Base payouts before it. `args.evm.nonce` is ignored.
  - **EVM fee and gas caps.** `gas_limit` must be 21000..=100000 (callers may send 21000; the contract raises the EVM gas it signs with to the 50,000 floor, final audit H-5), `max_fee_per_gas` 1..=100 gwei on Base and 1..=1000 gwei on Monad (per-chain cap, published in `get_config().chains[].max_fee_per_gas`), and `max_priority_fee_per_gas` ≤ `max_fee_per_gas`.
  - **`resign_foreign` rules:**
    - One re-sign per payout in flight (a request counts as lost after 10 min).
    - EVM `signed`/`broadcast`: both fees must be ≥ 110% of the last request.
    - EVM `broadcast`: also only ≥ 5 min after the last request.
    - Solana: always ≥ 5 min after the last request. `signed`/`broadcast` Solana payouts may only be re-signed by the contract `owner_id` or the keeper set with `set_keeper({account_id})`, after checking that the old signature never landed.
    - **v2:** every re-sign (all chains, all statuses) is operator-only and waits ≥ 5 min after the last request; an EVM re-sign goes through the derived-key lookup and the ecrecover check like step 3.
    - The view `get_sign_track({token_id, index})` shows the last request time, the last fees and `resign_allowed_after_ms`.
  - **Keys follow the NFT owner.** Changing the Will NFT owner while Alive/Warning revokes every pulse and agent key (v2: only while Alive, and the whole vault is reset, §2.9). A key whose AddKey lands after an owner change is deleted.
  - **Key auth checks the signer account.** Key auth also requires `signer_account_id == contract`.
  - **No `agent_pay` to the contract.** `agent_pay` panics if `receiver_id` is the contract itself.
- **Limits:** ≤ 10 heirs, ≤ 5 keys per kind, ≤ 4 foreign payouts in total, of which at most 1 on Monad (review 2, H-4; the per-chain cap is `get_config().chains[].max_payouts`), ≤ 10 allowlist entries, interval 10 s..10 y, `grace_missed` ≤ 1000. The log keeps the last 40 entries (v2: 40 routine entries plus 40 key events in a separate ring, `vault_created` pinned).
- **Defaults:** bounty 0.01 NEAR; storage fee 0.1 NEAR flat. `set_dao({token_id, dao_id: null})` clears the DAO. `set_foreign_payouts({token_id, payouts})` forces `status: "pending"`.
- **NFT:** approvals (NEP-178) are not supported (`approval_id` must be null). `nft_transfer_call` reverts if the receiver returns `true`. `extra.heirs` is the heir count.
- **Extra views:** `get_config()`. `get_vaults({from_index, limit})` takes JSON numbers (limit ≤ 100).
- **Callbacks:** `on_key_added`, `on_transfer_done`, `on_dao_proposal`, `on_foreign_signed`, `nft_resolve_transfer` (all `#[private]`). `on_foreign_signed` returns the new step.
- **Build:** near-sdk 5.30 needs `--cfg near` for on-chain builds without cargo-near. `contracts/dmw/build.sh` handles it.

### 2.8 Guardian pause and chain registry (contracts agent, 2026-11-07)

Addresses docs/SECURITY_REVIEW.md M-1 (a dead pulse key triggers a live owner's vault).

- **`set_guardian({token_id, guardian_id: AccountId|null, max_pause_s: u64|null})`**: owner only, while not
  Triggered. `max_pause_s` is required with a guardian, range 10 s..90 days; the guardian cannot be the contract.
  Event/log `guardian_set` (detail `"<guardian> <s>s"` or `"cleared"`). Changing the guardian leaves a running pause alone.
- **`pause({token_id})` → new `trigger_at_ms`**: the guardian or the owner. Rejected with `no guardian set`,
  `unauthorized: not guardian or owner`, `vault_triggered` (stored Triggered/Settled), `deadline_passed`
  (the effective deadline is already reached, even if nobody poked yet), or `already_paused` (a pause was taken
  since the last heartbeat). Sets `paused_until_ms = now + max_pause_s`. Event/log `paused`, data
  `{token_id, by: "guardian"|"owner", account_id, paused_until_ms, trigger_at_ms, previous_trigger_at_ms}`,
  log detail `"<guardian|owner> <account> until <ms>"`.
- **One pause per heartbeat cycle.** Only a heartbeat (owner or pulse key) clears the pause and re-arms it. There is
  no `resume`. So without a heartbeat the deadline can move at most once, to `paused_at + max_pause_s`.
- **State derivation:** `trigger_at_ms = max(last_beat + interval*(grace+1), paused_until_ms)`; `warning_at_ms` is not
  moved. While `now < paused_until_ms` the vault reads as `Warning`, even if it would otherwise be Alive, so
  `agent_pay` is denied with `vault_not_alive`. `poke` uses the extended deadline.
- **NFT transfer** while Live clears `guardian_id`/`max_pause_s` (like keys, the guardian belonged to the old owner);
  a running pause stays until the new owner's first heartbeat.
- **Storage compatibility:** the guard lives in a raw slot `guard:<token_id>` (borsh `{guardian_id, max_pause_s,
  paused_until_ms, paused_at_ms}`), not in the stored `Vault` bytes (`#[borsh(skip)]`, filled in on every read).
  Existing vaults read unchanged with no guardian.
- **`vault_created` log detail** is now the original owner account (the dashboard needs it after settlement).
  Vaults created before this change have an empty detail; the `vault_created` event data always had `owner_id`.

**Chain registry.** `ForeignChain` is `base | solana | monad` (Monad appended, so stored borsh discriminants are
unchanged). EVM chains share step 3: the registry gives each its chain id, path prefix and fee cap:

| chain | chain id | path | `max_fee_per_gas` cap |
| --- | --- | --- | --- |
| `base` | 84532 | `base-<id>-<salt>` (v1: `base-<id>`) | 100 gwei |
| `monad` | 10143 | `monad-<id>-<salt>` (v1: `monad-<id>`) | 1000 gwei (Monad's base fee floor is 100 gwei) |

- The EVM nonce of payout `i` = number of payouts **on the same chain** before it (each chain has its own derived address).
- `set_foreign_payouts` requires `0x` + 40 hex for every EVM chain. `mark_broadcast` lower-cases EVM hashes for both.
- `args.evm` is used for whichever EVM payout is current; `resign_foreign` applies the same rules to Monad as to Base.
- `get_config().chains` lists the registry (`chain`, `kind`, `chain_id`, `path`, `domain_id`, `rpc`, `explorer_tx`,
  `max_fee_per_gas`), plus `min_pause_s`/`max_pause_s`.
- Keeper side: `keeper/src/chains/evm.ts` `chainConfig(chain)` mirrors the registry (rpc, chainId, explorer,
  fee cap; `MONAD_RPC` env override). `derive.ts` derives from the view's `derivation_paths` (v1 fallback `monad-<id>`).

### 2.9 Contract v2 (security fixes, 2026-11-12)

Details, rationale and test names: [`docs/SECURITY_FIXES_V2.md`](docs/SECURITY_FIXES_V2.md). In short:

- **Init:** `new(owner_id, keeper_id?, mpc_signer?)` is `#[private]`; `scripts/near-admin.mjs deploy` sends DeployContract
  and `new` as one transaction.
- **Operators** (`is_operator`): the contract keeper, the vault keeper (`set_vault_keeper`), the vault owner and any heir;
  never the contract itself. Only operators may `mark_broadcast`, `resign_foreign`, and sign a step-3 payout during the
  first hour after it becomes current (`get_config().step3_open_after_ms`); after that anyone may, so settlement cannot stall.
- **Keeper rotation:** the current keeper may hand over with `set_keeper` (works on a locked contract; cannot clear there).
- **Will NFT transfer** only while Alive. A transfer while Live resets the vault for the new owner: `last_beat = now`, the
  new owner as sole heir, no foreign payouts, DAO, guardian, pause, spends or vault keeper, default policy and bounty, every
  pulse/agent key revoked with its unspent allowance refunded.
- **Bounty:** ≤ 1 NEAR (`create_vault`, `set_bounty`); `poke` pays at most 10% of the balance.
- **Deposits:** ≥ 0.01 NEAR from anyone but the owner.
- **Log:** routine events and key events in two rings of 40; `vault_created` pinned; `LogEntry.seq` orders the merged view.
- **Heartbeat:** owner path needs 1 yocto; a pulse-key beat cannot end a running pause. `unpause` for the owner.
- **Storage:** measured per call; the deposit is topped up from the vault balance (owner changes fail if the balance
  cannot cover them); excess released at step 5. `storage_bytes` / `storage_deposit` in the view.
- **Callbacks:** each requires exactly one promise result; anything else is a failure (never a credit).
- **Keys:** `remove_key`, a sale and step 2 refund each key's unspent allowance (estimate: (prepaid + 5 TGas) × 10⁸ yocto
  per call, less 0.01 NEAR).
- **Agent window:** rolling 24 h over `spends` (≤ 24 entries, merged conservatively).
- **Derivation:** salted per vault (§1); EVM signatures are ecrecovered against the derived key (§2.4).
- `get_config()` adds `mpc_signer`, `keeper`, `max_bounty`, `min_deposit`, `step3_open_after_ms`, `resign_cooldown_ms`.

## 3. Keeper: `keeper/` (TypeScript, Node 22, ESM)

Commands (`npm run <cmd>` or `npx dmw <cmd>`):

| cmd | does |
| --- | --- |
| `derive --token <id>` | prints derived Base, Monad and Solana source addresses for the vault (reads the vault's `derivation_paths`, then the MPC signer's `derived_public_key` view) |
| `pulse --token <id> --key <ed25519:...> [--interval 60]` | heartbeat daemon; prints a countdown; Ctrl-C = "death" |
| `keeper [--poll 5] [--once] [--token <id,id,...>]` | `--token` restricts the loop to those vaults (default: every vault; `pulse` takes a single `--token`). Loop: `get_vaults`, `poke` any vault past deadline, `execute_step` any Triggered vault (fetching nonce/fees from the payout chain's RPC, Base or Monad, and blockhash from Solana for step 3), relay any `signed` payout (eth_sendRawTransaction / sendTransaction), then `mark_broadcast`. Logs every action with explorer links |
| `agent-demo --token <id> --key <agent key>` | runs two `agent_pay` calls: one allowed (small, allowlisted) and one denied (over cap, unknown receiver); prints the on-chain log lines |
| `dao create --name estate-<id>` | creates a Sputnik v2 DAO on testnet with the owner as council and prints its id |

> Note (2026-11-09): `keeper` also takes `--owner-prefix <prefix>` (only vaults whose `owner_id` starts with it),
> `--until-idle` and `--max-seconds <n>` (a bounded sweep that exits when nothing matching is overdue or Triggered).
> `due --owner-prefix <prefix>` is the read-only pre-check. With `DMW_NOTIFY_WEBHOOK` set, the loop posts one JSON
> message when a vault turns Warning and one when it is Triggered. `.github/workflows/keeper.yml` runs the sweep for
> `dmw-guest-` vaults every ten minutes. Details in `keeper/README.md`.

Config via `.env` (`.env.example` committed): `NEAR_NETWORK`, `DMW_CONTRACT`, `KEEPER_ACCOUNT_ID`, `KEEPER_PRIVATE_KEY`, `BASE_RPC`, `MONAD_RPC`, `SOLANA_RPC`.
Solana blockhashes expire in ~60–90 s; the keeper fetches a fresh one right before `execute_step`. It never retries at once: if the payout comes out `failed`, or its signed tx goes stale before it is relayed, the keeper waits until `get_sign_track().resign_allowed_after_ms` (5 min after the last request) and then calls `resign_foreign` with a new blockhash. For a stale signed tx it first checks that the old signature never landed; if that lookup fails it waits and looks again instead of signing. After 2 re-signs of one payout it pauses that payout for 5 min.

## 4. Dashboard: `dashboard/` (Vite + React + TypeScript, wallet-selector with MyNearWallet + Meteor)

Routes:
- `/` — connect wallet; list my vaults; "Create vault" wizard (interval, grace, heirs with bps, policy, foreign payouts with derived addresses shown + faucet links, optional DAO)
- `/vault/:id` — live Will NFT image (poll every 3 s), state ribbon, countdown, **Heartbeat** button, **Kill (stop daemon)** instructions, agent panel (policy, allow/deny log from events), keys panel (add pulse/agent key: generates keypair in browser, calls `add_*_key`, shows the key for the daemon), settlement timeline (5 steps with explorer links: nearblocks.io/testnet, sepolia.basescan.org, explorer.solana.com?cluster=devnet, Sputnik UI), `claim` button when Settled and I'm the NFT owner
- `/heir` — "Got an email?" — sign in (wallet or NEAR Auth if feasible), shows vaults where I'm an heir and what arrived

Design: dark, calm, one accent; large type (recorded at 125%). No marketing copy in the app.

> Note (2026-11-09): added since v1, no contract change.
> - The create wizard has its own route, `/create`; `/` lists vaults and links to it. `/pulse` is the standalone phone
>   page: paired from the vault page by QR code or link, it holds a pulse key in `localStorage` and sends `heartbeat`.
> - `/try`, the guest run: a throwaway `dmw-guest-<hex>.testnet` account from the testnet faucet, held in the browser,
>   drives a 30 s vault from `create_vault` to `claim` (see `dashboard/README.md`, "Guest run"). Heirs are implicit
>   accounts. The register folds unfinished guest vaults into their own group.
> - `/vault/:id` gains "The record" (the vault log as the Will NFT's history) and derives a missing `from_address`
>   in the browser. `/heir` leads with the wallet; Google sign-in shows only where NEAR Auth accepts the origin.
>
> Note (2026-11-12, contract v2): source addresses are derived from the view's `derivation_paths` and shown on the vault
> page (never the owner-typed `from_address`, never predicted on `/create`); the owner's Heartbeat attaches 1 yocto on a
> v2 contract; heirs whose account does not exist get a warning (`view_account`); Unpause for the owner; the broadcast
> relay button only for operators; Will NFT transfer only while Alive.

## 5. Site: `site/` (static, no build step to serve: `index.html` + `styles.css` + ES modules in `js/`, self-hosted fonts, no CDN, no Tailwind; the WebGL seal `js/seal3d.bundle.js` is three.js bundled by `design/seal3d/build.mjs`)

> The paragraph below is the original brief. The shipped page (v4) has: the hold-to-stop hero, a trust strip, the vault 5
> story, "run one yourself" (links to the dashboard's `/try`), the live estate graph of vault 1, the demo video, the quiz,
> a builders section, the heir claim band, the security model, the attorney section, the FAQ and a "follow mainnet" link
> to GitHub releases (there is no waitlist backend). `site/README.md` lists the modules.

Landing page per the mockup in the plan doc: hero "Your crypto shouldn't die with you.", vault card, trust strip,
three steps, heir claim band, FAQ, a "follow mainnet" link to GitHub releases (no waitlist backend exists), footer disclaimer
"Not a will. Not a custodian. Configure it with your estate attorney."

## 6. Repo conventions

- Directories are owned: `contracts/` (contract agents), `keeper/`, `dashboard/`, `site/`. Don't edit outside your directory except `SPEC.md` (with a note) and your own entry in `README.md`.
- Conventional commits. No secrets ever; `gitleaks` in CI.
- `make build | test | deploy | demo | kill` at repo root (`Makefile`), each printing what to expect.
- Everything must run from a clean clone on Linux/macOS with Rust, Node 22, openssl and curl. `near-cli-rs` is optional (`scripts/check.sh` lists it as nice-to-have); account creation, calls and views go through `scripts/near-admin.mjs` (near-api-js) and `contracts/tools/tx.mjs`.
