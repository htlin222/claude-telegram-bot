/**
 * Formatting module for Claude Telegram Bot.
 *
 * Markdown conversion and tool status display formatting.
 */

/**
 * Escape HTML special characters.
 */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Convert standard markdown to Telegram-compatible HTML.
 *
 * HTML is more reliable than Telegram's Markdown which breaks on special chars.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a href="">
 */
export function convertMarkdownToHtml(text: string): string {
	// Store code blocks temporarily to avoid processing their contents
	const codeBlocks: string[] = [];
	const inlineCodes: string[] = [];

	// Save code blocks first (```code```)
	text = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
		codeBlocks.push(code);
		return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
	});

	// Save inline code (`code`)
	text = text.replace(/`([^`]+)`/g, (_, code) => {
		inlineCodes.push(code);
		return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
	});

	// Escape HTML entities in the remaining text
	text = escapeHtml(text);

	// Headers: ## Header -> <b>Header</b>
	text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>\n");

	// Bold: **text** -> <b>text</b>
	text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

	// Also handle *text* as bold (single asterisk)
	text = text.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, "<b>$1</b>");

	// Double underscore: __text__ -> <b>text</b>
	text = text.replace(/__([^_]+)__/g, "<b>$1</b>");

	// Italic: _text_ -> <i>text</i> (but not __text__ or word_with_underscores)
	// Require proper word boundaries: space/punctuation before opening _, and after closing _
	text = text.replace(
		/(?<=^|[\s(])_([^_\n]+?)_(?=$|[\s.,;:!?)\]])/gm,
		"<i>$1</i>",
	);

	// Blockquotes: &gt; text -> <blockquote>text</blockquote>
	text = convertBlockquotes(text);

	// Bullet lists: - item or * item -> • item
	text = text.replace(/^[-*] /gm, "• ");

	// Horizontal rules: --- or *** -> blank line
	text = text.replace(/^[-*]{3,}$/gm, "");

	// Links: [text](url) -> <a href="url">text</a>
	text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

	// Restore code blocks
	for (let i = 0; i < codeBlocks.length; i++) {
		const escapedCode = escapeHtml(codeBlocks[i]!);
		text = text.replace(`\x00CODEBLOCK${i}\x00`, `<pre>${escapedCode}</pre>`);
	}

	// Restore inline code
	for (let i = 0; i < inlineCodes.length; i++) {
		const escapedCode = escapeHtml(inlineCodes[i]!);
		text = text.replace(
			`\x00INLINECODE${i}\x00`,
			`<code>${escapedCode}</code>`,
		);
	}

	// Collapse multiple newlines
	text = text.replace(/\n{3,}/g, "\n\n");

	return text;
}

/**
 * Convert blockquotes (handles multi-line).
 */
function convertBlockquotes(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let inBlockquote = false;
	const blockquoteLines: string[] = [];

	for (const line of lines) {
		if (line.startsWith("&gt; ") || line === "&gt;") {
			if (line === "&gt;") {
				blockquoteLines.push("");
			} else {
				// Remove '&gt; ' and strip # from hashtags (Telegram mobile bug workaround)
				const content = line.slice(5).replace(/#/g, "");
				blockquoteLines.push(content);
			}
			inBlockquote = true;
		} else {
			if (inBlockquote) {
				result.push(`<blockquote>${blockquoteLines.join("\n")}</blockquote>`);
				blockquoteLines.length = 0;
				inBlockquote = false;
			}
			result.push(line);
		}
	}

	// Handle blockquote at end
	if (inBlockquote) {
		result.push(`<blockquote>${blockquoteLines.join("\n")}</blockquote>`);
	}

	return result.join("\n");
}

// Legacy alias
export const convertMarkdownForTelegram = convertMarkdownToHtml;

/**
 * Detect file paths in text that could be sent as documents.
 * Returns array of { path, display } objects.
 * If workingDir is provided, relative paths are resolved and checked for existence.
 * Supports both plain text and HTML formatted responses.
 */
export function detectFilePaths(
	text: string,
	workingDir?: string,
): Array<{ path: string; display: string }> {
	const paths: Array<{ path: string; display: string }> = [];
	const seen = new Set<string>();

	// Match paths in various formats
	const patterns = [
		// HTML code tags: <code>/path/to/file.ext</code> or <code>file.ext</code>
		/<code>([a-zA-Z0-9_./+-]+\.[a-zA-Z0-9]+)<\/code>/gi,
		// Absolute paths in backticks: `/path/to/file.ext`
		/`(\/[^\s`]+\.[a-zA-Z0-9]+)`/g,
		// Relative paths in backticks with extension: `name.txt`, `path/to/file.ext`
		/`([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.[a-zA-Z0-9]+)`/g,
		// Paths after common prefixes (absolute)
		/(?:file|path|saved|created|wrote|output|generated|reading|writing|editing):\s*(\/[^\s,)<]+\.[a-zA-Z0-9]+)/gi,
		// Paths after common prefixes (relative)
		/(?:file|path|saved|created|wrote|output|generated|reading|writing|editing):\s*([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.[a-zA-Z0-9]+)/gi,
		// Standalone absolute paths with extensions (common directories)
		/(?:^|\s)(\/(?:Users|home|tmp|var|etc|opt|Applications)[^\s,)<]+\.[a-zA-Z0-9]+)/gm,
		// Relative paths that look like files (e.g., src/index.ts, README.md)
		/(?:^|\s)([a-zA-Z0-9_-]+\/[a-zA-Z0-9_./+-]+\.[a-zA-Z0-9]+)(?:\s|$|<|,|\))/gm,
	];

	for (const pattern of patterns) {
		const matches = text.matchAll(pattern);
		for (const match of matches) {
			let filePath = match[1];
			if (!filePath) continue;

			// Clean up HTML entities if present
			filePath = filePath
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&amp;/g, "&")
				.replace(/&quot;/g, '"');

			// Resolve relative paths if workingDir is provided
			if (!filePath.startsWith("/") && workingDir) {
				filePath = `${workingDir}/${filePath}`;
			}

			// Skip if we've already seen this path
			if (seen.has(filePath)) continue;
			seen.add(filePath);

			// Get display name (last 2 path components)
			const parts = filePath.split("/");
			const display =
				parts.length >= 2
					? parts.slice(-2).join("/")
					: parts[parts.length - 1] || filePath;
			paths.push({ path: filePath, display });
		}
	}

	return paths;
}

