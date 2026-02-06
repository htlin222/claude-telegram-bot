/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession class manages Claude Code sessions using the Agent SDK V1.
 * V1 supports full options (cwd, mcpServers, settingSources, etc.)
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { Context } from "grammy";
import { resolvePath } from "./bookmarks";
import {
	AGENT_PROVIDER,
	AGENT_PROVIDERS,
	type AgentProviderId,
	ALLOWED_PATHS,
	MAX_CONCURRENT_QUERIES,
	MCP_SERVERS,
	QUERY_TIMEOUT_MS,
	SAFETY_PROMPT,
	SESSION_FILE,
	STREAMING_THROTTLE_MS,
	TEMP_PATHS,
	THINKING_DEEP_KEYWORDS,
	THINKING_KEYWORDS,
	TIMEOUT_PROMPT_WAIT_MS,
	WORKING_DIR,
} from "./config";
import { botEvents } from "./events";
import { formatToolStatus } from "./formatting";
import { checkPendingAskUserRequests } from "./handlers/streaming";
import {
	ClaudeProvider,
	type ClaudeOptions as Options,
	type ClaudeQuery as Query,
	type ClaudeSDKMessage as SDKMessage,
} from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import type { AgentProvider } from "./providers/types";
import { checkCommandSafety, isPathAllowed } from "./security";
import type { SessionData, StatusCallback, TokenUsage } from "./types";

const SESSION_VERSION = 1;
const PENDING_WORKTREE_TIMEOUT_MS = Number.parseInt(
	process.env.PENDING_WORKTREE_TIMEOUT_MS || String(10 * 60 * 1000),
	10,
);

/**
 * Determine thinking token budget based on message keywords.
 * Exported for testing.
 */
