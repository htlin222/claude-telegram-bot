/**
 * Unit tests for command handlers.
 *
 * Tests parsing and validation logic without mocking Grammy/Telegram.
 * Extracts the pure functions and regex patterns from command handlers.
 */

import { describe, expect, test } from "bun:test";

// ============== Model Switching Logic ==============

/**
 * Parse model name from /model command.
 * Returns the model name if valid, null otherwise.
 */
function parseModelCommand(text: string): string | null {
	const match = text.match(/^\/model\s+(\w+)$/i);
	if (!match) return null;

	const modelName = match[1]?.toLowerCase();
	if (modelName !== "sonnet" && modelName !== "opus" && modelName !== "haiku") {
		return null;
	}

	return modelName;
}

/**
 * Validate a model name.
 */
function isValidModelName(name: string): boolean {
	const normalized = name.toLowerCase();
	return (
		normalized === "sonnet" || normalized === "opus" || normalized === "haiku"
	);
}

describe("Model switching logic", () => {
	describe("parseModelCommand", () => {
		test("parses valid model name: sonnet", () => {
			expect(parseModelCommand("/model sonnet")).toBe("sonnet");
		});

		test("parses valid model name: opus", () => {
			expect(parseModelCommand("/model opus")).toBe("opus");
		});

		test("parses valid model name: haiku", () => {
			expect(parseModelCommand("/model haiku")).toBe("haiku");
		});

		test("handles case insensitivity", () => {
			expect(parseModelCommand("/model SONNET")).toBe("sonnet");
			expect(parseModelCommand("/model Opus")).toBe("opus");
			expect(parseModelCommand("/model HaIkU")).toBe("haiku");
		});

		test("returns null for invalid model names", () => {
			expect(parseModelCommand("/model gpt4")).toBeNull();
			expect(parseModelCommand("/model claude")).toBeNull();
			expect(parseModelCommand("/model gemini")).toBeNull();
		});

		test("returns null for missing model name", () => {
			expect(parseModelCommand("/model")).toBeNull();
			expect(parseModelCommand("/model ")).toBeNull();
		});

		test("returns null for extra arguments", () => {
			expect(parseModelCommand("/model sonnet extra")).toBeNull();
		});

		test("returns null for non-model commands", () => {
			expect(parseModelCommand("/start")).toBeNull();
			expect(parseModelCommand("model sonnet")).toBeNull();
		});
	});

	describe("isValidModelName", () => {
		test("accepts valid model names", () => {
			expect(isValidModelName("sonnet")).toBe(true);
			expect(isValidModelName("opus")).toBe(true);
			expect(isValidModelName("haiku")).toBe(true);
		});

		test("handles case insensitivity", () => {
			expect(isValidModelName("SONNET")).toBe(true);
			expect(isValidModelName("Opus")).toBe(true);
			expect(isValidModelName("HAIKU")).toBe(true);
		});

		test("rejects invalid model names", () => {
			expect(isValidModelName("gpt4")).toBe(false);
			expect(isValidModelName("claude")).toBe(false);
			expect(isValidModelName("")).toBe(false);
			expect(isValidModelName("sonnet-3.5")).toBe(false);
		});
	});
});

// ============== Thinking Level Parsing ==============

type ThinkingLevel = { tokens: number; label: string };

/**
 * Parse thinking level from /think command.
 * Returns tokens and label, or null for invalid levels.
 */
function parseThinkCommand(text: string): ThinkingLevel | null {
	const match = text.match(/^\/think\s+(\w+)$/i);

	// Default behavior (no argument)
	if (!match) {
		// Only return default if it's the base command
		if (text === "/think" || text === "/think ") {
			return { tokens: 50000, label: "deep (50K tokens)" };
		}
		return null;
	}

	const level = match[1]?.toLowerCase();

	switch (level) {
		case "off":
		case "0":
			return { tokens: 0, label: "off" };
		case "normal":
		case "10k":
			return { tokens: 10000, label: "normal (10K tokens)" };
		case "deep":
		case "50k":
			return { tokens: 50000, label: "deep (50K tokens)" };
		default:
			return null;
	}
}

/**
 * Map budget level names to tokens.
 */
