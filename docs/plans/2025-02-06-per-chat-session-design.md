# Per-Chat Session Management - Implementation Plan

**Date:** 2025-02-06
**Goal:** Enable multiple independent Claude sessions by using Telegram's native multi-chat capability

## 📋 Overview

Transform the bot from single global session to per-chat sessions, allowing users to:

- Work on multiple projects simultaneously in different Telegram chats
- Each chat maintains independent session history and working directory
- Switch between contexts by simply switching Telegram chats

## 🎯 Design Decisions

### 1. Session Persistence

- **Strategy:** Each chat gets its own session file
- **Location:** `/tmp/claude-telegram-sessions/{chatId}.json`
- **Format:**
  ```json
  {
    "version": 1,
    "chat_id": 123456,
    "session_id": "abc123...",
    "working_dir": "/Users/htlin/project-a",
    "saved_at": "2024-01-01T12:00:00Z"
  }
  ```

### 2. Working Directory Management

- **Strategy:** Each chat remembers its own working directory
- **New Chat Default:** Use global `CLAUDE_WORKING_DIR` from environment
- **User Control:** `/cd` command changes working dir for current chat only

### 3. Session Lifecycle

- **Creation:** Lazy - created on first message in a chat
- **Loading:** Auto-restore from disk if session file exists
- **Saving:** Debounced write per-chat (existing logic)
- **Cleanup:** Manual via `/sessions cleanup` command

## 🏗️ Architecture

### Core Classes

```typescript
// SessionManager: Manages multiple ClaudeSession instances
class SessionManager {
  private sessions: Map<number, ClaudeSession> = new Map();
  private readonly SESSION_DIR = "/tmp/claude-telegram-sessions/";

  // Get or create session for a chat
  getSession(chatId: number): ClaudeSession;

  // Persistence
  saveSession(chatId: number): void;
  loadSessionFromDisk(chatId: number, session: ClaudeSession): boolean;

  // Management
  getAllActiveSessions(): Array<{ chatId: number; session: ClaudeSession }>;
  cleanupIdleSessions(maxIdleMs: number): number;
}

// Export singleton
export const sessionManager = new SessionManager();
```

### Handler Pattern Change

**Before:**

```typescript
import { session } from "../session";
await session.sendMessageStreaming(...);
```

**After:**

```typescript
import { sessionManager } from "../session";
const session = sessionManager.getSession(chatId);
await session.sendMessageStreaming(...);
```

## 📝 Implementation Tasks

### Phase 1: Core Infrastructure (2 hours)

#### 1.1 Create SessionManager Class (45 min)

- [ ] Add `SessionManager` class to `src/session.ts`
- [ ] Implement `getSession(chatId)` with lazy initialization
- [ ] Create session directory on startup (`ensureSessionDir()`)
- [ ] Move session file path logic to use `SESSION_DIR`

#### 1.2 Per-Chat Persistence (45 min)

- [ ] Update `saveSession()` to accept `chatId` parameter
- [ ] Update `loadSessionFromDisk()` to use per-chat file paths
- [ ] Update `SessionData` type to include `chat_id: number`
- [ ] Handle migration from old single-file format (optional warning)

#### 1.3 Export Singleton (15 min)

- [ ] Export `sessionManager` singleton instance
- [ ] Remove global `session` export (breaking change)
- [ ] Update `src/index.ts` to use `sessionManager`

#### 1.4 Startup Restoration (15 min)

- [ ] Implement `loadAllSessions()` method
- [ ] Call `loadAllSessions()` in bot startup
- [ ] Log restored sessions on startup

### Phase 2: Handler Updates (1 hour)

#### 2.1 Update All Message Handlers (30 min)

- [ ] `src/handlers/text.ts` - Add `const session = sessionManager.getSession(chatId)`
- [ ] `src/handlers/voice.ts` - Same pattern
- [ ] `src/handlers/photo.ts` - Same pattern
- [ ] `src/handlers/document.ts` - Same pattern
- [ ] `src/handlers/callback.ts` - Same pattern

