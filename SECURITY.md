# Security

Testnet reference implementation. Not audited. Not a will. Do not hold real funds.

## Reporting a vulnerability

- Email **security@deadmanswallet.dev** with a description and, if you can, a reproduction (testnet tx links help).
- Or open an issue at https://github.com/agarretson/deadmans-wallet/issues. For anything that could put funds
  at risk, open an issue that only asks for a private channel, and leave out the details.

Please give us a reasonable chance to fix it before public disclosure.

## Scope and known trust assumptions

- The contract account's full-access key (held by the deployer) can redeploy the code. That is a testnet
  trust assumption; see `docs/SECURITY_REVIEW.md` item I-1 and the security table in the README.
- All keys in this repository and its CI are testnet-only and are rotated after demos.
