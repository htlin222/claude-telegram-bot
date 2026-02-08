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
- 🔍 **極速檔案搜尋**：SQLite 索引加速 50-200 倍，智慧自動傳檔
- 👀 **即時檔案監控**：自動更新索引，無需手動重建
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
- **檔案搜尋**：`/search <檔名>` - SQLite 索引極速搜尋
  - 找到 1 個檔案 → 自動傳送檔案
  - 找到 2-3 個 → 顯示下載按鈕
  - 找到 4+ 個 → 顯示精簡列表
- **索引管理**：`/rebuild_index` `/index_stats` - 管理檔案索引
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

## 檔案索引與搜尋

Bot 內建 SQLite 驅動的高效能檔案索引系統：

### 功能特色

- **極速搜尋**：比檔案系統掃描快 50-200 倍（<10ms vs 500-2000ms）
- **即時更新**：檔案監控器自動更新索引（新增/修改/刪除）
- **智慧自動傳檔**：
  - 找到 1 個檔案 → 自動傳送
  - 找到 2-3 個 → 顯示下載按鈕
  - 找到 4+ 個 → 顯示精簡列表
- **最近存取追蹤**：搜尋結果依使用頻率排序

### 指令

- `/search <檔名>` - 搜尋檔案（例：`/search config.ts`）
- `/index_stats` - 查看索引統計與監控狀態
- `/rebuild_index` - 手動重建索引（通常不需要）

### 運作原理

1. **啟動**：Bot 自動在背景建立檔案索引
2. **監控**：檔案監控器即時追蹤變化
3. **搜尋**：SQLite 索引實現瞬間查詢
4. **自動傳送**：只有一個結果？立即傳送檔案

### 效能比較

| 操作 | 之前（無索引） | 之後（有索引） |
|------|--------------|--------------|
| 檔案搜尋 | ~500-2000ms | <10ms |
| 新增檔案 | 需手動掃描 | 自動索引（<100ms） |
| 修改檔案 | 需手動掃描 | 自動更新（<50ms） |
| 刪除檔案 | 需手動掃描 | 自動移除（<10ms） |

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
