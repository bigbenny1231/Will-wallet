import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { transactions } from "near-api-js";
import "@near-wallet-selector/modal-ui/styles.css";
import { CONTRACT, MOCK, NETWORK } from "../config";
import type { CallArgs } from "../types";
import { MOCK_ACCOUNT, mockApi } from "./mock";

// Display-only override for screenshots/tests (VITE_DEBUG_ACCOUNT=<account>); no wallet is attached, so calls still fail.
const DEBUG_ACCOUNT: string = import.meta.env.VITE_DEBUG_ACCOUNT || "";
const GAS_DEFAULT = "100000000000000"; // 100 TGas

interface WalletCtx {
  ready: boolean;
  accountId: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  /** Sends one or more function calls to the DMW contract. Redirect wallets (MyNearWallet) navigate away and never resolve. */
  call: (calls: CallArgs | CallArgs[]) => Promise<unknown>;
}

const Ctx = createContext<WalletCtx | null>(null);

export function useWallet(): WalletCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("WalletProvider missing");
  return v;
}

function toTx(c: CallArgs) {
  return {
    receiverId: CONTRACT,
    actions: [transactions.functionCall(c.method, c.args, BigInt(c.gas ?? GAS_DEFAULT), BigInt(c.deposit ?? "0"))],
  };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(MOCK ? MOCK_ACCOUNT : DEBUG_ACCOUNT || null);
  const selectorRef = useRef<WalletSelector | null>(null);
  const modalRef = useRef<WalletSelectorModal | null>(null);

  useEffect(() => {
    if (MOCK || DEBUG_ACCOUNT) {
      setReady(true);
      return;
    }
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;
    (async () => {
      const selector = await setupWalletSelector({
        network: NETWORK,
        modules: [setupMyNearWallet(), setupMeteorWallet()],
      });
      if (cancelled) return;
      selectorRef.current = selector;
      modalRef.current = setupModal(selector, { contractId: CONTRACT, theme: "dark" });
      const pick = (s: ReturnType<WalletSelector["store"]["getState"]>) => s.accounts.find((a) => a.active)?.accountId ?? s.accounts[0]?.accountId ?? null;
      setAccountId(pick(selector.store.getState()));
      sub = selector.store.observable.subscribe((s) => setAccountId(pick(s)));
      setReady(true);
    })().catch((e) => {
      console.error("wallet selector init failed", e);
      setReady(true);
    });
    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  const connect = useCallback(() => modalRef.current?.show(), []);

  const disconnect = useCallback(async () => {
    if (MOCK) return;
    const sel = selectorRef.current;
    if (!sel) return;
    const w = await sel.wallet();
    await w.signOut();
    setAccountId(null);
  }, []);

  const call = useCallback(
    async (calls: CallArgs | CallArgs[]) => {
      const list = Array.isArray(calls) ? calls : [calls];
      if (MOCK) {
        for (const c of list) await mockApi.call(accountId ?? MOCK_ACCOUNT, c);
        return undefined;
      }
      const sel = selectorRef.current;
      if (!sel || !accountId) throw new Error("Connect a wallet first");
      const wallet = await sel.wallet();
      if (list.length === 1) return wallet.signAndSendTransaction(toTx(list[0]));
      return wallet.signAndSendTransactions({ transactions: list.map(toTx) });
    },
    [accountId],
  );

  const value = useMemo(() => ({ ready, accountId, connect, disconnect, call }), [ready, accountId, connect, disconnect, call]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
