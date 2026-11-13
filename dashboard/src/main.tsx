import "./polyfills";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "@fontsource/jetbrains-mono/400.css";
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
  document.title = "Pulse · Lastword";
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined));
  }
}

// /pulse holds the pulse private key in localStorage. It is rendered on its own, without the wallet selector:
// no wallet SDK code (and none of its dependencies) is even loaded on that page, so the only scripts that run next
// to the key are this app's own and near-api-js (AUDIT_FINAL_OFFCHAIN F-05). The dashboard loads as before.
const root = ReactDOM.createRoot(document.getElementById("root")!);
// A stylesheet that fails to preload (the wallet-selector CSS @imports Google Fonts; an ad blocker, a firewall or the
// CSP can block that) must not reject the page's dynamic import and leave a blank screen. JS chunk failures still throw.
window.addEventListener("vite:preloadError", (e) => {
  const err = (e as Event & { payload?: unknown }).payload;
  if (/preload CSS/i.test(String((err as Error)?.message ?? err))) e.preventDefault();
});
if (window.location.pathname.startsWith("/pulse")) {
  void import("./pages/Pulse").then(({ default: Pulse }) =>
    root.render(
      <React.StrictMode>
        <div className="grain" aria-hidden />
        <Pulse />
      </React.StrictMode>,
    ),
  );
} else {
  void Promise.all([import("react-router-dom"), import("./App"), import("./lib/wallet")]).then(([{ BrowserRouter }, { default: App }, { WalletProvider }]) =>
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <WalletProvider>
            <App />
          </WalletProvider>
        </BrowserRouter>
      </React.StrictMode>,
    ),
  );
}
