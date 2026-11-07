SHELL := /bin/bash
.DEFAULT_GOAL := help
# .env is read by the scripts themselves (scripts/lib.sh, keeper/src/config.ts); it is not exported into
# every make recipe, so cargo and npm never see KEEPER_PRIVATE_KEY.

TOKEN ?= $(shell cat .demo/vault_id 2>/dev/null || echo 1)
KEEPER_DEPS := keeper/node_modules/.package-lock.json
DASHBOARD_DEPS := dashboard/node_modules/.package-lock.json
AGENT_DEPS := agent/node_modules/.package-lock.json

help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

check: ## Verify toolchain (required: Rust + wasm32, Node >= 22, openssl, curl; optional: cargo-near, near-cli-rs, docker)
	@./scripts/check.sh

$(KEEPER_DEPS): keeper/package-lock.json
	cd keeper && npm ci --no-audit --no-fund --loglevel=error
	@touch $@

$(DASHBOARD_DEPS): dashboard/package-lock.json
	cd dashboard && npm ci --no-audit --no-fund --loglevel=error
	@touch $@

$(AGENT_DEPS): agent/package-lock.json
	cd agent && npm ci --no-audit --no-fund --loglevel=error
	@touch $@

install: $(KEEPER_DEPS) $(DASHBOARD_DEPS) $(AGENT_DEPS) ## npm ci in keeper/, dashboard/ and agent/ (run automatically by the targets that need it)

build: ## Build the contract to WASM (cargo-near -> target/near/dmw.wasm, else plain cargo with --cfg near)
	./contracts/dmw/build.sh

build-reproducible: ## Reproducible build of the committed tree in the pinned Docker image (needs docker + cargo-near)
	REPRODUCIBLE=1 ./contracts/dmw/build.sh

test: $(KEEPER_DEPS) $(DASHBOARD_DEPS) $(AGENT_DEPS) ## Contract unit tests (76), keeper typecheck + tests (44), dashboard tests (32), agent typecheck + tests
	cd contracts/dmw && cargo test --locked
	cd keeper && npm run --silent typecheck && npm test --silent
	cd dashboard && npm test --silent
	cd agent && npm run --silent typecheck && npm test --silent

deploy: $(KEEPER_DEPS) ## Faucet account + keeper account, build, deploy, init, set_keeper; writes .env (NEW=1: ignore DMW_CONTRACT)
	./scripts/deploy.sh

demo: $(KEEPER_DEPS) ## Testnet demo on the .env contract: new vault (60 s), keys, agent allowed+denied, pulse + keeper in background
	./scripts/demo.sh

agent: $(AGENT_DEPS) ## Autonomous agent with the scoped wallet wrapper (TOKEN=<id>, key = DMW_AGENT_KEY in .env or .demo/agent.key.json; BRAIN=scripted|anthropic|openai|nearai; ARGS=...). Writes .demo/agent-transcript.md
	cd agent && ./node_modules/.bin/tsx src/cli.ts --token $(TOKEN) $(if $(BRAIN),--brain $(BRAIN)) $(ARGS)

kill: ## Stop the pulse daemon = the owner disappears. Follows the keeper log until Settled (~4 min)
	./scripts/kill.sh

stop: ## Stop the background pulse and keeper started by make demo
	@pkill -f 'src/cli.ts (pulse|keeper)' && echo "stopped pulse/keeper" || echo "nothing running"
	@rm -f .demo/pulse.pid .demo/keeper.pid .demo/tail.pid

status: $(KEEPER_DEPS) ## Print a vault's state (TOKEN=<id>, default: the last make demo vault)
	@cd keeper && ./node_modules/.bin/tsx src/cli.ts status --token $(TOKEN)

clean: ## Remove build artifacts and node_modules
	rm -rf contracts/dmw/target keeper/node_modules keeper/dist dashboard/node_modules dashboard/dist agent/node_modules

.PHONY: help check install build build-reproducible test deploy demo agent kill stop status clean
