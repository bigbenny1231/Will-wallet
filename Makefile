SHELL := /bin/bash
.DEFAULT_GOAL := help
-include .env
export

TOKEN ?= $(shell cat .demo/vault_id 2>/dev/null || echo 1)

help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

check: ## Verify toolchain (Rust, wasm target, cargo-near, near-cli-rs, Node 22)
	@./scripts/check.sh

build: ## Build the contract to WASM (cargo-near if installed, else plain cargo with --cfg near)
	./contracts/dmw/build.sh

test: ## Run contract unit tests + keeper tests
	cd contracts/dmw && cargo test
	cd keeper && npm test --silent

deploy: ## Deploy + init the contract to the account in .env (DMW_CONTRACT)
	./scripts/deploy.sh

demo: ## One-command testnet demo: new vault (60 s interval), keys, agent allowed+denied, pulse + keeper in background
	./scripts/demo.sh

kill: ## Stop the pulse daemon = the owner disappears. Watch the keeper settle the estate.
	./scripts/kill.sh

status: ## Print a vault's state (TOKEN=<id>, default: the last `make demo` vault)
	@cd keeper && ./node_modules/.bin/tsx src/cli.ts status --token $(TOKEN)

clean: ## Remove build artifacts
	rm -rf contracts/dmw/target keeper/node_modules keeper/dist dashboard/node_modules dashboard/dist
