/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration, bookmarks, file sending).
 */

import { unlinkSync } from "node:fs";
import { type Context, InlineKeyboard } from "grammy";
import { addBookmark, removeBookmark, resolvePath } from "../bookmarks";
import {
	AGENT_PROVIDERS,
	type AgentProviderId,
	ALLOWED_USERS,
	MESSAGE_EFFECTS,
} from "../config";
import { formatUserError } from "../errors";
import { escapeHtml } from "../formatting";
import { queryQueue } from "../query-queue";
import { isAuthorized, isPathAllowed } from "../security";
import { sessionManager } from "../session";
import { withRetry } from "../telegram-api";
import { auditLog, startTypingIndicator } from "../utils";
import { logNonCriticalError } from "../utils/error-logging";
import {
	createOrReuseWorktree,
	getCombinedDiff,
	getGitDiff,
	getMergeInfo,
	revertAllChanges,
} from "../worktree";
import { createStatusCallback, StreamingState } from "./streaming";
import { execShellCommand } from "./text";

/**
 * Handle callback queries from inline keyboards.
 */
export async function handleCallback(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const username = ctx.from?.username || "unknown";
	const chatId = ctx.chat?.id;
	const callbackData = ctx.callbackQuery?.data;

	if (!userId || !chatId || !callbackData) {
		await ctx.answerCallbackQuery();
		return;
	}

	// 1. Authorization check
	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.answerCallbackQuery({ text: "Unauthorized" });
		return;
	}

	// Get session for this chat
	const session = sessionManager.getSession(chatId);

	// 2. Handle voice confirmation callbacks
	if (callbackData.startsWith("voice:")) {
		await handleVoiceCallback(ctx, userId, username, chatId, callbackData);
		return;
	}

	// 3. Handle shell command confirmation
	if (callbackData.startsWith("shell:")) {
		await handleShellCallback(ctx, userId, username, callbackData);
		return;
	}

	// 2a. Handle timeout response callbacks
	if (callbackData.startsWith("timeout:")) {
		await handleTimeoutCallback(ctx, callbackData);
		return;
	}

	// 2b. Handle pending message callbacks
	if (callbackData.startsWith("pending:")) {
		await handlePendingCallback(ctx, userId, username, callbackData);
		return;
	}

	// 2c. Handle action callbacks (undo/test/commit)
	if (callbackData.startsWith("action:")) {
		await handleActionCallback(ctx, userId, username, callbackData);
		return;
	}

	// 2d. Handle bookmark callbacks
	if (callbackData.startsWith("bookmark:")) {
		await handleBookmarkCallback(ctx, callbackData);
		return;
	}

	// 2e. Handle file sending callbacks
	if (callbackData.startsWith("sendfile:")) {
		await handleSendFileCallback(ctx, callbackData);
		return;
	}

	// 2f. Handle handoff callbacks
	if (callbackData.startsWith("handoff:")) {
		await handleHandoffCallback(ctx, callbackData);
		return;
	}

	// 2g. Handle provider callbacks
	if (callbackData.startsWith("provider:")) {
		await handleProviderCallback(ctx, callbackData);
		return;
	}

	// 2h. Handle branch callbacks
	if (callbackData.startsWith("branch:")) {
		await handleBranchCallback(ctx, userId, chatId, callbackData);
		return;
	}

	// 2i. Handle merge callbacks
	if (callbackData.startsWith("merge:")) {
		await handleMergeCallback(ctx, userId, username, callbackData);
		return;
	}

	// 2j. Handle diff callbacks
	if (callbackData.startsWith("diff:")) {
		await handleDiffCallback(ctx, userId, username, callbackData);
		return;
	}

	// 2k. Handle restart callbacks
	if (callbackData.startsWith("restart:")) {
		await handleRestartCallback(ctx, callbackData);
		return;
	}

	// 3. Parse callback data: askuser:{request_id}:{option_index}
	if (!callbackData.startsWith("askuser:")) {
		await ctx.answerCallbackQuery();
		return;
	}

	const parts = callbackData.split(":");
	const requestId = parts[1];
	const optionPart = parts[2];
	if (parts.length !== 3 || !requestId || !optionPart) {
		await ctx.answerCallbackQuery({ text: "Invalid callback data" });
		return;
	}

	const optionIndex = Number.parseInt(optionPart, 10);

	// 3. Load request file
	const requestFile = `/tmp/ask-user-${requestId}.json`;
	let requestData: {
		question: string;
		options: string[];
		status: string;
	};

	try {
		const file = Bun.file(requestFile);
		const text = await file.text();
		requestData = JSON.parse(text);
	} catch (error) {
		console.error(`Failed to load ask-user request ${requestId}:`, error);
		await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
		return;
	}

	// 4. Get selected option
	if (optionIndex < 0 || optionIndex >= requestData.options.length) {
		await ctx.answerCallbackQuery({ text: "Invalid option" });
		return;
	}

	const selectedOption = requestData.options[optionIndex];
	if (!selectedOption) {
		await ctx.answerCallbackQuery({ text: "Invalid option" });
		return;
	}

	// 5. Update the message to show selection
	try {
		await ctx.editMessageText(`✓ ${selectedOption}`);
	} catch (error) {
		console.debug("Failed to edit callback message:", error);
	}

	// 6. Answer the callback
	await ctx.answerCallbackQuery({
		text: `Selected: ${selectedOption.slice(0, 50)}`,
	});

	// 7. Delete request file
	try {
		unlinkSync(requestFile);
	} catch (error) {
		console.debug("Failed to delete request file:", error);
	}

	// 8. Send the choice to Claude as a message
	const message = selectedOption;

	// Interrupt any running query - button responses are always immediate
	if (session.isRunning) {
		console.log("Interrupting current query for button response");
		await session.stop();
		// Small delay to ensure clean interruption
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	// Start typing
	const typing = startTypingIndicator(ctx);

	// Create streaming state
	const state = new StreamingState();
	const statusCallback = createStatusCallback(ctx, state, ctx.chat?.id);

	try {
		const response = await queryQueue.sendMessage(
			message,
			username,
			userId,
			statusCallback,
			chatId,
			ctx,
		);

		await auditLog(userId, username, "CALLBACK", message, response);
	} catch (error) {
		console.error("Error processing callback:", error);

		for (const toolMsg of state.toolMessages) {
			try {
				await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
			} catch (error) {
				console.debug("Failed to delete tool message:", error);
			}
		}

		const errorStr = String(error);
		const isClaudeCodeCrash = errorStr
			.toLowerCase()
			.includes("process exited with code");

		if (errorStr.includes("abort") || errorStr.includes("cancel")) {
			// Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
			const wasInterrupt = session.consumeInterruptFlag();
			if (!wasInterrupt) {
				await withRetry(() => ctx.reply("🛑 Query stopped."));
			}
		} else if (isClaudeCodeCrash) {
			await session.kill(); // Clear possibly corrupted session
			await withRetry(() =>
				ctx.reply(
					"⚠️ Claude Code crashed and the session was reset. Please try again.",
				),
			);
		} else {
			const userMessage = formatUserError(
				error instanceof Error ? error : new Error(errorStr),
			);
			await withRetry(() =>
				ctx.reply(`❌ ${userMessage}`, {
					message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
				}),
			);
		}
	} finally {
		typing.stop();
	}
}