/**
 * Detect if user is requesting to view/download files.
 *
 * Patterns matched (case-insensitive, supports Chinese and English):
 * - "把檔案給我看"
 * - "send me the file"
 * - "show me the file"
 * - "download the file"
 * - "give me the file"
 * - "can i see the file"
 * - "let me see the file"
 * - etc.
 */
export function detectFileRequest(text: string): boolean {
	const lowerText = text.toLowerCase().trim();

	// Chinese patterns
	const chinesePatterns = [
		/把.*檔案.*給我/,
		/檔案.*給我看/,
		/給我.*檔案/,
		/傳.*檔案/,
		/下載.*檔案/,
		/看.*檔案/,
		/檔案.*看/,
	];

	// English patterns
	const englishPatterns = [
		/\b(send|give|show)\s+(me\s+)?(the\s+)?files?\b/,
		/\b(download|get)\s+(the\s+)?files?\b/,
		/\bcan\s+i\s+(see|have|get)\s+(the\s+)?files?\b/,
		/\blet\s+me\s+(see|have)\s+(the\s+)?files?\b/,
		/\bi\s+(want|need)\s+(the\s+)?files?\b/,
		/\bfiles?\s+(please|pls)\b/,
	];

	// Check Chinese patterns (case-sensitive for Chinese)
	for (const pattern of chinesePatterns) {
		if (pattern.test(text)) {
			return true;
		}
	}

	// Check English patterns (case-insensitive)
	for (const pattern of englishPatterns) {
		if (pattern.test(lowerText)) {
			return true;
		}
	}

	return false;
}

// ============== Tool Status Formatting ==============

/**
 * Shorten a file path for display (last 2 components).
 */
function shortenPath(path: string): string {
	if (!path) return "file";
	const parts = path.split("/");
	if (parts.length >= 2) {
		return parts.slice(-2).join("/");
	}
	return parts[parts.length - 1] || path;
}

/**
 * Truncate text with ellipsis.
 */
function truncate(text: string, maxLen = 60): string {
	if (!text) return "";
	// Clean up newlines for display
	const cleaned = text.replace(/\n/g, " ").trim();
	if (cleaned.length <= maxLen) return cleaned;
	return `${cleaned.slice(0, maxLen)}...`;
}

