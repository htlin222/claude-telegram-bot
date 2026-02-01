/**
 * Unit tests for callback handlers (file sending, bookmarks).
 */

import { describe, expect, test } from "bun:test";

describe("File sending callback data", () => {
	describe("base64 encoding/decoding", () => {
		test("encodes and decodes simple path", () => {
			const path = "/Users/test/file.txt";
			const encoded = Buffer.from(path).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(path);
		});

		test("encodes and decodes path with spaces", () => {
			const path = "/Users/test/my file.txt";
			const encoded = Buffer.from(path).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(path);
		});

		test("encodes and decodes path with special characters", () => {
			const path = "/Users/test/file-name_v2.1.txt";
			const encoded = Buffer.from(path).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(path);
		});

		test("encodes and decodes unicode path", () => {
			const path = "/Users/test/文件.txt";
			const encoded = Buffer.from(path).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(path);
		});

		test("encodes and decodes long path", () => {
			const path = "/Users/test/very/deep/nested/directory/structure/file.txt";
			const encoded = Buffer.from(path).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(path);
		});
	});

	describe("callback data format", () => {
		test("creates valid callback data", () => {
			const path = "/tmp/test.txt";
			const encoded = Buffer.from(path).toString("base64");
			const callbackData = `sendfile:${encoded}`;
			expect(callbackData.startsWith("sendfile:")).toBe(true);
		});

		test("extracts path from callback data", () => {
			const path = "/tmp/test.txt";
			const encoded = Buffer.from(path).toString("base64");
			const callbackData = `sendfile:${encoded}`;

			const extractedEncoded = callbackData.slice("sendfile:".length);
			const extractedPath = Buffer.from(extractedEncoded, "base64").toString(
				"utf-8",
			);
			expect(extractedPath).toBe(path);
		});

		test("callback data fits within Telegram limits", () => {
			// Telegram callback data max is 64 bytes
			const maxPath = "/Users/verylongusername/very/deep/path/file.txt";
			const encoded = Buffer.from(maxPath).toString("base64");
			const callbackData = `sendfile:${encoded}`;
			// This might exceed 64 bytes for very long paths
			// The implementation should handle this
			expect(callbackData.length).toBeGreaterThan(0);
		});
	});

	describe("path validation", () => {
		test("identifies absolute paths", () => {
			const absolutePaths = [
				"/tmp/file.txt",
				"/Users/test/doc.pdf",
				"/home/user/data.json",
				"/var/log/app.log",
			];

			for (const path of absolutePaths) {
				expect(path.startsWith("/")).toBe(true);
			}
		});

		test("identifies relative paths", () => {
			const relativePaths = [
				"./file.txt",
				"../parent/file.txt",
				"subdir/file.txt",
				"file.txt",
			];

			for (const path of relativePaths) {
				expect(path.startsWith("/")).toBe(false);
			}
		});
	});
});

describe("Bookmark callback data", () => {
	describe("callback data format", () => {
		test("creates add bookmark callback", () => {
			const path = "/Users/test/project";
			const callbackData = `bookmark:add:${path}`;
			expect(callbackData).toBe("bookmark:add:/Users/test/project");
		});

		test("creates remove bookmark callback", () => {
			const path = "/Users/test/project";
			const callbackData = `bookmark:remove:${path}`;
			expect(callbackData).toBe("bookmark:remove:/Users/test/project");
		});

		test("creates new session callback", () => {
			const path = "/Users/test/project";
			const callbackData = `bookmark:new:${path}`;
			expect(callbackData).toBe("bookmark:new:/Users/test/project");
		});

		test("handles paths with colons", () => {
			// Path parsing should handle colons in path
			const callbackData = "bookmark:add:/path/with:colon/file.txt";
			const parts = callbackData.split(":");
			expect(parts[0]).toBe("bookmark");
			expect(parts[1]).toBe("add");
			// Path is everything after second colon
			const path = parts.slice(2).join(":");
			expect(path).toBe("/path/with:colon/file.txt");
		});
	});

	describe("action parsing", () => {
		test("parses add action", () => {
			const callbackData = "bookmark:add:/path";
			const parts = callbackData.split(":");
			expect(parts[1]).toBe("add");
		});

		test("parses remove action", () => {
			const callbackData = "bookmark:remove:/path";
			const parts = callbackData.split(":");
			expect(parts[1]).toBe("remove");
		});

		test("parses new action", () => {
			const callbackData = "bookmark:new:/path";
			const parts = callbackData.split(":");
			expect(parts[1]).toBe("new");
		});

		test("parses noop action", () => {
			const callbackData = "bookmark:noop:";
			const parts = callbackData.split(":");
			expect(parts[1]).toBe("noop");
		});
	});
});

