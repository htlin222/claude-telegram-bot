/**
 * Text message handler for Claude Telegram Bot.
 */

import { spawn } from "node:child_process";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { ALLOWED_USERS } from "../config";
import { formatUserError } from "../errors";
import { checkCommandSafety, isAuthorized, rateLimiter } from "../security";
import { session } from "../session";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { createStatusCallback, StreamingState } from "./streaming";

/**
 * Execute a shell command and return output.
 */
export async function execShellCommand(
	command: string,
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], {
			cwd,
			timeout: 30000, // 30s timeout
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
				await ctx.reply(`🚫 Command blocked: ${reason}`);
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
				`⚠️ <b>Confirm shell command</b>\n\n` +
					`📁 <code>${cwd}</code>\n` +
					`💻 <code>${shellCmd.length > 200 ? `${shellCmd.slice(0, 200)}...` : shellCmd}</code>`,
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
	let statusCallback = createStatusCallback(ctx, state);

	// 8. Send to Claude with retry logic for crashes
	const MAX_RETRIES = 1;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await session.sendMessageStreaming(
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

			// Clean up any partial messages from this attempt
			for (const toolMsg of state.toolMessages) {
				try {
					await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
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
				await ctx.reply(`⚠️ Claude crashed, retrying...`);
				// Reset state for retry
				state = new StreamingState();
				statusCallback = createStatusCallback(ctx, state);
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
			} else {
				await ctx.reply(`❌ ${formatUserError(error as Error)}`);
			}
			break; // Exit loop after handling error
		}
	}

	// 10. Cleanup
	stopProcessing();
	typing.stop();
}