#### 2.2 Update Command Handlers (30 min)

- [ ] `src/handlers/commands.ts` - Update all commands to use `sessionManager.getSession(chatId)`
- [ ] Verify all commands that access session state (20+ commands)
- [ ] Special attention to: `/status`, `/new`, `/resume`, `/cd`, `/cost`

### Phase 3: New Management Features (1 hour)

#### 3.1 `/sessions` Command (30 min)

- [ ] Create `/sessions` command handler
- [ ] Display all active sessions with status:

  ```
  📊 Active Sessions (3)

  • Chat: Main Project (#123456)
    Status: Running (15s)
    Dir: /Users/htlin/project
    Last activity: 5m ago

  • Chat: Feature XYZ (#789012)
    Status: Idle
    Dir: /Users/htlin/worktree/feature-xyz
    Last activity: 1h ago
  ```

- [ ] Add inline buttons for each session (optional actions)

#### 3.2 `/sessions cleanup` Command (30 min)

- [ ] Implement `cleanupIdleSessions(maxIdleMs)` method
- [ ] Default cleanup: sessions idle > 24 hours
- [ ] Report cleaned up sessions
- [ ] Add environment variable for idle threshold

### Phase 4: Enhanced `/status` Command (30 min)

#### 4.1 Update `/status` Display (30 min)

- [ ] Add current chat ID to status output
- [ ] Show total active sessions count
- [ ] Add link to `/sessions` for multi-session overview
- [ ] Keep existing per-session details (query status, usage, etc.)

Example output:

```
📊 Bot Status

🆔 Chat: #123456
✅ Session: Active (abc12345...)
🤖 Provider: claude

📊 Global: 3 active sessions
   Use /sessions to view all

🔄 Query: Running (15s)
   └─ 🔍 Grep: searching for "handleText"
...
```

### Phase 5: Documentation & Testing (30 min)

#### 5.1 Update Documentation (15 min)

- [ ] Update `CLAUDE.md` - Architecture section
- [ ] Update `CLAUDE.md` - Session management explanation
- [ ] Add migration notes (breaking change from global session)
- [ ] Document new `/sessions` command

#### 5.2 Testing (15 min)

- [ ] Test creating sessions in multiple chats
- [ ] Verify session persistence after bot restart
- [ ] Test `/cd` isolation between chats
- [ ] Test concurrent queries in different chats
- [ ] Verify cleanup command works

## 🔧 Key Code Changes

### 1. Session Manager Implementation

