#!/usr/bin/env node
// Minimal NEAR testnet admin tool (no near-cli needed). Uses keeper/node_modules/near-api-js.
//   node scripts/near-admin.mjs create <name>.testnet            -> creates via faucet, saves key to keys/<name>.json
//   node scripts/near-admin.mjs deploy <acct> <wasm> [initJson]   -> deploys, and with initJson calls new(initJson) in the
//                                                                    SAME transaction (dmw `new` is #[private]: nobody can
//                                                                    init the account between deploy and init)
//   node scripts/near-admin.mjs call <signer> <contract> <method> '<json>' [gasTgas] [deposit: NEAR, or 1y = 1 yocto]
//   node scripts/near-admin.mjs view <contract> <method> '<json>'
//   node scripts/near-admin.mjs call-with-key <signerAcct> <ed25519:key> <contract> <method> '<json>' [gasTgas]
//   node scripts/near-admin.mjs send <from> <to> <near>
//   node scripts/near-admin.mjs keys <acct>
//   node scripts/near-admin.mjs sub <parent> <prefix> [near]       -> creates <prefix>.<parent> funded by the parent (no faucet)
//   node scripts/near-admin.mjs fund <payer> <name>.testnet [near]  -> creates a top-level .testnet account paid by <payer>
//                                                                    through the `testnet` registrar (no faucet)
//   node scripts/near-admin.mjs lock <acct>                      -> deletes the account's own full-access key (irreversible)
//   node scripts/near-admin.mjs derive-keeper                    -> the long-lived keeper: derives its account id and
//                                                                    key from the KEEPER_SEED secret (env), saves the key
//                                                                    to keys/<id>.json, prints only the account id
//   node scripts/near-admin.mjs balance <acct>                   -> available NEAR (decimal), 0 if the account is missing
//   node scripts/near-admin.mjs sweep <acct> <beneficiary>       -> deletes <acct>, its whole balance goes to <beneficiary>
import { createRequire } from 'node:module';
import { hkdfSync, createPrivateKey, createPublicKey } from 'node:crypto';
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
// Base58 (Bitcoin alphabet), the encoding of NEAR ed25519 keys.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0')); let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}
// The long-lived keeper (v3). Its key is never stored anywhere but the KEEPER_SEED repository secret: every run derives
// the same ed25519 key and the same account id from it (HKDF-SHA256, domain-separated labels), so the key cannot be lost
// with a runner, nobody has to copy a private key around, and replacing the secret replaces the keeper.
function deriveKeeper() {
  const seed = process.env.KEEPER_SEED || '';
  if (seed.length < 32) throw new Error('derive-keeper: KEEPER_SEED must be set and at least 32 characters long');
  const ikm = Buffer.from(seed, 'utf8');
  const sk = Buffer.from(hkdfSync('sha256', ikm, 'dmw-keeper', 'ed25519 secret key v1', 32));
  const tag = Buffer.from(hkdfSync('sha256', ikm, 'dmw-keeper', 'account id v1', 4)).toString('hex');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sk]);
  const pub = Buffer.from(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x, 'base64url');
  const id = `dmw-keeper-${tag}.testnet`;
  return { id, public_key: `ed25519:${b58(pub)}`, private_key: `ed25519:${b58(Buffer.concat([sk, pub]))}` };
}
function saveKey(name, publicKey, privateKey) {
  // Full-access keys: owner-only directory and file (0700 / 0600), never the umask default (AUDIT_FINAL_OFFCHAIN F-01).
  mkdirSync(KEYS, { recursive: true, mode: 0o700 }); chmodSync(KEYS, 0o700);
  const file = join(KEYS, `${name}.json`);
  writeFileSync(file, JSON.stringify({ account_id: name, public_key: publicKey, private_key: privateKey }, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
async function create(name) {
  // A key already saved for this name (the derived keeper) is used as is; otherwise a fresh random key.
  const saved = join(KEYS, `${name}.json`);
  const kp = existsSync(saved) ? KeyPair.fromString(JSON.parse(readFileSync(saved, 'utf8')).private_key) : KeyPair.fromRandom('ed25519');
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
// DeployContract and the `new` call go out as two actions of one transaction (v2, finding G): either both land or
// neither does, and no third party can call `new` on freshly deployed code in between.
async function deploy(acct, wasm, initJson) {
  const { deployContract, functionCall } = near.transactions;
  const actions = [deployContract(readFileSync(wasm))];
  if (initJson) actions.push(functionCall("new", JSON.parse(initJson), tgas(100), 0n));
  show(await account(acct).signAndSendTransaction({ receiverId: acct, actions, throwOnFailure: false }));
}
const [cmd, ...a] = process.argv.slice(2);
try {
  if (cmd === 'create') await create(a[0]);
  else if (cmd === 'deploy') await deploy(a[0], a[1], a[2]); else if (cmd === 'call') {
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
  } else if (cmd === 'sub') {
    // Sub-account <prefix>.<parent>, paid for by the parent (no faucet call; the faucet allows about 10 accounts per
    // IP per 12 h). The new key is saved to keys/ like `create`.
    const [parent, prefix, amount] = a;
    const name = `${prefix}.${parent}`;
    const kp = KeyPair.fromRandom('ed25519');
    show(await account(parent).createSubAccount(name, kp.getPublicKey(), toYocto(amount || '1')));
    mkdirSync(KEYS, { recursive: true, mode: 0o700 }); chmodSync(KEYS, 0o700);
    const file = join(KEYS, `${name}.json`);
    writeFileSync(file, JSON.stringify({ account_id: name, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`created ${name} (${amount || 1} NEAR from ${parent})  key saved to keys/${name}.json`);
  } else if (cmd === 'fund') {
    // Top-level <name>.testnet paid for by an existing account, through the `testnet` registrar's create_account (the
    // same call near-cli's "fund-myself" makes). Keeps demo names unchanged while saving faucet calls. The registrar
    // returns false (and refunds) when the name is taken, so the key is saved only on a true result.
    const [payer, name, amount] = a;
    if (!/^[a-z0-9_-]+\.testnet$/.test(name || '')) throw new Error(`fund: ${name} is not a top-level .testnet name`);
    const kp = KeyPair.fromRandom('ed25519');
    const r = await account(payer).callFunctionRaw({ contractId: 'testnet', methodName: 'create_account', args: { new_account_id: name, new_public_key: kp.getPublicKey().toString() }, gas: tgas(100), deposit: toYocto(amount || '0.5') });
    show(r);
    let ok = false; try { ok = Buffer.from(r?.status?.SuccessValue || '', 'base64').toString() === 'true'; } catch {}
    if (!ok) throw new Error(`fund: the registrar did not create ${name}`);
    mkdirSync(KEYS, { recursive: true, mode: 0o700 }); chmodSync(KEYS, 0o700);
    const file = join(KEYS, `${name}.json`);
    writeFileSync(file, JSON.stringify({ account_id: name, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`created ${name} (${amount || 0.5} NEAR from ${payer})  key saved to keys/${name}.json`);
  } else if (cmd === 'lock') {
    // Delete the account's own full-access key (the one in keys/<acct>.json). Afterwards nobody can deploy new code to
    // the account or call owner-only methods as it; function-call keys stay. Irreversible: a fix means a fresh account.
    const acc = account(a[0]);
    const pub = KeyPair.fromString(loadKey(a[0])).getPublicKey().toString();
    show(await acc.deleteKey(pub));
    const left = await provider.viewAccessKeyList(a[0]);
    const full = left.keys.filter((k) => k.access_key.permission === 'FullAccess');
    console.log(`full-access keys left on ${a[0]}: ${full.length}`);
    if (full.length) process.exitCode = 1;
  } else if (cmd === 'keys') {
    console.log(JSON.stringify(await provider.viewAccessKeyList(a[0]), null, 2));
  } else if (cmd === 'derive-keeper') {
    const k = deriveKeeper();
    saveKey(k.id, k.public_key, k.private_key);
    console.log(k.id);
  } else if (cmd === 'balance') {
    // Available balance in NEAR (amount minus the storage stake), "0" when the account does not exist.
    let out = '0';
    try {
      const v = await provider.query({ request_type: 'view_account', finality: 'final', account_id: a[0] });
      const storage = BigInt(v.storage_usage) * 10n ** 19n;
      const avail = BigInt(v.amount) > storage ? BigInt(v.amount) - storage : 0n;
      out = (Number(avail / 10n ** 18n) / 1e6).toFixed(6);
    } catch (e) { if (!/does not exist|UNKNOWN_ACCOUNT/i.test(String(e?.message || e))) throw e; }
    console.log(out);
  } else if (cmd === 'sweep') {
    // Delete a throwaway account and send its whole balance to <beneficiary> (how the keeper is topped up from a fresh
    // faucet account). Refuses the beneficiary itself and anything that holds a contract.
    const [acct, to] = a;
    if (!acct || !to || acct === to) throw new Error('sweep <acct> <beneficiary>: two different accounts');
    const v = await provider.query({ request_type: 'view_account', finality: 'final', account_id: acct });
    if (v.code_hash && v.code_hash !== '11111111111111111111111111111111') throw new Error(`sweep: ${acct} holds a contract; refusing`);
    show(await account(acct).deleteAccount(to));
  } else if (cmd === 'genkey') {
    const kp = KeyPair.fromRandom('ed25519'); console.log(JSON.stringify({ public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
  } else { console.error('unknown command'); process.exit(2); }
} catch (e) { console.error(e.message || e); process.exit(1); }
