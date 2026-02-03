/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { parse } from "shell-quote";
import {
	ALLOWED_PATHS,
	BLOCKED_PATTERNS,
	RATE_LIMIT_ENABLED,
	RATE_LIMIT_REQUESTS,
	RATE_LIMIT_WINDOW,
	TEMP_PATHS,
} from "./config";
import type { RateLimitBucket } from "./types";

// ============== Rate Limiter ==============

// Bucket expiration time (1 hour) - prevents unbounded memory growth
const BUCKET_EXPIRATION_MS = Number.parseInt(
	process.env.BUCKET_EXPIRATION_MS || String(60 * 60 * 1000),
	10,
);
// Cleanup interval (10 minutes)
const CLEANUP_INTERVAL_MS = Number.parseInt(
	process.env.CLEANUP_INTERVAL_MS || String(10 * 60 * 1000),
	10,
);

class RateLimiter {
	private buckets = new Map<number, RateLimitBucket>();
	private maxTokens: number;
	private refillRate: number; // tokens per second
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.maxTokens = RATE_LIMIT_REQUESTS;
		this.refillRate = RATE_LIMIT_REQUESTS / RATE_LIMIT_WINDOW;

		// Start periodic cleanup
		this.startCleanup();
	}

	/**
	 * Start periodic cleanup of expired buckets.
	 */
	private startCleanup(): void {
		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredBuckets();
		}, CLEANUP_INTERVAL_MS);

		// Don't prevent process from exiting
		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	/**
	 * Remove buckets that haven't been used recently.
	 */
	private cleanupExpiredBuckets(): void {
		const now = Date.now();
		let removed = 0;

		for (const [userId, bucket] of this.buckets) {
			if (now - bucket.lastUpdate > BUCKET_EXPIRATION_MS) {
				this.buckets.delete(userId);
				removed++;
			}
		}

		if (removed > 0) {
			console.debug(`Rate limiter cleanup: removed ${removed} expired buckets`);
		}
	}

	check(userId: number): [allowed: boolean, retryAfter?: number] {
		if (!RATE_LIMIT_ENABLED) {
			return [true];
		}

		const now = Date.now();
		let bucket = this.buckets.get(userId);

		if (!bucket) {
			bucket = { tokens: this.maxTokens, lastUpdate: now };
			this.buckets.set(userId, bucket);
		}

		// Refill tokens based on time elapsed
		const elapsed = (now - bucket.lastUpdate) / 1000;
		bucket.tokens = Math.min(
			this.maxTokens,
			bucket.tokens + elapsed * this.refillRate,
		);
		bucket.lastUpdate = now;

		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return [true];
		}

		// Calculate time until next token
		const retryAfter = (1 - bucket.tokens) / this.refillRate;
		return [false, retryAfter];
	}

	getStatus(userId: number): {
		tokens: number;
		max: number;
		refillRate: number;
	} {
		const bucket = this.buckets.get(userId);
		return {
			tokens: bucket?.tokens ?? this.maxTokens,
			max: this.maxTokens,
			refillRate: this.refillRate,
		};
	}
}

export const rateLimiter = new RateLimiter();

// ============== Path Validation ==============

export function isPathAllowed(path: string): boolean {
	try {
		// Expand ~ and resolve to absolute path
		const expanded = path.replace(/^~/, process.env.HOME || "");
		const normalized = normalize(expanded);

		// Try to resolve symlinks (may fail if path doesn't exist yet)
		let resolved: string;
		try {
			resolved = realpathSync(normalized);
		} catch {
			resolved = resolve(normalized);
		}

		// Always allow temp paths (for bot's own files)
		for (const tempPath of TEMP_PATHS) {
			if (resolved.startsWith(tempPath)) {
				return true;
			}
		}

		// Check against allowed paths using proper containment
		for (const allowed of ALLOWED_PATHS) {
			const allowedResolved = resolve(allowed);
			if (
				resolved === allowedResolved ||
				resolved.startsWith(`${allowedResolved}/`)
			) {
				return true;
			}
		}

		return false;
	} catch {
		return false;
	}
}

// ============== Command Safety ==============

/**
 * Extract rm command arguments from a parsed command.
 * Handles cases where rm is part of a pipeline or compound command.
 */
function extractRmArgs(tokens: ReturnType<typeof parse>): string[] {
	const args: string[] = [];
	let inRmCommand = false;

	for (const token of tokens) {
		// Handle string tokens
		if (typeof token === "string") {
			if (token === "rm") {
				inRmCommand = true;
				continue;
			}
			if (inRmCommand) {
				// Stop at shell operators that end the rm command
				if (token === ";" || token === "&&" || token === "||") {
					inRmCommand = false;
					continue;
				}
				args.push(token);
			}
		} else if (typeof token === "object" && token !== null) {
			// Handle shell-quote special objects (operators, etc.)
			// These indicate command boundaries
			if ("op" in token) {
				inRmCommand = false;
			}
		}
	}

	return args;
}

export function checkCommandSafety(
	command: string,
): [safe: boolean, reason: string] {
	const lowerCommand = command.toLowerCase();

	// Check blocked patterns first
	for (const pattern of BLOCKED_PATTERNS) {
		if (lowerCommand.includes(pattern.toLowerCase())) {
			return [false, `Blocked pattern: ${pattern}`];
		}
	}

	// Special handling for rm commands - validate paths using shell-quote
	if (lowerCommand.includes("rm ")) {
		try {
			// Use shell-quote to properly parse the command
			const tokens = parse(command);
			const rmArgs = extractRmArgs(tokens);

			for (const arg of rmArgs) {
				// Skip flags (start with -)
				if (arg.startsWith("-")) continue;
				// Skip empty or very short args
				if (arg.length <= 1) continue;

				// Check if path is allowed
				if (!isPathAllowed(arg)) {
					return [false, `rm target outside allowed paths: ${arg}`];
				}
			}
		} catch {
			// If parsing fails, be cautious
			return [false, "Could not parse rm command for safety check"];
		}
	}

	return [true, ""];
}

// ============== Authorization ==============

export function isAuthorized(
	userId: number | undefined,
	allowedUsers: number[],
): boolean {
	if (!userId) return false;
	if (allowedUsers.length === 0) return false;
	return allowedUsers.includes(userId);
}
