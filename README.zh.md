# Claude Telegram Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**Repo 描述：** 透過 Telegram 操作 Claude Code 的機器人，支援即時串流回覆、檔案工具與 MCP 整合。

## 總覽

Claude Telegram Bot 讓你在 Telegram 直接控制 Claude Code，並將回覆與工具狀態即時串流回聊天室。專案使用 Bun + grammY，並採用官方 Claude Agent SDK。

## 功能

- 💬 文字、🎤 語音（支援轉錄編輯）、📸 圖片、📄 文件
- ⚡ 串流回覆與工具狀態
- 📨 Claude 忙碌時自動排隊訊息
- 🔘 透過 `ask_user` MCP 的按鈕互動
- 🧠 thinking / plan / compact 模式
- 🧵 Session 持久化與 `/resume`
- 📁 Git worktree、`/diff`、`/undo`、`/file`
- 🗂️ 快速列檔：`/image`、`/pdf`、`/docx`、`/html`
- ✏️ 語音轉錄確認與編輯功能，送給 Claude 前可先檢查與補充
- 🔄 智慧型 `/restart` 指令，支援 TTY 模式偵測與確認對話框
- 🛡️ 安全層：白名單、限流、路徑檢查、指令保護、稽核紀錄
- 🗂️ 分聊天室 Session：每個 Telegram 聊天室擁有獨立的 Claude session

## API 文件

`https://htlin222.github.io/claude-telegram-bot/`

## 快速開始

### 需求

- **Bun 1.0+**
- **Telegram Bot Token**（向 @BotFather 申請）
- **Claude Code CLI**（建議，供 SDK CLI 登入）
- **OpenAI API Key**（可選，用於語音轉文字）

### 透過 npm 安裝（建議）

套件： [npm 上的 ctb](https://www.npmjs.com/package/ctb)

```bash
npm install -g ctb

# 顯示設定教學
ctb tut

# 在任何專案目錄啟動
cd ~/my-project
ctb
```

首次執行時，`ctb` 會提示輸入 Telegram Bot Token 與允許的使用者 ID，並可選擇寫入 `.env`。

### 從原始碼安裝

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

# 選填
CLAUDE_WORKING_DIR=/path/to/your/folder    # 備用工作目錄
OPENAI_API_KEY=sk-...                      # 語音轉文字
```

### 工作目錄

Bot 依以下順序決定工作目錄：

1. **CLI `--dir` 參數**：`ctb --dir ~/my-project`
2. **當前目錄**：執行 `ctb` 時所在的目錄（最常見）
3. **`CLAUDE_WORKING_DIR`**：環境變數備用
4. **`$HOME`**：最後預設值

**常見用法：**

```bash
cd ~/my-project
ctb              # 工作目錄 = ~/my-project
```

**Claude SDK 認證（建議）：**

- 本專案使用 `@anthropic-ai/claude-agent-sdk`。
- 優先使用 **CLI 登入**：執行一次 `claude` 並登入。這會使用 Claude Code 訂閱，通常成本較低。
- 只有在無法 CLI 登入（如 CI/無頭環境）時才使用 `ANTHROPIC_API_KEY`。

## 指令

### Session

- `/start` `/new` `/resume` `/stop` `/status` `/retry` `/handoff` `/pending` `/restart`
- `/sessions` - 列出所有聊天室的 session

### 模型與推理

- `/model` `/provider` `/think` `/plan` `/compact` `/cost`

### 檔案與 Worktree

- `/cd` `/worktree` `/branch` `/diff` `/file` `/undo` `/bookmarks`
- 列檔：`/image` `/pdf` `/docx` `/html`
- **自動傳檔**：當 Claude 提到檔案後，只要說「把檔案給我看」或 "send me the file"，bot 就會自動偵測並傳送檔案！

### Shell

訊息前綴 `!` 會在工作目錄執行：

```
!ls -la
!git status
```

## 分聊天室 Session

每個 Telegram 聊天室擁有獨立的 Claude session：

- **多專案並行**：在不同聊天室處理不同專案
- **獨立歷史紀錄**：每個聊天室有自己的對話上下文
- **獨立工作目錄**：每個聊天室用 `/cd` 設定不同目錄
- **Session 持久化**：Bot 重啟後自動恢復

**使用範例：**

```
聊天室 A: /cd ~/frontend    → 前端開發
聊天室 B: /cd ~/backend     → 後端 API
聊天室 C: /cd ~/docs        → 文件撰寫
```

用 `/sessions` 查看所有聊天室的 session 狀態。

## 最佳實務

- 從專案目錄執行 `ctb`，自動設定工作目錄。
- 用 `ALLOWED_PATHS` 明確限制可讀寫範圍。
- 有風險的變更先用 `/worktree`，並在 `/commit` 前用 `/diff`。
- 任務切換前用 `/new` 清理上下文。
- 不同專案用不同 Telegram 聊天室（分聊天室 session）。
- 先用 `/image`/`/pdf`/`/docx`/`/html` 找檔，再用 `/file` 下載。
- 建議啟用 Claude SDK 的 CLI 認證，降低成本並避免 API key 限額問題。

## 安全性

本機器人刻意略過互動式權限確認以提升速度。請閱讀安全模型與保護機制：

- `SECURITY.zh.md`

## License

MIT
