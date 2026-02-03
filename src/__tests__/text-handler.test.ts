/**
 * Unit tests for text message handler.
 *
 * Tests prefix detection, message parsing, and flow routing logic
 * without mocking the entire handler.
 */

import { describe, expect, test } from "bun:test";
import { checkCommandSafety, isAuthorized } from "../security";

// ============== Prefix Detection Utilities ==============

/**
 * Detect message prefix type and extract the content.
 *
 * Mirrors the logic in handleText() for routing messages.
 */
function detectMessagePrefix(message: string): {
	type: "shell" | "interrupt" | "cancel" | "regular";
	content: string;
} {
	const trimmed = message.trim();

	// Check for interrupt prefix (!!)
	if (message.startsWith("!!")) {
		const content = message.slice(2).trim();
		return { type: "interrupt", content };
	}

	// Check for shell command prefix (!)
	if (message.startsWith("!")) {
		const content = message.slice(1).trim();
		return { type: "shell", content };
	}

	// Check for cancel command (worktree flow)
	if (
		trimmed.toLowerCase() === "/cancel" ||
		trimmed.toLowerCase() === "cancel"
	) {
		return { type: "cancel", content: "" };
	}

	// Regular message for Claude
	return { type: "regular", content: message };
}

/**
 * Extract shell command from ! prefix message.
 * Returns empty if message starts with !! (interrupt prefix).
 */
function extractShellCommand(message: string): string {
	if (!message.startsWith("!") || message.startsWith("!!")) {
		return "";
	}
	return message.slice(1).trim();
}

/**
 * Extract interrupt message from !! prefix.
 */
function extractInterruptMessage(message: string): string {
	if (!message.startsWith("!!")) {
		return "";
	}
	return message.slice(2).trim();
}

/**
 * Check if message is a worktree cancel command.
 */
function isWorktreeCancel(message: string): boolean {
	const trimmed = message.trim().toLowerCase();
	return trimmed === "/cancel" || trimmed === "cancel";
}

// ============== Tests ==============

