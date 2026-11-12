# Security

Dead Man's Wallet runs on NEAR testnet. It is not a will. Do not send it real funds.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a
vulnerability**. The report stays private between you and the maintainers. A description and, if you can, a
reproduction (testnet transaction links help) are enough.

Please give us a reasonable chance to fix it before public disclosure.

## Reviews

The code was reviewed in several passes, each by a reviewer that had not written it. Every Critical and High finding
was fixed, and each contract fix has a regression test named after its finding. The passes, what they found and what
was fixed are listed in the README ([Security model](README.md#security-model)). There has been no third-party audit.

## Scope and trust

- This source is contract v3 (the review v3 fixes, `docs/SECURITY_FIXES_V3.md`). The live contract runs it, and its
  account has no full-access key, so nobody, the author included, can change its code or move a vault's funds outside
  the contract's rules; the deploy and lock transactions are in `docs/LIVE_CONTRACT.md`. Earlier contracts are listed
  in `docs/history/`.
- No private key is committed. The workflows' accounts are testnet accounts. The hosted keeper's key is derived on the
  runner from the repository secret `KEEPER_SEED`, is never committed, and is masked in the workflow's logs.
- **Keeper.** On a locked contract the contract keeper is a trusted operator for every vault: it may sign and
  re-sign foreign payouts with any fees within the chain caps, and re-sign a signed Solana payout (no nonce, so each
  re-sign can be a second payment) at most 3 times per payout per keeper epoch. A compromised keeper is removed by
  the **keeper admin** set in `new`: it can only propose a new keeper, a new MPC signer or a new admin, each taking
  effect 48 h later through `execute_admin_proposal` (anyone may run it). The admin is never an operator or a keeper
  and cannot move funds; a compromised admin can at most install its own keeper after 48 h in public view (events
  `admin_proposal`), which the existing keeper cannot veto. The admin's key comes from a second secret,
  `KEEPER_ADMIN_SEED`, that only the deploy and the admin task of the `testnet` workflow read; the scheduled keeper
  never sees it.
- A new MPC signer with a different root key derives different foreign addresses: `propose_mpc_signer` is meant for
  a migration of the same signer, not for moving funds held at the old addresses.
