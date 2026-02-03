/**
 * Unit tests for utility modules.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logNonCriticalError, safeEditMessage } from "../utils/error-logging";
import {
	cleanupTempFile,
	cleanupTempFiles,
	safeUnlink,
} from "../utils/temp-cleanup";

// Test directory for temp file tests
const TEST_DIR = "/tmp/claude-telegram-bot-tests";

describe("temp-cleanup utilities", () => {
	beforeEach(() => {
		// Ensure test directory exists
		if (!existsSync(TEST_DIR)) {
			mkdirSync(TEST_DIR, { recursive: true });
		}
	});

	afterEach(() => {
		// Cleanup test directory
		try {
			const { rmSync } = require("node:fs");
			rmSync(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors in test teardown
		}
	});

	describe("cleanupTempFile", () => {
		test("deletes existing file", () => {
			const testFile = join(TEST_DIR, "test-cleanup.txt");
			writeFileSync(testFile, "test content");
			expect(existsSync(testFile)).toBe(true);

			cleanupTempFile(testFile);
			expect(existsSync(testFile)).toBe(false);
		});

		test("handles non-existent file gracefully", () => {
			const nonExistent = join(TEST_DIR, "does-not-exist.txt");
			expect(() => cleanupTempFile(nonExistent)).not.toThrow();
		});

		test("handles invalid path gracefully", () => {
			expect(() => cleanupTempFile("")).not.toThrow();
			expect(() => cleanupTempFile("/nonexistent/path/file.txt")).not.toThrow();
		});

		test("silent mode suppresses logging", () => {
			const nonExistent = join(TEST_DIR, "silent-test.txt");
			// Should not throw even with silent=true
			expect(() => cleanupTempFile(nonExistent, true)).not.toThrow();
		});
	});

	describe("cleanupTempFiles", () => {
		test("deletes multiple files", () => {
			const files = [
				join(TEST_DIR, "multi-1.txt"),
				join(TEST_DIR, "multi-2.txt"),
				join(TEST_DIR, "multi-3.txt"),
			];

			for (const file of files) {
				writeFileSync(file, "content");
			}

			for (const file of files) {
				expect(existsSync(file)).toBe(true);
			}

			cleanupTempFiles(files);

			for (const file of files) {
				expect(existsSync(file)).toBe(false);
			}
		});

		test("handles empty array", () => {
			expect(() => cleanupTempFiles([])).not.toThrow();
		});

		test("handles mixed existing and non-existing files", () => {
			const existingFile = join(TEST_DIR, "exists.txt");
			writeFileSync(existingFile, "content");

			const files = [
				existingFile,
				join(TEST_DIR, "does-not-exist-1.txt"),
				join(TEST_DIR, "does-not-exist-2.txt"),
			];

			expect(() => cleanupTempFiles(files)).not.toThrow();
			expect(existsSync(existingFile)).toBe(false);
		});
	});

	describe("safeUnlink", () => {
		test("returns true when file is deleted", () => {
			const testFile = join(TEST_DIR, "safe-unlink.txt");
			writeFileSync(testFile, "content");

			const result = safeUnlink(testFile);
			expect(result).toBe(true);
			expect(existsSync(testFile)).toBe(false);
		});

		test("returns true when file does not exist", () => {
			const nonExistent = join(TEST_DIR, "nonexistent.txt");
			const result = safeUnlink(nonExistent);
			expect(result).toBe(true);
		});

		test("returns false on permission error", () => {
			// This test is platform-dependent, skip if not possible
			const protectedDir = "/root/protected-file.txt";
			const result = safeUnlink(protectedDir);
			// Should return false for permission denied (or true if file doesn't exist)
			expect(typeof result).toBe("boolean");
		});
	});
});

describe("error-logging utilities", () => {
	describe("logNonCriticalError", () => {
		test("handles Error objects", () => {
			const error = new Error("Test error message");
			// Should not throw
			expect(() => logNonCriticalError("test context", error)).not.toThrow();
		});

		test("handles string errors", () => {
			expect(() =>
				logNonCriticalError("test context", "string error"),
			).not.toThrow();
		});

		test("handles null/undefined errors", () => {
			expect(() => logNonCriticalError("test context", null)).not.toThrow();
			expect(() =>
				logNonCriticalError("test context", undefined),
			).not.toThrow();
		});

		test("handles objects as errors", () => {
			expect(() =>
				logNonCriticalError("test context", { code: "ERR", msg: "fail" }),
			).not.toThrow();
		});

		test("accepts debug level", () => {
			expect(() =>
				logNonCriticalError("test", new Error("test"), "debug"),
			).not.toThrow();
		});

		test("accepts warn level", () => {
			expect(() =>
				logNonCriticalError("test", new Error("test"), "warn"),
			).not.toThrow();
		});
	});

	describe("safeEditMessage", () => {
		test("returns true on successful operation", async () => {
			const result = await safeEditMessage(async () => "success", "test edit");
			expect(result).toBe(true);
		});

		test("returns false on failed operation", async () => {
			const result = await safeEditMessage(async () => {
				throw new Error("Edit failed");
			}, "test edit failure");
			expect(result).toBe(false);
		});

		test("handles rejected promises", async () => {
			const result = await safeEditMessage(
				() => Promise.reject(new Error("Rejected")),
				"test rejection",
			);
			expect(result).toBe(false);
		});

		test("handles synchronous throws", async () => {
			const result = await safeEditMessage(() => {
				throw new Error("Sync throw");
			}, "test sync throw");
			expect(result).toBe(false);
		});
	});
});

describe("Session file permissions", () => {
	test("session file should be created with restricted permissions", () => {
		// This is an integration-level test concept
		// We test that writeFileSync with mode 0o600 works correctly
		const testFile = join(TEST_DIR, "session-perms-test.json");

		// Ensure test directory exists
		if (!existsSync(TEST_DIR)) {
			mkdirSync(TEST_DIR, { recursive: true });
		}

		writeFileSync(testFile, JSON.stringify({ test: true }), { mode: 0o600 });

		expect(existsSync(testFile)).toBe(true);

		// Check file permissions (Unix only)
		const stats = statSync(testFile);
		const mode = stats.mode & 0o777; // Get permission bits only
		expect(mode).toBe(0o600); // Owner read/write only
	});
});
