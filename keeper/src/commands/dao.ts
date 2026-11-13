import pc from 'picocolors';
import { GAS, makeAccount, makeProvider, toTxResult } from '../backend.js';
import type { Config } from '../config.js';
import { errMsg, nearTxLink } from '../util.js';

export const FACTORY = 'sputnik-v2.testnet';
export const DAO_DEPOSIT = 6n * 10n ** 24n;

export function daoArgs(name: string, owner: string, purpose: string) {
  const inner = { config: { name, purpose, metadata: '' }, policy: [owner] };
  return { name, args: Buffer.from(JSON.stringify(inner)).toString('base64') };
}

export function validDaoName(n: string): boolean {
  return /^[a-z0-9]+([-_][a-z0-9]+)*$/.test(n) && n.length >= 2 && n.length <= 40;
}

/** Exact near-cli-rs command a human can paste if our call fails. */
export function nearCliCommand(name: string, owner: string, purpose: string): string {
  const json = JSON.stringify(daoArgs(name, owner, purpose));
  return `near contract call-function as-transaction ${FACTORY} create json-args '${json}' prepaid-gas '150.0 Tgas' attached-deposit '6 NEAR' sign-as ${owner} network-config testnet sign-with-keychain send`;
}

export async function daoCreate(
  cfg: Config,
  o: { name: string; owner?: string; account?: string; key?: string; purpose?: string },
): Promise<{ ok: boolean; daoId: string; hint?: string }> {
  const daoId = `${o.name}.${FACTORY}`;
  const accountId = o.account || cfg.keeperAccountId;
  const owner = o.owner || accountId || 'OWNER.testnet';
  const purpose = o.purpose || "Estate settlement proposals from Lastword";
  const manual = nearCliCommand(o.name, owner, purpose);

  if (!validDaoName(o.name)) return { ok: false, daoId, hint: `invalid DAO name "${o.name}" (lowercase letters, digits, - and _)` };
  if (cfg.mock) {
    console.log(pc.dim('(mock) skipping factory call'));
    return { ok: true, daoId };
  }
  try {
    const key = o.key || cfg.keeperPrivateKey;
    if (!accountId || !key) throw new Error('no signing account: set KEEPER_ACCOUNT_ID/KEEPER_PRIVATE_KEY or pass --account/--key');
    const provider = makeProvider(cfg.rpcUrl);
    const account = makeAccount(provider, accountId, key);
    const outcome = await account.callFunctionRaw({
      contractId: FACTORY,
      methodName: 'create',
      args: daoArgs(o.name, owner, purpose),
      gas: GAS.daoCreate,
      deposit: DAO_DEPOSIT,
      waitUntil: 'EXECUTED',
    });
    const tx = toTxResult(outcome);
    console.log(`create tx  ${nearTxLink(tx.hash)}`);
    if (tx.failure) throw new Error(`factory call failed: ${tx.failure}`);
    // The factory returns `true` on success; confirm the account really exists.
    if (tx.returnValue === false) throw new Error('factory returned false (name taken or deposit too low)');
    try {
      await provider.viewAccount(daoId);
    } catch {
      throw new Error(`factory call finished but ${daoId} does not exist`);
    }
    return { ok: true, daoId };
  } catch (e) {
    return { ok: false, daoId, hint: `${errMsg(e)}\n\nRun this yourself instead:\n  ${manual}` };
  }
}
