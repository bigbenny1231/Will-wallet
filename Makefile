SHELL := /bin/bash
.DEFAULT_GOAL := help
-include .env
export

TOKEN ?= 1

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

check: ## Verify toolchain (Rust, wasm target, cargo-near, near-cli-rs, Node 22)
	@./scripts/check.sh

build: ## Build the contract to WASM
	cd contracts/dmw && cargo near build non-reproducible-wasm 2>/dev/null || (cd contracts/dmw && cargo build --target wasm32-unknown-unknown --release)

test: ## Run contract unit tests + keeper tests
	cd contracts/dmw && cargo test
	cd keeper && npm test --silent

deploy: ## Deploy + init the contract to the account in .env (DMW_CONTRACT)
	./scripts/deploy.sh

demo: ## One-command testnet demo: create vault (20s beat), keys, agent pay allowed+denied, start pulse + keeper
	./scripts/demo.sh

kill: ## Stop the pulse daemon = the owner disappears. Watch the keeper settle the estate.
	./scripts/kill.sh

status: ## Print the vault's current state
	near contract call-function as-read-only $(DMW_CONTRACT) get_vault json-args '{"token_id":"$(TOKEN)"}' network-config testnet now

clean: ## Remove build artifacts
	rm -rf contracts/dmw/target keeper/node_modules keeper/dist dashboard/node_modules dashboard/dist
