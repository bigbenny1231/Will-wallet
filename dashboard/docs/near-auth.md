# Heir sign-in with Google through NEAR Auth

Researched and built 2026-11-07. Sources: https://docs.auth.near.org (Quickstart, Browser SDK, Authenticate users,
Resources/Testnet) and the published packages `@fast-auth-near/browser-sdk@1.4.2` and
`@fast-auth-near/javascript-provider@1.4.1`.

## What NEAR Auth is

NEAR Auth (formerly FastAuth) lets a user sign NEAR transactions with an existing login (Google, Apple, email,
passkeys). Login runs through an Auth0 tenant that NEAR Auth operates. The signing key is not stored anywhere. The NEAR
MPC network derives it from the login identity:

```
v1.signer-prod.testnet.derived_public_key({
  path: "jwt#https://login.testnet.fast-auth.com/#<auth0 sub>",
  predecessor: "fast-auth.testnet",
  domain_id: 1            // ed25519
})
```

This is exactly what `FastAuthSigner.getPublicKey()` in the browser SDK calls (`JavascriptProvider.getPath()` builds
the path from the ID token's `sub`). Transactions are signed by calling `fast-auth.testnet`, which checks the Auth0 JWT
(`jwt.fast-auth.testnet`, `auth0.jwt.fast-auth.testnet`) and asks the MPC network to sign.

Testnet values (docs, Resources/Testnet): Auth0 domain `login.testnet.fast-auth.com`, shared client id
`np8paqIpMWmNbzT4xAvOOapZBjsOpptl` (development only), contracts `fast-auth.testnet` and `v1.signer-prod.testnet`.
Mainnet needs approved Auth0 credentials (apply at docs.auth.near.org/home/apply).

## Answers to the three questions

1. **The SDK.** `@fast-auth-near/browser-sdk` (`FastAuthClient`, `FastAuthSigner`) plus
   `@fast-auth-near/javascript-provider` (`JavascriptProvider`, wraps `@auth0/auth0-spa-js`). Both depend on
   `near-api-js@^5` and pull in `react-native-auth0`; this dashboard uses `near-api-js@6`. We do not install them.
   For sign-in we only need the Auth0 login and one view call, so the dashboard uses `@auth0/auth0-spa-js` directly
   and reproduces `getPath()` and `getPublicKey()` in `src/lib/nearAuth.ts` (about 30 lines).
2. **Testnet support.** Yes. Checked by hand: the Google connection (`google-oauth2`) is enabled on the testnet
   tenant, `derived_public_key` answers on `v1.signer-prod.testnet`, and the token endpoint sends CORS headers.
3. **A NEAR account for a Google identity, in a browser, without a wallet.** Yes, with a caveat about which account.
   The docs and SDK return a public key, not an account id. `FastAuthSigner.createAccount(accountId)` only builds a
   `create_account` call that someone has to submit and pay for. But the derived key is ed25519, so it controls exactly
   one **implicit account**: the hex of the key's 32 bytes. That id is deterministic, needs nothing on chain, and NEAR
   sent to it (settlement step 1) creates it. So a Google identity resolves to a NEAR account id with no wallet, no
   relayer and no transaction. If the user has also created a named account with this key (for example through a
   NEAR Auth app), the dashboard asks nearblocks (`/v3/keys/<key>`, best effort, rate limited) and searches those too.

## The limit that decides where it works

The shared testnet Auth0 client accepts exactly one callback URL: `http://localhost:3000`. Checked by sending
`/authorize` requests with other `redirect_uri` values: `http://localhost:5173`, `http://localhost:3000/heir`,
`http://127.0.0.1:3000`, `https://localhost:3000`, the Vercel deployment and `https://example.com` all return
"Callback URL mismatch". So:

- `npm run dev:auth` (Vite on port 3000): **Continue with Google works.** Verified with Playwright on 2026-11-07: the
  button opens the NEAR Auth popup, which goes on to Google's sign-in page (`shots/v3-heir-nearauth-google-popup.png`).
  We did not finish a Google login in the sandbox (no Google account there), so the last step, reading the `sub` and
  deriving the key, is checked against the same code path with a known `sub` (see the test and the RPC call above)
  and end to end in mock mode (`shots/v3-heir-google.png`).
- Any other origin, including the public deployment: there is no Google button; the page says that sign-in with
  Google works from a local copy and waits for production credentials. Turning it on needs our own Auth0 client from NEAR Auth with the deployment's
  URL registered, then `VITE_NEAR_AUTH_CLIENT_ID` and `VITE_NEAR_AUTH_ORIGINS`.

## What the heir page does

1. "Continue with Google" opens an Auth0 popup on `login.testnet.fast-auth.com` with `connection=google-oauth2`.
2. It reads `sub` (and `email`) from the ID token.
3. It calls `derived_public_key` with the path above and turns the key into the implicit account id.
4. It lists vaults whose heirs include that account (or a named account found for the key), with the usual bequest view.
5. It shows the account id with Copy, so the heir can give it to the person naming them.

## What it does not do yet

- **Claim or sign as the heir.** Heirs receive NEAR automatically at step 1; nothing needs signing to inherit. If the
  heir becomes the Will NFT owner and wants to `claim` the remainder, they need to sign. That is the full FastAuth
  flow (`requestTransactionSignature` then `sendTransaction`), and it needs the account to exist and hold gas.
- **Naming an heir by email.** The owner still types a NEAR account id in the create wizard. An "add heir by Google
  account" helper is impossible without the heir's `sub`, which only the heir's own login reveals; the heir has to
  sign in once and pass the id on.

## Honest one-liner for the README

"Heirs can sign in with Google through NEAR Auth on testnet (shared credentials, `localhost:3000` only). The Google
identity resolves to the NEAR implicit account its MPC key controls, and the page lists what was left to it. On the
public site there is no Google button until we have production credentials; the page says so."