/**
 * Handle shell command confirmation callbacks.
 * Format: shell:run:base64cmd or shell:cancel
 */
async function handleShellCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const parts = callbackData.split(":");
	const action = parts[1];

	if (action === "cancel") {
		await ctx.answerCallbackQuery({ text: "Cancelled" });
		try {
			await ctx.editMessageText("❌ Command cancelled");
		} catch {
			// Message may have been deleted
		}
		return;
	}

	if (action === "run") {
		const encodedCmd = parts.slice(2).join(":"); // Handle colons in base64
		let shellCmd: string;
		try {
			shellCmd = Buffer.from(encodedCmd, "base64").toString("utf-8");
		} catch {
			await ctx.answerCallbackQuery({ text: "Invalid command" });
			return;
		}

		await ctx.answerCallbackQuery({ text: "Running..." });

		const chatId = ctx.chat?.id;
		if (!chatId) return;
		const session = sessionManager.getSession(chatId);
		const cwd = session.workingDir;
		try {
			await ctx.editMessageText(
				`⚡ Running in <code>${cwd}</code>:\n<code>${shellCmd}</code>`,
				{ parse_mode: "HTML" },
			);
		} catch {
			// Message may have been deleted
		}

		const { stdout, stderr, exitCode } = await execShellCommand(shellCmd, cwd);
		const output = (stdout + stderr).trim();
		const maxLen = 4000;
		const truncated =
			output.length > maxLen
				? `${output.slice(0, maxLen)}...(truncated)`
				: output;

		const statusEmoji = exitCode === 0 ? "✅" : "❌";
		// 👍 Thumbs Up for success, 👎 Thumbs Down for failure
		const effectId =
			exitCode === 0 ? MESSAGE_EFFECTS.THUMBS_UP : MESSAGE_EFFECTS.THUMBS_DOWN;
		await ctx.reply(
			`${statusEmoji} Exit code: ${exitCode}\n<pre>${truncated || "(no output)"}</pre>`,
			{ parse_mode: "HTML", message_effect_id: effectId },
		);
		await auditLog(userId, username, "SHELL", shellCmd, `exit=${exitCode}`);
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}

