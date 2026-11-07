import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { global: "globalThis" },
  server: { port: 5173, host: true },
  build: {
    chunkSizeWarningLimit: 2500,
    // Vite 8 bundles with Rolldown: codeSplitting replaces Rollup's manualChunks. Groups are matched in order.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
            // Before wallet-selector: groups capture their dependencies recursively, so listing these later let the
            // wallet-selector chunk swallow buffer and near-api-js, and /pulse (which needs both) then evaluated the
            // whole wallet SDK next to the pulse key (docs/AUDIT_FINAL_OFFCHAIN.md F-05).
            { name: "polyfills", test: /node_modules[\\/](buffer|base64-js|ieee754)[\\/]/ },
            { name: "near-api-js", test: /node_modules[\\/](near-api-js|@near-js|@noble|borsh|bs58|base-x|js-sha256|tweetnacl|depd|http-errors|mustache|secp256k1|elliptic|bn\.js|lru_map|is-my-json-valid|exponential-backoff)[\\/]/ },
            { name: "wallet-selector", test: /node_modules[\\/]@near-wallet-selector[\\/]/ },
            // chainsig.js ships one prebuilt bundle with every chain adapter (7+ MB), so it cannot be tree-shaken; it is only used by lib/derive.ts.
            { name: "chainsig", test: /node_modules[\/]chainsig\.js[\/]/ },
          ],
        },
      },
    },
  },
});