/**
 * Wrap text in HTML code tags, escaping special chars.
 */
function code(text: string): string {
	return `<code>${escapeHtml(text)}</code>`;
}

/**
 * Format tool use for display in Telegram with HTML formatting.
 */
export function formatToolStatus(
	toolName: string,
	toolInput: Record<string, unknown>,
): string {
	const emojiMap: Record<string, string> = {
		Read: "📖",
		Write: "📝",
		Edit: "✏️",
		Bash: "▶️",
		Glob: "🔍",
		Grep: "🔎",
		WebSearch: "🔍",
		WebFetch: "🌐",
		Task: "🎯",
		TodoWrite: "📋",
		mcp__: "🔧",
	};

	// Find matching emoji
	let emoji = "🔧";
	for (const [key, val] of Object.entries(emojiMap)) {
		if (toolName.includes(key)) {
			emoji = val;
			break;
		}
	}

	// Format based on tool type
	if (toolName === "Read") {
		const filePath = String(toolInput.file_path || "file");
		const shortPath = shortenPath(filePath);
		const imageExtensions = [
			".jpg",
			".jpeg",
			".png",
			".gif",
			".webp",
			".bmp",
			".svg",
			".ico",
		];
		if (imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext))) {
			return "👀 Viewing";
		}
		return `${emoji} Reading ${code(shortPath)}`;
	}

	if (toolName === "Write") {
		const filePath = String(toolInput.file_path || "file");
		return `${emoji} Writing ${code(shortenPath(filePath))}`;
	}

	if (toolName === "Edit") {
		const filePath = String(toolInput.file_path || "file");
		return `${emoji} Editing ${code(shortenPath(filePath))}`;
	}

	if (toolName === "Bash") {
		const cmd = String(toolInput.command || "");
		const desc = String(toolInput.description || "");
		if (desc) {
			return `${emoji} ${escapeHtml(desc)}: ${code(truncate(cmd, 40))}`;
		}
		return `${emoji} ${code(truncate(cmd, 50))}`;
	}

	if (toolName === "Grep") {
		const pattern = String(toolInput.pattern || "");
		const path = String(toolInput.path || "");
		if (path) {
			return `${emoji} Searching ${code(truncate(pattern, 30))} in ${code(
				shortenPath(path),
			)}`;
		}
		return `${emoji} Searching ${code(truncate(pattern, 40))}`;
	}

	if (toolName === "Glob") {
		const pattern = String(toolInput.pattern || "");
		return `${emoji} Finding ${code(truncate(pattern, 50))}`;
	}

	if (toolName === "WebSearch") {
		const query = String(toolInput.query || "");
		return `${emoji} Searching: ${code(truncate(query, 50))}`;
	}

	if (toolName === "WebFetch") {
		const url = String(toolInput.url || "");
		return `${emoji} Fetching ${code(truncate(url, 50))}`;
	}

	if (toolName === "Task") {
		const desc = String(toolInput.description || "");
		if (desc) {
			return `${emoji} Agent: ${code(desc)}`;
		}
		return `${emoji} Running agent...`;
	}

	if (toolName === "Skill") {
		const skillName = String(toolInput.skill || "");
		if (skillName) {
			return `💭 Using skill: ${code(skillName)}`;
		}
		return `💭 Using skill...`;
	}

	if (toolName.startsWith("mcp__")) {
		// Generic MCP tool formatting
		const parts = toolName.split("__");
		if (parts.length >= 3) {
			const server = parts[1]!;
			let action = parts[2]!;
			// Remove redundant server prefix from action
			if (action.startsWith(`${server}_`)) {
				action = action.slice(server.length + 1);
			}
			action = action.replace(/_/g, " ");

			// Try to get meaningful summary
			const summary =
				toolInput.title ||
				toolInput.query ||
				toolInput.content ||
				toolInput.text ||
				toolInput.id ||
				"";

			if (summary) {
				return `🔧 ${code(server)} ${action}: ${code(
					truncate(String(summary), 40),
				)}`;
			}
			return `🔧 ${code(server)}: ${action}`;
		}
		return `🔧 ${code(toolName)}`;
	}

	return `${emoji} ${escapeHtml(toolName)}`;
}
