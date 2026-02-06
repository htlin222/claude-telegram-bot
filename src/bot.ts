/**
 * Claude Telegram Bot - Bot startup module
 *
 * This module is imported by cli.ts after environment setup.
 * Can also be run directly with `bun run src/bot.ts` for backwards compatibility.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { run, sequentialize } from "@grammyjs/runner";
import { Bot } from "grammy";
import {
	ALLOWED_USERS,
	PID_FILE,
	RESTART_FILE,
	TELEGRAM_TOKEN,
	WORKING_DIR,
} from "./config";
import { safeUnlink } from "./utils/temp-cleanup";
import {
	handleBookmarks,
	handleBranch,
	handleCallback,
	handleCd,
	handleCompact,
	handleCost,
	handleDocument,
	handleFile,
	handleModel,
	handleNew,
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

// ============== Single Instance Lock ==============
// Prevents two bot instances from running simultaneously for the same working directory.
// If two instances poll Telegram, each receives different updates, causing missed messages
// and duplicate responses.
function acquirePidLock(): void {
	const currentPid = process.pid;

	if (existsSync(PID_FILE)) {
		try {
			const existingPid = Number.parseInt(
				readFileSync(PID_FILE, "utf-8").trim(),
				10,
			);
			if (!Number.isNaN(existingPid) && existingPid !== currentPid) {
				try {
					// Signal 0 just checks if the process exists, doesn't actually send a signal
					process.kill(existingPid, 0);
					// Process is alive - abort startup
					console.error(
						`ERROR: Another bot instance is already running (PID ${existingPid}).`,
					);
					console.error(`PID file: ${PID_FILE}`);
					console.error(
						"If the previous instance crashed, delete the PID file and retry.",
					);
					process.exit(1);
				} catch {
					// process.kill threw - the process doesn't exist, stale PID file
					console.warn(
						`Stale PID file found (PID ${existingPid} is not running). Taking over.`,
					);
				}
			}
		} catch {
			// Couldn't read/parse PID file - overwrite it
		}
	}

	writeFileSync(PID_FILE, String(currentPid), { mode: 0o600 });
	console.log(`PID lock acquired: ${currentPid}`);
}

function releasePidLock(): void {
	safeUnlink(PID_FILE);
}

acquirePidLock();

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

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
	sequentialize((ctx) => {
		// Commands are not sequentialized - they work immediately
		if (ctx.message?.text?.startsWith("/")) {
			return undefined;
		}
		// Messages with ! prefix bypass queue (interrupt)
		if (ctx.message?.text?.startsWith("!")) {
			return undefined;
		}
		// Callback queries (button clicks) are not sequentialized
		if (ctx.callbackQuery) {
			return undefined;
		}
		// Other messages are sequentialized per chat
		return ctx.chat?.id.toString();
	}),
);

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
bot.command("model", handleModel);
bot.command("provider", handleProvider);
bot.command("worktree", handleWorktree);
bot.command("branch", handleBranch);
bot.command("cost", handleCost);
bot.command("think", handleThink);
bot.command("plan", handlePlan);
bot.command("compact", handleCompact);
bot.command("undo", handleUndo);
bot.command("bookmarks", handleBookmarks);

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
console.log("Claude Telegram Bot");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Set up Telegram menu commands
await bot.api.setMyCommands([
	{ command: "start", description: "Show status and user ID" },
	{ command: "new", description: "Start a fresh session" },
	{ command: "resume", description: "Resume last session" },
	{ command: "stop", description: "Interrupt current query" },
	{ command: "status", description: "Check what Claude is doing" },
	{ command: "retry", description: "Retry last message" },
	{ command: "handoff", description: "Carry response to new session" },
	{ command: "pending", description: "Show queued messages" },
	{ command: "model", description: "Switch model (sonnet/opus/haiku)" },
	{ command: "provider", description: "Switch agent provider" },
	{ command: "worktree", description: "Create and enter a worktree" },
	{ command: "branch", description: "Switch branch worktree" },
	{ command: "think", description: "Force extended thinking" },
	{ command: "plan", description: "Toggle planning mode" },
	{ command: "compact", description: "Trigger context compaction" },
	{ command: "cost", description: "Show token usage and cost" },
	{ command: "cd", description: "Change working directory" },
	{ command: "file", description: "Download a file" },
	{ command: "undo", description: "Revert file changes" },
	{ command: "skill", description: "Invoke a Claude Code skill" },
	{ command: "bookmarks", description: "Manage directory bookmarks" },
	{ command: "restart", description: "Restart the bot" },
]);
console.log("Menu commands registered");

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
	try {
		const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
		const age = Date.now() - data.timestamp;

		// Only update if restart was recent (within 30 seconds)
		if (age < 30000 && data.chat_id && data.message_id) {
			const pid = process.pid;
			const logFile = data.log_file || "/tmp/claude-telegram-bot.log";

			await bot.api.editMessageText(
				data.chat_id,
				data.message_id,
				`✅ <b>Bot Restarted</b>\n\n` +
					`PID: <code>${pid}</code>\n` +
					`Log: <code>${logFile}</code>\n\n` +
					`View logs:\n<code>tail -f ${logFile}</code>\n\n` +
					`Stop bot:\n<code>kill ${pid}</code>`,
				{ parse_mode: "HTML" },
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
const stopRunner = () => {
	if (runner.isRunning()) {
		console.log("Stopping bot...");
		runner.stop();
	}
};

process.on("SIGINT", () => {
	console.log("Received SIGINT");
	stopRunner();
	releasePidLock();
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("Received SIGTERM");
	stopRunner();
	releasePidLock();
	process.exit(0);
});
