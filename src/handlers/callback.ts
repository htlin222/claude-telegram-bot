/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration, bookmarks, file sending).
 */

import { unlinkSync } from "node:fs";
import { type Context, InlineKeyboard } from "grammy";
import { addBookmark, removeBookmark } from "../bookmarks";
import {
	AGENT_PROVIDERS,
	ALLOWED_USERS,
	type AgentProviderId,
	MESSAGE_EFFECTS,
} from "../config";
import { isAuthorized } from "../security";
import { session } from "../session";
import { auditLog, startTypingIndicator } from "../utils";
import { createOrReuseWorktree, getMergeInfo } from "../worktree";
import { StreamingState, createStatusCallback } from "./streaming";
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

	// 2. Handle shell command confirmation
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
		await handleBranchCallback(ctx, callbackData);
		return;
	}

	// 2i. Handle merge callbacks
	if (callbackData.startsWith("merge:")) {
		await handleMergeCallback(ctx, userId, username, callbackData);
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
	const statusCallback = createStatusCallback(ctx, state);

	try {
		const response = await session.sendMessageStreaming(
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
				await ctx.reply("🛑 Query stopped.");
			}
		} else if (isClaudeCodeCrash) {
			await session.kill(); // Clear possibly corrupted session
			await ctx.reply(
				"⚠️ Claude Code crashed and the session was reset. Please try again.",
			);
		} else {
			await ctx.reply(`❌ Error: ${errorStr.slice(0, 200)}`);
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
		const statusCallback = createStatusCallback(ctx, state);

		try {
			const response = await session.sendMessageStreaming(
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
			await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
		} finally {
			typing.stop();
		}
		return;
	}

	await ctx.answerCallbackQuery({ text: "Unknown action" });
}

/**
 * Handle action callbacks (undo/test/commit).
 * Format: action:undo, action:test, action:commit
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

	// Map action to Claude command
	const commandMap: Record<string, string> = {
		undo: "/undo",
		test: "run unit tests",
		commit: "/commit",
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
	const statusCallback = createStatusCallback(ctx, state);

	try {
		const response = await session.sendMessageStreaming(
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
		await ctx.reply(`❌ 執行失敗: ${String(error).slice(0, 200)}`);
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
	callbackData: string,
): Promise<void> {
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

	// Save current session before switching
	session.flushSession();
	session.setWorkingDir(result.path);
	await session.kill();

	try {
		await ctx.editMessageText(
			`✅ Switched to worktree:\n<code>${result.path}</code>\n\nBranch: <code>${result.branch}</code>`,
			{ parse_mode: "HTML" },
		);
	} catch {
		await ctx.reply(
			`✅ Switched to worktree:\n<code>${result.path}</code>\n\nBranch: <code>${result.branch}</code>`,
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

	// Check file exists
	if (!existsSync(filePath)) {
		await ctx.answerCallbackQuery({ text: "File not found" });
		return;
	}

	// Send the file
	try {
		await ctx.answerCallbackQuery({ text: "Sending file..." });
		const fileName = basename(filePath);
		await ctx.replyWithDocument(new InputFile(filePath, fileName));
	} catch (error) {
		console.error("Failed to send file:", error);
		await ctx.reply(`❌ Failed to send file: ${String(error).slice(0, 100)}`);
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
	if (callbackData === "merge:cancel") {
		await ctx.answerCallbackQuery({ text: "Merge cancelled" });
		try {
			await ctx.editMessageText("❌ Merge cancelled.");
		} catch {}
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

	// Switch to main worktree
	session.flushSession();
	session.setWorkingDir(info.mainWorktreePath);
	await session.kill();

	try {
		await ctx.editMessageText(
			`🔀 Switched to <code>${info.mainBranch}</code> worktree.\n\nMerging <code>${branchToMerge}</code>...`,
			{ parse_mode: "HTML" },
		);
	} catch {}

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
	const statusCallback = createStatusCallback(ctx, state);
	const chatId = ctx.chat?.id;

	try {
		const response = await session.sendMessageStreaming(
			mergePrompt,
			username,
			userId,
			statusCallback,
			chatId,
		);

		await auditLog(userId, username, "MERGE", branchToMerge, response);
	} catch (error) {
		console.error("Merge error:", error);
		await ctx.reply(`❌ Merge failed: ${String(error).slice(0, 200)}`);
	} finally {
		typing.stop();
	}
}
