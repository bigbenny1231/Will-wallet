// Sends heartbeats from the phone. Signer = the Lastword contract account + the pulse key (a function-call access key
// scoped to `heartbeat`, 1 NEAR allowance). 10 TGas per beat: the allowance is charged for prepaid gas.
import { Account, KeyPair, KeyPairSigner, providers } from "near-api-js";
import { MOCK, RPC } from "../config";
import { GAS, heartbeatCall } from "./calls";
import { mockApi } from "./mock";
import type { Pairing } from "./pairing";
import type { VaultView } from "../types";

const provider = new providers.JsonRpcProvider({ url: RPC });

export interface Beater {
  publicKey: string;
  beat: () => Promise<string | null>;
  view: () => Promise<VaultView | null>;
}

export function makeBeater(p: Pairing): Beater {
  const kp = KeyPair.fromString(p.secret as `ed25519:${string}`);
  const publicKey = kp.getPublicKey().toString();
  if (MOCK) {
    return {
      publicKey,
      beat: async () => {
        await new Promise((r) => setTimeout(r, 450));
        await mockApi.call("pulse-key", heartbeatCall(p.token));
        return null;
      },
      view: () => mockApi.getVault(p.token),
    };
  }
  const account = new Account(p.contract, provider, new KeyPairSigner(kp));
  return {
    publicKey,
    async beat() {
      const c = heartbeatCall(p.token);
      const out = await account.callFunctionRaw({
        contractId: p.contract,
        methodName: c.method,
        args: c.args,
        gas: BigInt(GAS.heartbeat),
        deposit: 0n,
        waitUntil: "INCLUDED",
      });
      return out?.transaction?.hash ?? null;
    },
    async view() {
      const v = (await provider.callFunction(p.contract, "get_vault", { token_id: p.token })) as VaultView | null;
      return v ?? null;
    },
  };
}

/** Human sentence for the common failures of a pulse-key heartbeat. */
export function beatError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/does not exist while viewing|AccessKeyDoesNotExist|access key .* (does not|doesn't) exist/i.test(m)) return "This key is not registered on the contract. It may have been removed or settlement deleted it.";
  if (/NotEnoughAllowance|allowance/i.test(m)) return "The key's gas allowance is spent. Pair a new phone from the vault page.";
  if (/vault_triggered|Triggered|already_triggered/i.test(m)) return "The vault is triggered. Heartbeats are no longer accepted.";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "No connection to the NEAR node. Retrying.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}