export function getThinkingLevel(message: string): number {
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
 * Note: Currently unused but kept for potential future use.
 */
function _getTextFromMessage(msg: SDKMessage): string | null {
	if (msg.type !== "assistant") return null;

	const textParts: string[] = [];
	for (const block of msg.message.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return textParts.length > 0 ? textParts.join("") : null;
}

function createProvider(
	providerId: AgentProviderId,
): AgentProvider<SDKMessage, Options, Query> {
	if (providerId === "codex") {
		return new CodexProvider();
	}
	return new ClaudeProvider();
}

function resolveProvider(): {
	provider: AgentProvider<SDKMessage, Options, Query>;
	id: AgentProviderId;
} {
	const id = AGENT_PROVIDER;
	return { provider: createProvider(id), id };
}

/**
 * Manages Claude Code sessions using the Agent SDK V1.
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
	lastMessage: string | null = null;
	lastBotResponse: string | null = null;

	// Model and mode settings
	currentModel: "sonnet" | "opus" | "haiku" = "sonnet";
	forceThinking: number | null = null; // Tokens for next message, then resets
	planMode = false;

	// Cumulative usage tracking
	totalInputTokens = 0;
	totalOutputTokens = 0;
	totalCacheReadTokens = 0;

	// File checkpointing for /undo
	private _queryInstance: Query | null = null;
	private _userMessageUuids: string[] = [];

	// Debounced session saving
	private _saveTimeout: ReturnType<typeof setTimeout> | null = null;
	private _pendingSave = false;
	private readonly SAVE_DEBOUNCE_MS = Number.parseInt(
		process.env.SAVE_DEBOUNCE_MS || "500",
		10,
	);

	// Mutable working directory (can be changed with /cd)
	private _workingDir: string = WORKING_DIR;

	private abortController: AbortController | null = null;
	private isQueryRunning = false;
	private stopRequested = false;
	private _isProcessing = false;
	private _wasInterruptedByNewMessage = false;

	// Concurrent query tracking
	private static _activeQueries = 0;

	// Timeout check state
	private _lastTimeoutCheck = 0;
	private _timeoutResponse: "continue" | "abort" | null = null;

	// Last user message for retry functionality
	private _lastUserMessage: string | null = null;

	// Handoff context for session compression
	private _handoffContext: string | null = null;

	// Pending message queue
	private _pendingMessages: Array<{
		id: string;
		text: string;
		timestamp: Date;
	}> = [];

	// Pending worktree request
	private _pendingWorktreeRequests = new Map<
		string,
		{
			userId: number;
			chatId: number;
			createdAt: Date;
		}
	>();

	// Pending voice edit (stores transcript waiting for user to add supplemental text)
	private _pendingVoiceEdit: Map<number, string> = new Map();

	// Chat ID tracking for per-chat session management
	private _chatId: number | null = null;

	private provider: AgentProvider<SDKMessage, Options, Query>;
	private providerId: AgentProviderId;

	/**
	 * Set chat ID for this session (used for per-chat session management).
	 */
	setChatId(chatId: number): void {
		this._chatId = chatId;
	}

	/**
	 * Set the user's response to a timeout check prompt.
	 */
	setTimeoutResponse(response: "continue" | "abort"): void {
		this._timeoutResponse = response;
	}

	/**
	 * Get the last user message (for retry).
	 */
	getLastUserMessage(): string | null {
		return this._lastUserMessage;
	}

	/**
	 * Set handoff context to inject into next new session.
	 */
	setHandoffContext(context: string): void {
		this._handoffContext = context;
	}

	/**
	 * Get and clear handoff context.
	 */
	consumeHandoffContext(): string | null {
		const ctx = this._handoffContext;
		this._handoffContext = null;
		return ctx;
	}

	/**
	 * Add a message to the pending queue.
	 */
	addPendingMessage(text: string): string {
		const id = Math.random().toString(36).slice(2, 10);
		this._pendingMessages.push({ id, text, timestamp: new Date() });
		return id;
	}

	/**
	 * Get all pending messages.
	 */
	getPendingMessages(): Array<{ id: string; text: string; timestamp: Date }> {
		return [...this._pendingMessages];
	}

	/**
	 * Remove and return a pending message by ID.
	 */
	removePendingMessage(id: string): string | null {
		const index = this._pendingMessages.findIndex((m) => m.id === id);
		if (index === -1) return null;
		const [removed] = this._pendingMessages.splice(index, 1);
		return removed?.text ?? null;
	}

	/**
	 * Clear all pending messages.
	 */
	clearPendingMessages(): void {
		this._pendingMessages = [];
	}

	/**
	 * Get pending message count.
	 */
	get pendingCount(): number {
		return this._pendingMessages.length;
	}

	/**
	 * Store a transcript that's waiting for user to add supplemental text.
	 */
	setPendingVoiceEdit(userId: number, transcript: string): void {
		this._pendingVoiceEdit.set(userId, transcript);
	}

	/**
	 * Get and remove pending voice edit for a user.
	 */
	consumePendingVoiceEdit(userId: number): string | null {
		const transcript = this._pendingVoiceEdit.get(userId);
		if (transcript) {
			this._pendingVoiceEdit.delete(userId);
			return transcript;
		}
		return null;
	}

	constructor(provider?: AgentProvider<SDKMessage, Options, Query>) {
		if (provider) {
			this.provider = provider;
			this.providerId = provider.id as AgentProviderId;
		} else {
			const resolved = resolveProvider();
			this.provider = resolved.provider;
			this.providerId = resolved.id;
		}
		botEvents.on("interruptRequested", () => {
			if (this.isRunning) {
				this.markInterrupt();
				this.stop();
			}
		});
	}

	get workingDir(): string {
		return this._workingDir;
	}

	requestWorktree(userId: number, chatId: number): boolean {
		this.cleanupExpiredWorktreeRequests();
		const key = this.getWorktreeKey(userId, chatId);
		if (this._pendingWorktreeRequests.has(key)) {
			return false;
		}
		this._pendingWorktreeRequests.set(key, {
			userId,
			chatId,
			createdAt: new Date(),
		});
		return true;
	}

	peekWorktreeRequest(
		userId: number,
		chatId: number,
	): { chatId: number; createdAt: Date } | null {
		this.cleanupExpiredWorktreeRequests();
		const key = this.getWorktreeKey(userId, chatId);
		const request = this._pendingWorktreeRequests.get(key);
		if (!request) return null;
		return {
			chatId: request.chatId,
			createdAt: request.createdAt,
		};
	}

	clearWorktreeRequest(userId?: number, chatId?: number): void {
		if (userId !== undefined && chatId !== undefined) {
			const key = this.getWorktreeKey(userId, chatId);
			this._pendingWorktreeRequests.delete(key);
			return;
		}
		this._pendingWorktreeRequests.clear();
	}

	private getWorktreeKey(userId: number, chatId: number): string {
		return `${userId}:${chatId}`;
	}

	private cleanupExpiredWorktreeRequests(): void {
		if (this._pendingWorktreeRequests.size === 0) return;
		const now = Date.now();
		for (const [key, request] of this._pendingWorktreeRequests) {
			if (now - request.createdAt.getTime() > PENDING_WORKTREE_TIMEOUT_MS) {
				this._pendingWorktreeRequests.delete(key);
			}
		}
	}

	get currentProvider(): AgentProviderId {
		return this.providerId;
	}

	async setProvider(providerId: AgentProviderId): Promise<[boolean, string]> {
		if (!AGENT_PROVIDERS.includes(providerId)) {
			return [false, `Unknown provider: ${providerId}`];
		}
		if (this.isRunning) {
			return [false, "Session is running. Stop it before switching provider."];
		}
		if (this.providerId === providerId) {
			return [false, `Already using provider: ${providerId}`];
		}

		await this.kill();
		this.provider = createProvider(providerId);
		this.providerId = providerId;

		return [
			true,
			`Switched provider to ${providerId}. Session cleared; next message starts fresh.`,
		];
	}

	/**
	 * Change the working directory for future sessions.
	 * Clears the current session since directory changed.
	 */
	setWorkingDir(dir: string): void {
		this._workingDir = dir;
		// Clear session when changing directory
		this.sessionId = null;
		console.log(`Working directory changed to: ${dir}`);
	}

	get isActive(): boolean {
		return this.sessionId !== null;
	}

	get isRunning(): boolean {
		return this.isQueryRunning || this._isProcessing;
	}

	/**
	 * Get current number of active queries across all sessions.
	 */
	static get activeQueryCount(): number {
		return ClaudeSession._activeQueries;
	}

	/**
	 * Check if the last stop was triggered by a new message interrupt (! prefix).
	 * Resets the flag when called. Also clears stopRequested so new messages can proceed.
	 */
	consumeInterruptFlag(): boolean {
		const was = this._wasInterruptedByNewMessage;
		this._wasInterruptedByNewMessage = false;
		if (was) {
			// Clear stopRequested so the new message can proceed
			this.stopRequested = false;
		}
		return was;
	}

	/**
	 * Mark that this stop is from a new message interrupt.
	 */
	markInterrupt(): void {
		this._wasInterruptedByNewMessage = true;
	}

	/**
	 * Clear the stopRequested flag (used after interrupt to allow new message to proceed).
	 */
	clearStopRequested(): void {
		this.stopRequested = false;
	}

	/**
	 * Mark processing as started.
	 * Returns a cleanup function to call when done.
	 */
	startProcessing(): () => void {
		this._isProcessing = true;
		return () => {
			this._isProcessing = false;
		};
	}

	/**
	 * Stop the currently running query or mark for cancellation.
	 * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
	 */
	async stop(): Promise<"stopped" | "pending" | false> {
		// If a query is actively running, abort it
		if (this.isQueryRunning && this.abortController) {
			this.stopRequested = true;
			this.abortController.abort();
			console.log("Stop requested - aborting current query");
			return "stopped";
		}

		// If processing but query not started yet
		if (this._isProcessing) {
			this.stopRequested = true;
			console.log("Stop requested - will cancel before query starts");
			return "pending";
		}

		return false;
	}

	/**
	 * Send a message to Claude with streaming updates via callback.
	 *
	 * @param ctx - grammY context for ask_user button display
	 */
	async sendMessageStreaming(
		message: string,
		username: string,
		userId: number,
		statusCallback: StatusCallback,
		chatId?: number,
		ctx?: Context,
	): Promise<string> {
		// Set chat context for ask_user MCP tool
		if (chatId) {
			process.env.TELEGRAM_CHAT_ID = String(chatId);
		}

		const isNewSession = !this.isActive;

		// Determine thinking tokens - forceThinking overrides keyword detection
		let thinkingTokens: number;
		if (this.forceThinking !== null) {
			thinkingTokens = this.forceThinking;
			this.forceThinking = null; // Reset after use
		} else {
			thinkingTokens = getThinkingLevel(message);
		}
		const thinkingLabel =
			{ 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
			String(thinkingTokens);

		// Determine model based on currentModel setting
		const modelMap = {
			sonnet: "claude-sonnet-4-5",
			opus: "claude-opus-4-5",
			haiku: "claude-haiku-3-5",
		};
		const modelId = modelMap[this.currentModel];

		// Store original message for retry functionality
		this._lastUserMessage = message;

		// Inject current date/time at session start so Claude doesn't need to call a tool for it
		let messageToSend = message;
		if (isNewSession) {
			const now = new Date();
			const datePrefix = `[Current date/time: ${now.toLocaleDateString(
				"en-US",
				{
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					timeZoneName: "short",
				},
			)}]\n\n`;

			// Check for handoff context from previous session
			const handoff = this.consumeHandoffContext();
			if (handoff) {
				messageToSend = `${datePrefix}[Previous session summary]\n${handoff}\n\n[New request]\n${message}`;
			} else {
				messageToSend = datePrefix + message;
			}
		}

		// Build SDK V1 options - supports all features
		const options: Options = {
			model: modelId,
			cwd: this._workingDir,
			settingSources: ["user", "project"],
			permissionMode: this.planMode ? "plan" : "bypassPermissions",
			allowDangerouslySkipPermissions: !this.planMode,
			systemPrompt: SAFETY_PROMPT,
			mcpServers: MCP_SERVERS,
			maxThinkingTokens: thinkingTokens,
			additionalDirectories: ALLOWED_PATHS,
			resume: this.sessionId || undefined,
			enableFileCheckpointing: true, // Enable /undo support
		};

		// Add Claude Code executable path if set (required for standalone builds)
		if (process.env.CLAUDE_CODE_PATH) {
			options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
		}

		if (this.sessionId && !isNewSession) {
			console.log(
				`RESUMING session ${this.sessionId.slice(
					0,
					8,
				)}... (thinking=${thinkingLabel})`,
			);
		} else {
			console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
			this.sessionId = null;
		}

		// Check if stop was requested during processing phase
		if (this.stopRequested) {
			console.log(
				"Query cancelled before starting (stop was requested during processing)",
			);
			this.stopRequested = false;
			throw new Error("Query cancelled");
		}

		// Check concurrent query limit
		if (ClaudeSession._activeQueries >= MAX_CONCURRENT_QUERIES) {
			console.warn(
				`Concurrent query limit reached (${ClaudeSession._activeQueries}/${MAX_CONCURRENT_QUERIES})`,
			);
			throw new Error(
				`Server busy: ${ClaudeSession._activeQueries} queries running. Please wait.`,
			);
		}

		// Create abort controller for cancellation
		this.abortController = new AbortController();
		this.isQueryRunning = true;
		ClaudeSession._activeQueries++;
		botEvents.emit("sessionRunning", true);
		this.stopRequested = false;
		this.queryStarted = new Date();
		this.currentTool = null;
		this._lastTimeoutCheck = Date.now(); // Reset timeout check
		this._timeoutResponse = null;

		// Response tracking
		const responseParts: string[] = [];
		let currentSegmentId = 0;
		let currentSegmentText = "";
		let lastTextUpdate = 0;
		let queryCompleted = false;
		let askUserTriggered = false;
		let suppressExitError = false;
		let forcedResponse: string | null = null;

		try {
			// Use provider query - supports all options including cwd, mcpServers, etc.
			const queryInstance = this.provider.createQuery({
				prompt: messageToSend,
				options,
				abortController: this.abortController,
			});

			// Store query instance for /undo support
			this._queryInstance = queryInstance;

			// Process streaming response
			for await (const event of queryInstance) {
				// Check for abort
				if (this.stopRequested) {
					console.log("Query aborted by user");
					break;
				}

				// Check for timeout - prompt user every QUERY_TIMEOUT_MS
				const elapsed = this.queryStarted
					? Date.now() - this.queryStarted.getTime()
					: 0;
				const timeSinceLastCheck = Date.now() - this._lastTimeoutCheck;

				// Check if we've hit a timeout interval (3 min, 6 min, 9 min, etc.)
				if (
					elapsed > QUERY_TIMEOUT_MS &&
					timeSinceLastCheck > QUERY_TIMEOUT_MS
				) {
					this._lastTimeoutCheck = Date.now();
					this._timeoutResponse = null;

					const minutes = Math.round(elapsed / 60000);
					console.log(`Query running for ${minutes} minutes, prompting user`);

					// Send timeout check prompt to user
					await statusCallback(
						"timeout_check",
						`⏱️ 已運作 ${minutes} 分鐘，要中斷嗎？`,
					);

					// Wait for user response (with timeout)
					const waitStart = Date.now();
					while (Date.now() - waitStart < TIMEOUT_PROMPT_WAIT_MS) {
						if (this._timeoutResponse === "abort") {
							console.log("User chose to abort query");
							this.abortController?.abort();
							throw new Error("Query cancelled by user");
						}
						if (this._timeoutResponse === "continue") {
							console.log("User chose to continue query");
							break;
						}
						if (this.stopRequested) {
							break; // Exit wait loop if stop requested
						}
						await new Promise((resolve) => setTimeout(resolve, 500));
					}

					// If no response, continue automatically
					if (this._timeoutResponse === null) {
						console.log("No user response, continuing automatically");
					}
					this._timeoutResponse = null;
				}

				// Capture session_id from first message
				if (!this.sessionId && event.session_id) {
					this.sessionId = event.session_id;
					console.log(`GOT session_id: ${this.sessionId.slice(0, 8)}...`);
					this.saveSession();
				}

				// Capture user message UUIDs for /undo checkpoints
				if (event.type === "user" && event.uuid) {
					this._userMessageUuids.push(event.uuid);
					console.log(`Checkpoint: user message ${event.uuid.slice(0, 8)}...`);
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
									// Allow reads from temp paths and .claude directories
									const isTmpRead =
										toolName === "Read" &&
										(TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
											filePath.includes("/.claude/"));

									if (!isTmpRead && !isPathAllowed(filePath)) {
										console.warn(
											`BLOCKED: File access outside allowed paths: ${filePath}`,
										);
										await statusCallback("tool", `Access denied: ${filePath}`);
										throw new Error(`File access blocked: ${filePath}`);
									}
								}
							}

							// Safety check for Codex file operations
							if (toolName === "CodexFileChange") {
								const changes = Array.isArray(toolInput.changes)
									? toolInput.changes
									: [];
								for (const change of changes) {
									const rawPath =
										change && typeof change === "object"
											? String((change as { path?: string }).path || "")
											: "";
									if (!rawPath) continue;
									const resolvedPath = resolvePath(rawPath, this._workingDir);
									if (!isPathAllowed(resolvedPath)) {
										console.warn(
											`BLOCKED: Codex file access outside allowed paths: ${resolvedPath}`,
										);
										await statusCallback(
											"tool",
											`Access denied: ${resolvedPath}`,
										);
										throw new Error(`File access blocked: ${resolvedPath}`);
									}
								}
							}

							// Segment ends when tool starts
							if (currentSegmentText) {
								await statusCallback(
									"segment_end",
									currentSegmentText,
									currentSegmentId,
								);
								currentSegmentId++;
								currentSegmentText = "";
							}

							// Format and show tool status
							const toolDisplay = formatToolStatus(toolName, toolInput);
							this.currentTool = toolDisplay;
							this.lastTool = toolDisplay;
							console.log(`Tool: ${toolDisplay}`);

							// Don't show tool status for ask_user - the buttons are self-explanatory
							if (!toolName.startsWith("mcp__ask-user")) {
								await statusCallback("tool", toolDisplay);
							}

							// Check for pending ask_user requests after ask-user MCP tool
							if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
								// Small delay to let MCP server write the file
								await new Promise((resolve) => setTimeout(resolve, 200));

								// Retry a few times in case of timing issues
								for (let attempt = 0; attempt < 3; attempt++) {
									const buttonsSent = await checkPendingAskUserRequests(
										ctx,
										chatId,
									);
									if (buttonsSent) {
										askUserTriggered = true;
										break;
									}
									if (attempt < 2) {
										await new Promise((resolve) => setTimeout(resolve, 100));
									}
								}
							}
						}

						// Text content
						if (block.type === "text") {
							responseParts.push(block.text);
							currentSegmentText += block.text;

							// Stream text updates (throttled)
							const now = Date.now();
							if (
								now - lastTextUpdate > STREAMING_THROTTLE_MS &&
								currentSegmentText.length > 20
							) {
								await statusCallback(
									"text",
									currentSegmentText,
									currentSegmentId,
								);
								lastTextUpdate = now;
							}
						}
					}

					// Break out of event loop if ask_user was triggered
					if (askUserTriggered) {
						break;
					}
				}

				// Result message
				if (event.type === "result") {
					console.log("Response complete");
					queryCompleted = true;

					// Capture usage if available
					if ("usage" in event && event.usage) {
						this.lastUsage = event.usage as TokenUsage;
						const u = this.lastUsage;
						// Accumulate totals
						this.totalInputTokens += u.input_tokens || 0;
						this.totalOutputTokens += u.output_tokens || 0;
						this.totalCacheReadTokens += u.cache_read_input_tokens || 0;
						console.log(
							`Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
								u.cache_read_input_tokens || 0
							} cache_create=${u.cache_creation_input_tokens || 0}`,
						);
					}
				}
			}

			// V1 query completes automatically when the generator ends
		} catch (error) {
			const errorStr = String(error).toLowerCase();
			const isExitError = errorStr.includes("process exited with code");
			const isCleanupError =
				errorStr.includes("cancel") || errorStr.includes("abort");
			const hasPartialResponse = responseParts.length > 0;
			const canSuppressExitError =
				isExitError &&
				(queryCompleted ||
					askUserTriggered ||
					this.stopRequested ||
					hasPartialResponse);

			if (
				(isCleanupError || canSuppressExitError) &&
				(queryCompleted ||
					askUserTriggered ||
					this.stopRequested ||
					hasPartialResponse)
			) {
				if (isExitError && hasPartialResponse && !queryCompleted) {
					suppressExitError = true;
					forcedResponse = responseParts.join("");
				}
				console.warn(`Suppressed post-completion error: ${error}`);
			} else {
				console.error(`Error in query: ${error}`);
				this.lastError = String(error).slice(0, 100);
				this.lastErrorTime = new Date();
				throw error;
			}
		} finally {
			this.isQueryRunning = false;
			ClaudeSession._activeQueries = Math.max(
				0,
				ClaudeSession._activeQueries - 1,
			);
			botEvents.emit("sessionRunning", false);
			botEvents.emit("queryFinished", undefined);
			this.abortController = null;
			this.queryStarted = null;
			this.currentTool = null;
		}

		this.lastActivity = new Date();
		this.lastError = null;
		this.lastErrorTime = null;

		// If ask_user was triggered, return early - user will respond via button
		if (askUserTriggered) {
			await statusCallback("done", "");
			return "[Waiting for user selection]";
		}

		// Emit final segment
		if (currentSegmentText) {
			await statusCallback("segment_end", currentSegmentText, currentSegmentId);
		}

		await statusCallback("done", "");

		const finalResponse =
			forcedResponse || responseParts.join("") || "No response from Claude.";
		this.lastBotResponse = finalResponse;
		return finalResponse;
	}

	/**
	 * Kill the current session (clear session_id).
	 */
	async kill(): Promise<void> {
		this.sessionId = null;
		this.lastActivity = null;
		this.clearPendingMessages();
		this.clearWorktreeRequest();
		// Reset usage totals
		this.totalInputTokens = 0;
		this.totalOutputTokens = 0;
		this.totalCacheReadTokens = 0;
		// Reset modes
		this.planMode = false;
		this.forceThinking = null;
		// Reset checkpoints
		this._queryInstance = null;
		this._userMessageUuids = [];
		console.log("Session cleared");
	}

	/**
	 * Check if undo is available (has checkpoints).
	 */
	get canUndo(): boolean {
		return this._queryInstance !== null && this._userMessageUuids.length > 0;
	}

	/**
	 * Get number of available undo checkpoints.
	 */
	get undoCheckpoints(): number {
		return this._userMessageUuids.length;
	}

	/**
	 * Undo file changes by rewinding to the last user message checkpoint.
	 * Returns [success, message].
	 */
	async undo(): Promise<[boolean, string]> {
		if (!this._queryInstance) {
			return [false, "No active session to undo"];
		}

		if (this._userMessageUuids.length === 0) {
			return [false, "No checkpoints available"];
		}

		// Get and remove the last user message UUID
		const targetUuid = this._userMessageUuids.pop();
		if (!targetUuid) {
			return [false, "No checkpoints available"];
		}

		try {
			console.log(`Rewinding files to checkpoint ${targetUuid.slice(0, 8)}...`);
			await this._queryInstance.rewindFiles(targetUuid);

			const remaining = this._userMessageUuids.length;
			return [
				true,
				`✅ Reverted file changes to checkpoint \`${targetUuid.slice(0, 8)}...\`\n${remaining} checkpoint${remaining !== 1 ? "s" : ""} remaining`,
			];
		} catch (error) {
			// Restore the checkpoint on failure
			this._userMessageUuids.push(targetUuid);
			console.error(`Undo failed: ${error}`);
			return [false, `Failed to undo: ${error}`];
		}
	}

	/**
	 * Estimate cost based on current model and usage.
	 */
	estimateCost(): { inputCost: number; outputCost: number; total: number } {
		// Pricing per 1M tokens (approximate as of 2024)
		const pricing = {
			sonnet: { input: 3, output: 15 },
			opus: { input: 15, output: 75 },
			haiku: { input: 0.25, output: 1.25 },
		};
		const rates = pricing[this.currentModel];

		const inputCost = (this.totalInputTokens / 1_000_000) * rates.input;
		const outputCost = (this.totalOutputTokens / 1_000_000) * rates.output;

		return {
			inputCost,
			outputCost,
			total: inputCost + outputCost,
		};
	}

	/**
	 * Save session to disk for resume after restart (debounced).
	 * Multiple calls within SAVE_DEBOUNCE_MS will only result in one write.
	 */
	private saveSession(): void {
		if (!this.sessionId) return;

		this._pendingSave = true;

		// Clear existing timeout if any
		if (this._saveTimeout) {
			clearTimeout(this._saveTimeout);
		}

		// Schedule the actual write
		this._saveTimeout = setTimeout(() => {
			this._doSaveSession();
		}, this.SAVE_DEBOUNCE_MS);
	}

	/**
	 * Actually perform the session write to disk.
	 */
	private _doSaveSession(): void {
		if (!this.sessionId || !this._pendingSave) return;

		this._pendingSave = false;
		this._saveTimeout = null;

		// If chat ID is set, delegate to SessionManager
		if (this._chatId !== null) {
			sessionManager.saveSession(this._chatId);
			return;
		}

		// Fallback: save to old global session file (deprecated)
		try {
			const data: SessionData = {
				version: SESSION_VERSION,
				chat_id: 0, // Legacy: use 0 for global session
				session_id: this.sessionId,
				saved_at: new Date().toISOString(),
				working_dir: this._workingDir,
			};
			// Use mode 0o600 for owner read/write only (security)
			writeFileSync(SESSION_FILE, JSON.stringify(data), { mode: 0o600 });
			console.log(`Session saved to ${SESSION_FILE}`);
		} catch (error) {
			console.warn(`Failed to save session: ${error}`);
		}
	}

	/**
	 * Immediately flush any pending session save to disk.
	 * Use this for graceful shutdown to ensure session is persisted.
	 */
	flushSession(): void {
		if (this._saveTimeout) {
			clearTimeout(this._saveTimeout);
			this._saveTimeout = null;
		}

		if (this._pendingSave || this.sessionId) {
			this._pendingSave = true; // Ensure _doSaveSession runs
			this._doSaveSession();
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

			const text = readFileSync(SESSION_FILE, "utf-8");
			const data: SessionData = JSON.parse(text);

			if (!data.session_id) {
				return [false, "Saved session file is empty"];
			}

			if (data.version !== SESSION_VERSION) {
				return [
					false,
					`Session version mismatch (found v${data.version ?? 0}, expected v${SESSION_VERSION})`,
				];
			}

			if (data.working_dir && data.working_dir !== this._workingDir) {
				return [
					false,
					`Session was for different directory: ${data.working_dir}`,
				];
			}

			this.sessionId = data.session_id;
			this.lastActivity = new Date();
			console.log(
				`Resumed session ${data.session_id.slice(0, 8)}... (saved at ${
					data.saved_at
				})`,
			);
			return [
				true,
				`Resumed session \`${data.session_id.slice(0, 8)}...\` (saved at ${
					data.saved_at
				})`,
			];
		} catch (error) {
			console.error(`Failed to resume session: ${error}`);
			return [false, `Failed to load session: ${error}`];
		}
	}
}

