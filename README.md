# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**Repository description:** A Telegram bot that lets you drive Claude Code from your phone with streaming replies, file tooling, and MCP integrations.

**中文說明**: [README.zh.md](README.zh.md)

## Overview

Claude Telegram Bot connects Telegram → Claude Code and streams responses (including tool status) back to your chat. It’s built with Bun + grammY and uses the official Claude Agent SDK.

## Features

- 💬 Text, 🎤 voice (with transcript editing), 📸 photos, 📄 documents
- ⚡ Streaming responses with live tool status
- 📨 Message queueing while Claude is busy
- 🔘 Inline action buttons via `ask_user` MCP
- 🧠 Thinking/plan/compact modes
- 🧵 Session persistence and `/resume`
- 📁 Git worktrees, `/diff`, `/undo`, `/file`
- 🗂️ File listing helpers: `/image`, `/pdf`, `/docx`, `/html`
- ✏️ Voice transcript confirmation and editing before sending to Claude
- 🔄 Smart `/restart` with TTY mode detection and confirmation dialog
- 🛡️ Safety layers: allowlist, rate limits, path checks, command guardrails, audit log
- 🗂️ Per-chat sessions: each Telegram chat has its own independent Claude session

## API Docs

`https://htlin222.github.io/claude-telegram-bot/`

## Quick Start

### Prerequisites

- **Bun 1.0+**
- **Telegram Bot Token** from @BotFather
- **Claude Code CLI** (recommended, for SDK CLI auth)
- **OpenAI API Key** (optional, for voice transcription)

### Install via npm (Recommended)

Package: [ctb on npm](https://www.npmjs.com/package/ctb)

```bash
npm install -g ctb

# Show setup tutorial
ctb tut

# Run in any project directory
cd ~/my-project
ctb
```

On first run, `ctb` will prompt for your Telegram bot token and allowed user IDs, then optionally save them to `.env`.

### Install from Source

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

# Optional
CLAUDE_WORKING_DIR=/path/to/your/folder    # Fallback working directory
OPENAI_API_KEY=sk-...                      # For voice transcription
```

### Working Directory

The bot determines the working directory in this order:

1. **CLI `--dir` flag**: `ctb --dir ~/my-project`
2. **Current directory**: Where you run `ctb` (most common)
3. **`CLAUDE_WORKING_DIR`**: Environment variable fallback
4. **`$HOME`**: Last resort default

**Typical usage:**

```bash
cd ~/my-project
ctb              # Working dir = ~/my-project
```

**Claude SDK authentication (recommended):**

- This bot uses `@anthropic-ai/claude-agent-sdk`.
- Prefer **CLI auth**: run `claude` once and sign in. This uses your Claude Code subscription and is typically more cost-effective.
- Use `ANTHROPIC_API_KEY` only if you cannot use CLI auth (headless/CI environments).

## Commands

### Session

- `/start` `/new` `/resume` `/stop` `/status` `/retry` `/handoff` `/pending` `/restart`
- `/sessions` - List all active sessions across chats

### Model & Reasoning

- `/model` `/provider` `/think` `/plan` `/compact` `/cost`

### Files & Worktrees

- `/cd` `/worktree` `/branch` `/diff` `/file` `/undo` `/bookmarks`
- File listing: `/image` `/pdf` `/docx` `/html`
- **Auto file send**: Just say "把檔案給我看" or "send me the file" after Claude mentions files, and the bot will automatically detect and send them!

### Shell

Prefix a message with `!` to run it in the working directory:

```
!ls -la
!git status
```

## Per-Chat Sessions

Each Telegram chat maintains its own independent Claude session:

- **Multiple projects**: Work on different projects in separate Telegram chats
- **Independent history**: Each chat has its own conversation context
- **Separate working dirs**: Use `/cd` in each chat to set different directories
- **Session persistence**: Sessions survive bot restarts

**Example workflow:**

```
Chat A: /cd ~/frontend    → Frontend development
Chat B: /cd ~/backend     → Backend API work
Chat C: /cd ~/docs        → Documentation
```

Use `/sessions` to view all active sessions across chats.

## Best Practices

- Run `ctb` from your project directory to auto-set the working directory.
- Use `ALLOWED_PATHS` to explicitly scope where Claude can read/write.
- Use `/worktree` for risky changes and `/diff` before `/commit`.
- Prefer `/new` before unrelated tasks to keep context clean.
- Use separate Telegram chats for different projects (per-chat sessions).
- Use `/image`/`/pdf`/`/docx`/`/html` to quickly locate files for `/file`.
- Enable CLI auth for the Claude SDK to reduce cost and avoid API-key throttling.

## Security

This bot intentionally bypasses interactive permission prompts for speed. Review the model and safeguards here:

- `SECURITY.md`

## License

MIT
