/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart, /cd, /bookmarks
 */

import { existsSync, statSync } from "node:fs";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { isBookmarked, loadBookmarks, resolvePath } from "../bookmarks";
import { ALLOWED_USERS, RESTART_FILE } from "../config";
import { isAuthorized, isPathAllowed } from "../security";
import { session } from "../session";
import { startTypingIndicator } from "../utils";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized. Contact the bot owner for access.");
		return;
	}

	const status = session.isActive ? "Active session" : "No active session";
	const workDir = session.workingDir;

	await ctx.reply(
		`🤖 <b>Claude Telegram Bot</b>\n\n` +
			`Status: ${status}\n` +
			`Working directory: <code>${workDir}</code>\n\n` +
			`<b>Commands:</b>\n` +
			`/new - Start fresh session\n` +
			`/stop - Stop current query\n` +
			`/status - Show detailed status\n` +
			`/resume - Resume last session\n` +
			`/retry - Retry last message\n` +
			`/handoff - Compress: carry last response to new session\n` +
			`/cd - Change working directory\n` +
			`/file - Download a file\n` +
			`/bookmarks - Manage directory bookmarks\n` +
			`/restart - Restart the bot\n\n` +
			`<b>Tips:</b>\n` +
			`• <code>!cmd</code> - Run shell command\n` +
			`• <code>!!msg</code> - Interrupt and send new message\n` +
			`• Use "think" keyword for extended reasoning\n` +
			`• Send photos, voice, or documents`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	// Stop any running query
	if (session.isRunning) {
		const result = await session.stop();
		if (result) {
			await Bun.sleep(100);
			session.clearStopRequested();
		}
	}

	// Clear session
	await session.kill();

	// Get context info
	const username = process.env.USER || process.env.USERNAME || "unknown";
	const workDir = session.workingDir;
	const now = new Date().toLocaleString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

	await ctx.reply(
		`🆕 Session cleared. Next message starts fresh.\n\n` +
			`👤 ${username}\n` +
			`📁 <code>${workDir}</code>\n` +
			`🕐 ${now}`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (session.isRunning) {
		const result = await session.stop();
		if (result) {
			// Wait for the abort to be processed, then clear stopRequested so next message can proceed
			await Bun.sleep(100);
			session.clearStopRequested();
		}
		// Silent stop - no message shown
	}
	// If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const lines: string[] = ["📊 <b>Bot Status</b>\n"];

	// Session status
	if (session.isActive) {
		lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
	} else {
		lines.push("⚪ Session: None");
	}

	// Query status
	if (session.isRunning) {
		const elapsed = session.queryStarted
			? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
			: 0;
		lines.push(`🔄 Query: Running (${elapsed}s)`);
		if (session.currentTool) {
			lines.push(`   └─ ${session.currentTool}`);
		}
	} else {
		lines.push("⚪ Query: Idle");
		if (session.lastTool) {
			lines.push(`   └─ Last: ${session.lastTool}`);
		}
	}

	// Last activity
	if (session.lastActivity) {
		const ago = Math.floor(
			(Date.now() - session.lastActivity.getTime()) / 1000,
		);
		lines.push(`\n⏱️ Last activity: ${ago}s ago`);
	}

	// Usage stats
	if (session.lastUsage) {
		const usage = session.lastUsage;
		lines.push(
			`\n📈 Last query usage:`,
			`   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
			`   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`,
		);
		if (usage.cache_read_input_tokens) {
			lines.push(
				`   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`,
			);
		}
	}

	// Error status
	if (session.lastError) {
		const ago = session.lastErrorTime
			? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
			: "?";
		lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
	}

	// Working directory
	lines.push(`\n📁 Working dir: <code>${session.workingDir}</code>`);

	await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /pending - Show and manage pending messages queue.
 */
export async function handlePending(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const pending = session.getPendingMessages();

	if (pending.length === 0) {
		await ctx.reply("📭 No pending messages.");
		return;
	}

	// Build message with inline keyboard
	let text = `📋 <b>Pending Messages</b> (${pending.length})\n\n`;
	const keyboard = new InlineKeyboard();

	for (const msg of pending) {
		const preview =
			msg.text.length > 40 ? `${msg.text.slice(0, 40)}...` : msg.text;
		const ago = Math.floor((Date.now() - msg.timestamp.getTime()) / 1000);
		text += `• <code>${preview}</code> (${ago}s ago)\n`;

		// Button with truncated text
		const btnLabel =
			msg.text.length > 25 ? `${msg.text.slice(0, 25)}...` : msg.text;
		keyboard.text(btnLabel, `pending:exec:${msg.id}`).row();
	}

	keyboard.text("🗑 Clear All", "pending:clear");

	await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

/**
 * /resume - Resume the last session.
 */
export async function handleResume(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (session.isActive) {
		await ctx.reply("Session already active. Use /new to start fresh first.");
		return;
	}

	const [success, message] = session.resumeLast();
	if (success) {
		await ctx.reply(`✅ ${message}`);
	} else {
		await ctx.reply(`❌ ${message}`);
	}
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const msg = await ctx.reply("🔄 Restarting bot...");

	// Save message info so we can update it after restart
	if (chatId && msg.message_id) {
		try {
			await Bun.write(
				RESTART_FILE,
				JSON.stringify({
					chat_id: chatId,
					message_id: msg.message_id,
					timestamp: Date.now(),
				}),
			);
		} catch (e) {
			console.warn("Failed to save restart info:", e);
		}
	}

	// Give time for the message to send
	await Bun.sleep(500);

	// Exit - launchd will restart us
	process.exit(0);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	// Check if there's a message to retry
	if (!session.lastMessage) {
		await ctx.reply("❌ No message to retry.");
		return;
	}

	// Check if something is already running
	if (session.isRunning) {
		await ctx.reply("⏳ A query is already running. Use /stop first.");
		return;
	}

	const message = session.lastMessage;
	await ctx.reply(
		`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`,
	);

	// Simulate sending the message again by emitting a fake text message event
	// We do this by directly calling the text handler logic
	const { handleText } = await import("./text");

	// Create a modified context with the last message
	const fakeCtx = {
		...ctx,
		message: {
			...ctx.message,
			text: message,
		},
	} as Context;

	await handleText(fakeCtx);
}

/**
 * /skill - Invoke a Claude Code skill.
 */
export async function handleSkill(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	// Get the skill name and args from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/skill\s+(\S+)(?:\s+(.*))?$/);

	if (!match) {
		await ctx.reply(
			`🎯 <b>Invoke Skill</b>\n\n` +
				`Usage: <code>/skill &lt;name&gt; [args]</code>\n\n` +
				`Examples:\n` +
				`• <code>/skill commit</code>\n` +
				`• <code>/skill review-pr 123</code>\n` +
				`• <code>/skill map</code>`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const skillName = match[1] ?? "";
	const skillArgs = match[2] || "";

	// Build the skill command (Claude Code format: /skill_name args)
	const skillCommand = skillArgs
		? `/${skillName} ${skillArgs}`
		: `/${skillName}`;

	// Send to Claude via handleText
	const { handleText } = await import("./text");
	const fakeCtx = {
		...ctx,
		message: {
			...ctx.message,
			text: skillCommand,
		},
	} as Context;

	await handleText(fakeCtx);
}

/**
 * /model - Switch between models.
 */
export async function handleModel(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const text = ctx.message?.text || "";
	const match = text.match(/^\/model\s+(\w+)$/i);

	if (!match) {
		const current = session.currentModel;
		await ctx.reply(
			`🤖 <b>Model Selection</b>\n\n` +
				`Current: <b>${current}</b>\n\n` +
				`Usage: <code>/model &lt;name&gt;</code>\n\n` +
				`Available:\n` +
				`• <code>/model sonnet</code> - Fast, balanced\n` +
				`• <code>/model opus</code> - Most capable\n` +
				`• <code>/model haiku</code> - Fastest, cheapest`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const modelName = match[1]?.toLowerCase();
	if (modelName !== "sonnet" && modelName !== "opus" && modelName !== "haiku") {
		await ctx.reply(
			`❌ Unknown model: ${modelName}\n\nUse: sonnet, opus, or haiku`,
		);
		return;
	}

	session.currentModel = modelName;
	await ctx.reply(`🤖 Switched to <b>${modelName}</b>`, { parse_mode: "HTML" });
}

/**
 * /cost - Show token usage and estimated cost.
 */
export async function handleCost(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const cost = session.estimateCost();
	const formatNum = (n: number) => n.toLocaleString();
	const formatCost = (n: number) => `$${n.toFixed(4)}`;

	await ctx.reply(
		`💰 <b>Session Usage</b>\n\n` +
			`Model: <b>${session.currentModel}</b>\n\n` +
			`<b>Tokens:</b>\n` +
			`• Input: ${formatNum(session.totalInputTokens)}\n` +
			`• Output: ${formatNum(session.totalOutputTokens)}\n` +
			`• Cache read: ${formatNum(session.totalCacheReadTokens)}\n\n` +
			`<b>Estimated Cost:</b>\n` +
			`• Input: ${formatCost(cost.inputCost)}\n` +
			`• Output: ${formatCost(cost.outputCost)}\n` +
			`• Total: <b>${formatCost(cost.total)}</b>`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /think - Force extended thinking for next message.
 */
export async function handleThink(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const text = ctx.message?.text || "";
	const match = text.match(/^\/think\s+(\w+)$/i);

	let tokens: number;
	let label: string;

	if (!match) {
		// Default to deep thinking
		tokens = 50000;
		label = "deep (50K tokens)";
	} else {
		const level = match[1]?.toLowerCase();
		if (level === "off" || level === "0") {
			tokens = 0;
			label = "off";
		} else if (level === "normal" || level === "10k") {
			tokens = 10000;
			label = "normal (10K tokens)";
		} else if (level === "deep" || level === "50k") {
			tokens = 50000;
			label = "deep (50K tokens)";
		} else {
			await ctx.reply(`❌ Unknown level: ${level}\n\nUse: off, normal, deep`);
			return;
		}
	}

	session.forceThinking = tokens;
	await ctx.reply(`🧠 Next message will use <b>${label}</b> thinking`, {
		parse_mode: "HTML",
	});
}

/**
 * /plan - Toggle planning mode.
 */
export async function handlePlan(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	session.planMode = !session.planMode;

	if (session.planMode) {
		await ctx.reply(
			`📋 <b>Plan mode ON</b>\n\n` +
				`Claude will analyze and plan without executing tools.\n` +
				`Use <code>/plan</code> again to exit.`,
			{ parse_mode: "HTML" },
		);
	} else {
		await ctx.reply(`📋 Plan mode OFF - Normal execution resumed`);
	}
}

/**
 * /compact - Request context compaction (sends a hint to Claude).
 */
export async function handleCompact(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!session.isActive) {
		await ctx.reply("❌ No active session to compact.");
		return;
	}

	// Send a message that triggers Claude to compact
	const { handleText } = await import("./text");
	const fakeCtx = {
		...ctx,
		message: {
			...ctx.message,
			text: "/compact",
		},
	} as Context;

	await handleText(fakeCtx);
}

/**
 * Escape HTML special characters for Telegram.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * /handoff - Start fresh session with last response as context.
 */
export async function handleHandoff(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const lastResponse = session.lastBotResponse;

	if (!lastResponse) {
		await ctx.reply(
			"❌ No previous response to carry forward.\nUse /new for a fresh start.",
		);
		return;
	}

	// Preview what will be carried forward (truncated)
	const preview =
		lastResponse.length > 500
			? `${lastResponse.slice(0, 500)}...`
			: lastResponse;

	const keyboard = new InlineKeyboard()
		.text("✅ Handoff & Continue", "handoff:go")
		.text("❌ Cancel", "handoff:cancel");

	await ctx.reply(
		`📦 <b>Context Handoff</b>\n\n` +
			`This will:\n` +
			`1. Clear current session\n` +
			`2. Start fresh with last response as context\n\n` +
			`<b>Last response preview:</b>\n` +
			`<code>${escapeHtml(preview)}</code>`,
		{ parse_mode: "HTML", reply_markup: keyboard },
	);
}

/**
 * /undo - Revert file changes to last checkpoint.
 */
export async function handleUndo(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!session.isActive) {
		await ctx.reply("❌ No active session.");
		return;
	}

	if (!session.canUndo) {
		await ctx.reply(
			`❌ No checkpoints available.\n\n` +
				`Checkpoints are created when you send messages.`,
		);
		return;
	}

	// Show progress
	const typing = startTypingIndicator(ctx);
	const statusMsg = await ctx.reply("⏪ Reverting files...");

	try {
		const [success, message] = await session.undo();

		// Update status message with result
		await ctx.api.editMessageText(
			ctx.chat!.id,
			statusMsg.message_id,
			success ? message : `❌ ${message}`,
			{ parse_mode: "HTML" },
		);
	} finally {
		typing.stop();
	}
}

/**
 * /cd - Change working directory.
 */
export async function handleCd(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	// Get the path argument from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/cd\s+(.+)$/);

	if (!match) {
		await ctx.reply(
			`📁 Current directory: <code>${session.workingDir}</code>\n\n` +
				`Usage: <code>/cd /path/to/directory</code>`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const inputPath = (match[1] ?? "").trim();
	// Resolve relative paths from current working directory
	const resolvedPath = resolvePath(inputPath, session.workingDir);

	// Validate path exists and is a directory
	if (!existsSync(resolvedPath)) {
		await ctx.reply(`❌ Path does not exist: <code>${resolvedPath}</code>`, {
			parse_mode: "HTML",
		});
		return;
	}

	const stats = statSync(resolvedPath);
	if (!stats.isDirectory()) {
		await ctx.reply(
			`❌ Path is not a directory: <code>${resolvedPath}</code>`,
			{
				parse_mode: "HTML",
			},
		);
		return;
	}

	// Check if path is allowed
	if (!isPathAllowed(resolvedPath)) {
		await ctx.reply(
			`❌ Access denied: <code>${resolvedPath}</code>\n\nPath must be in allowed directories.`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Change directory
	session.setWorkingDir(resolvedPath);

	// Build inline keyboard
	const keyboard = new InlineKeyboard();
	if (isBookmarked(resolvedPath)) {
		keyboard.text("⭐ Already bookmarked", "bookmark:noop");
	} else {
		keyboard.text("➕ Add to bookmarks", `bookmark:add:${resolvedPath}`);
	}

	await ctx.reply(
		`📁 Changed to: <code>${resolvedPath}</code>\n\nSession cleared. Next message starts fresh.`,
		{
			parse_mode: "HTML",
			reply_markup: keyboard,
		},
	);
}

/**
 * Send a single file to the user. Returns error message or null on success.
 */
async function sendFile(
	ctx: Context,
	filePath: string,
): Promise<string | null> {
	// Resolve relative paths from current working directory
	const resolvedPath = resolvePath(filePath, session.workingDir);

	// Validate path exists
	if (!existsSync(resolvedPath)) {
		return `File not found: ${resolvedPath}`;
	}

	const stats = statSync(resolvedPath);
	if (stats.isDirectory()) {
		return `Cannot send directory: ${resolvedPath}`;
	}

	// Check if path is allowed
	if (!isPathAllowed(resolvedPath)) {
		return `Access denied: ${resolvedPath}`;
	}

	// Check file size (Telegram limit is 50MB for bots)
	const MAX_FILE_SIZE = 50 * 1024 * 1024;
	if (stats.size > MAX_FILE_SIZE) {
		const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
		return `File too large: ${resolvedPath} (${sizeMB}MB, max 50MB)`;
	}

	// Send the file
	try {
		const filename = resolvedPath.split("/").pop() || "file";
		await ctx.replyWithDocument(new InputFile(resolvedPath, filename));
		return null;
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		return `Failed to send: ${errMsg}`;
	}
}

/**
 * /file - Send a file to the user.
 * Without arguments: auto-detect file paths from last bot response.
 */
export async function handleFile(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	// Get the path argument from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/file\s+(.+)$/);

	// If no argument, try to auto-detect from last bot response
	if (!match) {
		if (!session.lastBotResponse) {
			await ctx.reply(
				`📎 <b>Download File</b>\n\n` +
					`Usage: <code>/file &lt;filepath&gt;</code>\n` +
					`Or just <code>/file</code> to send files from the last response.\n\n` +
					`No recent response to extract files from.`,
				{ parse_mode: "HTML" },
			);
			return;
		}

		// Extract paths from <code> tags (response is HTML)
		const codeMatches = session.lastBotResponse.matchAll(
			/<code>([^<]+)<\/code>/g,
		);
		const candidates: string[] = [];
		for (const m of codeMatches) {
			const content = m[1]?.trim();
			// Must have file extension (contains . followed by letters)
			if (content && /\.[a-zA-Z0-9]+$/.test(content)) {
				candidates.push(content);
			}
		}

		// Deduplicate
		const detected = [...new Set(candidates)];

		if (detected.length === 0) {
			await ctx.reply(
				`📎 No file paths found in <code>&lt;code&gt;</code> tags.\n\n` +
					`Usage: <code>/file &lt;filepath&gt;</code>`,
				{ parse_mode: "HTML" },
			);
			return;
		}

		// Send each detected file
		const errors: string[] = [];
		let sent = 0;
		for (const filePath of detected) {
			const error = await sendFile(ctx, filePath);
			if (error) {
				errors.push(`${filePath}: ${error}`);
			} else {
				sent++;
			}
		}

		// Report any errors
		if (errors.length > 0) {
			await ctx.reply(`⚠️ Some files failed:\n${errors.join("\n")}`, {
				parse_mode: "HTML",
			});
		}

		if (sent === 0 && errors.length > 0) {
			// All failed, already reported above
		} else if (sent > 0) {
			// Success message optional, files speak for themselves
		}

		return;
	}

	// Explicit path provided
	const inputPath = (match[1] ?? "").trim();
	const error = await sendFile(ctx, inputPath);
	if (error) {
		await ctx.reply(`❌ ${error}`, { parse_mode: "HTML" });
	}
}

/**
 * /bookmarks - List and manage bookmarks.
 */
export async function handleBookmarks(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	const bookmarks = loadBookmarks();

	if (bookmarks.length === 0) {
		await ctx.reply(
			"📚 No bookmarks yet.\n\n" +
				"Use <code>/cd /path/to/dir</code> and click 'Add to bookmarks'.",
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Build message and keyboards
	let message = "📚 <b>Bookmarks</b>\n\n";

	const keyboard = new InlineKeyboard();
	for (const bookmark of bookmarks) {
		message += `📁 <code>${bookmark.path}</code>\n`;

		// Each bookmark gets two buttons on the same row
		keyboard
			.text(`🆕 ${bookmark.name}`, `bookmark:new:${bookmark.path}`)
			.text("🗑️", `bookmark:remove:${bookmark.path}`)
			.row();
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}