/**
 * Handle pending message callbacks.
 * Format: pending:exec:{id} or pending:clear
 */
async function handlePendingCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const parts = callbackData.split(":");
	const action = parts[1];

	if (action === "clear") {
		session.clearPendingMessages();
		await ctx.answerCallbackQuery({ text: "Cleared all pending messages" });
		try {
			await ctx.editMessageText("📭 Pending messages cleared.");
		} catch {
			// Message may have been deleted
		}
		return;
	}

	if (action === "exec") {
		const msgId = parts[2];
		if (!msgId) {
			await ctx.answerCallbackQuery({ text: "Invalid message ID" });
			return;
		}

		const message = session.removePendingMessage(msgId);
		if (!message) {
			await ctx.answerCallbackQuery({ text: "Message not found or expired" });
			return;
		}

		// Check if session is busy
		if (session.isRunning) {
			// Re-queue the message
			session.addPendingMessage(message);
			await ctx.answerCallbackQuery({
				text: "Session busy. Message re-queued.",
			});
			return;
		}

		await ctx.answerCallbackQuery({ text: "Executing..." });

		// Delete the pending list message
		try {
			await ctx.deleteMessage();
		} catch {
			// Message may have been deleted
		}

		// Execute the message
		const typing = startTypingIndicator(ctx);
		const state = new StreamingState();
		const statusCallback = createStatusCallback(ctx, state, ctx.chat?.id);

		try {
			const response = await queryQueue.sendMessage(
				message,
				username,
				userId,
				statusCallback,
				ctx.chat?.id,
				ctx,
			);
			await auditLog(userId, username, "PENDING_EXEC", message, response);
		} catch (error) {
			console.error("Error executing pending message:", error);
			const userMessage = formatUserError(
				error instanceof Error ? error : new Error(String(error)),
			);
			await ctx.reply(`❌ ${userMessage}`, {
				message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
			});
		} finally {
			typing.stop();
		}
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}

/**
 * Handle action callbacks (undo/commit/yes/handoff).
 * Format: action:undo, action:commit, action:yes, action:handoff
 */
async function handleActionCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const action = callbackData.split(":")[1];

	// Delete the button message first
	try {
		await ctx.deleteMessage();
	} catch {
		// Message may have been deleted
	}

	// Handle handoff separately - it's not a command but a special action
	if (action === "handoff") {
		await ctx.answerCallbackQuery({ text: "Starting handoff..." });

		const chatId = ctx.chat?.id;
		if (!chatId) return;

		const session = sessionManager.getSession(chatId);
		const lastResponse = session.lastBotResponse;

		if (!lastResponse) {
			await ctx.reply("❌ No response to hand off");
			return;
		}

		// Save the response as handoff context
		session.setHandoffContext(lastResponse);

		// Kill session
		await session.kill();

		await ctx.reply(
			"✅ Session compressed. Last response will be used as context in your next message.",
			{ message_effect_id: MESSAGE_EFFECTS.CONFETTI },
		);
		return;
	}

	// Map action to Claude command
	const commandMap: Record<string, string> = {
		undo: "/undo",
		commit: "stage all and commit",
		yes: "yes",
	};

	const command = commandMap[action || ""];
	if (!command) {
		await ctx.answerCallbackQuery({ text: "Unknown action" });
		return;
	}

	await ctx.answerCallbackQuery({ text: `執行 ${command}...` });

	// Send the command to Claude
	const typing = startTypingIndicator(ctx);
	const state = new StreamingState();
	const statusCallback = createStatusCallback(ctx, state, ctx.chat?.id);

	try {
		const response = await queryQueue.sendMessage(
			command,
			username,
			userId,
			statusCallback,
			ctx.chat?.id,
			ctx,
		);
		await auditLog(userId, username, "ACTION", command, response);
	} catch (error) {
		console.error("Error executing action:", error);
		const userMessage = formatUserError(
			error instanceof Error ? error : new Error(String(error)),
		);
		await ctx.reply(`❌ 執行失敗: ${userMessage}`, {
			message_effect_id: MESSAGE_EFFECTS.POOP,
		});
	} finally {
		typing.stop();
	}
}

/**
 * Handle timeout check response callbacks.
 * Format: timeout:continue or timeout:abort
 */
