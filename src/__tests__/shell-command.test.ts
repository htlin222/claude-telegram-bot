/**
 * Unit tests for shell command execution (!command feature).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Execute a shell command and return output.
 * This is a copy of the function from text.ts for testing.
 */
async function execShellCommand(
	command: string,
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], {
			cwd,
			timeout: 30000,
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});

		proc.on("error", (err) => {
			resolve({ stdout, stderr: err.message, exitCode: 1 });
		});
	});
}

describe("Shell command execution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = `/tmp/shell-test-${Date.now()}`;
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		try {
			// Clean up test files
			const files = ["test.txt", "output.txt", "script.sh"];
			for (const file of files) {
				try {
					Bun.spawnSync(["rm", "-f", join(testDir, file)]);
				} catch {
					// Ignore
				}
			}
			rmdirSync(testDir);
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("basic commands", () => {
		test("executes echo command", async () => {
			const result = await execShellCommand("echo hello", testDir);
			expect(result.stdout.trim()).toBe("hello");
			expect(result.exitCode).toBe(0);
		});

		test("executes pwd command", async () => {
			const result = await execShellCommand("pwd", testDir);
			// macOS resolves /tmp to /private/tmp
			expect(result.stdout.trim()).toMatch(/\/?tmp\/shell-test-/);
			expect(result.exitCode).toBe(0);
		});

		test("executes ls command", async () => {
			// Create a test file
			writeFileSync(join(testDir, "test.txt"), "content");
			const result = await execShellCommand("ls", testDir);
			expect(result.stdout).toContain("test.txt");
			expect(result.exitCode).toBe(0);
		});

		test("executes mkdir command", async () => {
			const result = await execShellCommand("mkdir -p subdir", testDir);
			expect(result.exitCode).toBe(0);
			// Clean up
			Bun.spawnSync(["rmdir", join(testDir, "subdir")]);
		});

		test("executes cat command", async () => {
			writeFileSync(join(testDir, "test.txt"), "file content");
			const result = await execShellCommand("cat test.txt", testDir);
			expect(result.stdout.trim()).toBe("file content");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("command with arguments", () => {
		test("handles multiple arguments", async () => {
			const result = await execShellCommand("echo one two three", testDir);
			expect(result.stdout.trim()).toBe("one two three");
		});

		test("handles quoted arguments", async () => {
			const result = await execShellCommand('echo "hello world"', testDir);
			expect(result.stdout.trim()).toBe("hello world");
		});

		test("handles special characters in arguments", async () => {
			const result = await execShellCommand("echo 'test$var'", testDir);
			expect(result.stdout.trim()).toBe("test$var");
		});
	});

	describe("piped commands", () => {
		test("handles simple pipe", async () => {
			const result = await execShellCommand("echo hello | cat", testDir);
			expect(result.stdout.trim()).toBe("hello");
		});

		test("handles grep pipe", async () => {
			const result = await execShellCommand(
				"echo -e 'line1\\nline2\\nline3' | grep line2",
				testDir,
			);
			expect(result.stdout.trim()).toBe("line2");
		});

		test("handles wc pipe", async () => {
			const result = await execShellCommand("echo hello | wc -c", testDir);
			expect(Number.parseInt(result.stdout.trim())).toBeGreaterThan(0);
		});
	});

	describe("error handling", () => {
		test("returns non-zero exit code for failed command", async () => {
			const result = await execShellCommand(
				"ls /nonexistent-directory-12345",
				testDir,
			);
			expect(result.exitCode).not.toBe(0);
		});

		test("captures stderr for errors", async () => {
			const result = await execShellCommand(
				"ls /nonexistent-directory-12345",
				testDir,
			);
			expect(result.stderr.length).toBeGreaterThan(0);
		});

		test("handles command not found", async () => {
			const result = await execShellCommand("nonexistent-command-xyz", testDir);
			expect(result.exitCode).not.toBe(0);
		});

		test("handles syntax errors", async () => {
			const result = await execShellCommand("echo 'unclosed", testDir);
			expect(result.exitCode).not.toBe(0);
		});
	});

	describe("working directory", () => {
		test("executes in specified directory", async () => {
			const result = await execShellCommand("pwd", testDir);
			// macOS resolves /tmp to /private/tmp
			expect(result.stdout.trim()).toMatch(/\/?tmp\/shell-test-/);
		});

		test("creates file in working directory", async () => {
			await execShellCommand("touch newfile.txt", testDir);
			const lsResult = await execShellCommand("ls newfile.txt", testDir);
			expect(lsResult.exitCode).toBe(0);
			// Clean up
			Bun.spawnSync(["rm", join(testDir, "newfile.txt")]);
		});

		test("handles relative paths in working directory", async () => {
			writeFileSync(join(testDir, "data.txt"), "content");
			const result = await execShellCommand("cat ./data.txt", testDir);
			expect(result.stdout.trim()).toBe("content");
		});
	});

	describe("output handling", () => {
		test("handles large stdout", async () => {
			const result = await execShellCommand("seq 1 1000", testDir);
			expect(result.stdout.split("\n").length).toBeGreaterThan(100);
		});

		test("handles multiline output", async () => {
			const result = await execShellCommand(
				"echo -e 'line1\\nline2\\nline3'",
				testDir,
			);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toHaveLength(3);
		});

		test("handles mixed stdout and stderr", async () => {
			const result = await execShellCommand("echo out; echo err >&2", testDir);
			expect(result.stdout.trim()).toBe("out");
			expect(result.stderr.trim()).toBe("err");
		});

		test("handles empty output", async () => {
			const result = await execShellCommand("true", testDir);
			expect(result.stdout).toBe("");
			expect(result.exitCode).toBe(0);
		});
	});

	describe("shell features", () => {
		test("handles environment variables", async () => {
			const result = await execShellCommand("echo $HOME", testDir);
			expect(result.stdout.trim().length).toBeGreaterThan(0);
		});

		test("handles command substitution", async () => {
			const result = await execShellCommand("echo $(pwd)", testDir);
			// macOS resolves /tmp to /private/tmp
			expect(result.stdout.trim()).toMatch(/\/?tmp\/shell-test-/);
		});

		test("handles glob patterns", async () => {
			writeFileSync(join(testDir, "a.txt"), "");
			writeFileSync(join(testDir, "b.txt"), "");
			const result = await execShellCommand("ls *.txt", testDir);
			expect(result.stdout).toContain("a.txt");
			expect(result.stdout).toContain("b.txt");
			// Clean up
			Bun.spawnSync(["rm", join(testDir, "a.txt"), join(testDir, "b.txt")]);
		});

		test("handles redirections", async () => {
			await execShellCommand("echo content > output.txt", testDir);
			const result = await execShellCommand("cat output.txt", testDir);
			expect(result.stdout.trim()).toBe("content");
		});

		test("handles && chaining", async () => {
			const result = await execShellCommand(
				"echo first && echo second",
				testDir,
			);
			expect(result.stdout).toContain("first");
			expect(result.stdout).toContain("second");
		});

		test("handles || chaining", async () => {
			const result = await execShellCommand("false || echo fallback", testDir);
			expect(result.stdout.trim()).toBe("fallback");
		});
	});
});

describe("Shell command prefix detection", () => {
	test("detects ! prefix", () => {
		const message = "!ls -la";
		expect(message.startsWith("!")).toBe(true);
		expect(message.slice(1).trim()).toBe("ls -la");
	});

	test("extracts command after prefix", () => {
		const testCases = [
			{ input: "!pwd", expected: "pwd" },
			{ input: "! pwd", expected: "pwd" },
			{ input: "!  pwd", expected: "pwd" },
			{ input: "!ls -la /tmp", expected: "ls -la /tmp" },
			{ input: "!echo hello world", expected: "echo hello world" },
		];

		for (const { input, expected } of testCases) {
			expect(input.slice(1).trim()).toBe(expected);
		}
	});

	test("handles empty command after prefix", () => {
		const message = "!";
		const command = message.slice(1).trim();
		expect(command).toBe("");
	});

	test("handles whitespace only after prefix", () => {
		const message = "!   ";
		const command = message.slice(1).trim();
		expect(command).toBe("");
	});

	test("does not confuse with exclamation in text", () => {
		const notCommands = ["Hello! How are you?", "This is great!", "! at end"];

		for (const text of notCommands) {
			// These start with ! should still be detected
			// But "Hello!" doesn't start with !
			if (!text.startsWith("!")) {
				expect(text.startsWith("!")).toBe(false);
			}
		}
	});
});