function budgetLevelToTokens(
	level: string,
): { tokens: number; label: string } | null {
	const normalized = level.toLowerCase();

	const budgets: Record<string, { tokens: number; label: string }> = {
		off: { tokens: 0, label: "off" },
		"0": { tokens: 0, label: "off" },
		low: { tokens: 10000, label: "low (10K tokens)" },
		normal: { tokens: 10000, label: "normal (10K tokens)" },
		"10k": { tokens: 10000, label: "normal (10K tokens)" },
		medium: { tokens: 25000, label: "medium (25K tokens)" },
		"25k": { tokens: 25000, label: "medium (25K tokens)" },
		high: { tokens: 50000, label: "high (50K tokens)" },
		deep: { tokens: 50000, label: "deep (50K tokens)" },
		"50k": { tokens: 50000, label: "deep (50K tokens)" },
		max: { tokens: 100000, label: "max (100K tokens)" },
		"100k": { tokens: 100000, label: "max (100K tokens)" },
	};

	return budgets[normalized] || null;
}

describe("Thinking level parsing", () => {
	describe("parseThinkCommand", () => {
		test("returns default (deep) for bare /think command", () => {
			const result = parseThinkCommand("/think");
			expect(result).toEqual({ tokens: 50000, label: "deep (50K tokens)" });
		});

		test("parses 'off' level", () => {
			const result = parseThinkCommand("/think off");
			expect(result).toEqual({ tokens: 0, label: "off" });
		});

		test("parses '0' as off", () => {
			const result = parseThinkCommand("/think 0");
			expect(result).toEqual({ tokens: 0, label: "off" });
		});

		test("parses 'normal' level", () => {
			const result = parseThinkCommand("/think normal");
			expect(result).toEqual({ tokens: 10000, label: "normal (10K tokens)" });
		});

		test("parses '10k' level", () => {
			const result = parseThinkCommand("/think 10k");
			expect(result).toEqual({ tokens: 10000, label: "normal (10K tokens)" });
		});

		test("parses 'deep' level", () => {
			const result = parseThinkCommand("/think deep");
			expect(result).toEqual({ tokens: 50000, label: "deep (50K tokens)" });
		});

		test("parses '50k' level", () => {
			const result = parseThinkCommand("/think 50k");
			expect(result).toEqual({ tokens: 50000, label: "deep (50K tokens)" });
		});

		test("handles case insensitivity", () => {
			expect(parseThinkCommand("/think OFF")).toEqual({
				tokens: 0,
				label: "off",
			});
			expect(parseThinkCommand("/think DEEP")).toEqual({
				tokens: 50000,
				label: "deep (50K tokens)",
			});
		});

		test("returns null for invalid levels", () => {
			expect(parseThinkCommand("/think invalid")).toBeNull();
			expect(parseThinkCommand("/think 999")).toBeNull();
			expect(parseThinkCommand("/think max")).toBeNull(); // Not in original handler
		});

		test("returns null for extra arguments", () => {
			expect(parseThinkCommand("/think deep extra")).toBeNull();
		});
	});

	describe("budgetLevelToTokens", () => {
		test("maps 'low' to 10K tokens", () => {
			expect(budgetLevelToTokens("low")).toEqual({
				tokens: 10000,
				label: "low (10K tokens)",
			});
		});

		test("maps 'medium' to 25K tokens", () => {
			expect(budgetLevelToTokens("medium")).toEqual({
				tokens: 25000,
				label: "medium (25K tokens)",
			});
		});

		test("maps 'high' to 50K tokens", () => {
			expect(budgetLevelToTokens("high")).toEqual({
				tokens: 50000,
				label: "high (50K tokens)",
			});
		});

		test("maps 'max' to 100K tokens", () => {
			expect(budgetLevelToTokens("max")).toEqual({
				tokens: 100000,
				label: "max (100K tokens)",
			});
		});

		test("maps numeric aliases", () => {
			expect(budgetLevelToTokens("10k")).toEqual({
				tokens: 10000,
				label: "normal (10K tokens)",
			});
			expect(budgetLevelToTokens("25k")).toEqual({
				tokens: 25000,
				label: "medium (25K tokens)",
			});
			expect(budgetLevelToTokens("50k")).toEqual({
				tokens: 50000,
				label: "deep (50K tokens)",
			});
			expect(budgetLevelToTokens("100k")).toEqual({
				tokens: 100000,
				label: "max (100K tokens)",
			});
		});

		test("handles case insensitivity", () => {
			expect(budgetLevelToTokens("LOW")).toEqual({
				tokens: 10000,
				label: "low (10K tokens)",
			});
			expect(budgetLevelToTokens("MAX")).toEqual({
				tokens: 100000,
				label: "max (100K tokens)",
			});
		});

		test("returns null for invalid levels", () => {
			expect(budgetLevelToTokens("invalid")).toBeNull();
			expect(budgetLevelToTokens("")).toBeNull();
			expect(budgetLevelToTokens("200k")).toBeNull();
		});
	});
});

