/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDFs and text files with media group buffering.
 */

import type { Context } from "grammy";
import * as pdfParse from "pdf-parse";
import type { PendingMediaGroup } from "../types";
import { session } from "../session";
import { ALLOWED_USERS, INTENT_BLOCK_THRESHOLD, TEMP_DIR, MEDIA_GROUP_TIMEOUT } from "../config";
import { isAuthorized, rateLimiter, classifyIntent } from "../security";
import { auditLog, auditLogBlocked, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

// Max file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Pending document groups
const pendingDocGroups = new Map<string, PendingMediaGroup>();

/**
 * Download a document and return the local path.
 */
async function downloadDocument(ctx: Context): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const file = await ctx.getFile();
  const fileName = doc.file_name || `doc_${Date.now()}`;

  // Sanitize filename
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const docPath = `${TEMP_DIR}/${safeName}`;

  // Download
  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`
  );
  const buffer = await response.arrayBuffer();
  await Bun.write(docPath, buffer);

  return docPath;
}

/**
 * Extract text from a document.
 */
async function extractText(filePath: string, mimeType?: string): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF extraction
  if (mimeType === "application/pdf" || extension === ".pdf") {
    const buffer = await Bun.file(filePath).arrayBuffer();
    // @ts-expect-error pdf-parse type issues
    const data = await pdfParse.default(Buffer.from(buffer));
    return data.text;
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

/**
 * Process documents with Claude.
 */
async function processDocuments(
  ctx: Context,
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  // Build prompt
  let prompt: string;
  if (documents.length === 1) {
    const doc = documents[0]!;
    prompt = caption
      ? `Document: ${doc.name}\n\nContent:\n${doc.content}\n\n---\n\n${caption}`
      : `Please analyze this document (${doc.name}):\n\n${doc.content}`;
  } else {
    const docList = documents
      .map((d, i) => `--- Document ${i + 1}: ${d.name} ---\n${d.content}`)
      .join("\n\n");
    prompt = caption
      ? `${documents.length} Documents:\n\n${docList}\n\n---\n\n${caption}`
      : `Please analyze these ${documents.length} documents:\n\n${docList}`;
  }

  // Intent classification on caption
  if (caption) {
    const intent = await classifyIntent(caption);
    if (!intent.safe && intent.confidence > INTENT_BLOCK_THRESHOLD) {
      console.warn(`Blocked document from ${username}: ${intent.reason}`);
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

    await auditLog(userId, username, "DOCUMENT", `[${documents.length} docs] ${caption || ""}`, response);
  } catch (error) {
    console.error("Error processing document:", error);

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
 * Process a buffered document group.
 */
async function processDocGroup(groupId: string): Promise<void> {
  const group = pendingDocGroups.get(groupId);
  if (!group) return;

  pendingDocGroups.delete(groupId);

  const userId = group.ctx.from?.id;
  const username = group.ctx.from?.username || "unknown";
  const chatId = group.ctx.chat?.id;

  if (!userId || !chatId) return;

  // Extract text from all documents
  const documents: Array<{ path: string; name: string; content: string }> = [];

  for (const path of group.items) {
    try {
      const name = path.split("/").pop() || "document";
      const content = await extractText(path);
      documents.push({ path, name, content });
    } catch (error) {
      console.error(`Failed to extract ${path}:`, error);
    }
  }

  if (documents.length === 0) {
    await group.ctx.reply("❌ Failed to extract any documents.");
    return;
  }

  // Update status message
  if (group.statusMsg) {
    try {
      await group.ctx.api.editMessageText(
        group.statusMsg.chat.id,
        group.statusMsg.message_id,
        `📄 Processing ${documents.length} documents...`
      );
    } catch {
      // Ignore
    }
  }

  await processDocuments(group.ctx, documents, group.caption, userId, username, chatId);

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
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId || !doc) {
    return;
  }

  // 1. Authorization check
  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  // 2. Check file size
  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  // 3. Check file type
  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText = TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");

  if (!isPdf && !isText) {
    await ctx.reply(
      `❌ Unsupported file type: ${extension || doc.mime_type}\n\n` +
        `Supported: PDF, ${TEXT_EXTENSIONS.join(", ")}`
    );
    return;
  }

  // 4. Download document
  let docPath: string;
  try {
    docPath = await downloadDocument(ctx);
  } catch (error) {
    console.error("Failed to download document:", error);
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  // 5. Single document - process immediately
  if (!mediaGroupId) {
    // Rate limit
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
      return;
    }

    try {
      const content = await extractText(docPath, doc.mime_type);
      await processDocuments(
        ctx,
        [{ path: docPath, name: fileName, content }],
        ctx.message?.caption,
        userId,
        username,
        chatId
      );
    } catch (error) {
      console.error("Failed to extract document:", error);
      await ctx.reply(`❌ Failed to process document: ${String(error).slice(0, 100)}`);
    }
    return;
  }

  // 6. Media group - buffer with timeout
  if (!pendingDocGroups.has(mediaGroupId)) {
    // Rate limit on first doc only
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (!allowed) {
      await auditLogRateLimit(userId, username, retryAfter!);
      await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
      return;
    }

    // Create new group
    const statusMsg = await ctx.reply("📄 Receiving documents...");

    pendingDocGroups.set(mediaGroupId, {
      items: [docPath],
      ctx,
      caption: ctx.message?.caption,
      statusMsg,
      timeout: setTimeout(() => processDocGroup(mediaGroupId), MEDIA_GROUP_TIMEOUT),
    });
  } else {
    // Add to existing group
    const group = pendingDocGroups.get(mediaGroupId)!;
    group.items.push(docPath);

    // Update caption if this message has one
    if (ctx.message?.caption && !group.caption) {
      group.caption = ctx.message.caption;
    }

    // Reset timeout
    clearTimeout(group.timeout);
    group.timeout = setTimeout(() => processDocGroup(mediaGroupId), MEDIA_GROUP_TIMEOUT);
  }
}
