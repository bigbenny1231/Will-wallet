#!/usr/bin/env node
// Like scripts/near-admin.mjs `call` / `call-with-key`, but prints the tx link,
// every receipt log and the final result (used by contracts/smoke.sh).
//   node contracts/tools/tx.mjs call <signer> <contract> <method> '<json>' [tgas] [deposit: NEAR, or 1y = 1 yocto]
//   node contracts/tools/tx.mjs call-with-key <signerAcct> <ed25519:secret> <contract> <method> '<json>' [tgas]
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../keeper/package.json'));
const { KeyPair, KeyPairSigner, Account, providers } = require('near-api-js');
const provider = new providers.JsonRpcProvider({ url: process.env.NEAR_RPC || 'https://rpc.testnet.near.org' });
const NEAR = 10n ** 24n;
const toYocto = (n) => BigInt(Math.round(Number(n) * 1e6)) * (NEAR / 1_000_000n);
// Deposit: NEAR as a decimal ("0.5") or yoctoNEAR with a `y` suffix ("1y": the 1 yocto that owner
// methods and `pause` require, SPEC §2.3).
const toDeposit = (d) => (/^\d+y$/.test(d) ? BigInt(d.slice(0, -1)) : toYocto(d));

function loadKey(acct) {
  for (const p of [join(here, '../../keys', `${acct}.json`), join(process.env.HOME, '.near-credentials/testnet', `${acct}.json`)]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).private_key;
  }
  throw new Error(`no key for ${acct}`);
}

const [cmd, ...a] = process.argv.slice(2);
let signer, key, contract, method, args, gas, deposit;
if (cmd === 'call') [signer, contract, method, args, gas, deposit] = a;
else if (cmd === 'call-with-key') [signer, key, contract, method, args, gas] = a;
else { console.error('usage: call | call-with-key'); process.exit(2); }

const acc = new Account(signer, provider, new KeyPairSigner(KeyPair.fromString(key || loadKey(signer))));
let r;
try {
  r = await acc.callFunctionRaw({
    contractId: contract, methodName: method, args: JSON.parse(args || '{}'),
    gas: BigInt(gas || 100) * 10n ** 12n, deposit: deposit ? toDeposit(deposit) : 0n,
  });
} catch (e) {
  // Errors before inclusion (e.g. access-key scope) have no tx; failures after inclusion carry one.
  const h = e?.context?.transactionHash || e?.transaction_outcome?.id;
  if (h) console.log(`tx https://testnet.nearblocks.io/txns/${h}`);
  console.log(`  error: ${(e.message || String(e)).slice(0, 400)}`);
  process.exit(1);
}
console.log(`tx https://testnet.nearblocks.io/txns/${r.transaction.hash}`);
for (const o of r.receipts_outcome) {
  for (const l of o.outcome.logs) console.log('  log:', l);
  const st = o.outcome.status;
  if (st && st.Failure) console.log('  receipt failure:', JSON.stringify(st.Failure).slice(0, 300));
}
const st = r.status;
if (st.Failure) { console.log('  FAILURE:', JSON.stringify(st.Failure).slice(0, 400)); process.exit(1); }
if (st.SuccessValue !== undefined) console.log('  result:', Buffer.from(st.SuccessValue, 'base64').toString() || '(empty)');