describe("Text handler prefix detection", () => {
	describe("shell command prefix (!)", () => {
		test("detects ! prefix for shell commands", () => {
			const result = detectMessagePrefix("!ls -la");
			expect(result.type).toBe("shell");
			expect(result.content).toBe("ls -la");
		});

		test("handles ! with no command", () => {
			const result = detectMessagePrefix("!");
			expect(result.type).toBe("shell");
			expect(result.content).toBe("");
		});

		test("handles ! with whitespace only", () => {
			const result = detectMessagePrefix("!   ");
			expect(result.type).toBe("shell");
			expect(result.content).toBe("");
		});

		test("handles ! with leading whitespace before command", () => {
			const result = detectMessagePrefix("! pwd");
			expect(result.type).toBe("shell");
			expect(result.content).toBe("pwd");
		});

		test("preserves command arguments", () => {
			const result = detectMessagePrefix("!git status --short");
			expect(result.type).toBe("shell");
			expect(result.content).toBe("git status --short");
		});

		test("handles complex shell commands", () => {
			const testCases = [
				{
					input: "!echo hello | grep h",
					expected: "echo hello | grep h",
				},
				{
					input: "!ls -la && pwd",
					expected: "ls -la && pwd",
				},
				{
					input: '!echo "hello world"',
					expected: 'echo "hello world"',
				},
				{
					input: "!cat file.txt > output.txt",
					expected: "cat file.txt > output.txt",
				},
			];

			for (const { input, expected } of testCases) {
				const result = detectMessagePrefix(input);
				expect(result.content).toBe(expected);
			}
		});
	});

	describe("interrupt prefix (!!)", () => {
		test("detects !! prefix for interrupts", () => {
			const result = detectMessagePrefix("!!stop and do this instead");
			expect(result.type).toBe("interrupt");
			expect(result.content).toBe("stop and do this instead");
		});

		test("handles !! with empty message", () => {
			const result = detectMessagePrefix("!!");
			expect(result.type).toBe("interrupt");
			expect(result.content).toBe("");
		});

		test("handles !! with whitespace only", () => {
			const result = detectMessagePrefix("!!   ");
			expect(result.type).toBe("interrupt");
			expect(result.content).toBe("");
		});

		test("handles !! with leading whitespace before message", () => {
			const result = detectMessagePrefix("!! urgent message");
			expect(result.type).toBe("interrupt");
			expect(result.content).toBe("urgent message");
		});

		test("!! takes precedence over single !", () => {
			// !! should be detected first, not as ! followed by !
			const result = detectMessagePrefix("!!command");
			expect(result.type).toBe("interrupt");
			expect(result.content).toBe("command");
		});

		test("preserves full interrupt message", () => {
			const result = detectMessagePrefix(
				"!!Please cancel that and run tests instead",
			);
			expect(result.type).toBe("interrupt");
			expect(result.content).toBe("Please cancel that and run tests instead");
		});
	});

	describe("cancel command (/cancel)", () => {
		test("detects /cancel command", () => {
			const result = detectMessagePrefix("/cancel");
			expect(result.type).toBe("cancel");
		});

		test("detects cancel without slash", () => {
			const result = detectMessagePrefix("cancel");
			expect(result.type).toBe("cancel");
		});

		test("is case insensitive", () => {
			expect(detectMessagePrefix("/CANCEL").type).toBe("cancel");
			expect(detectMessagePrefix("/Cancel").type).toBe("cancel");
			expect(detectMessagePrefix("CANCEL").type).toBe("cancel");
			expect(detectMessagePrefix("Cancel").type).toBe("cancel");
		});

		test("handles whitespace around cancel", () => {
			expect(detectMessagePrefix("  /cancel  ").type).toBe("cancel");
			expect(detectMessagePrefix("  cancel  ").type).toBe("cancel");
		});

		test("does not detect cancel in longer messages", () => {
			expect(detectMessagePrefix("/cancel please").type).toBe("regular");
			expect(detectMessagePrefix("please cancel").type).toBe("regular");
			expect(detectMessagePrefix("cancel that").type).toBe("regular");
		});
	});

	describe("regular messages", () => {
		test("detects regular text messages", () => {
			const result = detectMessagePrefix("Hello, how are you?");
			expect(result.type).toBe("regular");
			expect(result.content).toBe("Hello, how are you?");
		});

		test("does not confuse exclamation in text with prefix", () => {
			const result = detectMessagePrefix("That's great! Tell me more.");
			expect(result.type).toBe("regular");
			expect(result.content).toBe("That's great! Tell me more.");
		});

		test("handles messages starting with space", () => {
			const result = detectMessagePrefix("  regular message");
			expect(result.type).toBe("regular");
			expect(result.content).toBe("  regular message");
		});

		test("handles unicode messages", () => {
			const result = detectMessagePrefix("你好，这是中文消息");
			expect(result.type).toBe("regular");
			expect(result.content).toBe("你好，这是中文消息");
		});

		test("handles emoji messages", () => {
			const result = detectMessagePrefix("👋 Hello there!");
			expect(result.type).toBe("regular");
			expect(result.content).toBe("👋 Hello there!");
		});

		test("handles multiline messages", () => {
			const message = "Line 1\nLine 2\nLine 3";
			const result = detectMessagePrefix(message);
			expect(result.type).toBe("regular");
			expect(result.content).toBe(message);
		});
	});
});

describe("Shell command extraction", () => {
	test("extracts command from ! prefix", () => {
		expect(extractShellCommand("!ls -la")).toBe("ls -la");
		expect(extractShellCommand("!pwd")).toBe("pwd");
		expect(extractShellCommand("!git status")).toBe("git status");
	});

	test("handles whitespace variations", () => {
		expect(extractShellCommand("! ls")).toBe("ls");
		expect(extractShellCommand("!  ls")).toBe("ls");
		expect(extractShellCommand("!ls  ")).toBe("ls");
	});

	test("returns empty for non-shell messages", () => {
		expect(extractShellCommand("hello")).toBe("");
		expect(extractShellCommand("!!interrupt")).toBe("");
		expect(extractShellCommand("/cancel")).toBe("");
	});

	test("returns empty for empty command", () => {
		expect(extractShellCommand("!")).toBe("");
		expect(extractShellCommand("!   ")).toBe("");
	});

	test("handles special characters in commands", () => {
		expect(extractShellCommand('!echo "hello world"')).toBe(
			'echo "hello world"',
		);
		expect(extractShellCommand("!echo $HOME")).toBe("echo $HOME");
		expect(extractShellCommand("!cat file.txt | grep test")).toBe(
			"cat file.txt | grep test",
		);
	});
});