// Export class for testing
export { ClaudeSession };

// Session directory for per-chat sessions
const SESSION_DIR = "/tmp/claude-telegram-sessions/";
const IDLE_SESSION_CLEANUP_MS = Number.parseInt(
	process.env.IDLE_SESSION_CLEANUP_MS || String(24 * 60 * 60 * 1000), // 24 hours
	10,
);

/**
 * SessionManager manages multiple ClaudeSession instances (one per chat).
 */
class SessionManager {
	private sessions: Map<number, ClaudeSession> = new Map();

	constructor() {
		this.ensureSessionDir();
	}

	/**
	 * Ensure session directory exists.
	 */
	private ensureSessionDir(): void {
		if (!existsSync(SESSION_DIR)) {
			mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
			console.log(`Created session directory: ${SESSION_DIR}`);
		}
	}

	/**
	 * Get or create session for a chat.
	 */
	getSession(chatId: number): ClaudeSession {
		if (!this.sessions.has(chatId)) {
			const session = new ClaudeSession();

			// Try to load from disk
			const loaded = this.loadSessionFromDisk(chatId, session);

			if (!loaded) {
				// New session: use global default working dir
				session.setWorkingDir(WORKING_DIR);
			}

			// Set chat ID
			session.setChatId(chatId);

			this.sessions.set(chatId, session);
			console.log(`Created session for chat ${chatId}`);
		}
		return this.sessions.get(chatId)!;
	}

	/**
	 * Load session from disk for a specific chat.
	 */
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

	/**
	 * Save session to disk for a specific chat.
	 */
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

	/**
	 * Load all sessions from disk on startup.
	 */
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
					session.setChatId(chatId);
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

	/**
	 * Get all active sessions.
	 */
	getAllActiveSessions(): Array<{
		chatId: number;
		session: ClaudeSession;
	}> {
		return Array.from(this.sessions.entries()).map(([chatId, session]) => ({
			chatId,
			session,
		}));
	}

	/**
	 * Clean up idle sessions.
	 */
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

	/**
	 * Flush all sessions to disk (for graceful shutdown).
	 */
	flushAllSessions(): void {
		for (const [chatId, session] of this.sessions) {
			if (session.sessionId) {
				session.flushSession();
				this.saveSession(chatId);
			}
		}
	}
}

// Export singleton SessionManager
export const sessionManager = new SessionManager();

// Global session instance (DEPRECATED - will be removed)
// Use sessionManager.getSession(chatId) instead
export const session = new ClaudeSession();
