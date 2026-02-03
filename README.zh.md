# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**Repo 描述：** 透過 Telegram 操作 Claude Code 的機器人，支援即時串流回覆、檔案工具與 MCP 整合。

## 總覽

Claude Telegram Bot 讓你在 Telegram 直接控制 Claude Code，並將回覆與工具狀態即時串流回聊天室。專案使用 Bun + grammY，並採用官方 Claude Agent SDK。

## 功能

- 💬 文字、🎤 語音、📸 圖片、📄 文件
- ⚡ 串流回覆與工具狀態
- 📨 Claude 忙碌時自動排隊訊息
- 🔘 透過 `ask_user` MCP 的按鈕互動
- 🧠 thinking / plan / compact 模式
- 🧵 Session 持久化與 `/resume`
- 📁 Git worktree、`/diff`、`/undo`、`/file`
- 🗂️ 快速列檔：`/image`、`/pdf`、`/docx`、`/html`
- 🛡️ 安全層：白名單、限流、路徑檢查、指令保護、稽核紀錄

## API 文件

`https://htlin222.github.io/claude-telegram-bot/`

## 快速開始

### 需求

- **Bun 1.0+**
- **Telegram Bot Token**（向 @BotFather 申請）
- **Claude Code CLI**（建議，供 SDK CLI 登入）
- **OpenAI API Key**（可選，用於語音轉文字）

### 安裝與啟動

```bash
git clone https://github.com/htlin/claude-telegram-bot
cd claude-telegram-bot

cp .env.example .env
# 編輯 .env

bun install
bun run start
```

### 環境設定

```bash
# 必填
TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789

# 建議
CLAUDE_WORKING_DIR=/path/to/your/folder
OPENAI_API_KEY=sk-...                      # 語音轉文字
```

**Claude SDK 認證（建議）：**
- 本專案使用 `@anthropic-ai/claude-agent-sdk`。
- 優先使用 **CLI 登入**：執行一次 `claude` 並登入。這會使用 Claude Code 訂閱，通常成本較低。
- 只有在無法 CLI 登入（如 CI/無頭環境）時才使用 `ANTHROPIC_API_KEY`。

## 指令

### Session

- `/start` `/new` `/resume` `/stop` `/status` `/retry` `/handoff` `/pending` `/restart`

### 模型與推理

- `/model` `/provider` `/think` `/plan` `/compact` `/cost`

### 檔案與 Worktree

- `/cd` `/worktree` `/branch` `/diff` `/file` `/undo` `/bookmarks`
- 列檔：`/image` `/pdf` `/docx` `/html`

### Shell

訊息前綴 `!` 會在工作目錄執行：

```
!ls -la
!git status
```

## 最佳實務

- `CLAUDE_WORKING_DIR` 保持精簡，並放一份針對你的 `CLAUDE.md`。
- 用 `ALLOWED_PATHS` 明確限制可讀寫範圍。
- 有風險的變更先用 `/worktree`，並在 `/commit` 前用 `/diff`。
- 任務切換前用 `/new` 清理上下文。
- 先用 `/image`/`/pdf`/`/docx`/`/html` 找檔，再用 `/file` 下載。
- 建議啟用 Claude SDK 的 CLI 認證，降低成本並避免 API key 限額問題。

## 安全性

本機器人刻意略過互動式權限確認以提升速度。請閱讀安全模型與保護機制：

- `SECURITY.md`

## License

MIT
