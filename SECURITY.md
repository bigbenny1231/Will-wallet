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

- The live contract runs contract v2, this source (`docs/SECURITY_FIXES_V2.md`). Its account has no full-access key,
  so nobody, the author included, can change its code or move a vault's funds outside the contract's rules; the lock
  transaction is in `docs/LIVE_CONTRACT.md`.
- No private key is committed. The workflows' accounts are testnet accounts; the hosted keeper's key is derived on the
  runner from the repository secret `KEEPER_SEED`, is never committed, and is masked in the workflow's logs.
