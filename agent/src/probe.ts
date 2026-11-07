#!/usr/bin/env node
// Protocol-level probe: tries three things the agent key must NOT be able to do, straight at the NEAR node.
// Not part of the agent (the wallet has no such methods); this is evidence for the README.
//   npm run probe -- --key <agent key> [--contract <id>] [--token <id>]
import { Account, KeyPair, KeyPairSigner, providers } from 'near-api-js';
import { parseArgs } from 'node:util';
import { errMsg } from './util.js';

const { values: a } = parseArgs({ options: { key: { type: 'string' }, contract: { type: 'string' }, token: { type: 'string' } } });
const key = a.key ?? process.env.DMW_AGENT_KEY;
const contract = a.contract ?? process.env.DMW_CONTRACT;
if (!key || !contract) throw new Error('need --key (or DMW_AGENT_KEY) and --contract (or DMW_CONTRACT)');
const provider = new providers.JsonRpcProvider({ url: process.env.NEAR_RPC || 'https://rpc.testnet.fastnear.com' });
const acct = new Account(contract, provider, new KeyPairSigner(KeyPair.fromString(key as `ed25519:${string}`)));

async function attempt(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`- ${label}: **ACCEPTED (unexpected!)**`);
    process.exitCode = 1;
  } catch (e) {
    const type = (e as { type?: string }).type;
    const m = errMsg(e).replace(/\s+/g, ' ');
    console.log(`- ${label}: **rejected by the node**${type ? ` \`${type}\`` : ''} (${m.slice(0, 150)})`);
  }
}

console.log(`Probing key ${KeyPair.fromString(key as `ed25519:${string}`).getPublicKey().toString()} on ${contract}\n`);
// 1 yocto on purpose: a bigger amount is refused earlier because it exceeds the key's gas allowance, which proves less.
await attempt('Transfer action (1 yoctoNEAR) from the vault contract account to stranger.testnet', () => acct.transfer({ receiverId: 'stranger.testnet', amount: 1n }));
await attempt('agent_pay with 1 yoctoNEAR attached deposit', () =>
  acct.callFunctionRaw({ contractId: contract, methodName: 'agent_pay', args: { token_id: a.token ?? '1', receiver_id: 'stranger.testnet', amount: '1' }, gas: 30n * 10n ** 12n, deposit: 1n }),
);
await attempt('call another method (heartbeat) on the same contract', () => acct.callFunctionRaw({ contractId: contract, methodName: 'heartbeat', args: { token_id: a.token ?? '1' }, gas: 10n * 10n ** 12n }));
await attempt('agent_pay-scoped key calling a different contract (testnet faucet account)', () =>
  acct.callFunctionRaw({ contractId: 'dmw-api-96af.testnet', methodName: 'agent_pay', args: {}, gas: 10n * 10n ** 12n }),
);
