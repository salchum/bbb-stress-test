# ==============================================================================
# VARIABLES

# -- Docker
DOCKER_UID           = $(shell id -u)
DOCKER_GID           = $(shell id -g)
DOCKER_USER          = $(DOCKER_UID):$(DOCKER_GID)

COMPOSE              = DOCKER_USER=$(DOCKER_USER) docker compose
COMPOSE_RUN          = $(COMPOSE) run --rm
COMPOSE_RUN_APP      = $(COMPOSE_RUN) app

# -- Node
YARN                 = $(COMPOSE_RUN_APP) yarn

# -- CLI
# Extra arguments passed to cli.js commands, for example:
# make stress ARGS="test-1234 -w 3 -m 2 -l 4 -d 30 -v"
ARGS                 ?=

# ==============================================================================
# RULES

default: help

# -- Test suite

stress: ## Run stress test
stress: \
	prepare-artifacts
	@$(COMPOSE_RUN_APP) ./cli.js stress $(ARGS)
.PHONY: stress

list-meetings: ## List meetings running on the BBB server
list-meetings: \
	prepare-artifacts
	@$(COMPOSE_RUN_APP) ./cli.js list-meetings $(ARGS)
.PHONY: list-meetings


# -- Project bootstrap

.env:
	cp .env.default .env
	@echo ".env file generated successfully. Please edit it to set BBB_URL, BBB_SECRET and BBB_MEETING_ID"


bootstrap: ## Prepare deployable Docker image and .env
bootstrap: \
	.env \
	docker-build
.PHONY: bootstrap

# -- Build tools

build: ## Build the deployable Docker image
build: \
	docker-build
.PHONY: build

build-image: ## Build the deployable Docker image
build-image: docker-build
.PHONY: build-image

docker-build: ## Build the deployable Docker image
	$(COMPOSE) build app
.PHONY: docker-build

install: ## Install dependencies in a temporary container
install: \
	prepare-artifacts
	@$(YARN) install
.PHONY: install

# -- Node

lint: ## Run linters
lint: \
  lint-prettier
.PHONY: lint

lint-prettier: ## Run prettier over js/jsx/json/ts/tsx files -- beware! overwrites files
	@$(YARN) prettier-write
.PHONY: lint-prettier

node-console: # Run a terminal inside the node docker image
node-console: \
	prepare-artifacts
	$(COMPOSE_RUN_APP) bash
.PHONY: node-console


# -- Misc
help:
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
.PHONY: help

prepare-artifacts:
	@mkdir -p reports screenshots
	@chmod 777 reports screenshots
.PHONY: prepare-artifacts
