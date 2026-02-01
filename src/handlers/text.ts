/**
 * Text message handler for Claude Telegram Bot.
 */

import { spawn } from "node:child_process";
import type { Context } from "grammy";
import { ALLOWED_USERS } from "../config";
import { isAuthorized, rateLimiter } from "../security";
import { session } from "../session";
import {
	auditLog,
	auditLogRateLimit,
	checkInterrupt,
	startTypingIndicator,
} from "../utils";
import { createStatusCallback, StreamingState } from "./streaming";

/**
 * Execute a shell command and return output.
 */
async function execShellCommand(
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

	// 2. Shell command shortcut: !command executes directly
	if (message.startsWith("!")) {
		const shellCmd = message.slice(1).trim();
		if (shellCmd) {
			const cwd = session.workingDir;
			await ctx.reply(
				`⚡ Running in <code>${cwd}</code>:\n<code>${shellCmd}</code>`,
				{
					parse_mode: "HTML",
				},
			);

			const { stdout, stderr, exitCode } = await execShellCommand(
				shellCmd,
				cwd,
			);
			const output = (stdout + stderr).trim();
			const maxLen = 4000;
			const truncated =
				output.length > maxLen
					? `${output.slice(0, maxLen)}...(truncated)`
					: output;

			if (exitCode === 0) {
				await ctx.reply(
					`✅ Exit code: ${exitCode}\n<pre>${truncated || "(no output)"}</pre>`,
					{
						parse_mode: "HTML",
					},
				);
			} else {
				await ctx.reply(
					`❌ Exit code: ${exitCode}\n<pre>${truncated || "(no output)"}</pre>`,
					{
						parse_mode: "HTML",
					},
				);
			}
			await auditLog(userId, username, "SHELL", shellCmd, `exit=${exitCode}`);
			return;
		}
	}

	// 3. Check for interrupt prefix
	message = await checkInterrupt(message);
	if (!message.trim()) {
		return;
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

	// 4. Store message for retry
	session.lastMessage = message;

	// 5. Mark processing started
	const stopProcessing = session.startProcessing();

	// 6. Start typing indicator
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
				await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
			}
			break; // Exit loop after handling error
		}
	}

	// 10. Cleanup
	stopProcessing();
	typing.stop();
}