// ============== Command Argument Parsing ==============

/**
 * Parse path from /cd command.
 */
function parseCdCommand(text: string): string | null {
	const match = text.match(/^\/cd\s+(.+)$/);
	return match ? (match[1] ?? "").trim() : null;
}

/**
 * Parse skill name and args from /skill command.
 */
function parseSkillCommand(
	text: string,
): { name: string; args: string } | null {
	const match = text.match(/^\/skill\s+(\S+)(?:\s+(.*))?$/);
	if (!match) return null;

	return {
		name: match[1] ?? "",
		args: match[2] || "",
	};
}

/**
 * Parse file path from /file command.
 */
function parseFileCommand(text: string): string | null {
	const match = text.match(/^\/file\s+(.+)$/);
	return match ? (match[1] ?? "").trim() : null;
}

/**
 * Parse provider name from /provider command.
 */
function parseProviderCommand(text: string): string | null {
	const match = text.match(/^\/provider\s+(\w+)$/i);
	return match ? (match[1]?.toLowerCase() ?? null) : null;
}

describe("Command argument parsing", () => {
	describe("parseCdCommand", () => {
		test("extracts simple path", () => {
			expect(parseCdCommand("/cd /home/user")).toBe("/home/user");
		});

		test("extracts path with spaces (trimmed)", () => {
			expect(parseCdCommand("/cd   /home/user  ")).toBe("/home/user");
		});

		test("extracts relative path", () => {
			expect(parseCdCommand("/cd ./subdir")).toBe("./subdir");
		});

		test("extracts path with special characters", () => {
			expect(parseCdCommand("/cd /path/with spaces/and-dashes")).toBe(
				"/path/with spaces/and-dashes",
			);
		});

		test("extracts home directory shortcut", () => {
			expect(parseCdCommand("/cd ~")).toBe("~");
			expect(parseCdCommand("/cd ~/Documents")).toBe("~/Documents");
		});

		test("returns null for missing path", () => {
			expect(parseCdCommand("/cd")).toBeNull();
			expect(parseCdCommand("/cd ")).toBeNull();
		});

		test("returns null for non-cd commands", () => {
			expect(parseCdCommand("/start")).toBeNull();
			expect(parseCdCommand("cd /home")).toBeNull();
		});
	});

	describe("parseSkillCommand", () => {
		test("extracts skill name without args", () => {
			const result = parseSkillCommand("/skill commit");
			expect(result).toEqual({ name: "commit", args: "" });
		});

		test("extracts skill name with args", () => {
			const result = parseSkillCommand("/skill review-pr 123");
			expect(result).toEqual({ name: "review-pr", args: "123" });
		});

		test("extracts skill name with multiple args", () => {
			const result = parseSkillCommand("/skill test --watch --coverage");
			expect(result).toEqual({ name: "test", args: "--watch --coverage" });
		});

		test("handles skill names with hyphens", () => {
			const result = parseSkillCommand("/skill my-custom-skill");
			expect(result).toEqual({ name: "my-custom-skill", args: "" });
		});

		test("returns null for missing skill name", () => {
			expect(parseSkillCommand("/skill")).toBeNull();
			expect(parseSkillCommand("/skill ")).toBeNull();
		});

		test("returns null for non-skill commands", () => {
			expect(parseSkillCommand("/start")).toBeNull();
			expect(parseSkillCommand("skill commit")).toBeNull();
		});
	});

	describe("parseFileCommand", () => {
		test("extracts file path", () => {
			expect(parseFileCommand("/file /home/user/doc.txt")).toBe(
				"/home/user/doc.txt",
			);
		});

		test("extracts relative path", () => {
			expect(parseFileCommand("/file ./src/index.ts")).toBe("./src/index.ts");
		});

		test("extracts path with spaces", () => {
			expect(parseFileCommand("/file /path/to/my file.pdf")).toBe(
				"/path/to/my file.pdf",
			);
		});

		test("returns null for missing path", () => {
			expect(parseFileCommand("/file")).toBeNull();
			expect(parseFileCommand("/file ")).toBeNull();
		});

		test("returns null for non-file commands", () => {
			expect(parseFileCommand("/start")).toBeNull();
			expect(parseFileCommand("file /path")).toBeNull();
		});
	});

	describe("parseProviderCommand", () => {
		test("extracts provider name", () => {
			expect(parseProviderCommand("/provider claude")).toBe("claude");
			expect(parseProviderCommand("/provider codex")).toBe("codex");
		});

		test("handles case insensitivity", () => {
			expect(parseProviderCommand("/provider CLAUDE")).toBe("claude");
			expect(parseProviderCommand("/provider Codex")).toBe("codex");
		});

		test("returns null for missing provider", () => {
			expect(parseProviderCommand("/provider")).toBeNull();
			expect(parseProviderCommand("/provider ")).toBeNull();
		});

		test("returns null for non-provider commands", () => {
			expect(parseProviderCommand("/start")).toBeNull();
			expect(parseProviderCommand("provider claude")).toBeNull();
		});
	});
});

