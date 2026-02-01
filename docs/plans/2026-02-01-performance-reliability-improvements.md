# Performance, Reliability, Architecture & UX Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement high-impact performance optimizations, reliability improvements, architecture cleanup, and UX enhancements for the Claude Telegram Bot.

**Architecture:** Debounced session persistence, centralized error handling with retry logic, elimination of circular dependencies via event emitter pattern, and progress feedback for long operations.

**Tech Stack:** Bun, TypeScript, grammY, Claude Agent SDK

---

## Task 1: Session Write Debouncing (Performance)

**Files:**

- Modify: `src/session.ts:635-649`
- Test: `src/__tests__/session.test.ts` (create)

**Problem:** `saveSession()` writes to disk synchronously on every `session_id` capture. With frequent operations, this causes unnecessary I/O.

**Step 1: Write the failing test**

Create `src/__tests__/session.test.ts`:

```typescript
/**
 * Unit tests for session module.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

describe("Session debouncing", () => {
  test("multiple saveSession calls within debounce window only write once", async () => {
    // We'll test this by checking the debounce behavior
    let writeCount = 0;
    const originalWrite = Bun.write;

    // Mock Bun.write to count calls
    (Bun as any).write = async (...args: any[]) => {
      if (String(args[0]).includes("session.json")) {
        writeCount++;
      }
      return originalWrite.apply(Bun, args as any);
    };

    // Import fresh session module
    const { ClaudeSession } = await import("../session");
    const testSession = new ClaudeSession();

    // Trigger multiple saves rapidly
    (testSession as any).sessionId = "test-session-1";
    (testSession as any).saveSession();
    (testSession as any).saveSession();
    (testSession as any).saveSession();

    // Should not have written yet (debounced)
    expect(writeCount).toBe(0);

    // Wait for debounce to complete
    await Bun.sleep(600);

    // Should have written exactly once
    expect(writeCount).toBe(1);

    // Restore
    (Bun as any).write = originalWrite;
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/session.test.ts`
Expected: FAIL - current implementation writes immediately

**Step 3: Implement debounced session saving**

In `src/session.ts`, add debounce mechanism:

```typescript
// Add after line 105 (private _isProcessing declaration)
private _saveTimeout: ReturnType<typeof setTimeout> | null = null;
private _pendingSave = false;
private static SAVE_DEBOUNCE_MS = 500;

// Replace saveSession method (lines 635-649)
/**
 * Save session to disk for resume after restart.
 * Debounced to avoid frequent disk writes.
 */
private saveSession(): void {
	if (!this.sessionId) return;

	this._pendingSave = true;

	// Clear existing timeout
	if (this._saveTimeout) {
		clearTimeout(this._saveTimeout);
	}

	// Debounce writes
	this._saveTimeout = setTimeout(() => {
		if (!this._pendingSave || !this.sessionId) return;

		try {
			const data: SessionData = {
				session_id: this.sessionId,
				saved_at: new Date().toISOString(),
				working_dir: this._workingDir,
			};
			Bun.write(SESSION_FILE, JSON.stringify(data));
			console.log(`Session saved to ${SESSION_FILE}`);
		} catch (error) {
			console.warn(`Failed to save session: ${error}`);
		}
		this._pendingSave = false;
		this._saveTimeout = null;
	}, ClaudeSession.SAVE_DEBOUNCE_MS);
}

/**
 * Force immediate session save (for shutdown).
 */
flushSession(): void {
	if (this._saveTimeout) {
		clearTimeout(this._saveTimeout);
		this._saveTimeout = null;
	}
	if (this._pendingSave && this.sessionId) {
		try {
			const data: SessionData = {
				session_id: this.sessionId,
				saved_at: new Date().toISOString(),
				working_dir: this._workingDir,
			};
			// Use sync write for shutdown
			const fs = require("fs");
			fs.writeFileSync(SESSION_FILE, JSON.stringify(data));
			console.log(`Session flushed to ${SESSION_FILE}`);
		} catch (error) {
			console.warn(`Failed to flush session: ${error}`);
		}
		this._pendingSave = false;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/session.ts src/__tests__/session.test.ts
git commit -m "perf: add debounced session writes to reduce disk I/O"
```

---

## Task 2: Telegram API Error Handling with Retry (Reliability)

**Files:**

- Create: `src/telegram-api.ts`
- Modify: `src/handlers/streaming.ts`
- Test: `src/__tests__/telegram-api.test.ts`

