/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { McpServerConfig } from "./types";

// ============== Environment Setup ==============

const HOME = homedir();

// Ensure necessary paths are available for Claude's bash commands
// LaunchAgents don't inherit the full shell environment
const EXTRA_PATHS = [
	`${HOME}/.local/bin`,
	`${HOME}/.bun/bin`,
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
	if (!pathParts.includes(extraPath)) {
		pathParts.unshift(extraPath);
	}
}
process.env.PATH = pathParts.join(":");

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
	process.env.TELEGRAM_ALLOWED_USERS || ""
)
	.split(",")
	.filter((x) => x.trim())
	.map((x) => parseInt(x.trim(), 10))
	.filter((x) => !Number.isNaN(x));

export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// ============== Claude CLI Path ==============

// Auto-detect from PATH, or use environment override
function findClaudeCli(): string {
	const envPath = process.env.CLAUDE_CLI_PATH;
	if (envPath) return envPath;

	// Try to find claude in PATH using Bun.which
	const whichResult = Bun.which("claude");
	if (whichResult) return whichResult;

	// Final fallback
	return "/usr/local/bin/claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

// ============== MCP Configuration ==============

// MCP servers loaded from mcp-config.ts
let MCP_SERVERS: Record<string, McpServerConfig> = {};

try {
	// Dynamic import of MCP config
	const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
	const mcpModule = await import(mcpConfigPath).catch(() => null);
	if (mcpModule?.MCP_SERVERS) {
		MCP_SERVERS = mcpModule.MCP_SERVERS;
		console.log(
			`Loaded ${Object.keys(MCP_SERVERS).length} MCP servers from mcp-config.ts`,
		);
	}
} catch {
	console.log("No mcp-config.ts found - running without MCPs");
}

export { MCP_SERVERS };

// ============== Security Configuration ==============

// Allowed directories for file operations
const defaultAllowedPaths = [
	WORKING_DIR,
	`${HOME}/Documents`,
	`${HOME}/Downloads`,
	`${HOME}/Desktop`,
	`${HOME}/.claude`, // Claude Code data (plans, settings)
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
	? allowedPathsStr
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)
	: defaultAllowedPaths;

// Build safety prompt dynamically from ALLOWED_PATHS
function buildSafetyPrompt(allowedPaths: string[]): string {
	const pathsList = allowedPaths
		.map((p) => `   - ${p} (and subdirectories)`)
		.join("\n");

	return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

5. NEVER use the AskUserQuestion tool - it does not work in Telegram.
   - Instead, just ask your question directly in your response text
   - The user will reply with their answer in the next message
   - Example: Instead of using AskUserQuestion, just say "Which option do you prefer: A or B?"

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

// Dangerous command patterns to block
export const BLOCKED_PATTERNS = [
	// Destructive file operations
	"rm -rf /",
	"rm -rf ~",
	"rm -rf $HOME",
	"rm -rf /*",
	"rm -r /",
	"sudo rm",
	// System damage
	":(){ :|:& };:", // Fork bomb
	"> /dev/sd",
	"mkfs.",
	"dd if=",
	"chmod 777 /",
	"chmod -R 777",
	"chown -R",
	// Remote code execution
	"curl | bash",
	"curl | sh",
	"wget | bash",
	"wget | sh",
	"curl -s | bash",
	"wget -q | sh",
	// Sensitive file access
	"> /etc/",
	">> /etc/",
	"mv /etc/",
	"cp /etc/passwd",
	"cat /etc/shadow",
	// Network dangers
	"nc -l",
	"ncat -l",
	// Process/system manipulation
	"kill -9 1",
	"killall",
	"pkill -9",
	"shutdown",
	"reboot",
	"init 0",
	"init 6",
	// History/log tampering
	"history -c",
	"> ~/.bash_history",
	"shred",
];

// Query timeout interval (3 minutes) - prompts user to continue or abort
export const QUERY_TIMEOUT_MS = 180_000;

// Timeout for user to respond to "continue?" prompt (30 seconds)
// If no response, query continues automatically
export const TIMEOUT_PROMPT_WAIT_MS = 30_000;

// Maximum concurrent queries (prevents resource exhaustion)
export const MAX_CONCURRENT_QUERIES = parseInt(
	process.env.MAX_CONCURRENT_QUERIES || "3",
	10,
);

// ============== Voice Transcription ==============

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

const TRANSCRIPTION_CONTEXT = process.env.TRANSCRIPTION_CONTEXT || "";

export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
	? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
	: BASE_TRANSCRIPTION_PROMPT;

export const TRANSCRIPTION_AVAILABLE = !!OPENAI_API_KEY;

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
	process.env.THINKING_KEYWORDS || "think,pensa,ragiona";
const thinkingDeepKeywordsStr =
	process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,pensa bene";

export const THINKING_KEYWORDS = thinkingKeywordsStr
	.split(",")
	.map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
	.split(",")
	.map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// ============== Telegram Message Effects ==============
// https://core.telegram.org/api/effects
export const MESSAGE_EFFECTS = {
	FIRE: "5104841245755180586", // 🔥
	THUMBS_UP: "5107584321108051014", // 👍
	THUMBS_DOWN: "5104858069142078462", // 👎
	HEART: "5159385139981059251", // ❤️
	CONFETTI: "5046509860389126442", // 🎉
	POOP: "5046589136895476101", // 💩
} as const;

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
	process.env.AUDIT_LOG_PATH || "/tmp/claude-telegram-audit.log";
export const AUDIT_LOG_JSON =
	(process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";

// Audit log rotation: max size in bytes (default 10MB)
export const AUDIT_LOG_MAX_SIZE = parseInt(
	process.env.AUDIT_LOG_MAX_SIZE || String(10 * 1024 * 1024),
	10,
);
// Number of rotated files to keep (default 3: .log, .log.1, .log.2)
export const AUDIT_LOG_MAX_FILES = parseInt(
	process.env.AUDIT_LOG_MAX_FILES || "3",
	10,
);

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
	(process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
	process.env.RATE_LIMIT_REQUESTS || "20",
	10,
);
export const RATE_LIMIT_WINDOW = parseInt(
	process.env.RATE_LIMIT_WINDOW || "60",
	10,
);

// ============== File Paths ==============

// Generate a short hash for instance isolation
function hashDir(dir: string): string {
	let hash = 0;
	for (let i = 0; i < dir.length; i++) {
		const char = dir.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return Math.abs(hash).toString(36).slice(0, 8);
}

// Instance directory for session isolation (set by CLI or defaults to working dir)
const INSTANCE_DIR = process.env.CTB_INSTANCE_DIR || WORKING_DIR;
const INSTANCE_HASH = hashDir(INSTANCE_DIR);
const INSTANCE_TEMP_DIR = `/tmp/ctb-${INSTANCE_HASH}`;

export const SESSION_FILE = `${INSTANCE_TEMP_DIR}/session.json`;
export const RESTART_FILE = `${INSTANCE_TEMP_DIR}/restart.json`;
export const TEMP_DIR = `${INSTANCE_TEMP_DIR}/downloads`;

// Temp paths that are always allowed for bot operations
export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

// Ensure temp directories exist
await Bun.write(`${INSTANCE_TEMP_DIR}/.keep`, "");
await Bun.write(`${TEMP_DIR}/.keep`, "");

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
	console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
	process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
	console.error(
		"ERROR: TELEGRAM_ALLOWED_USERS environment variable is required",
	);
	process.exit(1);
}

console.log(
	`Config loaded: ${ALLOWED_USERS.length} allowed users, working dir: ${WORKING_DIR}`,
);
