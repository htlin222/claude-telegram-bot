/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V2.
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { StatusCallback, SessionData, TokenUsage } from "./types";

// Type for SDK V2 session (types may be incomplete in the SDK)
interface SDKSession {
  send(message: string): Promise<void>;
  receive(): AsyncIterable<SDKMessage>;
  close(): void;
}
import {
  WORKING_DIR,
  SAFETY_PROMPT,
  MCP_SERVERS,
  ALLOWED_PATHS,
  SESSION_FILE,
  THINKING_KEYWORDS,
  THINKING_DEEP_KEYWORDS,
} from "./config";
import { isPathAllowed, checkCommandSafety } from "./security";
import { formatToolStatus } from "./formatting";

/**
 * Determine thinking token budget based on message keywords.
 */
function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // Check deep thinking triggers first (more specific)
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  // Check normal thinking triggers
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  // Default: no thinking
  return 0;
}

/**
 * Extract text content from SDK message.
 */
function getTextFromMessage(msg: SDKMessage): string | null {
  if (msg.type !== "assistant") return null;

  const textParts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("") : null;
}

/**
 * Manages Claude Code sessions using the Agent SDK V2.
 */
class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning;
  }

  /**
   * Stop the currently running query.
   */
  async stop(): Promise<boolean> {
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      console.log("Stop requested - aborting current query");
      return true;
    }
    return false;
  }

  /**
   * Send a message to Claude with streaming updates via callback.
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] || String(thinkingTokens);

    // Build SDK options
    const options = {
      model: "claude-sonnet-4-20250514",
      cwd: WORKING_DIR,
      settingSources: ["project" as const],
      permissionMode: "bypassPermissions" as const,
      systemPrompt: SAFETY_PROMPT,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
    };

    if (this.sessionId && !isNewSession) {
      console.log(`RESUMING session ${this.sessionId.slice(0, 8)}... (thinking=${thinkingLabel})`);
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    // Create abort controller for cancellation
    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    // Response tracking
    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;

    try {
      // Create or resume session
      // Cast to SDKSession since V2 types may be incomplete
      const sessionInstance = (this.sessionId
        ? unstable_v2_resumeSession(this.sessionId, options)
        : unstable_v2_createSession(options)) as unknown as SDKSession;

      // Send the message
      await sessionInstance.send(message);

      // Process streaming response
      for await (const event of sessionInstance.receive()) {
        // Check for abort
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          this.saveSession();
        }

        // Handle different message types
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            // Thinking blocks
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            // Tool use blocks
            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // Safety check for Bash commands
              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  console.warn(`BLOCKED: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  throw new Error(`Unsafe command blocked: ${reason}`);
                }
              }

              // Safety check for file operations
              if (["Read", "Write", "Edit"].includes(toolName)) {
                const filePath = String(toolInput.file_path || "");
                if (filePath) {
                  const isTmpRead =
                    toolName === "Read" &&
                    (filePath.startsWith("/tmp/") ||
                      filePath.startsWith("/private/tmp/") ||
                      filePath.startsWith("/var/folders/") ||
                      filePath.includes("/.claude/"));

                  if (!isTmpRead && !isPathAllowed(filePath)) {
                    console.warn(`BLOCKED: File access outside allowed paths: ${filePath}`);
                    await statusCallback("tool", `Access denied: ${filePath}`);
                    throw new Error(`File access blocked: ${filePath}`);
                  }
                }
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback("segment_end", currentSegmentText, currentSegmentId);
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Format and show tool status
              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user
              if (!toolName.startsWith("mcp__ask-user")) {
                await statusCallback("tool", toolDisplay);
              }
            }

            // Text content
            if (block.type === "text") {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              // Stream text updates (throttled)
              const now = Date.now();
              if (now - lastTextUpdate > 500 && currentSegmentText.length > 20) {
                await statusCallback("text", currentSegmentText, currentSegmentId);
                lastTextUpdate = now;
              }
            }
          }
        }

        // Result message
        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          // Capture usage if available
          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            console.log("Usage:", this.lastUsage);
          }
        }
      }

      // Close the session
      sessionInstance.close();
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError = errorStr.includes("cancel") || errorStr.includes("abort");

      if (isCleanupError && (queryCompleted || this.stopRequested)) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // Emit final segment
    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  /**
   * Kill the current session (clear session_id).
   */
  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    console.log("Session cleared");
  }

  /**
   * Save session to disk for resume after restart.
   */
  private saveSession(): void {
    if (!this.sessionId) return;

    try {
      const data: SessionData = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
      };
      Bun.write(SESSION_FILE, JSON.stringify(data));
      console.log(`Session saved to ${SESSION_FILE}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  /**
   * Resume the last persisted session.
   */
  resumeLast(): [success: boolean, message: string] {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) {
        return [false, "No saved session found"];
      }

      const text = require("fs").readFileSync(SESSION_FILE, "utf-8");
      const data: SessionData = JSON.parse(text);

      if (!data.session_id) {
        return [false, "Saved session file is empty"];
      }

      if (data.working_dir && data.working_dir !== WORKING_DIR) {
        return [false, `Session was for different directory: ${data.working_dir}`];
      }

      this.sessionId = data.session_id;
      this.lastActivity = new Date();
      console.log(`Resumed session ${data.session_id.slice(0, 8)}... (saved at ${data.saved_at})`);
      return [true, `Resumed session \`${data.session_id.slice(0, 8)}...\` (saved at ${data.saved_at})`];
    } catch (error) {
      console.error(`Failed to resume session: ${error}`);
      return [false, `Failed to load session: ${error}`];
    }
  }
}

// Global session instance
export const session = new ClaudeSession();