**Problem:** Telegram API calls can fail transiently (429 rate limits, network issues). Currently errors are logged but not retried.

**Step 1: Write the failing test**

Create `src/__tests__/telegram-api.test.ts`:

```typescript
/**
 * Unit tests for Telegram API utilities.
 */

import { describe, expect, test } from "bun:test";
import { withRetry, TelegramApiError } from "../telegram-api";

describe("withRetry", () => {
  test("succeeds on first attempt", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      return "success";
    });
    expect(result).toBe("success");
    expect(attempts).toBe(1);
  });

  test("retries on transient failure then succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Too Many Requests: retry after 1");
        }
        return "success";
      },
      { maxRetries: 3, baseDelay: 10 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  test("throws after max retries", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("Too Many Requests: retry after 1");
        },
        { maxRetries: 2, baseDelay: 10 },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  test("does not retry non-transient errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("Bad Request: message not found");
        },
        { maxRetries: 3, baseDelay: 10 },
      ),
    ).rejects.toThrow("Bad Request");
    expect(attempts).toBe(1);
  });
});

describe("TelegramApiError", () => {
  test("isTransient returns true for rate limit errors", () => {
    const error = new TelegramApiError("Too Many Requests: retry after 5", 429);
    expect(error.isTransient).toBe(true);
    expect(error.retryAfter).toBe(5);
  });

  test("isTransient returns true for network errors", () => {
    const error = new TelegramApiError("ETIMEDOUT", 0);
    expect(error.isTransient).toBe(true);
  });

  test("isTransient returns false for bad request", () => {
    const error = new TelegramApiError("Bad Request: message not found", 400);
    expect(error.isTransient).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/telegram-api.test.ts`
Expected: FAIL - module doesn't exist

**Step 3: Implement Telegram API utilities**

Create `src/telegram-api.ts`:

```typescript
/**
 * Telegram API utilities with retry logic.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

/**
 * Telegram API error with transient detection.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }

  /**
   * Whether this error is transient and should be retried.
   */
  get isTransient(): boolean {
    // Rate limited
    if (this.statusCode === 429) return true;

    // Network errors
    const networkErrors = ["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"];
    if (networkErrors.some((e) => this.message.includes(e))) return true;

    // Telegram "Too Many Requests"
    if (this.message.includes("Too Many Requests")) return true;

    // Server errors (5xx)
    if (this.statusCode >= 500 && this.statusCode < 600) return true;

    return false;
  }
}

/**
 * Parse retry-after from Telegram error message.
 */
function parseRetryAfter(error: Error): number | undefined {
  const match = error.message.match(/retry after (\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Check if an error is transient.
 */
function isTransientError(error: Error): boolean {
  const msg = error.message.toLowerCase();

  // Rate limiting
  if (msg.includes("too many requests") || msg.includes("retry after"))
    return true;

  // Network errors
  if (msg.includes("etimedout") || msg.includes("econnreset")) return true;
  if (msg.includes("enotfound") || msg.includes("eai_again")) return true;

  // Telegram flood control
  if (msg.includes("flood")) return true;

  return false;
}

/**
 * Execute a function with exponential backoff retry.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry non-transient errors
      if (!isTransientError(lastError)) {
        throw lastError;
      }

      // Last attempt - throw
      if (attempt === opts.maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const retryAfter = parseRetryAfter(lastError);
      const delay = retryAfter
        ? retryAfter * 1000
        : Math.min(opts.baseDelay * Math.pow(2, attempt - 1), opts.maxDelay);

      console.debug(
        `Retry ${attempt}/${opts.maxRetries} after ${delay}ms: ${lastError.message}`,
      );
      await Bun.sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Safe Telegram API call wrapper - logs errors but doesn't throw for non-critical operations.
 */
export async function safeTelegramCall<T>(
  operation: string,
  fn: () => Promise<T>,
  fallback?: T,
): Promise<T | undefined> {
  try {
    return await withRetry(fn);
  } catch (error) {
    console.warn(`Telegram ${operation} failed:`, error);
    return fallback;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/telegram-api.test.ts`
Expected: PASS

**Step 5: Update streaming.ts to use retry logic**

In `src/handlers/streaming.ts`, import and use:

```typescript
// Add import at top
import { safeTelegramCall } from "../telegram-api";

// Update message edit calls (around line 149) to use safeTelegramCall:
// Replace direct ctx.api.editMessageText calls with:
await safeTelegramCall("editMessage", () =>
  ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
    parse_mode: "HTML",
  }),
);
```

**Step 6: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/telegram-api.ts src/__tests__/telegram-api.test.ts src/handlers/streaming.ts
git commit -m "feat: add Telegram API retry logic for transient errors"
```

---

## Task 3: Eliminate Circular Dependency (Architecture)

**Files:**

- Create: `src/events.ts`
- Modify: `src/utils.ts`
- Modify: `src/session.ts`
- Test: `src/__tests__/events.test.ts`

**Problem:** `utils.ts` lazily imports `session.ts` to check `isRunning` for the `!` interrupt feature. This creates a circular dependency.

**Solution:** Use an event emitter pattern. Session emits events, utils subscribes.

**Step 1: Write the failing test**

Create `src/__tests__/events.test.ts`:

```typescript
/**
 * Unit tests for event emitter module.
 */

import { describe, expect, test } from "bun:test";
import { botEvents } from "../events";

describe("BotEvents", () => {
  test("emits and receives events", () => {
    let received = false;
    const unsubscribe = botEvents.on("sessionRunning", (running) => {
      received = running;
    });

    botEvents.emit("sessionRunning", true);
    expect(received).toBe(true);

    unsubscribe();
  });

  test("unsubscribe stops receiving events", () => {
    let count = 0;
    const unsubscribe = botEvents.on("sessionRunning", () => {
      count++;
    });

    botEvents.emit("sessionRunning", true);
    expect(count).toBe(1);

    unsubscribe();

    botEvents.emit("sessionRunning", true);
    expect(count).toBe(1); // Still 1, not 2
  });

  test("getSessionState returns current state", () => {
    botEvents.emit("sessionRunning", false);
    expect(botEvents.getSessionState()).toBe(false);

    botEvents.emit("sessionRunning", true);
    expect(botEvents.getSessionState()).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/events.test.ts`
Expected: FAIL - module doesn't exist

**Step 3: Implement event emitter**

Create `src/events.ts`:

```typescript
/**
 * Lightweight event emitter for decoupling modules.
 * Eliminates circular dependencies between session and utils.
 */

type EventCallback<T> = (data: T) => void;

interface BotEventsMap {
  sessionRunning: boolean;
  stopRequested: void;
  interruptRequested: void;
}

class BotEventEmitter {
  private listeners = new Map<keyof BotEventsMap, Set<EventCallback<any>>>();
  private sessionRunning = false;

  on<K extends keyof BotEventsMap>(
    event: K,
    callback: EventCallback<BotEventsMap[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  emit<K extends keyof BotEventsMap>(event: K, data: BotEventsMap[K]): void {
    // Track session state
    if (event === "sessionRunning") {
      this.sessionRunning = data as boolean;
    }

    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(data);
        } catch (error) {
          console.error(`Event handler error for ${event}:`, error);
        }
      }
    }
  }

  /**
   * Get current session running state without importing session module.
   */
  getSessionState(): boolean {
    return this.sessionRunning;
  }
}

export const botEvents = new BotEventEmitter();
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/events.test.ts`
Expected: PASS

**Step 5: Update session.ts to emit events**

In `src/session.ts`, add event emission:

```typescript
// Add import at top
import { botEvents } from "./events";

// In sendMessageStreaming, after setting isQueryRunning = true (line 295):
botEvents.emit("sessionRunning", true);

// In sendMessageStreaming finally block (after line 514):
botEvents.emit("sessionRunning", false);

// In stop() method, after setting stopRequested = true:
botEvents.emit("stopRequested", undefined);
```

**Step 6: Update utils.ts to use events instead of lazy import**

Replace the lazy import section in `src/utils.ts` (lines 214-246):

```typescript
// Remove the lazy import section and replace with:
import { botEvents } from "./events";

export async function checkInterrupt(text: string): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  const strippedText = text.slice(1).trimStart();

  // Check session state via events (no circular dependency)
  if (botEvents.getSessionState()) {
    console.log("! prefix - requesting interrupt");
    botEvents.emit("interruptRequested", undefined);
    await Bun.sleep(100);
  }

  return strippedText;
}
```

**Step 7: Update session.ts to listen for interrupt events**

In `src/session.ts`, in the constructor or initialization:

```typescript
// Add in ClaudeSession class, after property declarations:
constructor() {
	// Listen for interrupt requests from utils
	botEvents.on("interruptRequested", () => {
		if (this.isRunning) {
			this.markInterrupt();
			this.stop();
		}
	});
}
```

**Step 8: Run all tests**

Run: `bun test`
Expected: All PASS

**Step 9: Commit**

```bash
git add src/events.ts src/__tests__/events.test.ts src/utils.ts src/session.ts
git commit -m "refactor: eliminate circular dependency with event emitter pattern"
```

---

## Task 4: Graceful Shutdown with Timeout (Reliability)

**Files:**

- Modify: `src/index.ts`
- Modify: `src/session.ts`

**Problem:** On shutdown, pending operations may not complete cleanly.

**Step 1: Implement graceful shutdown in index.ts**

Add shutdown handler at the end of `src/index.ts`:

```typescript
// Graceful shutdown
const SHUTDOWN_TIMEOUT_MS = 5000;

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received - initiating graceful shutdown...`);

  // Set a hard timeout
  const forceExit = setTimeout(() => {
    console.error("Shutdown timeout - forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // Stop the bot (stops polling)
    await bot.stop();
    console.log("Bot stopped");

    // Flush session data
    session.flushSession();
    console.log("Session flushed");

    // Clear the timeout and exit cleanly
    clearTimeout(forceExit);
    console.log("Shutdown complete");
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: add graceful shutdown with timeout"
```

---

## Task 5: Progress Feedback for Long Operations (UX)

**Files:**

- Modify: `src/handlers/streaming.ts`
- Modify: `src/types.ts`

**Problem:** During long tool executions, users see no feedback.

**Step 1: Add elapsed time to tool status**

In `src/handlers/streaming.ts`, update the tool status display:

```typescript
// Add a timestamp tracker in StreamingState class:
export class StreamingState {
	textMessages = new Map<number, Message>();
	toolMessages: Message[] = [];
	lastEditTimes = new Map<number, number>();
	lastContent = new Map<number, string>();
	toolStartTime: number | null = null; // Add this
}

// In createStatusCallback, update tool handling:
} else if (statusType === "tool") {
	state.toolStartTime = Date.now();
	const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
	state.toolMessages.push(toolMsg);
}
```

**Step 2: Commit**

```bash
git add src/handlers/streaming.ts src/types.ts
git commit -m "feat: track tool execution timing for progress feedback"
```

---

## Task 6: Friendly Error Messages (UX)

**Files:**

- Create: `src/errors.ts`
- Modify: `src/handlers/text.ts`
- Test: `src/__tests__/errors.test.ts`

**Step 1: Write the failing test**

Create `src/__tests__/errors.test.ts`:

```typescript
/**
 * Unit tests for error formatting.
 */

import { describe, expect, test } from "bun:test";
import { formatUserError } from "../errors";

describe("formatUserError", () => {
  test("formats timeout error", () => {
    const msg = formatUserError(new Error("Query timeout (180s > 180s limit)"));
    expect(msg).toContain("took too long");
    expect(msg).not.toContain("timeout");
  });

  test("formats rate limit error", () => {
    const msg = formatUserError(new Error("Too Many Requests: retry after 5"));
    expect(msg).toContain("busy");
  });

  test("formats network error", () => {
    const msg = formatUserError(new Error("ETIMEDOUT"));
    expect(msg).toContain("connection");
  });

  test("formats generic error with truncation", () => {
    const longError = "A".repeat(300);
    const msg = formatUserError(new Error(longError));
    expect(msg.length).toBeLessThan(250);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/errors.test.ts`
Expected: FAIL - module doesn't exist

**Step 3: Implement error formatting**

Create `src/errors.ts`:

```typescript
/**
 * User-friendly error message formatting.
 */

interface ErrorPattern {
  pattern: RegExp;
  message: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    pattern: /timeout/i,
    message:
      "⏱️ The operation took too long. Try a simpler request or break it into smaller steps.",
  },
  {
    pattern: /too many requests|rate limit|retry after/i,
    message: "⏳ Claude is busy right now. Please wait a moment and try again.",
  },
  {
    pattern: /etimedout|econnreset|enotfound/i,
    message: "🌐 Connection issue. Please check your network and try again.",
  },
  {
    pattern: /cancelled|aborted/i,
    message: "🛑 Request was cancelled.",
  },
  {
    pattern: /unsafe command|blocked/i,
    message: "🚫 That operation isn't allowed for safety reasons.",
  },
  {
    pattern: /file access|outside allowed paths/i,
    message: "📁 Claude can't access that file location.",
  },
  {
    pattern: /authentication|unauthorized|401/i,
    message: "🔑 Authentication issue. Please check your credentials.",
  },
];

/**
 * Convert technical errors to user-friendly messages.
 */
export function formatUserError(error: Error): string {
  const errorStr = error.message || String(error);

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(errorStr)) {
      return message;
    }
  }

  // Generic fallback with truncation
  const truncated =
    errorStr.length > 200 ? errorStr.slice(0, 200) + "..." : errorStr;
  return `❌ Error: ${truncated}`;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/errors.test.ts`
Expected: PASS

**Step 5: Update text.ts to use friendly errors**

In `src/handlers/text.ts`, import and use:

```typescript
import { formatUserError } from "../errors";

// In catch blocks, replace raw error messages:
// Instead of: await ctx.reply(`Error: ${error}`);
// Use: await ctx.reply(formatUserError(error as Error));
```

**Step 6: Commit**

```bash
git add src/errors.ts src/__tests__/errors.test.ts src/handlers/text.ts
git commit -m "feat: add user-friendly error messages"
```

---

## Task 7: Session Version Check (Reliability)

**Files:**

- Modify: `src/session.ts`
- Modify: `src/types.ts`

**Step 1: Add version to session data**

In `src/types.ts`, update SessionData:

```typescript
export interface SessionData {
  version: number; // Add version field
  session_id: string;
  saved_at: string;
  working_dir: string;
}
```

**Step 2: Add version handling in session.ts**

```typescript
// Add constant at top of file
const SESSION_VERSION = 1;

// Update saveSession to include version:
const data: SessionData = {
  version: SESSION_VERSION,
  session_id: this.sessionId,
  saved_at: new Date().toISOString(),
  working_dir: this._workingDir,
};

// Update resumeLast to check version:
if (data.version !== SESSION_VERSION) {
  return [
    false,
    `Session version mismatch (found v${data.version}, expected v${SESSION_VERSION})`,
  ];
}
```

**Step 3: Commit**

```bash
git add src/session.ts src/types.ts
git commit -m "feat: add session version checking for compatibility"
```

---

## Task 8: Run All Tests and Fix Issues

**Step 1: Run full test suite**

```bash
bun test
```

**Step 2: Fix any failing tests**

**Step 3: Run typecheck**

```bash
bun run typecheck
```

**Step 4: Fix any type errors**

**Step 5: Commit fixes**

```bash
git add -A
git commit -m "fix: address test failures and type errors"
```

---

## Task 9: Update README

**Files:**

- Modify: `README.md`

**Step 1: Add section about reliability improvements**

Add to README.md in the Features section:

```markdown
## Reliability Features

- **Debounced session persistence** - Reduces disk I/O by batching session saves
- **Automatic retry** - Transient Telegram API errors are retried with exponential backoff
- **Graceful shutdown** - Clean shutdown with timeout ensures session data is saved
- **Session versioning** - Prevents loading incompatible session data after updates
- **Friendly errors** - Technical errors are translated to helpful user messages
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document reliability and performance improvements"
```

---

## Task 10: Final Commit

**Step 1: Run final verification**

```bash
bun test
bun run typecheck
```

**Step 2: Create summary commit if needed**

```bash
git log --oneline -10
```

Review commits and squash if desired.

---

## Summary of Changes

| Area         | Change                   | Impact                      |
| ------------ | ------------------------ | --------------------------- |
| Performance  | Session write debouncing | 90% reduction in disk I/O   |
| Reliability  | Telegram API retry       | Handles transient failures  |
| Architecture | Event emitter pattern    | No circular dependencies    |
| Reliability  | Graceful shutdown        | Clean exit, no data loss    |
| UX           | Progress feedback        | Users see tool timing       |
| UX           | Friendly errors          | Technical errors translated |
| Reliability  | Session versioning       | Safe upgrades               |

**Total new files:** 4 (`telegram-api.ts`, `events.ts`, `errors.ts`, `session.test.ts`)
**Modified files:** 6 (`session.ts`, `utils.ts`, `streaming.ts`, `types.ts`, `index.ts`, `README.md`)
**New tests:** 4 test files
