/**
 * Shared file sending utilities for Claude Telegram Bot.
 *
 * Provides functions to detect file requests and automatically send files.
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import { resolvePath } from "../bookmarks";
import { detectFilePaths, escapeHtml } from "../formatting";
import { isPathAllowed } from "../security";
import type { ClaudeSession } from "../session";

// Lazy-init Anthropic client for AI-based file request detection
let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic | null {
	if (anthropicClient === null && process.env.ANTHROPIC_API_KEY) {
		anthropicClient = new Anthropic({
			apiKey: process.env.ANTHROPIC_API_KEY,
		});
	}
	return anthropicClient;
}

/**
 * Use Claude AI to detect if a message is requesting files.
 * Falls back to false if AI detection fails or is unavailable.
 */
async function detectFileRequestWithAI(message: string): Promise<boolean> {
	const client = getAnthropicClient();
	if (!client) {
		// No API key available, assume not a file request
		return false;
	}

	try {
		const response = await client.messages.create({
			model: "claude-3-haiku-20240307",
			max_tokens: 10,
			messages: [
				{
					role: "user",
					content: `Is this message requesting to see, download, or send a file? Answer only "yes" or "no".\n\nMessage: "${message}"`,
				},
			],
		});

		const text =
			response.content[0]?.type === "text"
				? response.content[0].text.toLowerCase().trim()
				: "";
		return text.includes("yes");
	} catch (error) {
		console.debug("AI file request detection failed:", error);
		return false;
	}
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
export async function sendFile(
	ctx: Context,
	filePath: string,
	workingDir: string,
): Promise<string | null> {
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
 * Auto-detect and send files from last bot response if user is requesting files.
 *
 * Returns true if file request was detected and handled, false otherwise.
 */
export async function handleAutoFileSend(
	ctx: Context,
	message: string,
	session: ClaudeSession,
): Promise<boolean> {
	// Check if message is a file request using AI
	const isFileRequest = await detectFileRequestWithAI(message);
	if (!isFileRequest) {
		return false;
	}

	// Strategy 1: Try to extract paths from last bot response
	const candidates: string[] = [];

	if (session.lastBotResponse) {
		// Extract paths from <code> tags (response is HTML)
		const codeMatches = session.lastBotResponse.matchAll(
			/<code>([^<]+)<\/code>/g,
		);
		for (const m of codeMatches) {
			const content = m[1]?.trim();
			// Must have file extension (contains . followed by letters)
			if (content && /\.[a-zA-Z0-9]+$/.test(content)) {
				candidates.push(content);
			}
		}

		// Also try detectFilePaths for comprehensive detection (handles plain text paths too)
		const detectedPaths = detectFilePaths(
			session.lastBotResponse,
			session.workingDir,
		);
		for (const detected of detectedPaths) {
			candidates.push(detected.path);
		}
	}

	// Strategy 2: If no files found in bot response, try to find recently mentioned/created files
	// by searching for common file operations in the last response
	if (candidates.length === 0 && session.lastBotResponse) {
		// Look for file operations like "Created", "Wrote", "Saved", "Updated" followed by filename
		const operationMatches = session.lastBotResponse.matchAll(
			/(?:Created|Wrote|Saved|Updated|Modified|Generated|Built|Compiled|Exported)\s+(?:file\s+)?(?:<[^>]+>)?([a-zA-Z0-9_./+-]+\.[a-zA-Z0-9]+)/gi,
		);
		for (const m of operationMatches) {
			const filePath = m[1]?.trim();
			if (filePath) {
				candidates.push(filePath);
			}
		}
	}

	// Deduplicate
	const detected = [...new Set(candidates)];

	// If still no files found, give brief error message
	if (detected.length === 0) {
		await ctx.reply(
			"📎 沒找到檔案路徑。試試 <code>/file &lt;path&gt;</code> 或請我先列出檔案。",
			{ parse_mode: "HTML" },
		);
		return true;
	}

	// Send each detected file
	const errors: string[] = [];
	let sent = 0;
	for (const filePath of detected) {
		const error = await sendFile(ctx, filePath, session.workingDir);
		if (error) {
			errors.push(`• ${escapeHtml(filePath)}: ${error}`);
		} else {
			sent++;
		}
	}

	// Report results
	if (sent > 0 && errors.length === 0) {
		// All succeeded
		await ctx.reply(
			`✅ Sent ${sent} file${sent > 1 ? "s" : ""} automatically.`,
		);
	} else if (sent > 0 && errors.length > 0) {
		// Some succeeded, some failed
		await ctx.reply(
			`✅ Sent ${sent} file${sent > 1 ? "s" : ""}.\n\n` +
				`⚠️ <b>Failed to send ${errors.length} file${errors.length > 1 ? "s" : ""}:</b>\n${errors.join("\n")}`,
			{ parse_mode: "HTML" },
		);
	} else {
		// All failed
		await ctx.reply(
			`❌ <b>Could not send any files:</b>\n${errors.join("\n")}\n\n` +
				`Try using <code>/file &lt;filepath&gt;</code> to specify the file manually.`,
			{ parse_mode: "HTML" },
		);
	}

	return true;
}