```typescript
// src/session.ts

const SESSION_VERSION = 1;
const SESSION_DIR = "/tmp/claude-telegram-sessions/";
const IDLE_SESSION_CLEANUP_MS = Number.parseInt(
  process.env.IDLE_SESSION_CLEANUP_MS || String(24 * 60 * 60 * 1000), // 24 hours
  10,
);

class SessionManager {
  private sessions: Map<number, ClaudeSession> = new Map();

  constructor() {
    this.ensureSessionDir();
  }

  private ensureSessionDir(): void {
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
      console.log(`Created session directory: ${SESSION_DIR}`);
    }
  }

  getSession(chatId: number): ClaudeSession {
    if (!this.sessions.has(chatId)) {
      const session = new ClaudeSession();

      // Try to load from disk
      const loaded = this.loadSessionFromDisk(chatId, session);

      if (!loaded) {
        // New session: use global default working dir
        session.setWorkingDir(WORKING_DIR);
      }

      this.sessions.set(chatId, session);
      console.log(`Created session for chat ${chatId}`);
    }
    return this.sessions.get(chatId)!;
  }

  private loadSessionFromDisk(chatId: number, session: ClaudeSession): boolean {
    const sessionFile = `${SESSION_DIR}/${chatId}.json`;

    try {
      const file = Bun.file(sessionFile);
      if (!file.size) return false;

      const text = readFileSync(sessionFile, "utf-8");
      const data: SessionData = JSON.parse(text);

      if (!data.session_id || data.version !== SESSION_VERSION) {
        return false;
      }

      session.sessionId = data.session_id;
      session.lastActivity = new Date();

      if (data.working_dir) {
        session.setWorkingDir(data.working_dir);
      }

      console.log(
        `Loaded session for chat ${chatId}: ${data.session_id.slice(0, 8)}...`,
      );
      return true;
    } catch (error) {
      console.warn(`Failed to load session for chat ${chatId}:`, error);
      return false;
    }
  }

  saveSession(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (!session?.sessionId) return;

    try {
      const sessionFile = `${SESSION_DIR}/${chatId}.json`;
      const data: SessionData = {
        version: SESSION_VERSION,
        chat_id: chatId,
        session_id: session.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: session.workingDir,
      };

      writeFileSync(sessionFile, JSON.stringify(data), { mode: 0o600 });
      console.log(`Saved session for chat ${chatId}`);
    } catch (error) {
      console.warn(`Failed to save session for chat ${chatId}:`, error);
    }
  }

  loadAllSessions(): void {
    try {
      if (!existsSync(SESSION_DIR)) return;

      const files = readdirSync(SESSION_DIR);
      let loaded = 0;

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const chatId = Number.parseInt(file.replace(".json", ""), 10);
        if (Number.isNaN(chatId)) continue;

        const session = new ClaudeSession();
        if (this.loadSessionFromDisk(chatId, session)) {
          this.sessions.set(chatId, session);
          loaded++;
        }
      }

      if (loaded > 0) {
        console.log(`Restored ${loaded} session(s) from disk`);
      }
    } catch (error) {
      console.warn("Failed to load sessions:", error);
    }
  }

  getAllActiveSessions(): Array<{
    chatId: number;
    session: ClaudeSession;
  }> {
    return Array.from(this.sessions.entries()).map(([chatId, session]) => ({
      chatId,
      session,
    }));
  }

  cleanupIdleSessions(maxIdleMs: number = IDLE_SESSION_CLEANUP_MS): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [chatId, session] of this.sessions) {
      if (!session.lastActivity) continue;

      const idleMs = now - session.lastActivity.getTime();
      if (idleMs > maxIdleMs) {
        this.sessions.delete(chatId);

        // Delete session file
        try {
          const sessionFile = `${SESSION_DIR}/${chatId}.json`;
          if (existsSync(sessionFile)) {
            unlinkSync(sessionFile);
          }
        } catch (error) {
          console.warn(
            `Failed to delete session file for chat ${chatId}:`,
            error,
          );
        }

        cleaned++;
        console.log(`Cleaned up idle session for chat ${chatId}`);
      }
    }

    return cleaned;
  }

  flushAllSessions(): void {
    for (const [chatId, session] of this.sessions) {
      if (session.sessionId) {
        session.flushSession();
        this.saveSession(chatId);
      }
    }
  }
}

export const sessionManager = new SessionManager();

// Remove old global session export:
// export const session = new ClaudeSession(); // DELETE THIS LINE
```

### 2. Update ClaudeSession.saveSession() to accept chatId

```typescript
// src/session.ts - Inside ClaudeSession class

// Add chatId tracking
private _chatId: number | null = null;

setChatId(chatId: number): void {
  this._chatId = chatId;
}

private saveSession(): void {
  if (!this.sessionId || !this._chatId) return;

  // Delegate to SessionManager
  const { sessionManager } = await import("./session");
  sessionManager.saveSession(this._chatId);
}
```

### 3. Update SessionData Type

```typescript
// src/types.ts

export interface SessionData {
  version: number;
  chat_id: number; // ADD THIS
  session_id: string;
  saved_at: string;
  working_dir: string;
}
```

### 4. Handler Pattern Example

```typescript
// src/handlers/text.ts

export async function handleText(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!userId || !chatId) return;

  // GET SESSION FOR THIS CHAT
  const session = sessionManager.getSession(chatId);

  // Set chat ID for saveSession delegation
  session.setChatId(chatId);

  // Rest of handler logic unchanged
  await session.sendMessageStreaming(...);
}
```

### 5. New /sessions Command

