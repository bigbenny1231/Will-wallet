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
            { name: "wallet-selector", test: /node_modules[\\/]@near-wallet-selector[\\/]/ },
            { name: "near-api-js", test: /node_modules[\\/](near-api-js|@near-js)[\\/]/ },
            // chainsig.js ships one prebuilt bundle with every chain adapter (7+ MB), so it cannot be tree-shaken; it is only used by lib/derive.ts.
            { name: "chainsig", test: /node_modules[\/]chainsig\.js[\/]/ },
          ],
        },
      },
    },
  },
});
