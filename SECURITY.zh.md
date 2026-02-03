# 安全模型

本文說明 Claude Telegram Bot 的安全架構。

English version: [SECURITY.md](SECURITY.md)

## 權限模式：完全略過

**此機器人會以禁用所有權限提示的模式執行 Claude Code。**

```typescript
// src/session.ts
permissionMode: "bypassPermissions"
allowDangerouslySkipPermissions: true
```

這代表 Claude 可以：
- **讀寫檔案**（不需確認）
- **執行 shell 指令**（不需提示）
- **自動使用所有工具**（Bash、Edit、Write 等）

這是刻意設計：機器人主打手機遠端操作，若每次都要確認會非常不便。因此改以多層防護來降低風險。

**此行為不可設定** —— 永遠是 bypass 模式。如需權限提示，請改用 Claude Code 本體。

## 威脅模型

本機器人設計給**受信任使用者的個人用途**。主要威脅包含：

1. **未授權存取** - Bot token 外洩或被發現
2. **提示注入** - 惡意內容誘導 Claude 執行錯誤操作
3. **誤操作** - 合法使用者不小心執行破壞性指令
4. **憑證外洩** - 嘗試取得 API Key、密碼、機密資訊

## 多層防護

### Layer 1：使用者白名單

只有 `TELEGRAM_ALLOWED_USERS` 內的 Telegram ID 才能使用。

```
使用者訊息 → 檢查 ID → 不在白名單則拒絕
```

- Telegram 使用者 ID 為數字且不可偽造
- 可用 [@userinfobot](https://t.me/userinfobot) 查詢
- 未授權的嘗試會被記錄

### Layer 2：限流

Token bucket 防止濫用，即使憑證外洩也有保護。

```
預設：每位使用者 60 秒最多 20 次
```

可透過以下設定調整：
- `RATE_LIMIT_ENABLED` - 啟用/停用（預設 true）
- `RATE_LIMIT_REQUESTS` - 視窗內請求數（預設 20）
- `RATE_LIMIT_WINDOW` - 視窗秒數（預設 60）

### Layer 3：路徑驗證

檔案操作僅限於明確允許的目錄。

```
預設允許路徑：
- CLAUDE_WORKING_DIR
- ~/Documents
- ~/Downloads
- ~/Desktop
```

可用 `ALLOWED_PATHS`（逗號分隔）自訂。

**驗證機制使用真正的路徑包含檢查：**
- 先解析 symlink
- 防止 `../` 路徑穿越
- 僅允許完全匹配的目錄

**暫存檔例外：**
- 允許讀取 `/tmp/` 與 `/var/folders/`
- 便於處理 Telegram 下載的檔案

### Layer 4：指令安全

危險 shell 指令會被阻擋（防禦縱深）。

#### 永遠禁止的模式

以下模式 **無條件拒絕**：

| 模式 | 原因 |
|------|------|
| `rm -rf /` | 系統毀損 |
| `rm -rf ~` | 家目錄刪除 |
| `rm -rf $HOME` | 家目錄刪除 |
| `sudo rm` | 權限刪除 |
| `:(){ :\|:& };:` | Fork bomb |
| `> /dev/sd` | 磁碟覆寫 |
| `mkfs.` | 格式化檔案系統 |
| `dd if=` | 原始磁碟操作 |

#### 需路徑驗證的指令

`rm` 指令（且未命中上述模式）**允許但需驗證路徑**：

```bash
rm file.txt              # 若在 ALLOWED_PATHS 內，允許
rm /etc/passwd           # 拒絕：超出 ALLOWED_PATHS
rm -rf ./node_modules    # 若 cwd 在 ALLOWED_PATHS 內，允許
rm -r /tmp/mydir         # 允許：/tmp 永遠允許
```

每個路徑參數都會先檢查是否在 `ALLOWED_PATHS`。

### Layer 5：系統提示

Claude 會收到安全提示，要求：

1. **刪除前必須確認**（要問「確定嗎？」）
2. **只能存取允許的目錄**
3. **拒絕危險指令**
4. **破壞性動作需二次確認**

這是主要防護層，其它層為防禦縱深。

### Layer 6：稽核紀錄

所有互動都會記錄，便於安全審查。

```
Log 位置：/tmp/claude-telegram-audit.log（可調整）
```

紀錄事件：
- `message` - 使用者訊息與 Claude 回覆
- `auth` - 授權嘗試
- `tool_use` - Claude 工具使用
- `error` - 處理錯誤
- `rate_limit` - 限流事件

可啟用 JSON 格式：`AUDIT_LOG_JSON=true`

## 不涵蓋的風險

1. **惡意授權使用者** - 白名單內的人擁有完全存取
2. **未知漏洞** - Claude / SDK / 相依套件的 0-day
3. **實體存取** - 他人直接操作機器
4. **網路攔截** - 雖然 Telegram 有加密，但仍可能風險

## 建議

1. **白名單保持精簡** - 只加入完全信任的使用者
2. **使用獨立工作目錄** - 避免指向 `/` 或 `~`
3. **定期檢查稽核紀錄** - 觀察可疑行為
4. **保持依賴更新** - 取得安全修補
5. **使用獨立 API Key** - 為本機器人配置獨立的 Anthropic Key
6. **啟用通知** - 新 session 啟動時提醒

## 事件應變

若懷疑被未授權存取：

1. **停止機器人**：`launchctl unload ~/Library/LaunchAgents/com.claude-telegram-ts.plist`
2. **撤銷 Bot Token**：通知 @BotFather 重發 token
3. **查看稽核紀錄**：檢查 `/tmp/claude-telegram-audit.log`
4. **檢查檔案變更**：審查允許目錄內近期活動
5. **更新憑證**：輪替可能外洩的 API key

## 安全更新

若發現安全問題：

1. **不要開公開 GitHub issue**
2. 私下聯絡維護者
3. 給予修補時間後再公開揭露