```typescript
// src/handlers/commands.ts

export async function handleSessions(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const allSessions = sessionManager.getAllActiveSessions();

  if (allSessions.length === 0) {
    await ctx.reply("📭 No active sessions.");
    return;
  }

  const lines: string[] = [
    `📊 <b>Active Sessions</b> (${allSessions.length})\n`,
  ];

  for (const { chatId, session } of allSessions) {
    const sessionIdShort = session.sessionId?.slice(0, 8) || "none";
    const status = session.isRunning ? "🔄 Running" : "⚪ Idle";
    const elapsed = session.queryStarted
      ? `${Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)}s`
      : "";
    const lastActivity = session.lastActivity
      ? formatTimeAgo(session.lastActivity)
      : "never";

    lines.push(
      `<b>Chat #${chatId}</b>`,
      `├─ ${status} ${elapsed}`,
      `├─ Session: <code>${sessionIdShort}...</code>`,
      `├─ Dir: <code>${session.workingDir}</code>`,
      `└─ Last: ${lastActivity}\n`,
    );
  }

  // Add cleanup button
  const keyboard = new InlineKeyboard().text(
    "🗑️ Cleanup Idle Sessions",
    "sessions:cleanup",
  );

  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

### 6. Update Bot Startup

```typescript
// src/index.ts

import { sessionManager } from "./session";

// In startup sequence
console.log("🤖 Starting Claude Telegram Bot...");

// Restore sessions from disk
sessionManager.loadAllSessions();

// Register handlers
bot.command("sessions", handleSessions);
// ... rest of handlers

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("📝 Saving all sessions before exit...");
  sessionManager.flushAllSessions();
  process.exit(0);
});
```

## 🔍 Testing Checklist

### Basic Functionality

- [ ] Create session in Chat A, verify session file created
- [ ] Send message in Chat B, verify separate session created
- [ ] Verify each chat maintains independent history
- [ ] Restart bot, verify sessions restored correctly

### Working Directory Isolation

- [ ] `/cd` in Chat A changes only Chat A's working dir
- [ ] Chat B retains its original working dir
- [ ] New Chat C starts with global default working dir

### Persistence

- [ ] Session files persist across bot restarts
- [ ] Working directories persist across bot restarts
- [ ] `/resume` works in each chat independently

### Commands

- [ ] `/status` shows current chat's session info
- [ ] `/sessions` lists all active sessions
- [ ] `/sessions cleanup` removes idle sessions
- [ ] `/new` clears only current chat's session

### Concurrent Usage

- [ ] Send query in Chat A, then immediately send in Chat B
- [ ] Verify both queries run independently
- [ ] Check MAX_CONCURRENT_QUERIES limit applies globally

## 🚨 Breaking Changes

### For Users

- **None** - Bot behavior is backwards compatible
- Existing users will see no difference (single chat usage)
- New feature is opt-in (create more chats to use)

### For Code

- **Breaking:** Remove `export const session` from `src/session.ts`
- All imports must change from:
  ```typescript
  import { session } from "./session";
  ```
  to:
  ```typescript
  import { sessionManager } from "./session";
  const session = sessionManager.getSession(chatId);
  ```

## 📊 Success Criteria

1. ✅ Users can work on multiple projects in different Telegram chats
2. ✅ Each chat maintains independent session history
3. ✅ Each chat remembers its own working directory
4. ✅ Sessions persist across bot restarts
5. ✅ `/sessions` command shows all active sessions
6. ✅ No performance degradation with multiple sessions
7. ✅ All existing features work unchanged in single-chat usage

## 🎉 Future Enhancements (Optional)

- Add chat titles/names for easier identification
- Allow users to name their sessions (e.g., "Frontend work")
- Session export/import for backup
- Cross-chat session sharing
- Web dashboard to view all sessions

## 📚 Resources

- Original proposal: See conversation history
- Telegram Bot API: https://core.telegram.org/bots/api
- Agent SDK V2 docs: (internal)

---

**Ready to implement?** Copy this plan to a new conversation and start with Phase 1!
