import { Link, NavLink, Route, Routes } from "react-router-dom";
import { MOCK, NETWORK } from "./config";
import { useWallet } from "./lib/wallet";
import Home from "./pages/Home";
import Vault from "./pages/Vault";
import Create from "./pages/Create";
import Heir from "./pages/Heir";

function Header() {
  const { accountId, connect, disconnect, ready } = useWallet();
  const nav = ({ isActive }: { isActive: boolean }) => `px-3 py-2 rounded-lg ${isActive ? "text-ink" : "text-mute hover:text-ink"}`;
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-3 text-xl font-semibold">
            <span className="inline-block h-5 w-5 rounded-full border-4 border-alive" />
            Dead Man's Wallet
          </Link>
          <nav className="flex gap-1 text-base">
            <NavLink to="/" end className={nav}>Vaults</NavLink>
            <NavLink to="/create" className={nav}>Create</NavLink>
            <NavLink to="/heir" className={nav}>Heir</NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-line px-3 py-1 text-xs uppercase tracking-widest text-mute">
            {MOCK ? "mock data" : NETWORK}
          </span>
          {accountId ? (
            <button className="btn" onClick={disconnect} title="Disconnect">{accountId}</button>
          ) : (
            <button className="btn btn-primary" onClick={connect} disabled={!ready}>Connect wallet</button>
          )}
        </div>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<Create />} />
          <Route path="/vault/:id" element={<Vault />} />
          <Route path="/heir" element={<Heir />} />
          <Route path="*" element={<p className="text-mute">Not found. <Link className="link" to="/">Back to vaults</Link></p>} />
        </Routes>
      </main>
    </div>
  );
}
