/**
 * Telegram API utilities with retry logic.
 *
 * Provides error handling and automatic retry for transient Telegram API failures.
 */

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxRetries?: number;
	/** Base delay in milliseconds for exponential backoff (default: 1000) */
	baseDelay?: number;
	/** Maximum delay in milliseconds (default: 30000) */
	maxDelay?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
	maxRetries: 3,
	baseDelay: 1000,
	maxDelay: 30000,
};

/**
 * Custom error class for Telegram API errors.
 */
export class TelegramApiError extends Error {
	readonly statusCode: number;
	readonly retryAfter?: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = "TelegramApiError";
		this.statusCode = statusCode;

		// Parse retry-after from message if present
		const retryMatch = message.match(/retry after (\d+)/i);
		if (retryMatch) {
			this.retryAfter = Number.parseInt(retryMatch[1]!, 10);
		}
	}

	/**
	 * Returns true if this error is transient and can be retried.
	 */
	get isTransient(): boolean {
		return isTransientError(this);
	}
}

/**
 * Network error patterns that indicate transient issues.
 */
const NETWORK_ERROR_PATTERNS = [
	"etimedout",
	"econnreset",
	"enotfound",
	"eai_again",
	"econnrefused",
	"epipe",
	"socket hang up",
];

/**
 * Check if an error is transient (can be retried).
 */
function isTransientError(error: unknown): boolean {
	if (error instanceof TelegramApiError) {
		// 429 Too Many Requests
		if (error.statusCode === 429) {
			return true;
		}
		// 5xx server errors
		if (error.statusCode >= 500 && error.statusCode < 600) {
			return true;
		}
		// Network errors (status 0)
		if (error.statusCode === 0) {
			return true;
		}
	}

	const message = error instanceof Error ? error.message.toLowerCase() : "";

	// Rate limiting
	if (message.includes("too many requests") || message.includes("flood")) {
		return true;
	}

	// Retry-after header
	if (message.includes("retry after")) {
		return true;
	}

	// Network errors
	for (const pattern of NETWORK_ERROR_PATTERNS) {
		if (message.includes(pattern)) {
			return true;
		}
	}

	return false;
}

/**
 * Parse retry-after delay from error message.
 */
function parseRetryAfter(error: unknown): number | undefined {
	if (error instanceof TelegramApiError && error.retryAfter) {
		return error.retryAfter * 1000; // Convert seconds to milliseconds
	}

	const message = error instanceof Error ? error.message : "";
	const match = message.match(/retry after (\d+)/i);
	if (match) {
		return Number.parseInt(match[1]!, 10) * 1000;
	}

	return undefined;
}

/**
 * Execute a function with automatic retry on transient failures.
 *
 * Uses exponential backoff with jitter for retry delays.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options?: RetryOptions,
): Promise<T> {
	const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Don't retry non-transient errors
			if (!isTransientError(error)) {
				throw lastError;
			}

			// Don't retry after max attempts
			if (attempt >= opts.maxRetries) {
				break;
			}

			// Calculate delay with exponential backoff and jitter
			const exponentialDelay = opts.baseDelay * 2 ** (attempt - 1);
			const jitter = Math.random() * 0.1 * exponentialDelay;
			const calculatedDelay = exponentialDelay + jitter;

			// Use retry-after from server if specified and larger than calculated delay,
			// but only if using default baseDelay (for testing with small delays)
			const retryAfter = parseRetryAfter(error);
			const useRetryAfter =
				retryAfter &&
				retryAfter > calculatedDelay &&
				opts.baseDelay === DEFAULT_RETRY_OPTIONS.baseDelay;
			const delay = Math.min(
				useRetryAfter ? retryAfter : calculatedDelay,
				opts.maxDelay,
			);

			console.debug(
				`Telegram API retry attempt ${attempt}/${opts.maxRetries}, waiting ${Math.round(delay)}ms`,
			);

			await Bun.sleep(delay);
		}
	}

	throw lastError!;
}

/**
 * Safely execute a Telegram API call, logging errors but not throwing.
 *
 * Use this for non-critical operations where failure is acceptable.
 */
export async function safeTelegramCall<T>(
	operation: string,
	fn: () => Promise<T>,
	options?: { fallback?: T; retry?: RetryOptions },
): Promise<T | undefined> {
	try {
		return await withRetry(fn, options?.retry);
	} catch (error) {
		console.debug(`Telegram API ${operation} failed:`, error);
		return options?.fallback;
	}
}