describe("Interrupt message extraction", () => {
	test("extracts message from !! prefix", () => {
		expect(extractInterruptMessage("!!stop that")).toBe("stop that");
		expect(extractInterruptMessage("!!new task")).toBe("new task");
	});

	test("handles whitespace variations", () => {
		expect(extractInterruptMessage("!! message")).toBe("message");
		expect(extractInterruptMessage("!!  message")).toBe("message");
		expect(extractInterruptMessage("!!message  ")).toBe("message");
	});

	test("returns empty for non-interrupt messages", () => {
		expect(extractInterruptMessage("hello")).toBe("");
		expect(extractInterruptMessage("!shell")).toBe("");
		expect(extractInterruptMessage("/cancel")).toBe("");
	});

	test("returns empty for empty interrupt", () => {
		expect(extractInterruptMessage("!!")).toBe("");
		expect(extractInterruptMessage("!!   ")).toBe("");
	});

	test("preserves full message content", () => {
		expect(
			extractInterruptMessage("!!Please stop and do something else instead"),
		).toBe("Please stop and do something else instead");
	});
});

describe("Worktree cancel detection", () => {
	test("detects /cancel", () => {
		expect(isWorktreeCancel("/cancel")).toBe(true);
	});

	test("detects cancel without slash", () => {
		expect(isWorktreeCancel("cancel")).toBe(true);
	});

	test("is case insensitive", () => {
		expect(isWorktreeCancel("/CANCEL")).toBe(true);
		expect(isWorktreeCancel("/Cancel")).toBe(true);
		expect(isWorktreeCancel("CANCEL")).toBe(true);
		expect(isWorktreeCancel("Cancel")).toBe(true);
	});

	test("handles leading/trailing whitespace", () => {
		expect(isWorktreeCancel("  /cancel  ")).toBe(true);
		expect(isWorktreeCancel("  cancel  ")).toBe(true);
		expect(isWorktreeCancel("\t/cancel\t")).toBe(true);
	});

	test("rejects cancel in longer text", () => {
		expect(isWorktreeCancel("cancel please")).toBe(false);
		expect(isWorktreeCancel("/cancel now")).toBe(false);
		expect(isWorktreeCancel("please cancel")).toBe(false);
	});

	test("rejects unrelated commands", () => {
		expect(isWorktreeCancel("/start")).toBe(false);
		expect(isWorktreeCancel("/new")).toBe(false);
		expect(isWorktreeCancel("hello")).toBe(false);
	});
});

describe("Authorization integration", () => {
	const allowedUsers = [123456, 789012];

	test("authorized users can send messages", () => {
		expect(isAuthorized(123456, allowedUsers)).toBe(true);
		expect(isAuthorized(789012, allowedUsers)).toBe(true);
	});

	test("unauthorized users are rejected", () => {
		expect(isAuthorized(999999, allowedUsers)).toBe(false);
		expect(isAuthorized(111111, allowedUsers)).toBe(false);
	});

	test("undefined userId is rejected", () => {
		expect(isAuthorized(undefined, allowedUsers)).toBe(false);
	});

	test("empty allowed list rejects everyone", () => {
		expect(isAuthorized(123456, [])).toBe(false);
	});
});

describe("Shell command safety checks", () => {
	test("safe commands pass", () => {
		expect(checkCommandSafety("ls -la")[0]).toBe(true);
		expect(checkCommandSafety("git status")[0]).toBe(true);
		expect(checkCommandSafety("pwd")[0]).toBe(true);
		expect(checkCommandSafety("echo hello")[0]).toBe(true);
	});

	test("dangerous rm commands are blocked", () => {
		const [safe1] = checkCommandSafety("rm -rf /");
		expect(safe1).toBe(false);

		const [safe2] = checkCommandSafety("rm -rf ~");
		expect(safe2).toBe(false);
	});

	test("rm to temp is allowed", () => {
		const [safe] = checkCommandSafety("rm /tmp/test.txt");
		expect(safe).toBe(true);
	});

	test("rm to system paths is blocked", () => {
		const [safe, reason] = checkCommandSafety("rm /etc/passwd");
		expect(safe).toBe(false);
		expect(reason).toContain("outside allowed paths");
	});

	test("fork bomb is blocked", () => {
		const [safe, reason] = checkCommandSafety(":(){ :|:& };:");
		expect(safe).toBe(false);
		expect(reason).toContain("Blocked pattern");
	});
});

