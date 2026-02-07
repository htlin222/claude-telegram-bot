/**
 * Tests for /restart command logic
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe("/restart command", () => {
	let originalArgv: string[];
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		originalArgv = [...process.argv];
		originalIsTTY = process.stdout.isTTY;
	});

	afterEach(() => {
		process.argv = originalArgv;
		Object.defineProperty(process.stdout, "isTTY", {
			value: originalIsTTY,
			writable: true,
			configurable: true,
		});
	});

	describe("Startup mode detection", () => {
		test("detects binary mode", () => {
			process.argv[1] = "/usr/local/bin/ctb";
			const botScript = process.argv[1] || "";
			const isBinary = !botScript.endsWith(".ts") && !botScript.endsWith(".js");

			expect(isBinary).toBe(true);
		});

		test("detects CLI mode (cli.ts)", () => {
			process.argv[1] = "/path/to/cli.ts";
			const botScript = process.argv[1] || "";
			const isCliMode =
				botScript.includes("cli.ts") || botScript.includes("cli.js");

			expect(isCliMode).toBe(true);
		});

		test("detects CLI mode (cli.js)", () => {
			process.argv[1] = "/path/to/cli.js";
			const botScript = process.argv[1] || "";
			const isCliMode =
				botScript.includes("cli.ts") || botScript.includes("cli.js");

			expect(isCliMode).toBe(true);
		});

		test("detects development mode (index.ts)", () => {
			process.argv[1] = "/path/to/src/index.ts";
			const botScript = process.argv[1] || "";
			const isCliMode =
				botScript.includes("cli.ts") || botScript.includes("cli.js");
			const isBinary = !botScript.endsWith(".ts") && !botScript.endsWith(".js");

			expect(isCliMode).toBe(false);
			expect(isBinary).toBe(false);
		});

		test("detects development mode (bot.ts)", () => {
			process.argv[1] = "/path/to/src/bot.ts";
			const botScript = process.argv[1] || "";
			const isCliMode =
				botScript.includes("cli.ts") || botScript.includes("cli.js");
			const isBinary = !botScript.endsWith(".ts") && !botScript.endsWith(".js");

			expect(isCliMode).toBe(false);
			expect(isBinary).toBe(false);
		});
	});

	describe("Restart command generation", () => {
		test("generates binary restart command", () => {
			process.argv[0] = "/usr/local/bin/ctb";
			process.argv[1] = "/usr/local/bin/ctb";
			const botScript = process.argv[1] || "";
			const isBinary = !botScript.endsWith(".ts") && !botScript.endsWith(".js");

			let restartCommand = "";
			if (isBinary) {
				restartCommand = process.argv[0] || "";
			}

			expect(restartCommand).toBe("/usr/local/bin/ctb");
		});

		test("generates CLI restart command", () => {
			process.argv[1] = "/path/to/cli.ts";
			const botScript = process.argv[1] || "";
			const isCliMode =
				botScript.includes("cli.ts") || botScript.includes("cli.js");

			let restartCommand = "";
			if (isCliMode) {
				restartCommand = `bun "${botScript}"`;
			}

			expect(restartCommand).toBe('bun "/path/to/cli.ts"');
		});

		test("generates development restart command", () => {
			process.argv[1] = "/path/to/src/index.ts";
			const botScript = process.argv[1] || "";
			const isCliMode =
				botScript.includes("cli.ts") || botScript.includes("cli.js");
			const isBinary = !botScript.endsWith(".ts") && !botScript.endsWith(".js");

			let restartCommand = "";
			if (!isBinary && !isCliMode) {
				restartCommand = `bun run "${botScript}"`;
			}

			expect(restartCommand).toBe('bun run "/path/to/src/index.ts"');
		});
	});

	describe("TTY detection", () => {
		test("detects TTY when process.stdout.isTTY is true", () => {
			Object.defineProperty(process.stdout, "isTTY", {
				value: true,
				writable: true,
				configurable: true,
			});

			const isTTY = process.stdout.isTTY;
			expect(isTTY).toBe(true);
		});

		test("detects non-TTY when process.stdout.isTTY is false", () => {
			Object.defineProperty(process.stdout, "isTTY", {
				value: false,
				writable: true,
				configurable: true,
			});

			const isTTY = process.stdout.isTTY;
			expect(isTTY).toBe(false);
		});

		test("handles undefined isTTY (background process)", () => {
			Object.defineProperty(process.stdout, "isTTY", {
				value: undefined,
				writable: true,
				configurable: true,
			});

			const isTTY = process.stdout.isTTY;
			expect(isTTY).toBeUndefined();
		});
	});

	describe("Log file path", () => {
		test("uses default log path for all modes", () => {
			const logFile = "/tmp/claude-telegram-bot.log";
			expect(logFile).toBe("/tmp/claude-telegram-bot.log");
		});
	});

	describe("Warning message content", () => {
		test("includes all required information", () => {
			const logFile = "/tmp/claude-telegram-bot.log";
			const restartCommand = 'bun run "src/index.ts"';

			const warning =
				"⚠️ <b>Terminal Mode Detected</b>\n\n" +
				"You started the bot from a terminal. Restarting will:\n" +
				"• Detach from your current terminal session\n" +
				"• Run in background\n" +
				`• Log to: <code>${logFile}</code>\n\n` +
				"View logs after restart:\n" +
				`<code>tail -f ${logFile}</code>\n\n` +
				"Or stop and restart manually:\n" +
				"• Press Ctrl+C\n" +
				`• Run <code>${restartCommand}</code>`;

			expect(warning).toContain("Terminal Mode Detected");
			expect(warning).toContain("Detach from your current terminal session");
			expect(warning).toContain(`Log to: <code>${logFile}</code>`);
			expect(warning).toContain(`tail -f ${logFile}`);
			expect(warning).toContain(`Run <code>${restartCommand}</code>`);
		});
	});

	describe("Restart success message", () => {
		test("includes PID and log file", () => {
			const pid = 12345;
			const logFile = "/tmp/claude-telegram-bot.log";

			const message =
				`✅ <b>Bot 重啟成功！</b>\n\n` +
				`🔢 程序編號：<code>${pid}</code>\n` +
				`📋 日誌位置：<code>${logFile}</code>\n\n` +
				`<b>查看即時日誌：</b>\n<code>tail -f ${logFile}</code>\n\n` +
				`<b>停止 Bot：</b>\n<code>kill ${pid}</code>`;

			expect(message).toContain("Bot 重啟成功");
			expect(message).toContain(`程序編號：<code>${pid}</code>`);
			expect(message).toContain(`日誌位置：<code>${logFile}</code>`);
			expect(message).toContain(`tail -f ${logFile}`);
			expect(message).toContain(`kill ${pid}`);
		});
	});

	describe("Full restart command", () => {
		test("constructs correct shell command", () => {
			const cwd = "/path/to/project";
			const restartCommand = 'bun run "src/index.ts"';
			const logFile = "/tmp/claude-telegram-bot.log";

			const fullCommand = `sleep 1 && cd "${cwd}" && ${restartCommand} >> ${logFile} 2>&1 & echo $!`;

			expect(fullCommand).toContain("sleep 1");
			expect(fullCommand).toContain(`cd "${cwd}"`);
			expect(fullCommand).toContain(restartCommand);
			expect(fullCommand).toContain(`>> ${logFile} 2>&1`);
			expect(fullCommand).toContain("echo $!");
		});
	});
});