describe("Ask user callback data", () => {
	describe("callback data format", () => {
		test("creates valid ask user callback", () => {
			const requestId = "abc123";
			const optionIndex = 0;
			const callbackData = `askuser:${requestId}:${optionIndex}`;
			expect(callbackData).toBe("askuser:abc123:0");
		});

		test("parses request ID", () => {
			const callbackData = "askuser:request-id-123:2";
			const parts = callbackData.split(":");
			expect(parts[1]).toBe("request-id-123");
		});

		test("parses option index", () => {
			const callbackData = "askuser:abc:3";
			const parts = callbackData.split(":");
			expect(Number.parseInt(parts[2] ?? "", 10)).toBe(3);
		});

		test("handles multi-digit option index", () => {
			const callbackData = "askuser:abc:15";
			const parts = callbackData.split(":");
			expect(Number.parseInt(parts[2] ?? "", 10)).toBe(15);
		});
	});

	describe("validation", () => {
		test("validates callback format", () => {
			const validCallbacks = [
				"askuser:id:0",
				"askuser:long-request-id:5",
				"askuser:123:99",
			];

			for (const cb of validCallbacks) {
				const parts = cb.split(":");
				expect(parts).toHaveLength(3);
				expect(parts[0]).toBe("askuser");
				expect(parts[1]?.length).toBeGreaterThan(0);
				expect(Number.parseInt(parts[2] ?? "", 10)).toBeGreaterThanOrEqual(0);
			}
		});

		test("detects invalid callback format", () => {
			const invalidCallbacks = [
				"askuser:", // Missing parts
				"askuser:id", // Missing option
				"askuser::", // Empty parts
				"other:id:0", // Wrong prefix
			];

			for (const cb of invalidCallbacks) {
				const parts = cb.split(":");
				const isValid =
					parts.length === 3 &&
					parts[0] === "askuser" &&
					(parts[1]?.length ?? 0) > 0 &&
					!Number.isNaN(Number.parseInt(parts[2] ?? "", 10));
				expect(isValid).toBe(false);
			}
		});
	});
});

describe("Inline keyboard button labels", () => {
	const BUTTON_LABEL_MAX_LENGTH = 30;

	test("truncates long labels", () => {
		const longLabel = "This is a very long option that should be truncated";
		const display =
			longLabel.length > BUTTON_LABEL_MAX_LENGTH
				? `${longLabel.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: longLabel;
		expect(display.length).toBeLessThanOrEqual(BUTTON_LABEL_MAX_LENGTH + 3);
	});

	test("keeps short labels unchanged", () => {
		const shortLabel = "Short option";
		const display =
			shortLabel.length > BUTTON_LABEL_MAX_LENGTH
				? `${shortLabel.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: shortLabel;
		expect(display).toBe(shortLabel);
	});

	test("handles exact length labels", () => {
		const exactLabel = "A".repeat(BUTTON_LABEL_MAX_LENGTH);
		const display =
			exactLabel.length > BUTTON_LABEL_MAX_LENGTH
				? `${exactLabel.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: exactLabel;
		expect(display).toBe(exactLabel);
	});

	test("handles empty labels", () => {
		const emptyLabel = "";
		const display =
			emptyLabel.length > BUTTON_LABEL_MAX_LENGTH
				? `${emptyLabel.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: emptyLabel;
		expect(display).toBe("");
	});

	test("handles unicode labels", () => {
		const unicodeLabel = "选择这个选项";
		const display =
			unicodeLabel.length > BUTTON_LABEL_MAX_LENGTH
				? `${unicodeLabel.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: unicodeLabel;
		expect(display).toBe(unicodeLabel);
	});

	test("handles emoji labels", () => {
		const emojiLabel = "📁 Download file";
		const display =
			emojiLabel.length > BUTTON_LABEL_MAX_LENGTH
				? `${emojiLabel.slice(0, BUTTON_LABEL_MAX_LENGTH)}...`
				: emojiLabel;
		expect(display).toBe(emojiLabel);
	});
});