async function handleTimeoutCallback(
	ctx: Context,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const action = callbackData.split(":")[1];

	if (action === "abort") {
		session.setTimeoutResponse("abort");
		await ctx.answerCallbackQuery({ text: "正在中斷..." });
		try {
			await ctx.editMessageText("🛑 已選擇中斷");
		} catch {
			// Message may have been deleted
		}
	} else if (action === "continue") {
		session.setTimeoutResponse("continue");
		await ctx.answerCallbackQuery({ text: "繼續執行" });
		try {
			await ctx.editMessageText("▶️ 繼續執行中...");
		} catch {
			// Message may have been deleted
		}
	} else {
		await ctx.answerCallbackQuery({ text: "Unknown action" });
	}
}

/**
 * Handle bookmark-related callbacks.
 */
async function handleBookmarkCallback(
	ctx: Context,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const parts = callbackData.split(":");
	if (parts.length < 2) {
		await ctx.answerCallbackQuery({ text: "Invalid bookmark action" });
		return;
	}

	const action = parts[1];
	const path = parts.slice(2).join(":"); // Path may contain colons

	switch (action) {
		case "noop":
			await ctx.answerCallbackQuery({ text: "Already bookmarked" });
			break;

		case "add":
			if (addBookmark(path)) {
				await ctx.answerCallbackQuery({ text: "Bookmark added!" });
				try {
					await ctx.editMessageReplyMarkup({ reply_markup: undefined });
				} catch {
					// Message may have been deleted
				}
			} else {
				await ctx.answerCallbackQuery({ text: "Already bookmarked" });
			}
			break;

		case "new":
			session.setWorkingDir(path);
			await ctx.answerCallbackQuery({
				text: `Changed to: ${path.slice(-30)}`,
			});
			await ctx.reply(
				`📁 Changed to: <code>${path}</code>\n\nSession cleared. Next message starts fresh.`,
				{ parse_mode: "HTML" },
			);
			break;

		case "remove":
			if (removeBookmark(path)) {
				await ctx.answerCallbackQuery({ text: "Bookmark removed" });
				// Remove the row from the keyboard by editing message
				try {
					// Re-fetch bookmarks and rebuild keyboard
					const { loadBookmarks } = await import("../bookmarks");
					const { InlineKeyboard } = await import("grammy");
					const bookmarks = loadBookmarks();

					if (bookmarks.length === 0) {
						await ctx.editMessageText(
							"📚 No bookmarks.\n\n" +
								"Use <code>/cd /path/to/dir</code> and click 'Add to bookmarks'.",
							{ parse_mode: "HTML" },
						);
					} else {
						let message = "📚 <b>Bookmarks</b>\n\n";
						const keyboard = new InlineKeyboard();
						for (const bookmark of bookmarks) {
							message += `📁 <code>${bookmark.path}</code>\n`;
							keyboard
								.text(`🆕 ${bookmark.name}`, `bookmark:new:${bookmark.path}`)
								.text("🗑️", `bookmark:remove:${bookmark.path}`)
								.row();
						}
						await ctx.editMessageText(message, {
							parse_mode: "HTML",
							reply_markup: keyboard,
						});
					}
				} catch {
					// Message may have been deleted
				}
			} else {
				await ctx.answerCallbackQuery({ text: "Bookmark not found" });
			}
			break;

		default:
			await ctx.answerCallbackQuery({ text: "Unknown action" });
	}
}

/**
 * Handle handoff callbacks.
 * Format: handoff:go or handoff:cancel
 */
