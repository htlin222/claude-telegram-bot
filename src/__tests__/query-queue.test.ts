/**
 * Tests for query queue with backpressure.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryQueue } from "../query-queue";

// Mock the session module
const mockSendMessageStreaming = mock(() => Promise.resolve("mock response"));

// Mock the config values
mock.module("../config", () => ({
	MAX_CONCURRENT_QUERIES: 2,
	MAX_QUERY_QUEUE_SIZE: 3,
}));

// Mock the session
mock.module("../session", () => ({
	ClaudeSession: {
		get activeQueryCount() {
			return mockActiveQueries;
		},
	},
	session: {
		sendMessageStreaming: mockSendMessageStreaming,
	},
}));

// Mock the events module
const mockEventListeners: Map<string, (() => void)[]> = new Map();
mock.module("../events", () => ({
	botEvents: {
		on: (event: string, callback: () => void) => {
			if (!mockEventListeners.has(event)) {
				mockEventListeners.set(event, []);
			}
			mockEventListeners.get(event)?.push(callback);
			return () => {
				const listeners = mockEventListeners.get(event);
				if (listeners) {
					const idx = listeners.indexOf(callback);
					if (idx >= 0) listeners.splice(idx, 1);
				}
			};
		},
		emit: (event: string) => {
			const listeners = mockEventListeners.get(event);
			if (listeners) {
				for (const listener of listeners) {
					listener();
				}
			}
		},
	},
}));

let mockActiveQueries = 0;

// Mock status callback
const createMockStatusCallback = () =>
	mock(() => Promise.resolve()) as unknown as (
		type: string,
		content: string,
	) => Promise<void>;

describe("QueryQueue", () => {
	let queue: QueryQueue;

	beforeEach(() => {
		queue = new QueryQueue();
		mockActiveQueries = 0;
		mockSendMessageStreaming.mockClear();
		mockEventListeners.clear();
	});

	test("executes immediately when under concurrent limit", async () => {
		mockActiveQueries = 0;
		const statusCallback = createMockStatusCallback();

		const result = await queue.sendMessage(
			"test message",
			"testuser",
			123,
			statusCallback,
		);

		expect(result).toBe("mock response");
		expect(mockSendMessageStreaming).toHaveBeenCalledTimes(1);
	});

	test("queues when at concurrent limit", async () => {
		mockActiveQueries = 2; // At limit (MAX_CONCURRENT_QUERIES = 2)
		const statusCallback = createMockStatusCallback();

		// Start the queued request (will not resolve immediately)
		const promise = queue.sendMessage(
			"test message",
			"testuser",
			123,
			statusCallback,
		);

		// Should be queued
		expect(queue.length).toBe(1);

		// Status callback should have been called with "queued"
		expect(statusCallback).toHaveBeenCalledWith(
			"queued",
			expect.stringContaining("Position 1"),
		);

		// Clean up - simulate query finishing
		mockActiveQueries = 0;
		await queue.processNext();
		await promise;
	});

	test("throws error when queue is full", async () => {
		mockActiveQueries = 2; // At limit
		const statusCallback = createMockStatusCallback();

		// Fill the queue (MAX_QUERY_QUEUE_SIZE = 3)
		const promises: Promise<string>[] = [];
		for (let i = 0; i < 3; i++) {
			promises.push(
				queue.sendMessage(`message ${i}`, "testuser", 123, statusCallback),
			);
		}
		expect(queue.length).toBe(3);

		// Next should throw
		await expect(
			queue.sendMessage("overflow message", "testuser", 123, statusCallback),
		).rejects.toThrow(/Queue full/);

		// Clean up - catch the rejections
		queue.clear();
		await Promise.allSettled(promises);
	});

	test("processNext executes queued query", async () => {
		mockActiveQueries = 2; // At limit
		const statusCallback = createMockStatusCallback();

		// Queue a request
		const promise = queue.sendMessage(
			"queued message",
			"testuser",
			123,
			statusCallback,
		);
		expect(queue.length).toBe(1);

		// Simulate query finishing
		mockActiveQueries = 0;
		await queue.processNext();

		const result = await promise;
		expect(result).toBe("mock response");
		expect(queue.length).toBe(0);
	});

	test("clear rejects all queued queries", async () => {
		mockActiveQueries = 2; // At limit
		const statusCallback = createMockStatusCallback();

		// Queue some requests
		const promise1 = queue.sendMessage("msg1", "user", 1, statusCallback);
		const promise2 = queue.sendMessage("msg2", "user", 2, statusCallback);

		expect(queue.length).toBe(2);

		// Clear the queue
		const cleared = queue.clear();
		expect(cleared).toBe(2);
		expect(queue.length).toBe(0);

		// Promises should reject - use allSettled to avoid unhandled rejection
		const results = await Promise.allSettled([promise1, promise2]);
		expect(results[0]?.status).toBe("rejected");
		expect(results[1]?.status).toBe("rejected");
		expect((results[0] as PromiseRejectedResult).reason.message).toBe(
			"Queue cleared",
		);
		expect((results[1] as PromiseRejectedResult).reason.message).toBe(
			"Queue cleared",
		);
	});

	test("getStatus returns queue information", async () => {
		const status = queue.getStatus();

		expect(status).toEqual({
			queued: 0,
			maxSize: 3,
			oldestWaitMs: null,
		});
	});

	test("getStatus includes wait time when queue has items", async () => {
		mockActiveQueries = 2; // At limit
		const statusCallback = createMockStatusCallback();

		// Queue a request
		const promise = queue.sendMessage("test", "user", 1, statusCallback);

		// Wait a bit
		await new Promise((resolve) => setTimeout(resolve, 10));

		const status = queue.getStatus();
		expect(status.queued).toBe(1);
		expect(status.oldestWaitMs).toBeGreaterThanOrEqual(10);

		// Clean up
		queue.clear();
		await Promise.allSettled([promise]);
	});

	test("isFull returns correct value", async () => {
		mockActiveQueries = 2; // At limit
		const statusCallback = createMockStatusCallback();

		expect(queue.isFull).toBe(false);

		// Fill to limit
		const promises: Promise<string>[] = [];
		for (let i = 0; i < 3; i++) {
			promises.push(queue.sendMessage(`msg${i}`, "user", i, statusCallback));
		}

		expect(queue.isFull).toBe(true);

		// Clean up
		queue.clear();
		await Promise.allSettled(promises);
	});
});
