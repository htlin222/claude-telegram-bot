/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { Message } from "grammy/types";
import {
	BUTTON_LABEL_MAX_LENGTH,
	MESSAGE_EFFECTS,
	STREAMING_THROTTLE_MS,
	TELEGRAM_MESSAGE_LIMIT,
	TELEGRAM_SAFE_LIMIT,
} from "../config";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import { safeTelegramCall } from "../telegram-api";
import type { StatusCallback } from "../types";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
	requestId: string,
	options: string[],
): InlineKeyboard {
	const keyboard = new InlineKeyboard();
	for (let idx = 0; idx < options.length; idx++) {
		const option = options[idx]!;
		// Truncate long options for button display
		const display =
			option.length > BUTTON_LABEL_MAX_LENGTH
				? `${option.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: option;
		const callbackData = `askuser:${requestId}:${idx}`;
		keyboard.text(display, callbackData).row();
	}
	return keyboard;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
	ctx: Context,
	chatId: number,
): Promise<boolean> {
	const glob = new Bun.Glob("ask-user-*.json");
	let buttonsSent = false;

	for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
		const filepath = `/tmp/${filename}`;
		try {
			const file = Bun.file(filepath);
			const text = await file.text();
			const data = JSON.parse(text);

			// Only process pending requests for this chat
			if (data.status !== "pending") continue;
			if (String(data.chat_id) !== String(chatId)) continue;

			const question = data.question || "Please choose:";
			const options = data.options || [];
			const requestId = data.request_id || "";

			if (options.length > 0 && requestId) {
				const keyboard = createAskUserKeyboard(requestId, options);
				await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
				buttonsSent = true;

				// Mark as sent
				data.status = "sent";
				await Bun.write(filepath, JSON.stringify(data));
			}
		} catch (error) {
			console.warn(`Failed to process ask-user file ${filepath}:`, error);
		}
	}

	return buttonsSent;
}

// Spinner frames for tool animation
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_SPINNER_INTERVAL_MS = Number.parseInt(
	process.env.TOOL_SPINNER_INTERVAL_MS || "3000",
	10,
); // Update every 3 seconds

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
	textMessages = new Map<number, Message>(); // segment_id -> telegram message
	toolMessages: Message[] = []; // ephemeral tool status messages
	lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
	lastContent = new Map<number, string>(); // segment_id -> last sent content
	toolStartTime: number | null = null; // timestamp when current tool started

	// Tool spinner state
	currentToolMsg: Message | null = null;
	currentToolContent = "";
	toolSpinnerInterval: ReturnType<typeof setInterval> | null = null;
	spinnerIndex = 0;

	/**
	 * Stop the tool spinner animation.
	 */
	stopToolSpinner(): void {
		if (this.toolSpinnerInterval) {
			clearInterval(this.toolSpinnerInterval);
			this.toolSpinnerInterval = null;
		}
		this.currentToolMsg = null;
		this.currentToolContent = "";
		this.spinnerIndex = 0;
	}
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
	ctx: Context,
	state: StreamingState,
): StatusCallback {
	return async (statusType: string, content: string, segmentId?: number) => {
		try {
			if (statusType === "thinking") {
				// Show thinking inline, compact (first 500 chars)
				const preview =
					content.length > 500 ? `${content.slice(0, 500)}...` : content;
				const escaped = escapeHtml(preview);
				const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
					parse_mode: "HTML",
				});
				state.toolMessages.push(thinkingMsg);
			} else if (statusType === "tool") {
				// Stop previous tool spinner if any
				state.stopToolSpinner();

				state.toolStartTime = Date.now();
				state.currentToolContent = content;
				state.spinnerIndex = 0;

				// Send initial tool message with spinner
				const initialContent = `${content} ${SPINNER_FRAMES[0]}`;
				const toolMsg = await ctx.reply(initialContent, { parse_mode: "HTML" });
				state.toolMessages.push(toolMsg);
				state.currentToolMsg = toolMsg;

				// Start spinner animation (every 3 seconds)
				state.toolSpinnerInterval = setInterval(async () => {
					if (!state.currentToolMsg) return;

					state.spinnerIndex = (state.spinnerIndex + 1) % SPINNER_FRAMES.length;
					const spinner = SPINNER_FRAMES[state.spinnerIndex];
					const newContent = `${state.currentToolContent} ${spinner}`;

					try {
						await ctx.api.editMessageText(
							state.currentToolMsg.chat.id,
							state.currentToolMsg.message_id,
							newContent,
							{ parse_mode: "HTML" },
						);
					} catch {
						// Message may have been deleted, stop spinner
						state.stopToolSpinner();
					}
				}, TOOL_SPINNER_INTERVAL_MS);
			} else if (statusType === "text" && segmentId !== undefined) {
				// New text segment means tool finished, stop spinner
				state.stopToolSpinner();
				const now = Date.now();
				const lastEdit = state.lastEditTimes.get(segmentId) || 0;

				if (!state.textMessages.has(segmentId)) {
					// New segment - create message
					const display =
						content.length > TELEGRAM_SAFE_LIMIT
							? `${content.slice(0, TELEGRAM_SAFE_LIMIT)}...`
							: content;
					const formatted = convertMarkdownToHtml(display);
					try {
						const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
						state.textMessages.set(segmentId, msg);
						state.lastContent.set(segmentId, formatted);
					} catch (htmlError) {
						// HTML parse failed, fall back to plain text
						console.debug("HTML reply failed, using plain text:", htmlError);
						const msg = await ctx.reply(formatted);
						state.textMessages.set(segmentId, msg);
						state.lastContent.set(segmentId, formatted);
					}
					state.lastEditTimes.set(segmentId, now);
				} else if (now - lastEdit > STREAMING_THROTTLE_MS) {
					// Update existing segment message (throttled)
					const msg = state.textMessages.get(segmentId)!;
					const display =
						content.length > TELEGRAM_SAFE_LIMIT
							? `${content.slice(0, TELEGRAM_SAFE_LIMIT)}...`
							: content;
					const formatted = convertMarkdownToHtml(display);
					// Skip if content unchanged
					if (formatted === state.lastContent.get(segmentId)) {
						return;
					}
					const editResult = await safeTelegramCall("editMessage", async () => {
						try {
							await ctx.api.editMessageText(
								msg.chat.id,
								msg.message_id,
								formatted,
								{ parse_mode: "HTML" },
							);
							return true;
						} catch (htmlError) {
							// HTML parse failed, try plain text
							console.debug("HTML edit failed, trying plain text:", htmlError);
							await ctx.api.editMessageText(
								msg.chat.id,
								msg.message_id,
								formatted,
							);
							return true;
						}
					});
					if (editResult) {
						state.lastContent.set(segmentId, formatted);
					}
					state.lastEditTimes.set(segmentId, now);
				}
			} else if (statusType === "segment_end" && segmentId !== undefined) {
				if (state.textMessages.has(segmentId) && content) {
					const msg = state.textMessages.get(segmentId)!;
					const formatted = convertMarkdownToHtml(content);

					// Skip if content unchanged
					if (formatted === state.lastContent.get(segmentId)) {
						return;
					}

					if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
						await safeTelegramCall("editFinalMessage", () =>
							ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
								parse_mode: "HTML",
							}),
						);
					} else {
						// Too long - delete and split
						try {
							await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
						} catch (error) {
							console.debug("Failed to delete message for splitting:", error);
						}
						for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
							const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
							try {
								await ctx.reply(chunk, { parse_mode: "HTML" });
							} catch (htmlError) {
								console.debug(
									"HTML chunk failed, using plain text:",
									htmlError,
								);
								await ctx.reply(chunk);
							}
						}
					}
				}
			} else if (statusType === "timeout_check") {
				// Show timeout prompt with inline keyboard
				const keyboard = new InlineKeyboard()
					.text("✋ 中斷", "timeout:abort")
					.text("▶️ 繼續", "timeout:continue");
				const timeoutMsg = await ctx.reply(content, {
					reply_markup: keyboard,
				});
				state.toolMessages.push(timeoutMsg); // Will be deleted when done
			} else if (statusType === "queued") {
				// User's query was queued - show position
				const queueMsg = await ctx.reply(`⏳ ${content}`);
				state.toolMessages.push(queueMsg);
			} else if (statusType === "queue_start") {
				// Queued query is now starting
				const startMsg = await ctx.reply(`🚀 ${content}`);
				state.toolMessages.push(startMsg);
			} else if (statusType === "done") {
				// Stop any running tool spinner
				state.stopToolSpinner();

				// Delete tool messages - text messages stay
				for (const toolMsg of state.toolMessages) {
					try {
						await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
					} catch (error) {
						console.debug("Failed to delete tool message:", error);
					}
				}

				// Show action buttons after response completes with confetti effect
				const actionKeyboard = new InlineKeyboard()
					.text("Undo", "action:undo")
					.text("Test", "action:test")
					.text("Commit", "action:commit");
				await ctx.reply("Done", {
					reply_markup: actionKeyboard,
					message_effect_id: MESSAGE_EFFECTS.CONFETTI,
				});
			}
		} catch (error) {
			console.error("Status callback error:", error);
		}
	};
}
