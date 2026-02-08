/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { existsSync, readFileSync } from "node:fs";
import { run } from "@grammyjs/runner";
import { Bot, InlineKeyboard } from "grammy";
import {
	ALLOWED_USERS,
	RESTART_FILE,
	TELEGRAM_TOKEN,
	WORKING_DIR,
	setBotUsername,
} from "./config";
import {
	handleBookmarks,
	handleBranch,
	handleCallback,
	handleCd,
	handleCompact,
	handleCost,
	handleDiff,
	handleDocument,
	handleDocx,
	handleFile,
	handleHandoff,
	handleHtml,
	handleImage,
	handleMerge,
	handleModel,
	handleNew,
	handlePdf,
	handlePending,
	handlePhoto,
	handlePlan,
	handleProvider,
	handleRestart,
	handleResume,
	handleRetry,
	handleSkill,
	handleStart,
	handleStatus,
	handleStop,
	handleText,
	handleThink,
	handleUndo,
	handleVoice,
	handleWorktree,
} from "./handlers";
import { session } from "./session";
import { safeUnlink } from "./utils/temp-cleanup";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// ============== Update Deduplication ==============
// Prevents processing the same Telegram update twice (e.g., during bot restarts,
// network retries, or Telegram server-side redelivery).
const DEDUP_WINDOW = 1000;
const processedUpdateIds = new Set<number>();
const updateIdQueue: number[] = [];

bot.use(async (ctx, next) => {
	const updateId = ctx.update.update_id;
	if (processedUpdateIds.has(updateId)) {
		console.log(`Skipping duplicate update ${updateId}`);
		return;
	}
	processedUpdateIds.add(updateId);
	updateIdQueue.push(updateId);
	while (updateIdQueue.length > DEDUP_WINDOW) {
		const old = updateIdQueue.shift();
		if (old !== undefined) processedUpdateIds.delete(old);
	}
	return next();
});

// Note: sequentialize removed - messages during active query are now queued
// and can be viewed/executed via /pending command

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("c", handleStop);
bot.command("kill", handleStop);
bot.command("dc", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);
bot.command("cd", handleCd);
bot.command("skill", handleSkill);
bot.command("file", handleFile);
bot.command("image", handleImage);
bot.command("pdf", handlePdf);
bot.command("docx", handleDocx);
bot.command("html", handleHtml);
bot.command("model", handleModel);
bot.command("provider", handleProvider);
bot.command("worktree", handleWorktree);
bot.command("branch", handleBranch);
bot.command("merge", handleMerge);
bot.command("cost", handleCost);
bot.command("think", handleThink);
bot.command("plan", handlePlan);
bot.command("compact", handleCompact);
bot.command("handoff", handleHandoff);
bot.command("undo", handleUndo);
bot.command("bookmarks", handleBookmarks);
bot.command("pending", handlePending);
bot.command("q", handlePending); // Alias for queue
bot.command("diff", handleDiff);

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
	console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
const botUsername = botInfo.username || "";
setBotUsername(botUsername);
console.log(`Bot started: @${botUsername}`);

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
	try {
		const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
		const age = Date.now() - data.timestamp;

		// Only update if restart was recent (within 30 seconds)
		if (age < 30000 && data.chat_id && data.message_id) {
			const pid = process.pid;
			const logFile = data.log_file || "/tmp/claude-telegram-bot.log";

			// Create inline keyboard with quick action buttons
			const keyboard = new InlineKeyboard()
				.text("🏠 Start", "restart:start")
				.text("🆕 New", "restart:new")
				.text("📊 Status", "restart:status");

			await bot.api.editMessageText(
				data.chat_id,
				data.message_id,
				`✅ <b>Bot 重啟成功！</b>\n\n` +
					`🔢 程序編號：<code>${pid}</code>\n` +
					`📋 日誌位置：<code>${logFile}</code>\n\n` +
					`<b>查看即時日誌：</b>\n<code>tail -f ${logFile}</code>\n\n` +
					`<b>停止 Bot：</b>\n<code>kill ${pid}</code>`,
				{ parse_mode: "HTML", reply_markup: keyboard },
			);
		}
		safeUnlink(RESTART_FILE);
	} catch (e) {
		console.warn("Failed to update restart message:", e);
		safeUnlink(RESTART_FILE);
	}
}

// Start with concurrent runner (commands work immediately)
const runner = run(bot);

// Graceful shutdown
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(
	process.env.SHUTDOWN_TIMEOUT_MS || "5000",
	10,
);

async function gracefulShutdown(signal: string): Promise<void> {
	console.log(`\n${signal} received - initiating graceful shutdown...`);

	// Set a hard timeout
	const forceExit = setTimeout(() => {
		console.error("Shutdown timeout - forcing exit");
		process.exit(1);
	}, SHUTDOWN_TIMEOUT_MS);

	try {
		// Stop the runner (stops polling)
		if (runner.isRunning()) {
			runner.stop();
			console.log("Bot stopped");
		}

		// Flush session data
		session.flushSession();
		console.log("Session flushed");

		// Clear the timeout and exit cleanly
		clearTimeout(forceExit);
		console.log("Shutdown complete");
		process.exit(0);
	} catch (error) {
		console.error("Error during shutdown:", error);
		clearTimeout(forceExit);
		process.exit(1);
	}
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
