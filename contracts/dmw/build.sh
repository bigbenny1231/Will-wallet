#!/usr/bin/env bash
# Build dmw.wasm.
#
#   ./build.sh                  cargo-near if installed (target/near/dmw.wasm), else plain cargo with
#                               --cfg near (target/wasm32-unknown-unknown/release/dmw.wasm)
#   REPRODUCIBLE=1 ./build.sh   `cargo near build reproducible-wasm`: builds the COMMITTED tree inside the
#                               Docker image pinned in Cargo.toml, so the same commit always gives the same
#                               code hash and NEP-330 `build_info` is filled in. Needs Docker and cargo-near.
#
# Every build fills NEP-330 `link` (Cargo.toml `repository`) and `version`, readable with the
# `contract_source_metadata` view. Prints the wasm path and its NEAR code hash (base58 sha256).
set -euo pipefail
cd "$(dirname "$0")"

code_hash() { node -e '
  const b=require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest();
  const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n=BigInt("0x"+b.toString("hex")), s="";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; } console.log(s);' "$1" 2>/dev/null || echo "?"; }

if [ "${REPRODUCIBLE:-0}" = 1 ]; then
  command -v cargo-near >/dev/null 2>&1 || { echo "REPRODUCIBLE=1 needs cargo-near: cargo install cargo-near --locked" >&2; exit 1; }
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "REPRODUCIBLE=1 needs a running Docker daemon" >&2; exit 1; }
  cargo near build reproducible-wasm
  OUT=target/near/dmw.wasm
elif command -v cargo-near >/dev/null 2>&1; then
  cargo near build non-reproducible-wasm --locked
  OUT=target/near/dmw.wasm
else
  echo "cargo-near not found; falling back to cargo build (install: cargo install cargo-near --locked)" >&2
  RUSTFLAGS="--cfg near -C link-arg=-s -C target-cpu=mvp" \
    cargo build --target wasm32-unknown-unknown --release --locked
  OUT=target/wasm32-unknown-unknown/release/dmw.wasm
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt -Oz --signext-lowering "$OUT" -o "$OUT"
  fi
fi
ls -la "$OUT"
echo "code hash $(code_hash "$OUT")   ($PWD/$OUT)"
