/**
 * Unit tests for logger module.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Logger, logger } from "../logger";

describe("Logger", () => {
	let consoleLogMock: ReturnType<typeof mock>;
	let consoleWarnMock: ReturnType<typeof mock>;
	let consoleErrorMock: ReturnType<typeof mock>;

	beforeEach(() => {
		consoleLogMock = mock(() => {});
		consoleWarnMock = mock(() => {});
		consoleErrorMock = mock(() => {});
		console.log = consoleLogMock;
		console.warn = consoleWarnMock;
		console.error = consoleErrorMock;
	});

	afterEach(() => {
		consoleLogMock.mockRestore?.();
		consoleWarnMock.mockRestore?.();
		consoleErrorMock.mockRestore?.();
	});

	describe("level configuration", () => {
		test("defaults to info level", () => {
			const log = new Logger();
			expect(log.getLevel()).toBe("info");
		});

		test("can be initialized with a specific level", () => {
			const log = new Logger("debug");
			expect(log.getLevel()).toBe("debug");
		});

		test("setLevel changes the log level", () => {
			const log = new Logger("info");
			log.setLevel("error");
			expect(log.getLevel()).toBe("error");
		});
	});

	describe("log level filtering", () => {
		test("debug level logs all messages", () => {
			const log = new Logger("debug");
			log.debug("debug msg");
			log.info("info msg");
			log.warn("warn msg");
			log.error("error msg");

			expect(consoleLogMock).toHaveBeenCalledTimes(2); // debug and info
			expect(consoleWarnMock).toHaveBeenCalledTimes(1);
			expect(consoleErrorMock).toHaveBeenCalledTimes(1);
		});

		test("info level skips debug messages", () => {
			const log = new Logger("info");
			log.debug("debug msg");
			log.info("info msg");
			log.warn("warn msg");
			log.error("error msg");

			expect(consoleLogMock).toHaveBeenCalledTimes(1); // only info
			expect(consoleWarnMock).toHaveBeenCalledTimes(1);
			expect(consoleErrorMock).toHaveBeenCalledTimes(1);
		});

		test("warn level skips debug and info messages", () => {
			const log = new Logger("warn");
			log.debug("debug msg");
			log.info("info msg");
			log.warn("warn msg");
			log.error("error msg");

			expect(consoleLogMock).toHaveBeenCalledTimes(0);
			expect(consoleWarnMock).toHaveBeenCalledTimes(1);
			expect(consoleErrorMock).toHaveBeenCalledTimes(1);
		});

		test("error level only logs errors", () => {
			const log = new Logger("error");
			log.debug("debug msg");
			log.info("info msg");
			log.warn("warn msg");
			log.error("error msg");

			expect(consoleLogMock).toHaveBeenCalledTimes(0);
			expect(consoleWarnMock).toHaveBeenCalledTimes(0);
			expect(consoleErrorMock).toHaveBeenCalledTimes(1);
		});
	});

	describe("message formatting", () => {
		test("includes timestamp in ISO format", () => {
			const log = new Logger("info");
			log.info("test message");

			const call = consoleLogMock.mock.calls[0][0] as string;
			// Check for ISO timestamp pattern: [YYYY-MM-DDTHH:MM:SS.sssZ]
			expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\]/);
		});

		test("includes level prefix", () => {
			const log = new Logger("debug");

			log.debug("test");
			expect(consoleLogMock.mock.calls[0][0]).toContain("DEBUG");

			log.info("test");
			expect(consoleLogMock.mock.calls[1][0]).toContain("INFO");

			log.warn("test");
			expect(consoleWarnMock.mock.calls[0][0]).toContain("WARN");

			log.error("test");
			expect(consoleErrorMock.mock.calls[0][0]).toContain("ERROR");
		});

		test("includes the message", () => {
			const log = new Logger("info");
			log.info("Hello, world!");

			const call = consoleLogMock.mock.calls[0][0] as string;
			expect(call).toContain("Hello, world!");
		});
	});

	describe("structured data (context)", () => {
		test("includes context as JSON", () => {
			const log = new Logger("info");
			log.info("Request received", { method: "GET", path: "/api/users" });

			const call = consoleLogMock.mock.calls[0][0] as string;
			expect(call).toContain('{"method":"GET","path":"/api/users"}');
		});

		test("handles empty context object", () => {
			const log = new Logger("info");
			log.info("Simple message", {});

			const call = consoleLogMock.mock.calls[0][0] as string;
			expect(call).not.toContain("{}");
		});

		test("handles undefined context", () => {
			const log = new Logger("info");
			log.info("Simple message");

			const call = consoleLogMock.mock.calls[0][0] as string;
			expect(call).toContain("Simple message");
			// Should not have trailing JSON
			expect(call).toMatch(/Simple message$/);
		});

		test("handles nested context objects", () => {
			const log = new Logger("info");
			log.info("Complex data", {
				user: { id: 123, name: "Alice" },
				tags: ["admin", "active"],
			});

			const call = consoleLogMock.mock.calls[0][0] as string;
			expect(call).toContain('"user":{"id":123,"name":"Alice"}');
			expect(call).toContain('"tags":["admin","active"]');
		});

		test("handles numeric and boolean values in context", () => {
			const log = new Logger("info");
			log.info("Status", { count: 42, enabled: true, ratio: 3.14 });

			const call = consoleLogMock.mock.calls[0][0] as string;
			expect(call).toContain('"count":42');
			expect(call).toContain('"enabled":true');
			expect(call).toContain('"ratio":3.14');
		});
	});

	describe("console method routing", () => {
		test("debug uses console.log", () => {
			const log = new Logger("debug");
			log.debug("test");
			expect(consoleLogMock).toHaveBeenCalled();
		});

		test("info uses console.log", () => {
			const log = new Logger("info");
			log.info("test");
			expect(consoleLogMock).toHaveBeenCalled();
		});

		test("warn uses console.warn", () => {
			const log = new Logger("info");
			log.warn("test");
			expect(consoleWarnMock).toHaveBeenCalled();
		});

		test("error uses console.error", () => {
			const log = new Logger("info");
			log.error("test");
			expect(consoleErrorMock).toHaveBeenCalled();
		});
	});

	describe("singleton instance", () => {
		test("logger is exported as singleton", () => {
			expect(logger).toBeInstanceOf(Logger);
		});

		test("singleton has expected methods", () => {
			expect(typeof logger.debug).toBe("function");
			expect(typeof logger.info).toBe("function");
			expect(typeof logger.warn).toBe("function");
			expect(typeof logger.error).toBe("function");
			expect(typeof logger.setLevel).toBe("function");
			expect(typeof logger.getLevel).toBe("function");
		});
	});
});
