import { useEffect } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { CONTRACT, MOCK, NETWORK, links } from "./config";
import { useWallet } from "./lib/wallet";
import Home from "./pages/Home";
import Vault from "./pages/Vault";
import Create from "./pages/Create";
import Heir from "./pages/Heir";
import PendingCreate from "./components/PendingCreate";
import Pulse from "./pages/Pulse";
import Try from "./pages/Try";
import { guestAvailable } from "./lib/guest";
import ContractNotice from "./components/ContractNotice";

function Mark() {
  // The mark (design/logo.svg): brass ring, one heartbeat in life green, the flat line in the text colour.
  return (
    <svg width="24" height="24" viewBox="0 0 32 32" aria-hidden className="shrink-0 overflow-visible" style={{ marginTop: "-0.1em" }}>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="14" cy="16" r="12.5" stroke="var(--accent)" strokeWidth="2" />
        <circle cx="14" cy="16" r="9.6" stroke="var(--accent)" strokeWidth=".9" />
        <path d="M6 17.5h3.6l1.8-8 2.4 14 1.8-9 1.4 3h6.6" stroke="var(--life)" strokeWidth="2" />
        <path d="M23.6 17.5H31" stroke="var(--text)" strokeWidth="2" />
      </g>
    </svg>
  );
}

function Header() {
  const { accountId, connect, disconnect, ready, isGuest, guest, guestAs, alias } = useWallet();
  const nav = ({ isActive }: { isActive: boolean }) =>
    `pb-0.5 text-[15px] border-b transition-colors duration-700 ${isActive ? "border-accent text-text" : "border-transparent text-text-2 hover:text-text"}`;
  const tryOn = guestAvailable() && !MOCK;
  const links = (
    <>
      <NavLink to="/" end className={nav}>Vaults</NavLink>
      <NavLink to="/create" className={nav}>Create</NavLink>
      {tryOn && <NavLink to="/try" className={nav}>Try it</NavLink>}
      <NavLink to="/heir" className={nav}>For heirs</NavLink>
    </>
  );
  const guestName = isGuest ? (guestAs ? `as ${alias(guestAs) ?? "an heir"}` : guest?.accountId.replace(/\.testnet$/, "")) : null;
  return (
    <header className="border-b border-rule">
      <div className="wrap py-4 md:py-5">
        <div className="flex items-center justify-between gap-x-6">
          <div className="flex min-w-0 items-center gap-x-10">
            <Link to="/" className="flex items-center gap-[7px]">
              <Mark />
              <span className="display whitespace-nowrap text-[26px] leading-none sm:text-[28px]">Dead Man’s Wallet</span>
            </Link>
            <nav className="hidden gap-6 whitespace-nowrap md:flex" aria-label="Primary">{links}</nav>
          </div>
          <div className="flex min-w-0 items-baseline gap-5">
            <span className="sc hidden sm:inline">{MOCK ? "Mock data" : NETWORK}</span>
            {accountId ? (
              isGuest ? (
                <button className="tl min-w-0 !text-[13px]" onClick={disconnect} title="Forget this guest account">
                  <span className="sc mr-1.5 !text-[11px]">Guest</span>
                  <span className="mono hidden truncate !text-[12.5px] sm:inline">{guestName}</span>
                </button>
              ) : (
                <button className="tl mono min-w-0 max-w-[46vw] truncate !text-[13px]" onClick={disconnect} title="Disconnect">{accountId}</button>
              )
            ) : (
              <button className="tl whitespace-nowrap" onClick={connect} disabled={!ready}>Connect wallet</button>
            )}
          </div>
        </div>
        <nav className="mt-3 flex items-baseline gap-6 whitespace-nowrap md:hidden" aria-label="Primary">
          {links}
          <span className="sc ml-auto sm:hidden">{MOCK ? "Mock" : NETWORK}</span>
        </nav>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-rule">
      <div className="wrap flex flex-wrap items-baseline justify-between gap-4 py-8 text-[13px] text-text-2">
        <p>Not a will. Not a custodian. Configure it with your estate attorney.</p>
        <a className="xl" href={links.nearAddress(CONTRACT)} target="_blank" rel="noreferrer">{CONTRACT}</a>
        <ContractNotice />
      </div>
    </footer>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const inverted = pathname.startsWith("/heir");
  // The heir page is the one warm page: bone ground, ink type. Set on <html> so the body colour follows.
  useEffect(() => {
    document.documentElement.classList.toggle("inverted", inverted);
  }, [inverted]);
  // The phone page stands alone: no header, no footer, nothing to tap by accident.
  if (pathname.startsWith("/pulse"))
    return (
      <>
        <div className="grain" aria-hidden />
        <Pulse />
      </>
    );
  return (
    <div className="flex min-h-screen flex-col">
      <div className="grain" aria-hidden />
      <Header />
      <PendingCreate />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<Create />} />
          <Route path="/vault/:id" element={<Vault />} />
          <Route path="/heir" element={<Heir />} />
          <Route path="/try" element={<Try />} />
          <Route
            path="*"
            element={
              <div className="wrap py-24">
                <h1 className="display text-[48px]">Nothing here.</h1>
                <Link className="tl mt-6" to="/">Back to vaults</Link>
              </div>
            }
          />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
