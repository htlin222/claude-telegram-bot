/**
 * Text message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { session } from "../session";
import { ALLOWED_USERS, INTENT_BLOCK_THRESHOLD } from "../config";
import { isAuthorized, rateLimiter, classifyIntent } from "../security";
import { auditLog, auditLogBlocked, auditLogRateLimit, checkInterrupt, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

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

  // 2. Check for interrupt prefix
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
    return;
  }

  // 4. Intent classification (security filter)
  const intent = await classifyIntent(message);
  if (!intent.safe && intent.confidence > INTENT_BLOCK_THRESHOLD) {
    console.warn(`Blocked message from ${username}: ${intent.reason}`);
    await auditLogBlocked(userId, username, message, intent.reason, intent.confidence);
    await ctx.reply("I can't help with that request.");
    return;
  }

  // 5. Start typing indicator
  const typing = startTypingIndicator(ctx);

  // 6. Create streaming state and callback
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    // 7. Send to Claude with streaming
    const response = await session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId
    );

    // 8. Audit log
    await auditLog(userId, username, "TEXT", message, response);
  } catch (error) {
    console.error("Error processing message:", error);

    // Clean up any partial messages
    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch {
        // Ignore
      }
    }

    // Check if it was a cancellation
    if (String(error).includes("abort") || String(error).includes("cancel")) {
      await ctx.reply("🛑 Query stopped.");
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}