async function handleHandoffCallback(
	ctx: Context,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const action = callbackData.split(":")[1];

	if (action === "cancel") {
		await ctx.answerCallbackQuery({ text: "Cancelled" });
		try {
			await ctx.editMessageText("❌ Handoff cancelled");
		} catch {
			// Message may have been deleted
		}
		return;
	}

	if (action === "go") {
		const lastResponse = session.lastBotResponse;

		if (!lastResponse) {
			await ctx.answerCallbackQuery({ text: "No response to hand off" });
			return;
		}

		// Save the response as handoff context
		session.setHandoffContext(lastResponse);

		// Kill session
		await session.kill();

		await ctx.answerCallbackQuery({ text: "Session compressed" });
		try {
			await ctx.editMessageText(
				"✅ Session compressed.\n\n" +
					"Your next message will include the previous context summary.",
			);
		} catch {
			// Message may have been deleted
		}
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}

/**
 * Handle provider switch callbacks.
 * Format: provider:set:{name}
 */
async function handleProviderCallback(
	ctx: Context,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const parts = callbackData.split(":");
	const action = parts[1];
	const provider = parts[2] as AgentProviderId | undefined;

	if (action !== "set" || !provider) {
		await ctx.answerCallbackQuery({ text: "Invalid provider action" });
		return;
	}

	if (!AGENT_PROVIDERS.includes(provider)) {
		await ctx.answerCallbackQuery({ text: "Unknown provider" });
		return;
	}

	const [success, message] = await session.setProvider(provider);
	if (!success) {
		await ctx.answerCallbackQuery({ text: message });
		return;
	}

	const current = session.currentProvider;
	const keyboard = new InlineKeyboard();
	for (const option of AGENT_PROVIDERS) {
		const label = option === current ? `✅ ${option}` : `⚪️ ${option}`;
		keyboard.text(label, `provider:set:${option}`).row();
	}

	try {
		await ctx.editMessageText(
			`🔀 <b>Provider Selection</b>\n\nCurrent: <b>${current}</b>\n\nChoose a provider below:`,
			{ parse_mode: "HTML", reply_markup: keyboard },
		);
	} catch {
		await ctx.reply(`🔀 ${message}`, { parse_mode: "HTML" });
	}

	await ctx.answerCallbackQuery({ text: `Switched to ${current}` });
}

/**
 * Handle branch switch callbacks.
 * Format: branch:switch:{base64}
 */
async function handleBranchCallback(
	ctx: Context,
	userId: number,
	chatId: number,
	callbackData: string,
): Promise<void> {
	const session = sessionManager.getSession(chatId);

	const prefix = "branch:switch:";
	if (!callbackData.startsWith(prefix)) {
		await ctx.answerCallbackQuery({ text: "Invalid branch action" });
		return;
	}

	let branch = "";
	try {
		const encoded = callbackData.slice(prefix.length);
		branch = Buffer.from(encoded, "base64").toString("utf-8");
	} catch {
		await ctx.answerCallbackQuery({ text: "Invalid branch data" });
		return;
	}

	if (!branch) {
		await ctx.answerCallbackQuery({ text: "Invalid branch" });
		return;
	}

	if (session.isRunning) {
		await ctx.answerCallbackQuery({ text: "Stop the current query first." });
		return;
	}

	const result = await createOrReuseWorktree(session.workingDir, branch);
	if (!result.success) {
		await ctx.answerCallbackQuery({ text: result.message });
		return;
	}

	if (!isPathAllowed(result.path)) {
		await ctx.answerCallbackQuery({
			text: "Worktree path is not in allowed directories.",
		});
		try {
			await ctx.reply(
				`❌ Worktree path is not in allowed directories:\n<code>${escapeHtml(result.path)}</code>\n\nUpdate ALLOWED_PATHS and try again.`,
				{ parse_mode: "HTML" },
			);
		} catch (error) {
			logNonCriticalError("branch allowlist reply", error);
		}
		return;
	}

	// Save current session before switching
	session.flushSession();
	session.setWorkingDir(result.path);
	await session.kill();
	session.clearWorktreeRequest(userId, chatId);

	try {
		await ctx.editMessageText(
			`✅ Switched to worktree:\n<code>${escapeHtml(result.path)}</code>\n\nBranch: <code>${escapeHtml(result.branch)}</code>`,
			{ parse_mode: "HTML" },
		);
	} catch {
		await ctx.reply(
			`✅ Switched to worktree:\n<code>${escapeHtml(result.path)}</code>\n\nBranch: <code>${escapeHtml(result.branch)}</code>`,
			{ parse_mode: "HTML" },
		);
	}

	await ctx.answerCallbackQuery({ text: `Switched to ${result.branch}` });
}

/**
 * Handle file sending callbacks.
 * Format: sendfile:base64encodedpath
 */
async function handleSendFileCallback(
	ctx: Context,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const { existsSync } = await import("node:fs");
	const { basename } = await import("node:path");
	const { InputFile } = await import("grammy");

	// Decode the file path (base64 encoded to handle special chars)
	const encodedPath = callbackData.slice("sendfile:".length);
	let filePath: string;
	try {
		filePath = Buffer.from(encodedPath, "base64").toString("utf-8");
	} catch {
		await ctx.answerCallbackQuery({ text: "Invalid file path" });
		return;
	}

	const resolvedPath = resolvePath(filePath, session.workingDir);

	// Check file exists
	if (!existsSync(resolvedPath)) {
		await ctx.answerCallbackQuery({ text: "File not found" });
		return;
	}

	if (!isPathAllowed(resolvedPath)) {
		await ctx.answerCallbackQuery({ text: "Access denied" });
		await ctx.reply(
			`❌ Access denied: <code>${escapeHtml(resolvedPath)}</code>`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Send the file
	try {
		await ctx.answerCallbackQuery({ text: "Sending file..." });
		const fileName = basename(resolvedPath);
		await ctx.replyWithDocument(new InputFile(resolvedPath, fileName));
	} catch (error) {
		console.error("Failed to send file:", error);
		await ctx.reply(`❌ Failed to send file: ${String(error).slice(0, 100)}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
	}
}

/**
 * Handle merge callbacks.
 * Format: merge:confirm:{base64branch} or merge:cancel
 */
async function handleMergeCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	if (callbackData === "merge:cancel") {
		await ctx.answerCallbackQuery({ text: "Merge cancelled" });
		try {
			await ctx.editMessageText("❌ Merge cancelled.");
		} catch (error) {
			logNonCriticalError("merge cancel edit", error);
		}
		return;
	}

	const prefix = "merge:confirm:";
	if (!callbackData.startsWith(prefix)) {
		await ctx.answerCallbackQuery({ text: "Invalid merge action" });
		return;
	}

	let branchToMerge = "";
	try {
		const encoded = callbackData.slice(prefix.length);
		branchToMerge = Buffer.from(encoded, "base64").toString("utf-8");
	} catch {
		await ctx.answerCallbackQuery({ text: "Invalid branch data" });
		return;
	}

	if (!branchToMerge) {
		await ctx.answerCallbackQuery({ text: "Invalid branch" });
		return;
	}

	if (session.isRunning) {
		await ctx.answerCallbackQuery({ text: "Stop the current query first." });
		return;
	}

	// Get merge info to find main worktree
	const info = await getMergeInfo(session.workingDir);
	if (!info.success) {
		await ctx.answerCallbackQuery({ text: info.message });
		return;
	}

	if (!isPathAllowed(info.mainWorktreePath)) {
		await ctx.answerCallbackQuery({
			text: "Main worktree path is not in allowed directories.",
		});
		await ctx.reply(
			`❌ Main worktree path is not in allowed directories:\n<code>${escapeHtml(info.mainWorktreePath)}</code>\n\nUpdate ALLOWED_PATHS and try again.`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Switch to main worktree
	session.flushSession();
	session.setWorkingDir(info.mainWorktreePath);
	await session.kill();

	try {
		await ctx.editMessageText(
			`🔀 Switched to <code>${escapeHtml(info.mainBranch)}</code> worktree.\n\nMerging <code>${escapeHtml(branchToMerge)}</code>...`,
			{ parse_mode: "HTML" },
		);
	} catch (error) {
		logNonCriticalError("merge status edit", error);
	}

	await ctx.answerCallbackQuery({ text: `Merging ${branchToMerge}...` });

	// Send merge command to Claude
	const mergePrompt = `Merge the branch "${branchToMerge}" into "${info.mainBranch}".

Steps:
1. Run \`git merge ${branchToMerge}\`
2. If there are merge conflicts, resolve them intelligently
3. After resolving, stage and commit the merge
4. Show me the result

If the merge is clean, just complete it. If there are conflicts, explain what you're doing to resolve them.`;

	const typing = startTypingIndicator(ctx);
	const state = new StreamingState();
	const statusCallback = createStatusCallback(ctx, state, chatId);

	try {
		const response = await queryQueue.sendMessage(
			mergePrompt,
			username,
			userId,
			statusCallback,
			chatId,
		);

		await auditLog(userId, username, "MERGE", branchToMerge, response);
	} catch (error) {
		console.error("Merge error:", error);
		await ctx.reply(`❌ Merge failed: ${String(error).slice(0, 200)}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
	} finally {
		typing.stop();
	}
}

/**
 * Handle diff callbacks.
 * Format: diff:view:{base64opts}, diff:commit, diff:revert, diff:revert:confirm
 */
async function handleDiffCallback(
	ctx: Context,
	userId: number,
	username: string,
	callbackData: string,
): Promise<void> {
	const chatId = ctx.chat?.id;
	if (!chatId) return;
	const session = sessionManager.getSession(chatId);

	const parts = callbackData.split(":");
	const action = parts[1];

	if (action === "view") {
		// Decode options
		const encodedOpts = parts.slice(2).join(":");
		let opts = "all";
		try {
			opts = Buffer.from(encodedOpts, "base64").toString("utf-8");
		} catch {
			// Default to all
		}

		// Parse options
		const isStaged = opts === "staged";
		const file = opts.startsWith("file:") ? opts.slice(5) : undefined;

		// Get diff
		const result = isStaged
			? await getGitDiff(session.workingDir, { staged: true })
			: file
				? await getCombinedDiff(session.workingDir, { file })
				: await getCombinedDiff(session.workingDir);

		if (!result.success) {
			await ctx.answerCallbackQuery({ text: result.message });
			return;
		}

		if (!result.hasChanges) {
			await ctx.answerCallbackQuery({ text: "No changes to show" });
			return;
		}

		const diffLines = result.fullDiff.split("\n").length;
		const DIFF_LINE_THRESHOLD = 50;

		if (diffLines > DIFF_LINE_THRESHOLD) {
			// Send as file
			await ctx.answerCallbackQuery({ text: "Sending diff file..." });

			const { InputFile } = await import("grammy");
			const diffBuffer = Buffer.from(result.fullDiff, "utf-8");
			const MAX_DIFF_SIZE = 50 * 1024 * 1024;
			if (diffBuffer.length > MAX_DIFF_SIZE) {
				await ctx.answerCallbackQuery({ text: "Diff file too large" });
				await ctx.reply("❌ Diff is too large to send as a file.", {
					message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
				});
				return;
			}
			const filename = file
				? `${file.replace(/\//g, "_")}.diff`
				: "changes.diff";
			try {
				await ctx.replyWithDocument(new InputFile(diffBuffer, filename));
			} catch (error) {
				console.error("Failed to send diff file:", error);
				await ctx.reply(
					`❌ Failed to send diff file: ${String(error).slice(0, 100)}`,
				);
			}
		} else {
			// Send as HTML pre block
			await ctx.answerCallbackQuery({ text: "Showing diff..." });

			const escapedDiff = result.fullDiff
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");

			// Truncate if too long for Telegram message
			const maxLen = 4000;
			const truncated =
				escapedDiff.length > maxLen
					? `${escapedDiff.slice(0, maxLen)}...(truncated)`
					: escapedDiff;

			await ctx.reply(`<pre>${truncated}</pre>`, { parse_mode: "HTML" });
		}
		return;
	}

	if (action === "commit") {
		await ctx.answerCallbackQuery({ text: "Starting commit flow..." });

		// Delete the diff message
		try {
			await ctx.deleteMessage();
		} catch {
			// Message may have been deleted
		}

		// Send commit command to Claude
		const typing = startTypingIndicator(ctx);
		const state = new StreamingState();
		const statusCallback = createStatusCallback(ctx, state, chatId);

		try {
			const response = await queryQueue.sendMessage(
				"/commit",
				username,
				userId,
				statusCallback,
				chatId,
				ctx,
			);

			await auditLog(userId, username, "DIFF_COMMIT", "/commit", response);
		} catch (error) {
			console.error("Commit error:", error);
			await ctx.reply(`❌ Commit failed: ${String(error).slice(0, 200)}`, {
				message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
			});
		} finally {
			typing.stop();
		}
		return;
	}

	if (action === "revert") {
		const subAction = parts[2];

		if (subAction === "cancel") {
			await ctx.answerCallbackQuery({ text: "Cancelled" });
			try {
				await ctx.deleteMessage();
			} catch {
				// Message may have been deleted
			}
			return;
		}

		if (subAction === "confirm") {
			// Execute revert
			await ctx.answerCallbackQuery({ text: "Reverting..." });

			const result = await revertAllChanges(session.workingDir);

			try {
				await ctx.editMessageText(
					result.success ? "✅ All changes reverted." : `❌ ${result.message}`,
				);
			} catch {
				await ctx.reply(
					result.success ? "✅ All changes reverted." : `❌ ${result.message}`,
				);
			}

			await auditLog(
				userId,
				username,
				"DIFF_REVERT",
				"revert all",
				result.message,
			);
			return;
		}

		// Show confirmation dialog (no subAction)
		await ctx.answerCallbackQuery({ text: "Confirm revert?" });

		const keyboard = new InlineKeyboard()
			.text("⚠️ Yes, Revert All", "diff:revert:confirm")
			.text("Cancel", "diff:revert:cancel");

		try {
			await ctx.editMessageText(
				"⚠️ <b>Confirm Revert</b>\n\nThis will discard ALL uncommitted changes (staged and unstaged).\n\n<b>This action cannot be undone!</b>",
				{ parse_mode: "HTML", reply_markup: keyboard },
			);
		} catch {
			await ctx.reply(
				"⚠️ <b>Confirm Revert</b>\n\nThis will discard ALL uncommitted changes.\n\n<b>This action cannot be undone!</b>",
				{ parse_mode: "HTML", reply_markup: keyboard },
			);
		}
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}

/**
 * Handle voice confirmation callbacks.
 * Format: voice:confirm:{data}, voice:cancel, voice:edit:{data}
 */
async function handleVoiceCallback(
	ctx: Context,
	userId: number,
	username: string,
	chatId: number,
	callbackData: string,
): Promise<void> {
	const session = sessionManager.getSession(chatId);

	const parts = callbackData.split(":");
	const action = parts[1];

	if (action === "cancel") {
		await ctx.answerCallbackQuery({ text: "已取消" });
		try {
			await ctx.editMessageText("❌ 語音訊息已取消");
		} catch {
			// Message may have been deleted
		}
		return;
	}

	if (action === "confirm" || action === "edit") {
		const encodedData = parts.slice(2).join(":");
		let transcript = "";

		try {
			const data = JSON.parse(Buffer.from(encodedData, "base64").toString());
			transcript = data.transcript || "";
		} catch {
			await ctx.answerCallbackQuery({ text: "無效的資料" });
			return;
		}

		if (!transcript) {
			await ctx.answerCallbackQuery({ text: "找不到轉錄文字" });
			return;
		}

		if (action === "edit") {
			// Request user to send additional text
			await ctx.answerCallbackQuery({ text: "請輸入補充文字" });
			try {
				await ctx.editMessageText(
					`✏️ 原始轉錄：\n"${transcript}"\n\n請輸入您要補充的文字，將會附加在原文後面：`,
				);
			} catch {
				await ctx.reply(
					`✏️ 原始轉錄：\n"${transcript}"\n\n請輸入您要補充的文字：`,
				);
			}

			// Store transcript for the next message
			session.setPendingVoiceEdit(userId, transcript);
			return;
		}

		// action === "confirm"
		await ctx.answerCallbackQuery({ text: "正在處理..." });

		// Update message to show confirmation
		try {
			await ctx.editMessageText(`✅ 已確認：\n"${transcript}"`);
		} catch {
			// Message may have been deleted
		}

		// Send to Claude
		const typing = startTypingIndicator(ctx);
		const state = new StreamingState();
		const statusCallback = createStatusCallback(ctx, state, ctx.chat?.id);

		try {
			const response = await queryQueue.sendMessage(
				transcript,
				username,
				userId,
				statusCallback,
				chatId,
				ctx,
			);

			await auditLog(userId, username, "VOICE_CONFIRM", transcript, response);
		} catch (error) {
			console.error("Error processing voice confirmation:", error);

			for (const toolMsg of state.toolMessages) {
				try {
					await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
				} catch (error) {
					console.debug("Failed to delete tool message:", error);
				}
			}

			const errorStr = String(error);
			const isClaudeCodeCrash = errorStr
				.toLowerCase()
				.includes("process exited with code");

			if (errorStr.includes("abort") || errorStr.includes("cancel")) {
				const wasInterrupt = session.consumeInterruptFlag();
				if (!wasInterrupt) {
					await ctx.reply("🛑 Query stopped.");
				}
			} else if (isClaudeCodeCrash) {
				await session.kill();
				await ctx.reply(
					"⚠️ Claude Code crashed and the session was reset. Please try again.",
				);
			} else {
				const userMessage = formatUserError(
					error instanceof Error ? error : new Error(errorStr),
				);
				await ctx.reply(`❌ ${userMessage}`, {
					message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
				});
			}
		} finally {
			typing.stop();
		}
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}

/**
 * Handle restart confirmation callbacks.
 * Format: restart:confirm, restart:cancel, restart:start, restart:new, restart:status
 */
async function handleRestartCallback(
	ctx: Context,
	callbackData: string,
): Promise<void> {
	const action = callbackData.split(":")[1];

	if (action === "cancel") {
		await ctx.answerCallbackQuery({ text: "已取消" });
		try {
			await ctx.editMessageText("❌ 重啟已取消");
		} catch {
			// Message may have been deleted
		}
		return;
	}

	if (action === "confirm") {
		await ctx.answerCallbackQuery({ text: "正在重啟..." });

		// Delete the confirmation message
		try {
			await ctx.deleteMessage();
		} catch {
			// Message may have been deleted
		}

		// Execute restart
		const { executeRestart } = await import("./commands");
		await executeRestart(ctx, ctx.chat?.id);
		return;
	}

	// Handle quick action buttons after restart
	if (action === "start") {
		await ctx.answerCallbackQuery({ text: "執行 /start" });
		const { handleStart } = await import("./commands");
		await handleStart(ctx);
		return;
	}

	if (action === "new") {
		await ctx.answerCallbackQuery({ text: "執行 /new" });
		const { handleNew } = await import("./commands");
		await handleNew(ctx);
		return;
	}

	if (action === "status") {
		await ctx.answerCallbackQuery({ text: "執行 /status" });
		const { handleStatus } = await import("./commands");
		await handleStatus(ctx);
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}