// ============== Help Text Format ==============

/**
 * Generate help text for /start command.
 * This is the structure from handleStart.
 */
function generateStartMessage(status: string, workDir: string): string {
	return `<b>Claude Telegram Bot</b>

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
/file - Download a file
/undo - Revert file changes
/skill - Invoke Claude Code skill
/bookmarks - Directory bookmarks
/restart - Restart the bot

<b>Tips:</b>
• <code>!cmd</code> - Run shell command
• <code>!!msg</code> - Interrupt and send
• Send photos, voice, or documents`;
}

/**
 * Check if help text contains expected sections.
 */
function hasExpectedSections(text: string): {
	hasSession: boolean;
	hasModel: boolean;
	hasFiles: boolean;
	hasTips: boolean;
} {
	return {
		hasSession:
			text.includes("<b>Session:</b>") &&
			text.includes("/new") &&
			text.includes("/stop"),
		hasModel:
			text.includes("<b>Model:</b>") &&
			text.includes("/model") &&
			text.includes("/think"),
		hasFiles:
			text.includes("<b>Files:</b>") &&
			text.includes("/cd") &&
			text.includes("/file"),
		hasTips:
			text.includes("<b>Tips:</b>") &&
			text.includes("!cmd") &&
			text.includes("!!msg"),
	};
}

describe("Help text format", () => {
	describe("generateStartMessage", () => {
		test("includes status", () => {
			const msg = generateStartMessage("Active session", "/home/user");
			expect(msg).toContain("Status: Active session");
		});

		test("includes working directory in code tag", () => {
			const msg = generateStartMessage("No session", "/home/user/project");
			expect(msg).toContain("<code>/home/user/project</code>");
		});

		test("includes all command sections", () => {
			const msg = generateStartMessage("Active", "/home");
			expect(msg).toContain("<b>Session:</b>");
			expect(msg).toContain("<b>Model:</b>");
			expect(msg).toContain("<b>Files:</b>");
			expect(msg).toContain("<b>Tips:</b>");
		});

		test("uses HTML bold tags", () => {
			const msg = generateStartMessage("Active", "/home");
			expect(msg).toContain("<b>Claude Telegram Bot</b>");
		});

		test("lists session commands", () => {
			const msg = generateStartMessage("Active", "/home");
			expect(msg).toContain("/new");
			expect(msg).toContain("/stop");
			expect(msg).toContain("/status");
			expect(msg).toContain("/resume");
			expect(msg).toContain("/retry");
		});

		test("lists model commands", () => {
			const msg = generateStartMessage("Active", "/home");
			expect(msg).toContain("/model");
			expect(msg).toContain("/think");
			expect(msg).toContain("/plan");
			expect(msg).toContain("/cost");
		});

		test("lists file commands", () => {
			const msg = generateStartMessage("Active", "/home");
			expect(msg).toContain("/cd");
			expect(msg).toContain("/file");
			expect(msg).toContain("/skill");
			expect(msg).toContain("/bookmarks");
		});
	});

	describe("hasExpectedSections", () => {
		test("detects all sections in valid help text", () => {
			const msg = generateStartMessage("Active", "/home");
			const sections = hasExpectedSections(msg);

			expect(sections.hasSession).toBe(true);
			expect(sections.hasModel).toBe(true);
			expect(sections.hasFiles).toBe(true);
			expect(sections.hasTips).toBe(true);
		});

		test("detects missing sections", () => {
			const incomplete = "<b>Session:</b>\n/new - Start\n/stop - Stop";
			const sections = hasExpectedSections(incomplete);

			expect(sections.hasSession).toBe(true);
			expect(sections.hasModel).toBe(false);
			expect(sections.hasFiles).toBe(false);
			expect(sections.hasTips).toBe(false);
		});
	});
});

