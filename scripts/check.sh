#!/usr/bin/env bash
# Verifies the toolchain and prints the exact fix for anything missing.
set -u
ok=1
say() { printf '  %-22s %s\n' "$1" "$2"; }
need() { # name, cmd, fix
  if command -v "$2" >/dev/null 2>&1; then say "$1" "ok ($( $2 --version 2>/dev/null | head -1 ))"; else say "$1" "MISSING -> $3"; ok=0; fi
}
echo "Dead Man's Wallet toolchain check"
need "rustc"      rustc      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
need "cargo"      cargo      "(installed with rustup)"
if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then say "wasm32 target" ok; else say "wasm32 target" "MISSING -> rustup target add wasm32-unknown-unknown"; ok=0; fi
need "cargo-near" cargo-near "cargo install cargo-near --locked"
need "near"       near       "curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh"
need "node"       node       "install Node 22: https://nodejs.org"
if [ -f .env ]; then say ".env" "ok (DMW_CONTRACT=${DMW_CONTRACT:-unset})"; else say ".env" "MISSING -> cp .env.example .env and fill it (make deploy does this for you)"; fi
[ $ok = 1 ] && echo "All good." || { echo "Fix the MISSING lines above, then re-run make check."; exit 1; }
