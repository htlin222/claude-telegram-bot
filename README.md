# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**Repository description:** A Telegram bot that lets you drive Claude Code from your phone with streaming replies, file tooling, and MCP integrations.

**中文說明**: `README.zh.md`

## Overview

Claude Telegram Bot connects Telegram → Claude Code and streams responses (including tool status) back to your chat. It’s built with Bun + grammY and uses the official Claude Agent SDK.

## Features

- 💬 Text, 🎤 voice, 📸 photos, 📄 documents
- ⚡ Streaming responses with live tool status
- 📨 Message queueing while Claude is busy
- 🔘 Inline action buttons via `ask_user` MCP
- 🧠 Thinking/plan/compact modes
- 🧵 Session persistence and `/resume`
- 📁 Git worktrees, `/diff`, `/undo`, `/file`
- 🗂️ File listing helpers: `/image`, `/pdf`, `/docx`, `/html`
- 🛡️ Safety layers: allowlist, rate limits, path checks, command guardrails, audit log

## API Docs

`https://htlin222.github.io/claude-telegram-bot/`

## Quick Start

### Prerequisites

- **Bun 1.0+**
- **Telegram Bot Token** from @BotFather
- **Claude Code CLI** (recommended, for SDK CLI auth)
- **OpenAI API Key** (optional, for voice transcription)

### Install & Run

```bash
git clone https://github.com/htlin/claude-telegram-bot
cd claude-telegram-bot

cp .env.example .env
# Edit .env with your credentials

bun install
bun run start
```

### Configure Environment

```bash
# Required
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789

# Recommended
CLAUDE_WORKING_DIR=/path/to/your/folder
OPENAI_API_KEY=sk-...                      # For voice transcription
```

**Claude SDK authentication (recommended):**
- This bot uses `@anthropic-ai/claude-agent-sdk`.
- Prefer **CLI auth**: run `claude` once and sign in. This uses your Claude Code subscription and is typically more cost-effective.
- Use `ANTHROPIC_API_KEY` only if you cannot use CLI auth (headless/CI environments).

## Commands

### Session

- `/start` `/new` `/resume` `/stop` `/status` `/retry` `/handoff` `/pending` `/restart`

### Model & Reasoning

- `/model` `/provider` `/think` `/plan` `/compact` `/cost`

### Files & Worktrees

- `/cd` `/worktree` `/branch` `/diff` `/file` `/undo` `/bookmarks`
- File listing: `/image` `/pdf` `/docx` `/html`

### Shell

Prefix a message with `!` to run it in the working directory:

```
!ls -la
!git status
```

## Best Practices

- Keep `CLAUDE_WORKING_DIR` small and focused; put a tailored `CLAUDE.md` there.
- Use `ALLOWED_PATHS` to explicitly scope where Claude can read/write.
- Use `/worktree` for risky changes and `/diff` before `/commit`.
- Prefer `/new` before unrelated tasks to keep context clean.
- Use `/image`/`/pdf`/`/docx`/`/html` to quickly locate files for `/file`.
- Enable CLI auth for the Claude SDK to reduce cost and avoid API-key throttling.

## Security

This bot intentionally bypasses interactive permission prompts for speed. Review the model and safeguards here:

- `SECURITY.md`

## License

MIT
