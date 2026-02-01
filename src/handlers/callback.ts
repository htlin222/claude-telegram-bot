/**
 * Callback query handler for Claude Telegram Bot.
 *
 * Handles inline keyboard button presses (ask_user MCP integration, bookmarks, file sending).
 */

import { unlinkSync } from "node:fs";
import type { Context } from "grammy";
import { addBookmark, removeBookmark } from "../bookmarks";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";
import { session } from "../session";
import { auditLog, startTypingIndicator } from "../utils";
import { createStatusCallback, StreamingState } from "./streaming";

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

	// 2. Handle bookmark callbacks
	if (callbackData.startsWith("bookmark:")) {
		await handleBookmarkCallback(ctx, callbackData);
		return;
	}

	// 2b. Handle file sending callbacks
	if (callbackData.startsWith("sendfile:")) {
		await handleSendFileCallback(ctx, callbackData);
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

	const optionIndex = parseInt(optionPart, 10);

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

		if (String(error).includes("abort") || String(error).includes("cancel")) {
			// Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
			const wasInterrupt = session.consumeInterruptFlag();
			if (!wasInterrupt) {
				await ctx.reply("🛑 Query stopped.");
			}
		} else {
			await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
		}
	} finally {
		typing.stop();
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
