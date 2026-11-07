import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "@fontsource/jetbrains-mono/400.css";
import App from "./App";
import { WalletProvider } from "./lib/wallet";
import "./index.css";

// The phone page is an installable app: manifest, icons and an offline shell. Only /pulse opts in, so the
// dashboard itself is never served stale.
if (window.location.pathname.startsWith("/pulse")) {
  const head = document.head;
  const add = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    head.appendChild(el);
  };
  add("link", { rel: "manifest", href: "/manifest.webmanifest" });
  add("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" });
  add("meta", { name: "theme-color", content: "#0B0C0F" });
  add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
  add("meta", { name: "mobile-web-app-capable", content: "yes" });
  add("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" });
  add("meta", { name: "apple-mobile-web-app-title", content: "Pulse" });
  document.title = "Pulse · Dead Man’s Wallet";
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined));
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <WalletProvider>
        <App />
      </WalletProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
