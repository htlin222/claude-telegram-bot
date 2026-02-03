/**
 * Query queue with backpressure for Claude Telegram Bot.
 *
 * When MAX_CONCURRENT_QUERIES is exceeded, queries are queued instead of
 * immediately failing. When a query finishes, the next queued query runs.
 */

import type { Context } from "grammy";
import { MAX_CONCURRENT_QUERIES, MAX_QUERY_QUEUE_SIZE } from "./config";
import { botEvents } from "./events";
import { ClaudeSession, session } from "./session";
import type { StatusCallback } from "./types";

/**
 * A queued query waiting to be executed.
 */
interface QueuedQuery {
	message: string;
	username: string;
	userId: number;
	statusCallback: StatusCallback;
	chatId?: number;
	ctx?: Context;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
	queuedAt: Date;
}

/**
 * Simple FIFO queue for queries that exceed the concurrent limit.
 */
class QueryQueue {
	private queue: QueuedQuery[] = [];
	private processing = false;

	/**
	 * Get current queue length.
	 */
	get length(): number {
		return this.queue.length;
	}

	/**
	 * Check if queue is full.
	 */
	get isFull(): boolean {
		return this.queue.length >= MAX_QUERY_QUEUE_SIZE;
	}

	/**
	 * Send a message to Claude, queueing if necessary.
	 *
	 * If under the concurrent limit, executes immediately.
	 * If at the limit but queue has space, queues the request.
	 * If queue is full, throws an error.
	 */
	async sendMessage(
		message: string,
		username: string,
		userId: number,
		statusCallback: StatusCallback,
		chatId?: number,
		ctx?: Context,
	): Promise<string> {
		// Check if we can execute immediately
		if (ClaudeSession.activeQueryCount < MAX_CONCURRENT_QUERIES) {
			return session.sendMessageStreaming(
				message,
				username,
				userId,
				statusCallback,
				chatId,
				ctx,
			);
		}

		// Check if queue is full
		if (this.isFull) {
			throw new Error(
				`Queue full (${this.queue.length}/${MAX_QUERY_QUEUE_SIZE}). Try again later.`,
			);
		}

		// Queue the request
		return new Promise<string>((resolve, reject) => {
			this.queue.push({
				message,
				username,
				userId,
				statusCallback,
				chatId,
				ctx,
				resolve,
				reject,
				queuedAt: new Date(),
			});

			const position = this.queue.length;
			console.log(
				`Query queued at position ${position} (active: ${ClaudeSession.activeQueryCount}/${MAX_CONCURRENT_QUERIES})`,
			);

			// Notify the user they're queued
			statusCallback(
				"queued",
				`Position ${position} in queue (${ClaudeSession.activeQueryCount} running)`,
			).catch(() => {
				// Ignore callback errors
			});
		});
	}

	/**
	 * Process the next queued query if possible.
	 * Called when a query finishes.
	 */
	async processNext(): Promise<void> {
		// Prevent concurrent processing
		if (this.processing) {
			return;
		}

		// Check if we can run a query
		if (
			this.queue.length === 0 ||
			ClaudeSession.activeQueryCount >= MAX_CONCURRENT_QUERIES
		) {
			return;
		}

		this.processing = true;

		try {
			const query = this.queue.shift();
			if (!query) {
				return;
			}

			const waitTime = Date.now() - query.queuedAt.getTime();
			console.log(
				`Processing queued query after ${waitTime}ms wait (${this.queue.length} remaining)`,
			);

			// Notify user their query is starting
			try {
				await query.statusCallback(
					"queue_start",
					"Your queued request is now processing",
				);
			} catch {
				// Ignore callback errors
			}

			// Execute the query
			try {
				const result = await session.sendMessageStreaming(
					query.message,
					query.username,
					query.userId,
					query.statusCallback,
					query.chatId,
					query.ctx,
				);
				query.resolve(result);
			} catch (error) {
				query.reject(error as Error);
			}
		} finally {
			this.processing = false;

			// Check if there are more queries to process
			// Use setImmediate to avoid stack overflow with many queued queries
			if (this.queue.length > 0) {
				setImmediate(() => this.processNext());
			}
		}
	}

	/**
	 * Clear all queued queries (e.g., on shutdown).
	 * Rejects all pending promises.
	 */
	clear(): number {
		const count = this.queue.length;
		for (const query of this.queue) {
			query.reject(new Error("Queue cleared"));
		}
		this.queue = [];
		console.log(`Cleared ${count} queued queries`);
		return count;
	}

	/**
	 * Get queue status for /status command.
	 */
	getStatus(): {
		queued: number;
		maxSize: number;
		oldestWaitMs: number | null;
	} {
		const oldestWaitMs =
			this.queue.length > 0 && this.queue[0]
				? Date.now() - this.queue[0].queuedAt.getTime()
				: null;

		return {
			queued: this.queue.length,
			maxSize: MAX_QUERY_QUEUE_SIZE,
			oldestWaitMs,
		};
	}
}

// Global queue instance
export const queryQueue = new QueryQueue();

// Listen for query completion to process next in queue
botEvents.on("queryFinished", () => {
	queryQueue.processNext();
});

// Export class for testing
export { QueryQueue };
