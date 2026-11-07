#!/usr/bin/env node
// Minimal NEAR testnet admin tool (no near-cli needed). Uses keeper/node_modules/near-api-js.
//   node scripts/near-admin.mjs create <name>.testnet            -> creates via faucet, saves key to keys/<name>.json
//   node scripts/near-admin.mjs deploy <acct> <wasm> [initJson]   -> deploys + calls new(initJson) if given
//   node scripts/near-admin.mjs call <signer> <contract> <method> '<json>' [gasTgas] [deposit: NEAR, or 1y = 1 yocto]
//   node scripts/near-admin.mjs view <contract> <method> '<json>'
//   node scripts/near-admin.mjs call-with-key <signerAcct> <ed25519:key> <contract> <method> '<json>' [gasTgas]
//   node scripts/near-admin.mjs send <from> <to> <near>
//   node scripts/near-admin.mjs keys <acct>
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../keeper/package.json'));
const near = require('near-api-js');
const { KeyPair, KeyPairSigner, Account } = near; const { JsonRpcProvider } = near.providers;
const RPC = process.env.NEAR_RPC || 'https://rpc.testnet.fastnear.com';
const KEYS = join(here, '..', 'keys');
const provider = new JsonRpcProvider({ url: RPC });
const NEAR = 10n ** 24n;
const toYocto = (n) => BigInt(Math.round(Number(n) * 1e6)) * (NEAR / 1_000_000n);
// Deposit: NEAR as a decimal ("0.5") or yoctoNEAR with a `y` suffix ("1y": the 1 yocto that owner
// methods and `pause` require, SPEC §2.3).
const toDeposit = (d) => (/^\d+y$/.test(d) ? BigInt(d.slice(0, -1)) : toYocto(d));
const tgas = (n) => BigInt(n) * 10n ** 12n;

function loadKey(acct) {
  const p = join(KEYS, `${acct}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).private_key;
  const legacy = join(process.env.HOME, '.near-credentials', 'testnet', `${acct}.json`);
  if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, 'utf8')).private_key;
  throw new Error(`no key for ${acct} in keys/ or ~/.near-credentials/testnet`);
}
function account(acct, key = loadKey(acct)) {
  return new Account(acct, provider, new KeyPairSigner(KeyPair.fromString(key)));
}
async function create(name) {
  const kp = KeyPair.fromRandom('ed25519');
  const res = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: name, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`faucet ${res.status}: ${txt}`);
  // Full-access keys: owner-only directory and file (0700 / 0600), never the umask default (AUDIT_FINAL_OFFCHAIN F-01).
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  chmodSync(KEYS, 0o700);
  const file = join(KEYS, `${name}.json`);
  writeFileSync(file, JSON.stringify({ account_id: name, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`created ${name}  key saved to keys/${name}.json`);
}
const show = (r) => {
  const h = r?.transaction?.hash; if (h) console.log(`tx https://testnet.nearblocks.io/txns/${h}`);
  const st = r?.status; if (st && 'Failure' in st) { console.error(JSON.stringify(st.Failure)); process.exitCode = 1; }
  const logs = (r?.receipts_outcome || []).flatMap((o) => o.outcome.logs); for (const l of logs) console.log('  log:', l);
  try { const v = st?.SuccessValue; if (v) console.log('  result:', Buffer.from(v, 'base64').toString()); } catch {}
};
const [cmd, ...a] = process.argv.slice(2);
try {
  if (cmd === 'create') await create(a[0]);
  else if (cmd === 'deploy') {
    const acc = account(a[0]);
    const r = await acc.deployContract(readFileSync(a[1]));
    show(r);
    if (a[2]) show(await acc.callFunctionRaw({ contractId: a[0], methodName: 'new', args: JSON.parse(a[2]), gas: tgas(100) }));
  } else if (cmd === 'call') {
    const acc = account(a[0]);
    show(await acc.callFunctionRaw({ contractId: a[1], methodName: a[2], args: JSON.parse(a[3] || '{}'), gas: tgas(a[4] || 100), deposit: a[5] ? toDeposit(a[5]) : 0n }));
  } else if (cmd === 'call-with-key') {
    const acc = account(a[0], a[1]);
    show(await acc.callFunctionRaw({ contractId: a[2], methodName: a[3], args: JSON.parse(a[4] || '{}'), gas: tgas(a[5] || 100) }));
  } else if (cmd === 'view') {
    const r = await provider.callFunction(a[0], a[1], JSON.parse(a[2] || '{}'));
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'send') {
    show(await account(a[0]).transfer({ receiverId: a[1], amount: toYocto(a[2]) }));
  } else if (cmd === 'keys') {
    console.log(JSON.stringify(await provider.viewAccessKeyList(a[0]), null, 2));
  } else if (cmd === 'genkey') {
    const kp = KeyPair.fromRandom('ed25519'); console.log(JSON.stringify({ public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
  } else { console.error('unknown command'); process.exit(2); }
} catch (e) { console.error(e.message || e); process.exit(1); }
