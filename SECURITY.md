# Security

Testnet reference implementation. Not audited. Not a will. Do not hold real funds.

## Reporting a vulnerability

- Open an issue at https://github.com/bigbenny1231/will-wallet/issues with a description and, if you can, a
  reproduction (testnet tx links help). For anything that could put funds at risk, open an issue that only asks for
  a private channel, and leave out the details.
- Email is not available yet: the `deadmanswallet.dev` domain is not registered, so `security@deadmanswallet.dev`
  does not receive mail.

Please give us a reasonable chance to fix it before public disclosure.

## Scope and known trust assumptions

- The contract account's full-access key (held by the deployer) can redeploy the code. That is a testnet
  trust assumption; see `docs/SECURITY_REVIEW.md` item I-1 and the security table in the README.
- All keys in this repository and its CI are testnet-only and are rotated after demos.
- This source is contract v3 (the review v3 fixes, `docs/SECURITY_FIXES_V3.md`). v3 changes the state layout, so it
  deploys to a new account with no full-access key. Before it, v2 (`docs/SECURITY_FIXES_V2.md`) went live on
  `dmw-885364.testnet` on Nov 12 2026 with no full-access key (`docs/LIVE_CONTRACT.md`), and v1 on `dmw-979268.testnet`.
- **Keeper.** On a locked contract the contract keeper is a trusted operator for every vault: it may sign and
  re-sign foreign payouts with any fees within the chain caps, and re-sign a signed Solana payout (no nonce, so each
  re-sign can be a second payment) at most 3 times per payout per keeper epoch. A compromised keeper is removed by
  the optional **keeper admin** set in `new`: it can only propose a new keeper, a new MPC signer or a new admin, each
  taking effect 48 h later through `execute_admin_proposal` (anyone may run it). The admin is never an operator or a
  keeper and cannot move funds; a compromised admin can at most install its own keeper after 48 h in public view
  (events `admin_proposal`), which the existing keeper cannot veto. Keep the admin key offline and separate from the
  keeper key. Without an admin, a compromised keeper can only be replaced by itself.
- A new MPC signer with a different root key derives different foreign addresses: `propose_mpc_signer` is meant for
  a migration of the same signer, not for moving funds held at the old addresses.
