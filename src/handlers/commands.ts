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
			`/cd - Change working directory\n` +
			`/preview - Download a file\n` +
			`/bookmarks - Manage directory bookmarks\n` +
			`/restart - Restart the bot\n\n` +
			`<b>Tips:</b>\n` +
			`• Prefix with <code>!</code> to interrupt current query\n` +
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

	await ctx.reply("🆕 Session cleared. Next message starts fresh.");
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
 * /preview - Send a file to the user.
 */
export async function handlePreview(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	// Get the path argument from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/preview\s+(.+)$/);

	if (!match) {
		await ctx.reply(
			`📎 <b>Preview/Download File</b>\n\n` +
				`Usage: <code>/preview &lt;filepath&gt;</code>\n\n` +
				`Examples:\n` +
				`• <code>/preview output.txt</code> (relative to working dir)\n` +
				`• <code>/preview /absolute/path/file.pdf</code>\n` +
				`• <code>/preview ~/Documents/report.csv</code>`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const inputPath = (match[1] ?? "").trim();
	// Resolve relative paths from current working directory
	const resolvedPath = resolvePath(inputPath, session.workingDir);

	// Validate path exists
	if (!existsSync(resolvedPath)) {
		await ctx.reply(`❌ File not found: <code>${resolvedPath}</code>`, {
			parse_mode: "HTML",
		});
		return;
	}

	const stats = statSync(resolvedPath);
	if (stats.isDirectory()) {
		await ctx.reply(
			`❌ Cannot preview directory: <code>${resolvedPath}</code>\n\nUse <code>/cd</code> to navigate.`,
			{ parse_mode: "HTML" },
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

	// Check file size (Telegram limit is 50MB for bots)
	const MAX_FILE_SIZE = 50 * 1024 * 1024;
	if (stats.size > MAX_FILE_SIZE) {
		const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
		await ctx.reply(
			`❌ File too large: <code>${resolvedPath}</code>\n\nSize: ${sizeMB}MB (max 50MB)`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	// Send the file
	try {
		const filename = resolvedPath.split("/").pop() || "file";
		await ctx.replyWithDocument(new InputFile(resolvedPath, filename));
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		await ctx.reply(`❌ Failed to send file: ${errMsg}`);
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
