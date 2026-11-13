#!/usr/bin/env bash
# Verifies the toolchain and prints the exact fix for anything missing.
# Exits 1 only if a REQUIRED tool is missing; optional tools only print a warning.
set -u
cd "$(dirname "$0")/.."
ok=1
say() { printf '  %-16s %s\n' "$1" "$2"; }
ver() { if [ "$1" = openssl ]; then openssl version; else "$@"; fi 2>/dev/null | head -1 | cut -d' ' -f1-2; }
need() { # name, cmd, fix
  if command -v "$2" >/dev/null 2>&1; then say "$1" "ok ($(ver "$2" --version))"; else say "$1" "MISSING -> $3"; ok=0; fi
}
want() { # name, cmd, what-for, fix
  if command -v "$2" >/dev/null 2>&1; then say "$1" "ok ($(ver "$2" --version))"; else say "$1" "optional, not found ($3) -> $4"; fi
}

echo "Lastword toolchain check"
echo "required:"
need "rustc"   rustc   "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
need "cargo"   cargo   "(installed with rustup)"
if rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then say "wasm32 target" ok
else say "wasm32 target" "MISSING -> rustup target add wasm32-unknown-unknown"; ok=0; fi
if command -v node >/dev/null 2>&1; then
  NV=$(node --version); major=${NV#v}; major=${major%%.*}
  if [ "$major" -ge 22 ] 2>/dev/null; then say "node" "ok ($NV)"; else say "node" "TOO OLD ($NV) -> install Node 22+: https://nodejs.org"; ok=0; fi
else say "node" "MISSING -> install Node 22+: https://nodejs.org"; ok=0; fi
need "npm"     npm     "(ships with Node)"
need "openssl" openssl "apt install openssl / brew install openssl (make demo uses it for random account names)"
need "curl"    curl    "apt install curl / brew install curl"

echo "optional:"
if command -v cargo-near >/dev/null 2>&1; then say "cargo-near" "ok ($(ver cargo near --version))"
else say "cargo-near" "optional, not found (build falls back to plain cargo) -> cargo install cargo-near --locked"; fi
want "near-cli-rs" near "not used by the scripts; handy for poking around" "curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh"
want "docker"  docker "only for make build-reproducible" "https://docs.docker.com/get-docker/"
want "wasm-opt" wasm-opt "shrinks the plain-cargo fallback build" "apt install binaryen / brew install binaryen"

echo "state:"
for d in keeper dashboard; do
  if [ -d $d/node_modules ]; then say "$d deps" "installed"; else say "$d deps" "not installed yet (make test / make demo run npm ci for you)"; fi
done
if [ -f .env ] && grep -q '^DMW_CONTRACT=' .env; then say ".env" "ok ($(grep '^DMW_CONTRACT=' .env))"
else say ".env" "not yet: make deploy creates the accounts and writes it (template: .env.example)"; fi

if [ $ok = 1 ]; then echo "All good."; else echo "Fix the MISSING lines above, then re-run make check."; exit 1; fi
