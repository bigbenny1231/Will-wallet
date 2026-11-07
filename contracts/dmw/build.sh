#!/usr/bin/env bash
# Build dmw.wasm. Prefers cargo-near (output: target/near/dmw.wasm); falls back to
# plain cargo with the `near` cfg that near-sdk >= 5.2x requires for on-chain
# builds (output: target/wasm32-unknown-unknown/release/dmw.wasm).
set -euo pipefail
cd "$(dirname "$0")"
if command -v cargo-near >/dev/null 2>&1; then
  cargo near build non-reproducible-wasm --locked
  ls -la target/near/dmw.wasm
else
  echo "cargo-near not found; falling back to cargo build (install: cargo install cargo-near --locked)" >&2
  RUSTFLAGS="--cfg near -C link-arg=-s -C target-cpu=mvp" \
    cargo build --target wasm32-unknown-unknown --release --locked
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz --signext-lowering target/wasm32-unknown-unknown/release/dmw.wasm \
      -o target/wasm32-unknown-unknown/release/dmw.wasm
  fi
  ls -la target/wasm32-unknown-unknown/release/dmw.wasm
fi
