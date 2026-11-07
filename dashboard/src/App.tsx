import { useEffect } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { CONTRACT, MOCK, NETWORK, links } from "./config";
import { useWallet } from "./lib/wallet";
import Home from "./pages/Home";
import Vault from "./pages/Vault";
import Create from "./pages/Create";
import Heir from "./pages/Heir";
import PendingCreate from "./components/PendingCreate";

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 40 40" aria-hidden className="shrink-0">
      <circle cx="20" cy="20" r="18.5" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
      <circle cx="20" cy="20" r="16" fill="none" stroke="var(--accent)" strokeWidth=".6" />
      <path d="M8 21h6l1.5-1.5 1.5 1.5 2-9 2.5 14 2-5.5h8.5" fill="none" stroke="var(--text)" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Header() {
  const { accountId, connect, disconnect, ready } = useWallet();
  const nav = ({ isActive }: { isActive: boolean }) =>
    `pb-0.5 text-[15px] border-b transition-colors duration-700 ${isActive ? "border-accent text-text" : "border-transparent text-text-2 hover:text-text"}`;
  return (
    <header className="border-b border-rule">
      <div className="wrap flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-5">
        <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
          <Link to="/" className="flex items-center gap-3">
            <Mark />
            <span className="display whitespace-nowrap text-[24px]">Dead Man’s Wallet</span>
          </Link>
          <nav className="flex gap-6 whitespace-nowrap" aria-label="Primary">
            <NavLink to="/" end className={nav}>Vaults</NavLink>
            <NavLink to="/create" className={nav}>Create</NavLink>
            <NavLink to="/heir" className={nav}>For heirs</NavLink>
          </nav>
        </div>
        <div className="flex items-baseline gap-6">
          <span className="sc">{MOCK ? "Mock data" : NETWORK}</span>
          {accountId ? (
            <button className="tl mono !text-[13px]" onClick={disconnect} title="Disconnect">{accountId}</button>
          ) : (
            <button className="tl" onClick={connect} disabled={!ready}>Connect wallet</button>
          )}
        </div>
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
