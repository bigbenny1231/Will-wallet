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
import { accountFor, guestAlias, loadGuest, saveGuest, sendAs, type GuestSession } from "./guest";

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
  /** Guest mode (lib/guest.ts): a throwaway testnet account held in this browser. Null when there is none. */
  guest: GuestSession | null;
  /** True when the active account is the guest account or one of its heirs (no wallet is connected). */
  isGuest: boolean;
  /** Which guest account signs: the owner, or the heir with this account id (to claim after settlement). */
  guestAs: string | null;
  setGuestAs: (accountId: string | null) => void;
  /** Stores a new or changed guest session; null forgets it. A function receives the latest session. */
  setGuest: (next: GuestSession | null | ((cur: GuestSession | null) => GuestSession | null)) => void;
  /** "Sarah", "Ben", "You" for accounts the guest session made; null otherwise. */
  alias: (accountId: string) => string | null;
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
  const [walletId, setAccountId] = useState<string | null>(MOCK ? MOCK_ACCOUNT : DEBUG_ACCOUNT || null);
  const [guest, setGuestState] = useState<GuestSession | null>(() => (MOCK ? null : loadGuest()));
  const [guestAs, setGuestAs] = useState<string | null>(null);
  const guestRef = useRef(guest);
  guestRef.current = guest;
  const setGuest = useCallback((next: GuestSession | null | ((cur: GuestSession | null) => GuestSession | null)) => {
    const value = typeof next === "function" ? next(guestRef.current) : next;
    guestRef.current = value;
    saveGuest(value);
    setGuestState(value);
    if (!value) setGuestAs(null);
  }, []);
  // A connected wallet always wins. Otherwise the guest account (or the guest heir chosen with setGuestAs) is active.
  const guestHeir = guest && guestAs ? (guest.heirs.find((h) => h.accountId === guestAs) ?? null) : null;
  const isGuest = !walletId && !!guest;
  const accountId = walletId ?? (guest ? (guestHeir?.accountId ?? guest.accountId) : null);
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
    if (MOCK) {
      setAccountId(null); // mock: lets the heir page show the Google sign-in
      return;
    }
    if (!walletId) {
      // Guest: the keys in this browser are the only way back into the account, so ask first.
      if (guestRef.current && confirm("Forget this guest account? Its keys are deleted from this browser. A vault it created stays on testnet.")) setGuest(null);
      return;
    }
    const sel = selectorRef.current;
    if (!sel) return;
    const w = await sel.wallet();
    await w.signOut();
    setAccountId(null);
  }, [walletId, setGuest]);

  const call = useCallback(
    async (calls: CallArgs | CallArgs[]) => {
      const list = Array.isArray(calls) ? calls : [calls];
      if (MOCK) {
        for (const c of list) await mockApi.call(accountId ?? MOCK_ACCOUNT, c);
        return undefined;
      }
      if (!walletId && guest) {
        // Guest: sign here with the throwaway key. One transaction per call, in order; the last outcome is returned.
        const signer = guestHeir ? accountFor(guestHeir.accountId, guestHeir.secret) : accountFor(guest.accountId, guest.secret);
        let last: unknown;
        for (const c of list) {
          const sent = await sendAs(signer, [c], { quick: c.method === "execute_step" });
          last = { transaction: { hash: sent.hash } };
          setGuest((cur) => (cur ? { ...cur, txs: [...cur.txs, { ms: Date.now(), label: c.method, hash: sent.hash }].slice(-60) } : cur));
        }
        return last;
      }
      const sel = selectorRef.current;
      if (!sel || !accountId) throw new Error("Connect a wallet first");
      const wallet = await sel.wallet();
      if (list.length === 1) return wallet.signAndSendTransaction(toTx(list[0]));
      return wallet.signAndSendTransactions({ transactions: list.map(toTx) });
    },
    [accountId, walletId, guest, guestHeir, setGuest],
  );

  const alias = useCallback((id: string) => (walletId ? null : guestAlias(guest, id)), [walletId, guest]);
  const value = useMemo(
    () => ({ ready, accountId, connect, disconnect, call, guest, isGuest, guestAs: guestHeir?.accountId ?? null, setGuestAs, setGuest, alias }),
    [ready, accountId, connect, disconnect, call, guest, isGuest, guestHeir, setGuest, alias],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