describe("Message routing flow", () => {
	test("! prefix routes to shell flow", () => {
		const message = "!git log --oneline -5";
		const { type, content } = detectMessagePrefix(message);

		expect(type).toBe("shell");
		expect(content).toBe("git log --oneline -5");

		// Verify command passes safety check
		const [safe] = checkCommandSafety(content);
		expect(safe).toBe(true);
	});

	test("!! prefix routes to interrupt flow", () => {
		const message = "!!stop and explain what you're doing";
		const { type, content } = detectMessagePrefix(message);

		expect(type).toBe("interrupt");
		expect(content).toBe("stop and explain what you're doing");
		expect(content.length).toBeGreaterThan(0);
	});

	test("/cancel routes to worktree cancel flow", () => {
		const message = "/cancel";
		const { type } = detectMessagePrefix(message);

		expect(type).toBe("cancel");
	});

	test("regular message routes to Claude flow", () => {
		const message = "Explain how this codebase works";
		const { type, content } = detectMessagePrefix(message);

		expect(type).toBe("regular");
		expect(content).toBe(message);
	});
});

describe("Edge cases", () => {
	test("empty message", () => {
		const result = detectMessagePrefix("");
		expect(result.type).toBe("regular");
		expect(result.content).toBe("");
	});

	test("whitespace only message", () => {
		const result = detectMessagePrefix("   ");
		expect(result.type).toBe("regular");
		expect(result.content).toBe("   ");
	});

	test("very long message", () => {
		const longMessage = "a".repeat(10000);
		const result = detectMessagePrefix(longMessage);
		expect(result.type).toBe("regular");
		expect(result.content.length).toBe(10000);
	});

	test("very long shell command", () => {
		const longCommand = `!${"echo test ".repeat(1000)}`;
		const result = detectMessagePrefix(longCommand);
		expect(result.type).toBe("shell");
		expect(result.content.length).toBeGreaterThan(9000);
	});

	test("message with only newlines", () => {
		const result = detectMessagePrefix("\n\n\n");
		expect(result.type).toBe("regular");
	});

	test("message starting with !!!", () => {
		// Triple ! should be detected as !! prefix with ! as content
		const result = detectMessagePrefix("!!!command");
		expect(result.type).toBe("interrupt");
		expect(result.content).toBe("!command");
	});

	test("message with special unicode characters", () => {
		const result = detectMessagePrefix("!echo 🎉 🚀 ✨");
		expect(result.type).toBe("shell");
		expect(result.content).toBe("echo 🎉 🚀 ✨");
	});

	test("message with null byte (edge case)", () => {
		const result = detectMessagePrefix("hello\x00world");
		expect(result.type).toBe("regular");
	});
});

describe("Base64 encoding for shell callback", () => {
	test("encodes and decodes shell command correctly", () => {
		const command = "ls -la /tmp";
		const encoded = Buffer.from(command).toString("base64");
		const decoded = Buffer.from(encoded, "base64").toString("utf-8");
		expect(decoded).toBe(command);
	});

	test("handles special characters in command", () => {
		const command = 'echo "hello world" | grep h';
		const encoded = Buffer.from(command).toString("base64");
		const decoded = Buffer.from(encoded, "base64").toString("utf-8");
		expect(decoded).toBe(command);
	});

	test("handles unicode in command", () => {
		const command = "echo 你好";
		const encoded = Buffer.from(command).toString("base64");
		const decoded = Buffer.from(encoded, "base64").toString("utf-8");
		expect(decoded).toBe(command);
	});

	test("creates valid callback data format", () => {
		const command = "pwd";
		const encoded = Buffer.from(command).toString("base64");
		const callbackData = `shell:run:${encoded}`;

		expect(callbackData.startsWith("shell:run:")).toBe(true);

		// Parse back
		const parts = callbackData.split(":");
		expect(parts[0]).toBe("shell");
		expect(parts[1]).toBe("run");
		const decodedCmd = Buffer.from(parts[2] ?? "", "base64").toString("utf-8");
		expect(decodedCmd).toBe(command);
	});
});

describe("Message queueing preview", () => {
	test("preview truncates long messages", () => {
		const message = "a".repeat(100);
		const maxPreviewLength = 50;
		const preview =
			message.length > maxPreviewLength
				? `${message.slice(0, maxPreviewLength)}...`
				: message;

		expect(preview.length).toBe(maxPreviewLength + 3); // 50 + "..."
		expect(preview.endsWith("...")).toBe(true);
	});

	test("preview keeps short messages intact", () => {
		const message = "short message";
		const maxPreviewLength = 50;
		const preview =
			message.length > maxPreviewLength
				? `${message.slice(0, maxPreviewLength)}...`
				: message;

		expect(preview).toBe(message);
	});

	test("preview handles exact length", () => {
		const message = "a".repeat(50);
		const maxPreviewLength = 50;
		const preview =
			message.length > maxPreviewLength
				? `${message.slice(0, maxPreviewLength)}...`
				: message;

		expect(preview).toBe(message);
	});
});
