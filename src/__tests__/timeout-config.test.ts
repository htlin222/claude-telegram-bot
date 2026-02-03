/**
 * Test suite for configurable timeout values.
 *
 * Verifies that all timeout configuration values are properly parsed as numbers
 * with sensible defaults.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe("Timeout Configuration", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		// Create a copy of env to restore later
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		// Restore original env
		process.env = originalEnv;
	});

	test("MEDIA_GROUP_TIMEOUT_MS should parse to a number", async () => {
		process.env.MEDIA_GROUP_TIMEOUT_MS = undefined;
		const { MEDIA_GROUP_TIMEOUT } = await import("../config");
		expect(typeof MEDIA_GROUP_TIMEOUT).toBe("number");
		expect(MEDIA_GROUP_TIMEOUT).toBe(1000);
	});

	test("MEDIA_GROUP_TIMEOUT_MS should use custom value when set", async () => {
		process.env.MEDIA_GROUP_TIMEOUT_MS = "2000";
		// Clear the module cache to reimport with new env
		delete require.cache[require.resolve("../config")];
		const { MEDIA_GROUP_TIMEOUT } = await import("../config");
		expect(MEDIA_GROUP_TIMEOUT).toBe(2000);
	});

	test("QUERY_TIMEOUT_MS should parse to a number", async () => {
		process.env.QUERY_TIMEOUT_MS = undefined;
		const { QUERY_TIMEOUT_MS } = await import("../config");
		expect(typeof QUERY_TIMEOUT_MS).toBe("number");
		expect(QUERY_TIMEOUT_MS).toBe(180000);
	});

	test("TIMEOUT_PROMPT_WAIT_MS should parse to a number", async () => {
		process.env.TIMEOUT_PROMPT_WAIT_MS = undefined;
		const { TIMEOUT_PROMPT_WAIT_MS } = await import("../config");
		expect(typeof TIMEOUT_PROMPT_WAIT_MS).toBe("number");
		expect(TIMEOUT_PROMPT_WAIT_MS).toBe(30000);
	});

	test("STREAMING_THROTTLE_MS should parse to a number", async () => {
		process.env.STREAMING_THROTTLE_MS = undefined;
		const { STREAMING_THROTTLE_MS } = await import("../config");
		expect(typeof STREAMING_THROTTLE_MS).toBe("number");
		expect(STREAMING_THROTTLE_MS).toBe(500);
	});

	test("all timeout values should be positive integers", async () => {
		const {
			MEDIA_GROUP_TIMEOUT,
			QUERY_TIMEOUT_MS,
			TIMEOUT_PROMPT_WAIT_MS,
			STREAMING_THROTTLE_MS,
		} = await import("../config");

		const timeouts = [
			MEDIA_GROUP_TIMEOUT,
			QUERY_TIMEOUT_MS,
			TIMEOUT_PROMPT_WAIT_MS,
			STREAMING_THROTTLE_MS,
		];

		for (const timeout of timeouts) {
			expect(Number.isInteger(timeout)).toBe(true);
			expect(timeout).toBeGreaterThan(0);
		}
	});
});