// ============== File Path Detection (from /file auto-detect) ==============

/**
 * Extract file paths from HTML code tags.
 * Used by /file command when called without arguments.
 */
function extractFilePathsFromHtml(html: string): string[] {
	const codeMatches = html.matchAll(/<code>([^<]+)<\/code>/g);
	const candidates: string[] = [];

	for (const m of codeMatches) {
		const content = m[1]?.trim();
		// Must have file extension (contains . followed by letters)
		if (content && /\.[a-zA-Z0-9]+$/.test(content)) {
			candidates.push(content);
		}
	}

	// Deduplicate
	return [...new Set(candidates)];
}

describe("File path detection", () => {
	describe("extractFilePathsFromHtml", () => {
		test("extracts single file path", () => {
			const html = "Created file <code>/home/user/file.txt</code>";
			expect(extractFilePathsFromHtml(html)).toEqual(["/home/user/file.txt"]);
		});

		test("extracts multiple file paths", () => {
			const html = "<code>src/index.ts</code> and <code>src/utils.ts</code>";
			expect(extractFilePathsFromHtml(html)).toEqual([
				"src/index.ts",
				"src/utils.ts",
			]);
		});

		test("deduplicates paths", () => {
			const html = "<code>file.txt</code> and <code>file.txt</code>";
			expect(extractFilePathsFromHtml(html)).toEqual(["file.txt"]);
		});

		test("ignores code without file extension", () => {
			const html = "<code>some-command</code> and <code>file.txt</code>";
			expect(extractFilePathsFromHtml(html)).toEqual(["file.txt"]);
		});

		test("ignores code that looks like commands", () => {
			const html = "<code>ls -la</code> <code>output.log</code>";
			expect(extractFilePathsFromHtml(html)).toEqual(["output.log"]);
		});

		test("handles various file extensions", () => {
			const html =
				"<code>doc.pdf</code> <code>image.png</code> <code>script.sh</code>";
			const result = extractFilePathsFromHtml(html);
			expect(result).toContain("doc.pdf");
			expect(result).toContain("image.png");
			expect(result).toContain("script.sh");
		});

		test("returns empty array for no matches", () => {
			const html = "No code tags here";
			expect(extractFilePathsFromHtml(html)).toEqual([]);
		});

		test("returns empty array for code without extensions", () => {
			const html = "<code>hostname</code> <code>username</code>";
			expect(extractFilePathsFromHtml(html)).toEqual([]);
		});
	});
});

// ============== Provider Validation ==============

const VALID_PROVIDERS = ["claude", "codex"] as const;
type ProviderId = (typeof VALID_PROVIDERS)[number];

/**
 * Validate provider name.
 */
function isValidProvider(name: string): name is ProviderId {
	return VALID_PROVIDERS.includes(name.toLowerCase() as ProviderId);
}

describe("Provider validation", () => {
	test("accepts valid providers", () => {
		expect(isValidProvider("claude")).toBe(true);
		expect(isValidProvider("codex")).toBe(true);
	});

	test("handles case insensitivity", () => {
		expect(isValidProvider("CLAUDE")).toBe(true);
		expect(isValidProvider("Codex")).toBe(true);
	});

	test("rejects invalid providers", () => {
		expect(isValidProvider("openai")).toBe(false);
		expect(isValidProvider("gpt")).toBe(false);
		expect(isValidProvider("")).toBe(false);
	});
});
