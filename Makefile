# Claude Telegram Bot - Makefile
# Usage: make <target>

SHELL := /bin/bash

PLIST_NAME := com.claude-telegram-ts
PLIST_PATH := ~/Library/LaunchAgents/$(PLIST_NAME).plist
PLIST_TEMPLATE := launchagent/$(PLIST_NAME).plist.template
LOG_FILE := /tmp/claude-telegram-bot.log
ERR_FILE := /tmp/claude-telegram-bot.err

.PHONY: help install setup run dev stop start restart status logs logs-err clean typecheck test

# Default target
help:
	@echo "Claude Telegram Bot"
	@echo ""
	@echo "Quick start:"
	@echo "  make setup      - First-time setup (install deps, create .env)"
	@echo "  make run        - Run bot in foreground"
	@echo "  make dev        - Run with auto-reload (watch mode)"
	@echo ""
	@echo "Background service (macOS LaunchAgent):"
	@echo "  make start      - Install and start background service"
	@echo "  make stop       - Stop background service"
	@echo "  make restart    - Restart background service"
	@echo "  make status     - Check if service is running"
	@echo "  make logs       - Tail stdout logs"
	@echo "  make logs-err   - Tail stderr logs"
	@echo "  make uninstall  - Remove background service"
	@echo ""
	@echo "Development:"
	@echo "  make install    - Install dependencies"
	@echo "  make test       - Run tests"
	@echo "  make typecheck  - Run TypeScript type check"
	@echo "  make clean      - Remove temp files and logs"

# Install dependencies
install:
	bun install

# First-time setup
setup: install
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		echo "Created .env from template"; \
		echo ">>> Edit .env with your TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS"; \
	else \
		echo ".env already exists"; \
	fi
	@echo ""
	@echo "Next steps:"
	@echo "  1. Edit .env with your credentials"
	@echo "  2. Run 'make run' to test"
	@echo "  3. Run 'make start' to run as background service"

# Run in foreground
run:
	bun run start

# Run with watch mode
dev:
	bun run dev

# Run tests
test:
	bun test

# TypeScript type check
typecheck:
	bun run typecheck

# === Background Service (macOS LaunchAgent) ===

# Install and start service
start:
	@if [ ! -f .env ]; then \
		echo "Error: .env not found. Run 'make setup' first."; \
		exit 1; \
	fi
	@echo "Installing LaunchAgent..."
	@mkdir -p ~/Library/LaunchAgents
	@export $$(grep -v '^#' .env | xargs) && \
	sed -e "s|/Users/USERNAME/.bun/bin/bun|$$(command -v bun)|g" \
	    -e "s|/Users/USERNAME/Dev/claude-telegram-bot-ts|$$(pwd)|g" \
	    -e "s|<string>/Users/USERNAME/Dev</string>|<string>$${CLAUDE_WORKING_DIR:-$$(pwd)}</string>|g" \
	    -e "s|your-bot-token-here|$${TELEGRAM_BOT_TOKEN}|g" \
	    -e "s|<string>123456789</string>|<string>$${TELEGRAM_ALLOWED_USERS}</string>|g" \
	    -e "s|<string>sk-...</string>|<string>$${OPENAI_API_KEY:-}</string>|g" \
	    -e "s|USERNAME|$$(whoami)|g" \
	    $(PLIST_TEMPLATE) > $(PLIST_PATH)
	@echo "Created $(PLIST_PATH) with values from .env"
	@launchctl unload $(PLIST_PATH) 2>/dev/null || true
	@launchctl load $(PLIST_PATH)
	@echo "Service started. Check 'make logs' for output."

# Stop service
stop:
	@launchctl unload $(PLIST_PATH) 2>/dev/null || echo "Service not running"
	@echo "Service stopped"

# Restart service
restart:
	@launchctl kickstart -k gui/$$(id -u)/$(PLIST_NAME) 2>/dev/null || \
		(echo "Service not loaded. Run 'make start' first." && exit 1)
	@echo "Service restarted"

# Check service status
status:
	@if launchctl list | grep -q $(PLIST_NAME); then \
		echo "Service: RUNNING"; \
		launchctl list $(PLIST_NAME); \
	else \
		echo "Service: NOT RUNNING"; \
	fi

# Uninstall service
uninstall: stop
	@rip $(PLIST_PATH) 2>/dev/null || true
	@echo "Service uninstalled"

# Tail stdout logs
logs:
	@if [ -f $(LOG_FILE) ]; then \
		tail -f $(LOG_FILE); \
	else \
		echo "No log file yet. Start the service first."; \
	fi

# Tail stderr logs
logs-err:
	@if [ -f $(ERR_FILE) ]; then \
		tail -f $(ERR_FILE); \
	else \
		echo "No error log yet."; \
	fi

# Clean temp files
clean:
	rip $(LOG_FILE) $(ERR_FILE) 2>/dev/null || true
	rip /tmp/telegram-bot 2>/dev/null || true
	@echo "Cleaned temp files"
