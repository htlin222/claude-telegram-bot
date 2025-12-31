/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 */

import type { Context } from "grammy";
import type { PendingMediaGroup } from "../types";
import { session } from "../session";
import { ALLOWED_USERS, INTENT_BLOCK_THRESHOLD, TEMP_DIR, MEDIA_GROUP_TIMEOUT } from "../config";
import { isAuthorized, rateLimiter, classifyIntent } from "../security";
import { auditLog, auditLogBlocked, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

// Pending media groups buffer
const pendingMediaGroups = new Map<string, PendingMediaGroup>();

/**
 * Download a photo and return the local path.
 */
async function downloadPhoto(ctx: Context): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  // Get the largest photo
  const photo = photos[photos.length - 1];
  const file = await ctx.getFile();

  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const photoPath = `${TEMP_DIR}/photo_${timestamp}_${random}.jpg`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(photoPath, buffer);

  return photoPath;
}

/**
 * Process photos with Claude.
 */
async function processPhotos(
  ctx: Context,
  photoPaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Build prompt
  let prompt: string;
  if (photoPaths.length === 1) {
    prompt = caption
      ? `[Photo: ${photoPaths[0]}]\n\n${caption}`
      : `Please analyze this image: ${photoPaths[0]}`;
  } else {
    const pathsList = photoPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
    prompt = caption
      ? `[Photos:\n${pathsList}]\n\n${caption}`
      : `Please analyze these ${photoPaths.length} images:\n${pathsList}`;
  }

  // Intent classification on caption
  if (caption) {
    const intent = await classifyIntent(caption);
    if (!intent.safe && intent.confidence > INTENT_BLOCK_THRESHOLD) {
      console.warn(`Blocked photo from ${username}: ${intent.reason}`);
      await auditLogBlocked(userId, username, caption, intent.reason, intent.confidence);
      await ctx.reply("I can't help with that request.");
      return;
    }
  }

  // Start typing
  const typing = startTypingIndicator(ctx);

  // Create streaming state
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId
    );

    await auditLog(userId, username, "PHOTO", prompt, response);
  } catch (error) {
    console.error("Error processing photo:", error);

    for (const toolMsg of state.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch {
        // Ignore
      }
    }

    if (String(error).includes("abort") || String(error).includes("cancel")) {
      await ctx.reply("🛑 Query stopped.");
    } else {
      await ctx.reply(`❌ Error: ${String(error).slice(0, 200)}`);
    }
  } finally {
    typing.stop();
  }
}

/**
 * Process a buffered media group.
 */
async function processMediaGroup(mediaGroupId: string): Promise<void> {
  const group = pendingMediaGroups.get(mediaGroupId);
  if (!group) return;

  pendingMediaGroups.delete(mediaGroupId);

  const userId = group.ctx.from?.id;
  const username = group.ctx.from?.username || "unknown";
  const chatId = group.ctx.chat?.id;

  if (!userId || !chatId) return;

  // Update status message
  if (group.statusMsg) {
    try {
      await group.ctx.api.editMessageText(
        group.statusMsg.chat.id,
        group.statusMsg.message_id,
        `📷 Processing ${group.items.length} photos...`
      );
    } catch {
      // Ignore
    }
  }

  await processPhotos(group.ctx, group.items, group.caption, userId, username, chatId);

  // Delete status message
  if (group.statusMsg) {
    try {
      await group.ctx.api.deleteMessage(group.statusMsg.chat.id, group.statusMsg.message_id);
    } catch {
      // Ignore
    }
  }
}

/**
 * Handle incoming photo messages.
 */
export async function handlePhoto(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Download photo
  let photoPath: string;
  try {
    photoPath = await downloadPhoto(ctx);
  } catch (error) {
    console.error("Failed to download photo:", error);
    await ctx.reply("❌ Failed to download photo.");
    return;
  }

  // 3. Single photo - process immediately
  if (!mediaGroupId) {
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
      return;
    }

    await processPhotos(ctx, [photoPath], ctx.message?.caption, userId, username, chatId);
    return;
  }

  // 4. Media group - buffer with timeout
  if (!pendingMediaGroups.has(mediaGroupId)) {
    // Rate limit on first photo only
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
      return;
    }

    // Create new group
    const statusMsg = await ctx.reply("📷 Receiving photos...");

    pendingMediaGroups.set(mediaGroupId, {
      items: [photoPath],
      ctx,
      caption: ctx.message?.caption,
      statusMsg,
      timeout: setTimeout(() => processMediaGroup(mediaGroupId), MEDIA_GROUP_TIMEOUT),
    });
  } else {
    // Add to existing group
    const group = pendingMediaGroups.get(mediaGroupId)!;
    group.items.push(photoPath);

    // Update caption if this message has one
    if (ctx.message?.caption && !group.caption) {
      group.caption = ctx.message.caption;
    }

    // Reset timeout
    clearTimeout(group.timeout);
    group.timeout = setTimeout(() => processMediaGroup(mediaGroupId), MEDIA_GROUP_TIMEOUT);
  }
}
