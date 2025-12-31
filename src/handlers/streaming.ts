/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard } from "grammy";
import type { StatusCallback } from "../types";
import { convertMarkdownToHtml } from "../formatting";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(requestId: string, options: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display = option.length > 30 ? option.slice(0, 30) + "..." : option;
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
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("/tmp/ask-user-*.json");
  let buttonsSent = false;

  for await (const filepath of glob.scan({ absolute: true })) {
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
        console.log(`Sent ask_user keyboard: ${requestId}`);
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

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
}

/**
 * Delete tracked messages.
 */
export async function cleanupMessages(state: StreamingState, keepText = false): Promise<void> {
  // Delete tool messages
  for (const toolMsg of state.toolMessages) {
    try {
      // grammY messages don't have delete() method, need to use API
      // This will be handled by the context in the callback
    } catch {
      // Ignore errors
    }
  }

  if (!keepText) {
    for (const msg of state.textMessages.values()) {
      try {
        // Same as above
      } catch {
        // Ignore errors
      }
    }
  }
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(ctx: Context, state: StreamingState): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;
        const thinkingMsg = await ctx.reply(`🧠 <i>${preview}</i>`, { parse_mode: "HTML" });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create message
          const display = content.length > 4000 ? content.slice(0, 4000) + "..." : content;
          const formatted = convertMarkdownToHtml(display);
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
          } catch {
            const msg = await ctx.reply(formatted);
            state.textMessages.set(segmentId, msg);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > 500) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          const display = content.length > 4000 ? content.slice(0, 4000) + "..." : content;
          const formatted = convertMarkdownToHtml(display);
          try {
            await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
              parse_mode: "HTML",
            });
          } catch {
            try {
              await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted);
            } catch {
              // Ignore errors
            }
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (state.textMessages.has(segmentId) && content) {
          const msg = state.textMessages.get(segmentId)!;
          const formatted = convertMarkdownToHtml(content);

          if (formatted.length <= 4096) {
            try {
              await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
                parse_mode: "HTML",
              });
            } catch {
              // Ignore errors
            }
          } else {
            // Too long - delete and split
            try {
              await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
            } catch {
              // Ignore errors
            }
            for (let i = 0; i < formatted.length; i += 4000) {
              const chunk = formatted.slice(i, i + 4000);
              try {
                await ctx.reply(chunk, { parse_mode: "HTML" });
              } catch {
                await ctx.reply(chunk);
              }
            }
          }
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch {
            // Ignore errors
          }
        }
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
