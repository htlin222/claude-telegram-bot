/**
 * Text message handler for Claude Telegram Bot.
 */

import { spawn } from "node:child_process";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { ALLOWED_USERS, MESSAGE_EFFECTS } from "../config";
import { formatUserError } from "../errors";
import { escapeHtml } from "../formatting";
import { queryQueue } from "../query-queue";
import {
	checkCommandSafety,
	isAuthorized,
	isPathAllowed,
	rateLimiter,
} from "../security";
import { sessionManager } from "../session";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { createOrReuseWorktree } from "../worktree";
import { createStatusCallback, StreamingState } from "./streaming";

/**
 * Execute a shell command and return output.
 */
export async function execShellCommand(
	command: string,
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const shellTimeoutMs = Number.parseInt(
		process.env.SHELL_COMMAND_TIMEOUT_MS || "30000",
		10,
	);
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], {
			cwd,
			timeout: shellTimeoutMs,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});

		proc.on("error", (err) => {
			resolve({ stdout, stderr: err.message, exitCode: 1 });
		});
	});
}

/**
 * Handle incoming text messages.
 */
export async function handleText(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const username = ctx.from?.username || "unknown";
	const chatId = ctx.chat?.id;
	let message = ctx.message?.text;

	if (!userId || !message || !chatId) {
		return;
	}

	// 1. Authorization check
	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized. Contact the bot owner for access.");
		return;
	}

	// Get session for this chat
	const session = sessionManager.getSession(chatId);

	// 1a. Pending voice edit - user is adding supplemental text to voice transcript
	const pendingVoice = session.consumePendingVoiceEdit(userId);
	if (pendingVoice) {
		// Combine original transcript with user's supplemental text
		message = `${pendingVoice} ${message}`;
		await ctx.reply(
			`✅ 已合併語音與補充文字：\n"${message.length > 200 ? `${message.slice(0, 200)}...` : message}"`,
		);
		// Continue to normal message processing below
	}

	// 1b. Pending worktree request
	const pendingWorktree = session.peekWorktreeRequest(userId, chatId);
	if (pendingWorktree) {
		const trimmed = message.trim();
		const command = trimmed.split(/\s+/)[0]?.toLowerCase() || "";
		const isCancel =
			command === "/cancel" ||
			command.startsWith("/cancel@") ||
			command === "cancel";
		if (command.startsWith("/") && !isCancel) {
			return;
		}
		if (isCancel) {
			session.clearWorktreeRequest(userId, chatId);
			await ctx.reply("❌ Worktree request cancelled.");
			return;
		}

		const result = await createOrReuseWorktree(session.workingDir, trimmed);
		if (!result.success) {
			await ctx.reply(
				`❌ ${result.message}\n\nSend another branch name or /cancel.`,
			);
			return;
		}

		if (!isPathAllowed(result.path)) {
			session.clearWorktreeRequest(userId, chatId);
			await ctx.reply(
				`❌ Worktree path is not in allowed directories:\n<code>${result.path}</code>\n\nUpdate ALLOWED_PATHS and try again.`,
				{
					parse_mode: "HTML",
					message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
				},
			);
			return;
		}

		// Save current session before switching
		session.flushSession();
		session.setWorkingDir(result.path);
		await session.kill();
		session.clearWorktreeRequest(userId, chatId);

		await ctx.reply(
			`✅ Switched to worktree:\n<code>${result.path}</code>\n\nBranch: <code>${result.branch}</code>`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// 2. Interrupt prefix: !! interrupts current query and sends message to Claude
	if (message.startsWith("!!")) {
		const interruptMsg = message.slice(2).trim();
		if (interruptMsg) {
			// Stop current query if running
			if (session.isRunning) {
				console.log("!! prefix - interrupting current query");
				session.markInterrupt();
				await session.stop();
				await Bun.sleep(100); // Small delay for clean interruption
			}
			// Continue with the message (will be sent to Claude below)
			message = interruptMsg;
		} else {
			return; // Empty message after !!
		}
	}
	// 3. Shell command shortcut: !command requires confirmation
	else if (message.startsWith("!")) {
		const shellCmd = message.slice(1).trim();
		if (shellCmd) {
			// Safety check - same as Claude's Bash tool
			const [isSafe, reason] = checkCommandSafety(shellCmd);
			if (!isSafe) {
				await ctx.reply(`🚫 Command blocked: ${reason}`, {
					message_effect_id: MESSAGE_EFFECTS.POOP,
				});
				await auditLog(userId, username, "SHELL_BLOCKED", shellCmd, reason);
				return;
			}

			// Show confirmation prompt with inline keyboard
			const cwd = session.workingDir;
			const encodedCmd = Buffer.from(shellCmd).toString("base64");
			const keyboard = new InlineKeyboard()
				.text("Run", `shell:run:${encodedCmd}`)
				.text("Cancel", "shell:cancel");

			await ctx.reply(
				`⚠️ <b>Confirm shell command</b>\n\n📁 <code>${cwd}</code>\n💻 <code>${shellCmd.length > 200 ? `${shellCmd.slice(0, 200)}...` : shellCmd}</code>`,
				{
					parse_mode: "HTML",
					reply_markup: keyboard,
				},
			);
			await auditLog(userId, username, "SHELL_PENDING", shellCmd);
			return;
		}
	}

	// 3. Rate limit check
	const [allowed, retryAfter] = rateLimiter.check(userId);
	if (!allowed) {
		await auditLogRateLimit(userId, username, retryAfter!);
		await ctx.reply(
			`⏳ Rate limited. Please wait ${retryAfter?.toFixed(1)} seconds.`,
		);
		return;
	}

	// 4. If session is busy, queue the message instead of executing
	if (session.isRunning) {
		const msgId = session.addPendingMessage(message);
		const preview =
			message.length > 50 ? `${message.slice(0, 50)}...` : message;
		await ctx.reply(
			`📥 Queued (${session.pendingCount} pending): <code>${preview}</code>\n\nUse /pending to view and execute.`,
			{ parse_mode: "HTML" },
		);
		await auditLog(userId, username, "QUEUED", message, msgId);
		return;
	}

	// 5. Store message for retry
	session.lastMessage = message;

	// 6. Mark processing started
	const stopProcessing = session.startProcessing();

	// 7. Start typing indicator
	const typing = startTypingIndicator(ctx);

	// 7. Create streaming state and callback
	let state = new StreamingState();
	let statusCallback = createStatusCallback(ctx, state, chatId);

	// 8. Send to Claude with retry logic for crashes
	const MAX_RETRIES = 1;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await queryQueue.sendMessage(
				message,
				username,
				userId,
				statusCallback,
				chatId,
				ctx,
			);

			// 9. Audit log
			await auditLog(userId, username, "TEXT", message, response);
			break; // Success - exit retry loop
		} catch (error) {
			const errorStr = String(error);
			const isClaudeCodeCrash = errorStr.includes("exited with code");

			// Clean up any partial messages from this attempt (both tool and text)
			for (const toolMsg of state.toolMessages) {
				try {
					await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
				} catch {
					// Ignore cleanup errors
				}
			}
			for (const [, textMsg] of state.textMessages) {
				try {
					await ctx.api.deleteMessage(textMsg.chat.id, textMsg.message_id);
				} catch {
					// Ignore cleanup errors
				}
			}

			// Retry on Claude Code crash (not user cancellation)
			if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
				console.log(
					`Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`,
				);
				await session.kill(); // Clear corrupted session
				await ctx.reply("⚠️ Claude crashed, retrying...");
				// Reset state for retry
				state = new StreamingState();
				statusCallback = createStatusCallback(ctx, state, chatId);
				continue;
			}

			// Final attempt failed or non-retryable error
			console.error("Error processing message:", error);

			// Check if it was a cancellation
			if (errorStr.includes("abort") || errorStr.includes("cancel")) {
				// Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
				const wasInterrupt = session.consumeInterruptFlag();
				if (!wasInterrupt) {
					await ctx.reply("🛑 Query stopped.");
				}
			} else if (isClaudeCodeCrash) {
				await session.kill(); // Clear possibly corrupted session
				await ctx.reply(
					"⚠️ Claude Code crashed and the session was reset. Please try again.",
					{
						message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
					},
				);
			} else {
				await ctx.reply(`❌ ${formatUserError(error as Error)}`, {
					message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
				});
			}
			break; // Exit loop after handling error
		}
	}

	// 10. Auto-process pending messages to maintain sequence order.
	// Messages get queued (via addPendingMessage) when a callback-triggered query
	// is running (callbacks bypass sequentialization). Without auto-processing,
	// the next text message would skip ahead of queued ones, causing sequence mismatch.
	while (session.pendingCount > 0) {
		const pending = session.getPendingMessages();
		const next = pending[0];
		if (!next) break;

		const pendingText = session.removePendingMessage(next.id);
		if (!pendingText) break;

		const preview =
			pendingText.length > 50 ? `${pendingText.slice(0, 50)}...` : pendingText;
		await ctx.reply(
			`🔄 Processing queued message: <code>${escapeHtml(preview)}</code>`,
			{ parse_mode: "HTML" },
		);

		session.lastMessage = pendingText;

		state = new StreamingState();
		statusCallback = createStatusCallback(ctx, state, chatId);

		try {
			const response = await queryQueue.sendMessage(
				pendingText,
				username,
				userId,
				statusCallback,
				chatId,
				ctx,
			);
			await auditLog(userId, username, "AUTO_PENDING", pendingText, response);
		} catch (error) {
			console.error("Error auto-processing pending message:", error);
			await ctx.reply(
				`❌ Failed to process queued message: ${formatUserError(error as Error)}`,
				{ message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN },
			);
			// Stop auto-processing on error but don't lose remaining messages
			break;
		}
	}

	// 11. Cleanup
	stopProcessing();
	typing.stop();
}
