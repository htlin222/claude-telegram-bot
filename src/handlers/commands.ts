/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart, /cd, /bookmarks, /image, /pdf, /docx, /html
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import { isBookmarked, loadBookmarks, resolvePath } from "../bookmarks";
import {
	AGENT_PROVIDERS,
	type AgentProviderId,
	ALLOWED_USERS,
	MESSAGE_EFFECTS,
	RESTART_FILE,
	TELEGRAM_MESSAGE_LIMIT,
} from "../config";
import { isAuthorized, isPathAllowed } from "../security";
import { sessionManager } from "../session";
import { startTypingIndicator } from "../utils";
import {
	getCombinedDiff,
	getGitDiff,
	getMergeInfo,
	getWorkingTreeStatus,
	listBranches,
} from "../worktree";

const CALLBACK_DATA_LIMIT = 64;
const BRANCH_LIST_LIMIT = Number.parseInt(
	process.env.BRANCH_LIST_LIMIT || "40",
	10,
);

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized. Contact the bot owner for access.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);
	const status = session.isActive ? "Active session" : "No active session";
	const workDir = session.workingDir;

	// Check launch mode and show appropriate badge
	const isCtb = !!process.env.CTB_INSTANCE_DIR;
	let modeInfo = "";
	if (isCtb) {
		try {
			// Read package.json for version
			const packageJsonPath = new URL("../../package.json", import.meta.url)
				.pathname;
			const packageJson = await Bun.file(packageJsonPath).json();
			const version = packageJson.version || "unknown";
			modeInfo = ` v${version}`;
		} catch {
			// Ignore version read errors
		}
	} else {
		// Development mode (bun run start)
		modeInfo = " 👨‍💻 開發模式";
	}

	await ctx.reply(
		`🤖 <b>Claude Telegram Bot${modeInfo}</b>

Status: ${status}
Working directory: <code>${workDir}</code>

<b>Session:</b>
/new - Start fresh session
/stop - Stop current query (or /kill)
/status - Show detailed status
/resume - Resume last session
/retry - Retry last message
/handoff - Carry response to new session
/pending - Show queued messages

<b>Model:</b>
/model - Switch model (sonnet/opus/haiku)
/provider - Switch agent provider
/think - Force extended thinking
/plan - Toggle planning mode
/compact - Trigger context compaction
/cost - Show token usage

<b>Files:</b>
/cd - Change working directory
/worktree - Create and enter a git worktree
/branch - Switch to a branch worktree
/merge - Merge current branch into main
/diff - View uncommitted changes
/file - Download a file
/image - List image files
/pdf - List PDF files
/docx - List DOCX files
/html - List HTML files
/undo - Revert file changes
/skill - Invoke Claude Code skill
/bookmarks - Directory bookmarks
/restart - Restart the bot

<b>Tips:</b>
• <code>!cmd</code> - Run shell command
• <code>!!msg</code> - Interrupt and send
• Send photos, voice, or documents`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

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

	// Format date as yyyy-mm-dd (Wed) HH:MM GMT+X
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const timezoneOffset = -now.getTimezoneOffset() / 60;
	const timezone =
		timezoneOffset >= 0 ? `GMT+${timezoneOffset}` : `GMT${timezoneOffset}`;
	const dateStr = `${year}-${month}-${day} (${weekday}) ${hours}:${minutes} ${timezone}`;

	// Get uname info (system name and hostname)
	const { execSync } = await import("node:child_process");
	let unameInfo = "";
	try {
		const system = execSync("uname -s", { encoding: "utf-8" }).trim();
		const hostname = execSync("uname -n", { encoding: "utf-8" }).trim();
		unameInfo = `${system} ${hostname}`;
	} catch (_e) {
		unameInfo = "N/A";
	}

	await ctx.reply(
		`🆕 Session cleared. Next message starts fresh.\n\n👤 ${username}\n📁 <code>${workDir}</code>\n🕐 ${dateStr}\n💻 <code>${unameInfo}</code>`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const lines: string[] = ["📊 <b>Bot Status</b>\n"];

	// Session status
	if (session.isActive) {
		lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
	} else {
		lines.push("⚪ Session: None");
	}

	// Provider status
	lines.push(`🤖 Provider: <b>${session.currentProvider}</b>`);

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
			"\n📈 Last query usage:",
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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (session.isActive) {
		await ctx.reply("Session already active. Use /new to start fresh first.");
		return;
	}

	const [success, message] = session.resumeLast();
	if (success) {
		await ctx.reply(`✅ ${message}`);
	} else {
		await ctx.reply(`❌ ${message}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
	}
}

/**
 * Execute the restart process.
 */
export async function executeRestart(
	ctx: Context,
	chatId: number | undefined,
): Promise<void> {
	// Determine restart command based on how bot was started
	const botScript = process.argv[1] || "";
	const isCliMode =
		botScript.includes("cli.ts") || botScript.includes("cli.js");
	const isBinary = !botScript.endsWith(".ts") && !botScript.endsWith(".js");

	let restartCommand: string;
	let logFile: string;

	if (isBinary) {
		// Standalone binary mode
		restartCommand = process.argv[0] || "";
		logFile = "/tmp/claude-telegram-bot.log";
	} else if (isCliMode) {
		// CLI mode (ctb)
		restartCommand = `bun "${botScript}"`;
		logFile = "/tmp/claude-telegram-bot.log";
	} else {
		// Development mode (bun run src/index.ts or src/bot.ts)
		restartCommand = `bun run "${botScript}"`;
		logFile = "/tmp/claude-telegram-bot.log";
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
					log_file: logFile,
				}),
			);
		} catch (e) {
			console.warn("Failed to save restart info:", e);
		}
	}

	// Give time for the message to send
	await Bun.sleep(500);

	// Spawn a new process to restart the bot
	const { spawn } = await import("node:child_process");
	const cwd = process.cwd();

	// Build the restart command with log redirection
	const fullCommand = `sleep 1 && cd "${cwd}" && ${restartCommand} >> ${logFile} 2>&1 & echo $!`;

	// Spawn detached process that will restart after current process exits
	spawn("sh", ["-c", fullCommand], {
		detached: true,
		stdio: "ignore",
	}).unref();

	// Exit current process
	process.exit(0);
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

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Detect if running in terminal mode
	const isTTY = process.stdout.isTTY;

	// Determine restart command based on how bot was started
	const botScript = process.argv[1] || "";
	const isCliMode =
		botScript.includes("cli.ts") || botScript.includes("cli.js");
	const isBinary = !botScript.endsWith(".ts") && !botScript.endsWith(".js");

	let restartCommand: string;
	let logFile: string;

	if (isBinary) {
		// Standalone binary mode
		restartCommand = process.argv[0] || "";
		logFile = "/tmp/claude-telegram-bot.log";
	} else if (isCliMode) {
		// CLI mode (ctb)
		restartCommand = `bun "${botScript}"`;
		logFile = "/tmp/claude-telegram-bot.log";
	} else {
		// Development mode (bun run src/index.ts or src/bot.ts)
		restartCommand = `bun run "${botScript}"`;
		logFile = "/tmp/claude-telegram-bot.log";
	}

	// Warn if running in terminal
	if (isTTY) {
		const keyboard = new InlineKeyboard()
			.text("✅ 確定重啟", "restart:confirm")
			.text("❌ 取消", "restart:cancel");

		await ctx.reply(
			"⚠️ <b>Terminal Mode Detected</b>\n\n" +
				"You started the bot from a terminal. Restarting will:\n" +
				"• Detach from your current terminal session\n" +
				"• Run in background\n" +
				`• Log to: <code>${logFile}</code>\n\n` +
				"View logs after restart:\n" +
				`<code>tail -f ${logFile}</code>\n\n` +
				"Or stop and restart manually:\n" +
				"• Press Ctrl+C\n" +
				`• Run <code>${restartCommand}</code>`,
			{ parse_mode: "HTML", reply_markup: keyboard },
		);

		// Don't proceed - wait for user to click button
		return;
	}

	// Not in TTY mode, proceed with restart directly
	await executeRestart(ctx, chatId);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Check if there's a message to retry
	if (!session.lastMessage) {
		await ctx.reply("❌ No message to retry.", {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Get the skill name and args from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/skill\s+(\S+)(?:\s+(.*))?$/);

	if (!match) {
		await ctx.reply(
			"🎯 <b>Invoke Skill</b>\n\n" +
				"Usage: <code>/skill &lt;name&gt; [args]</code>\n\n" +
				"Examples:\n" +
				"• <code>/skill commit</code>\n" +
				"• <code>/skill review-pr 123</code>\n" +
				"• <code>/skill map</code>",
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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const text = ctx.message?.text || "";
	const match = text.match(/^\/model\s+(\w+)$/i);

	if (!match) {
		const current = session.currentModel;
		await ctx.reply(
			`🤖 <b>Model Selection</b>\n\nCurrent: <b>${current}</b>\n\nUsage: <code>/model &lt;name&gt;</code>\n\nAvailable:\n• <code>/model sonnet</code> - Fast, balanced\n• <code>/model opus</code> - Most capable\n• <code>/model haiku</code> - Fastest, cheapest`,
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
 * /provider - Switch between agent providers.
 */
export async function handleProvider(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const text = ctx.message?.text || "";
	const match = text.match(/^\/provider\s+(\w+)$/i);

	if (!match) {
		const current = session.currentProvider;
		const keyboard = new InlineKeyboard();
		for (const provider of AGENT_PROVIDERS) {
			const label = provider === current ? `✅ ${provider}` : `⚪️ ${provider}`;
			keyboard.text(label, `provider:set:${provider}`).row();
		}

		await ctx.reply(
			`🔀 <b>Provider Selection</b>\n\nCurrent: <b>${current}</b>\n\nChoose a provider below:`,
			{ parse_mode: "HTML", reply_markup: keyboard },
		);
		return;
	}

	const providerName = match[1]?.toLowerCase() as AgentProviderId | undefined;
	if (!providerName || !AGENT_PROVIDERS.includes(providerName)) {
		await ctx.reply(
			`❌ Unknown provider: ${providerName}\n\nAvailable: ${AGENT_PROVIDERS.join(
				", ",
			)}`,
		);
		return;
	}

	const [success, message] = await session.setProvider(providerName);
	await ctx.reply(success ? `🔀 ${message}` : `❌ ${message}`, {
		parse_mode: "HTML",
	});
}

/**
 * /worktree - Create a git worktree and switch into it.
 */
export async function handleWorktree(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!userId || !chatId) {
		return;
	}

	const session = sessionManager.getSession(chatId);

	if (session.isRunning) {
		await ctx.reply("⚠️ A query is running. Use /stop first.");
		return;
	}

	const status = await getWorkingTreeStatus(session.workingDir);
	if (!status.success) {
		await ctx.reply(`❌ ${status.message}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}
	if (status.dirty) {
		await ctx.reply(
			"⚠️ Working tree has uncommitted changes. Commit or stash before creating a worktree.",
		);
		return;
	}

	const pending = session.peekWorktreeRequest(userId, chatId);
	if (pending) {
		const age = Math.floor((Date.now() - pending.createdAt.getTime()) / 1000);
		await ctx.reply(
			`⚠️ Already waiting for a branch name (${age}s ago). Send the branch name or /cancel.`,
		);
		return;
	}

	if (!session.requestWorktree(userId, chatId)) {
		await ctx.reply(
			"⚠️ Already waiting for a branch name. Send the branch name or /cancel.",
		);
		return;
	}

	// Save current session (if any) before switching
	session.flushSession();

	await ctx.reply(
		"🌿 <b>Worktree Setup</b>\n\n" +
			"Send the branch name to use (e.g. <code>feature/something-new</code>).\n" +
			"Reply with /cancel to abort.",
		{ parse_mode: "HTML" },
	);
}

/**
 * /branch - List branches and switch via worktree.
 */
export async function handleBranch(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (session.isRunning) {
		await ctx.reply("⚠️ A query is running. Use /stop first.");
		return;
	}

	const status = await getWorkingTreeStatus(session.workingDir);
	if (!status.success) {
		await ctx.reply(`❌ ${status.message}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}
	if (status.dirty) {
		await ctx.reply(
			"⚠️ Working tree has uncommitted changes. Commit or stash before switching branches.",
		);
		return;
	}

	const result = await listBranches(session.workingDir);
	if (!result.success) {
		await ctx.reply(`❌ ${result.message}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}

	if (result.branches.length === 0) {
		await ctx.reply("⚠️ No branches found.");
		return;
	}

	const keyboard = new InlineKeyboard();
	let omittedByLength = 0;
	let omittedByLimit = 0;
	let included = 0;
	for (const branch of result.branches) {
		if (included >= BRANCH_LIST_LIMIT) {
			omittedByLimit++;
			continue;
		}
		const encoded = Buffer.from(branch).toString("base64");
		const callbackData = `branch:switch:${encoded}`;
		if (callbackData.length > CALLBACK_DATA_LIMIT) {
			omittedByLength++;
			continue;
		}
		const label = branch === result.current ? `✅ ${branch}` : `⚪️ ${branch}`;
		keyboard.text(label, `branch:switch:${encoded}`).row();
		included++;
	}

	let message = `🌿 <b>Branches</b>\n\nCurrent: <b>${escapeHtml(result.current ?? "detached")}</b>\n\nSelect a branch to switch:`;
	if (omittedByLength > 0) {
		message += `\n\n<i>Omitted ${omittedByLength} branch${omittedByLength === 1 ? "" : "es"} due to callback length limits.</i>`;
	}
	if (omittedByLimit > 0) {
		message += `\n<i>Showing first ${included} of ${result.branches.length} branches.</i>`;
	}

	if (included === 0) {
		await ctx.reply(
			"⚠️ No branches fit Telegram callback limits. Try shorter branch names.",
		);
		return;
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}

/**
 * /merge - Merge current branch into main/master via Claude.
 * Switches to main worktree first so Claude can see and resolve conflicts.
 */
export async function handleMerge(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (session.isRunning) {
		await ctx.reply("⚠️ A query is running. Use /stop first.");
		return;
	}

	const status = await getWorkingTreeStatus(session.workingDir);
	if (!status.success) {
		await ctx.reply(`❌ ${status.message}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}
	if (status.dirty) {
		await ctx.reply(
			"⚠️ Working tree has uncommitted changes. Commit or stash before merging.",
		);
		return;
	}

	const result = await getMergeInfo(session.workingDir);
	if (!result.success) {
		await ctx.reply(`❌ ${result.message}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}

	const { currentBranch, mainBranch } = result;
	const encodedBranch = Buffer.from(currentBranch).toString("base64");
	const callbackData = `merge:confirm:${encodedBranch}`;
	if (callbackData.length > CALLBACK_DATA_LIMIT) {
		await ctx.reply(
			"❌ Branch name is too long for Telegram callbacks. Try a shorter branch name.",
		);
		return;
	}

	const keyboard = new InlineKeyboard()
		.text("Merge", callbackData)
		.text("Cancel", "merge:cancel");

	await ctx.reply(
		`🔀 <b>Merge Branch</b>\n\nMerge <code>${escapeHtml(currentBranch)}</code> → <code>${escapeHtml(mainBranch)}</code>\n\nThis will:\n1. Switch to <code>${escapeHtml(mainBranch)}</code> worktree\n2. Ask Claude to merge and resolve any conflicts`,
		{ parse_mode: "HTML", reply_markup: keyboard },
	);
}

/**
 * /cost - Show token usage and estimated cost.
 */
export async function handleCost(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	const cost = session.estimateCost();
	const formatNum = (n: number) => n.toLocaleString();
	const formatCost = (n: number) => `$${n.toFixed(4)}`;

	await ctx.reply(
		`💰 <b>Session Usage</b>\n\nModel: <b>${session.currentModel}</b>\n\n<b>Tokens:</b>\n• Input: ${formatNum(session.totalInputTokens)}\n• Output: ${formatNum(session.totalOutputTokens)}\n• Cache read: ${formatNum(session.totalCacheReadTokens)}\n\n<b>Estimated Cost:</b>\n• Input: ${formatCost(cost.inputCost)}\n• Output: ${formatCost(cost.outputCost)}\n• Total: <b>${formatCost(cost.total)}</b>`,
		{ parse_mode: "HTML" },
	);
}

/**
 * /think - Force extended thinking for next message.
 */
export async function handleThink(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	session.planMode = !session.planMode;

	if (session.planMode) {
		await ctx.reply(
			"📋 <b>Plan mode ON</b>\n\n" +
				"Claude will analyze and plan without executing tools.\n" +
				"Use <code>/plan</code> again to exit.",
			{ parse_mode: "HTML" },
		);
	} else {
		await ctx.reply("📋 Plan mode OFF - Normal execution resumed");
	}
}

/**
 * /compact - Trigger SDK context compaction.
 */
export async function handleCompact(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (!session.isActive) {
		await ctx.reply("❌ No active session to compact.", {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}

	// Send "/compact" to Claude SDK to trigger manual compaction
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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

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
		`📦 <b>Context Handoff</b>\n\nThis will:\n1. Clear current session\n2. Start fresh with last response as context\n\n<b>Last response preview:</b>\n<code>${escapeHtml(preview)}</code>`,
		{ parse_mode: "HTML", reply_markup: keyboard },
	);
}

/**
 * /undo - Revert file changes to last checkpoint.
 */
export async function handleUndo(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	if (!session.isActive) {
		await ctx.reply("❌ No active session.", {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}

	if (!session.canUndo) {
		await ctx.reply(
			"❌ No checkpoints available.\n\n" +
				"Checkpoints are created when you send messages.",
		);
		return;
	}

	// Show progress
	const typing = startTypingIndicator(ctx);
	const statusMsg = await ctx.reply("⏪ Reverting files...");

	try {
		const [success, message] = await session.undo();

		const chatId = ctx.chat?.id;
		if (!chatId) {
			await ctx.reply("❌ Unable to determine chat ID.", {
				message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
			});
			return;
		}

		// Update status message with result
		await ctx.api.editMessageText(
			chatId,
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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Get the path argument from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/cd\s+(.+)$/);

	if (!match) {
		await ctx.reply(
			`📁 Current directory: <code>${session.workingDir}</code>\n\nUsage: <code>/cd /path/to/directory</code>`,
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

	// Check if other sessions are using the same directory
	const conflictingChats = sessionManager.getOtherSessionsUsingDirectory(
		resolvedPath,
		chatId,
	);

	// Change directory
	session.setWorkingDir(resolvedPath);

	// Build inline keyboard
	const keyboard = new InlineKeyboard();
	if (isBookmarked(resolvedPath)) {
		keyboard.text("⭐ Already bookmarked", "bookmark:noop");
	} else {
		keyboard.text("➕ Add to bookmarks", `bookmark:add:${resolvedPath}`);
	}

	// Build response message
	let message = `📁 Changed to: <code>${resolvedPath}</code>\n\nSession cleared. Next message starts fresh.`;

	// Add warning if other sessions use same directory
	if (conflictingChats.length > 0) {
		const chatList = conflictingChats.map((id) => `#${id}`).join(", ");
		message += `\n\n⚠️ <b>Warning:</b> Chat ${chatList} also uses this directory.\nSimultaneous edits may cause conflicts. Consider using <code>/worktree</code> to create an isolated branch.`;
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}

// Text/code file extensions that should be displayed inline
const TEXT_EXTENSIONS = [
	".txt",
	".md",
	".json",
	".xml",
	".yaml",
	".yml",
	".toml",
	".ini",
	".env",
	".js",
	".ts",
	".jsx",
	".tsx",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".php",
	".sh",
	".bash",
	".zsh",
	".fish",
	".sql",
	".css",
	".scss",
	".sass",
	".less",
	".html",
	".vue",
	".svelte",
	".dart",
	".kt",
	".swift",
	".m",
	".mm",
	".r",
	".lua",
	".pl",
	".ex",
	".exs",
	".clj",
	".scala",
	".gradle",
	".cmake",
	".make",
	".dockerfile",
];

/**
 * Send a single file to the user. Returns error message or null on success.
 * For small text/code files, displays content inline with syntax highlighting.
 * For large or binary files, sends as document download.
 */
async function sendFile(
	ctx: Context,
	filePath: string,
	workingDir: string,
): Promise<string | null> {
	const { readFileSync } = await import("node:fs");

	// Resolve relative paths from current working directory
	const resolvedPath = resolvePath(filePath, workingDir);

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

	const filename = resolvedPath.split("/").pop() || "file";
	const ext = extname(filename).toLowerCase();
	const isTextFile = TEXT_EXTENSIONS.includes(ext);

	// For small text/code files, display inline with syntax highlighting
	const INLINE_SIZE_LIMIT = 4096; // Telegram message limit
	if (isTextFile && stats.size < INLINE_SIZE_LIMIT) {
		try {
			const content = readFileSync(resolvedPath, "utf-8");

			// Escape HTML special chars
			const escaped = content
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");

			// Truncate if too long for Telegram message
			const maxLen = 3800; // Leave room for header and formatting
			const truncated =
				escaped.length > maxLen
					? `${escaped.slice(0, maxLen)}...\n\n(truncated, use /file to download full file)`
					: escaped;

			await ctx.reply(
				`📄 <b>${escapeHtml(filename)}</b>\n\n<pre><code class="language-${ext.slice(1)}">${truncated}</code></pre>`,
				{ parse_mode: "HTML" },
			);
			return null;
		} catch (error) {
			// If inline display fails, fall through to file download
			console.debug("Failed to display inline, falling back to file:", error);
		}
	}

	// Check file size (Telegram limit is 50MB for bots)
	const MAX_FILE_SIZE = 50 * 1024 * 1024;
	if (stats.size > MAX_FILE_SIZE) {
		const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
		return `File too large: ${resolvedPath} (${sizeMB}MB, max 50MB)`;
	}

	// Send as file download
	try {
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
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Get the path argument from command
	const text = ctx.message?.text || "";
	const match = text.match(/^\/file\s+(.+)$/);

	// If no argument, try to auto-detect from last bot response
	if (!match) {
		if (!session.lastBotResponse) {
			await ctx.reply(
				"📎 <b>Download File</b>\n\n" +
					"Usage: <code>/file &lt;filepath&gt;</code>\n" +
					"Or just <code>/file</code> to send files from the last response.\n\n" +
					"No recent response to extract files from.",
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
				"📎 No file paths found in <code>&lt;code&gt;</code> tags.\n\n" +
					"Usage: <code>/file &lt;filepath&gt;</code>",
				{ parse_mode: "HTML" },
			);
			return;
		}

		// Send each detected file
		const errors: string[] = [];
		let sent = 0;
		for (const filePath of detected) {
			const error = await sendFile(ctx, filePath, session.workingDir);
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
	const error = await sendFile(ctx, inputPath, session.workingDir);
	if (error) {
		await ctx.reply(`❌ ${error}`, {
			parse_mode: "HTML",
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
	}
}

const IMAGE_EXTENSIONS = [
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".tiff",
	".tif",
	".svg",
	".heic",
	".heif",
	".avif",
];
const PDF_EXTENSIONS = [".pdf"];
const DOCX_EXTENSIONS = [".docx"];
const HTML_EXTENSIONS = [".html", ".htm"];

const FILE_LIST_SAFE_LIMIT = Math.max(1000, TELEGRAM_MESSAGE_LIMIT - 200);

function collectFilesByExtensions(
	rootDir: string,
	extensions: string[],
): string[] {
	const results: string[] = [];
	const extensionSet = new Set(extensions.map((ext) => ext.toLowerCase()));

	const walk = (dir: string): void => {
		if (!isPathAllowed(dir)) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				const ext = extname(entry.name).toLowerCase();
				if (extensionSet.has(ext) && isPathAllowed(fullPath)) {
					results.push(fullPath);
				}
			}
		}
	};

	walk(rootDir);
	return results.sort();
}

function buildFileListMessages(
	title: string,
	rootDir: string,
	lines: string[],
): string[] {
	const messages: string[] = [];
	const header = `${title} (${lines.length})\n📁 <code>${escapeHtml(rootDir)}</code>\n\n`;
	const contHeader = `${title} (cont.)\n\n`;
	let current = header;

	for (const line of lines) {
		const addition = `${line}\n`;
		if (current.length + addition.length > FILE_LIST_SAFE_LIMIT) {
			messages.push(current.trimEnd());
			current = `${contHeader}${addition}`;
		} else {
			current += addition;
		}
	}

	if (current.trim().length > 0) {
		messages.push(current.trimEnd());
	}

	return messages;
}

async function handleListFilesByExtensions(
	ctx: Context,
	label: string,
	emoji: string,
	extensions: string[],
): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);
	const rootDir = session.workingDir;
	if (!isPathAllowed(rootDir)) {
		await ctx.reply(`❌ Access denied: <code>${escapeHtml(rootDir)}</code>`, {
			parse_mode: "HTML",
		});
		return;
	}

	const files = collectFilesByExtensions(rootDir, extensions);
	if (files.length === 0) {
		await ctx.reply(
			`${emoji} No ${label.toLowerCase()} found in <code>${escapeHtml(rootDir)}</code>.`,
			{ parse_mode: "HTML" },
		);
		return;
	}

	const lines = files.map((filePath) => `<code>${escapeHtml(filePath)}</code>`);
	const title = `${emoji} <b>${label}</b>`;
	const messages = buildFileListMessages(title, rootDir, lines);

	for (const message of messages) {
		await ctx.reply(message, { parse_mode: "HTML" });
	}
}

/**
 * /image - List all image files under working directory.
 */
export async function handleImage(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(ctx, "Images", "🖼️", IMAGE_EXTENSIONS);
}

/**
 * /pdf - List all PDF files under working directory.
 */
export async function handlePdf(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(ctx, "PDFs", "📄", PDF_EXTENSIONS);
}

/**
 * /docx - List all DOCX files under working directory.
 */
export async function handleDocx(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(ctx, "DOCX", "📝", DOCX_EXTENSIONS);
}

/**
 * /html - List all HTML files under working directory.
 */
export async function handleHtml(ctx: Context): Promise<void> {
	await handleListFilesByExtensions(ctx, "HTML", "🌐", HTML_EXTENSIONS);
}

/**
 * /bookmarks - List and manage bookmarks.
 */
export async function handleBookmarks(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

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

/**
 * /diff - Show uncommitted changes with interactive buttons.
 * Variants:
 *   /diff - Show all uncommitted changes (staged + unstaged)
 *   /diff staged - Show only staged changes
 *   /diff <file> - Show diff for specific file
 */
export async function handleDiff(ctx: Context): Promise<void> {
	const userId = ctx.from?.id;
	const chatId = ctx.chat?.id;

	if (!isAuthorized(userId, ALLOWED_USERS)) {
		await ctx.reply("Unauthorized.");
		return;
	}

	if (!chatId) return;

	const session = sessionManager.getSession(chatId);

	// Parse arguments
	const text = ctx.message?.text || "";
	const match = text.match(/^\/diff(?:\s+(.+))?$/);
	const arg = match?.[1]?.trim();

	const isStaged = arg === "staged";
	const file = arg && arg !== "staged" ? arg : undefined;

	// Get diff based on arguments
	const result = isStaged
		? await getGitDiff(session.workingDir, { staged: true })
		: file
			? await getCombinedDiff(session.workingDir, { file })
			: await getCombinedDiff(session.workingDir);

	if (!result.success) {
		await ctx.reply(`❌ ${result.message}`, {
			message_effect_id: MESSAGE_EFFECTS.THUMBS_DOWN,
		});
		return;
	}

	if (!result.hasChanges) {
		await ctx.reply("✨ No uncommitted changes.");
		return;
	}

	// Build summary message
	let message = "📝 <b>Uncommitted Changes</b>";
	if (isStaged) {
		message += " (staged)";
	} else if (file) {
		message += ` (<code>${escapeHtml(file)}</code>)`;
	}
	message += "\n\n";

	// Add file summary
	for (const item of result.summary) {
		message += `<code>${escapeHtml(item.file)}</code> (+${item.added}, -${item.removed})\n`;
	}

	// Count lines in full diff
	const diffLines = result.fullDiff.split("\n").length;
	const DIFF_LINE_THRESHOLD = 50;

	// Build inline keyboard
	const keyboard = new InlineKeyboard();

	// Encode options for callback
	const opts = isStaged ? "staged" : file ? `file:${file}` : "all";
	const encodedOpts = Buffer.from(opts).toString("base64");

	const diffCallback = `diff:view:${encodedOpts}`;
	if (diffCallback.length <= CALLBACK_DATA_LIMIT) {
		keyboard.text("📄 View Diff", diffCallback);
	} else {
		message +=
			"\n<i>Diff view omitted: file path too long for Telegram callbacks.</i>";
	}
	keyboard.text("💾 Commit", "diff:commit");
	keyboard.row();
	keyboard.text("⚠️ Revert All", "diff:revert");

	// If diff is large, mention it
	if (diffLines > DIFF_LINE_THRESHOLD) {
		message += `\n<i>(${diffLines} lines - will send as file)</i>`;
	}

	await ctx.reply(message, {
		parse_mode: "HTML",
		reply_markup: keyboard,
	});
}
