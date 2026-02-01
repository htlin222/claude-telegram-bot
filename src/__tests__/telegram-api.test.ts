/**
 * Unit tests for Telegram API utilities.
 */

import { describe, expect, test } from "bun:test";
import { TelegramApiError, withRetry } from "../telegram-api";

describe("withRetry", () => {
	test("succeeds on first attempt", async () => {
		let attempts = 0;
		const result = await withRetry(async () => {
			attempts++;
			return "success";
		});
		expect(result).toBe("success");
		expect(attempts).toBe(1);
	});

	test("retries on transient failure then succeeds", async () => {
		let attempts = 0;
		const result = await withRetry(
			async () => {
				attempts++;
				if (attempts < 3) {
					throw new Error("Too Many Requests: retry after 1");
				}
				return "success";
			},
			{ maxRetries: 3, baseDelay: 10 },
		);
		expect(result).toBe("success");
		expect(attempts).toBe(3);
	});

	test("throws after max retries", async () => {
		let attempts = 0;
		await expect(
			withRetry(
				async () => {
					attempts++;
					throw new Error("Too Many Requests: retry after 1");
				},
				{ maxRetries: 2, baseDelay: 10 },
			),
		).rejects.toThrow();
		expect(attempts).toBe(2);
	});

	test("does not retry non-transient errors", async () => {
		let attempts = 0;
		await expect(
			withRetry(
				async () => {
					attempts++;
					throw new Error("Bad Request: message not found");
				},
				{ maxRetries: 3, baseDelay: 10 },
			),
		).rejects.toThrow("Bad Request");
		expect(attempts).toBe(1);
	});
});

describe("TelegramApiError", () => {
	test("isTransient returns true for rate limit errors", () => {
		const error = new TelegramApiError("Too Many Requests: retry after 5", 429);
		expect(error.isTransient).toBe(true);
		expect(error.retryAfter).toBe(5);
	});

	test("isTransient returns true for network errors", () => {
		const error = new TelegramApiError("ETIMEDOUT", 0);
		expect(error.isTransient).toBe(true);
	});

	test("isTransient returns false for bad request", () => {
		const error = new TelegramApiError("Bad Request: message not found", 400);
		expect(error.isTransient).toBe(false);
	});
});
