/**
 * Utilities for error logging in non-critical code paths.
 * These functions help maintain visibility into errors while
 * preventing crashes from non-essential operations.
 */

/**
 * Log a non-critical error that shouldn't crash the application.
 * Use this instead of empty catch blocks to maintain error visibility.
 *
 * @param context - Description of what operation failed
 * @param error - The error that occurred
 * @param level - Log level: 'debug' for expected failures, 'warn' for unexpected
 */
export function logNonCriticalError(
	context: string,
	error: unknown,
	level: "debug" | "warn" = "debug",
): void {
	const message = error instanceof Error ? error.message : String(error);
	const logFn = level === "warn" ? console.warn : console.debug;
	logFn(`[non-critical] ${context}: ${message}`);
}

/**
 * Wrapper for Telegram message edit operations that may fail.
 * Telegram editMessageText can fail if:
 * - Message was already edited
 * - Message is too old
 * - User blocked the bot
 *
 * @param operation - Async function that performs the edit
 * @param context - Description for logging
 */
export async function safeEditMessage(
	operation: () => Promise<unknown>,
	context: string,
): Promise<boolean> {
	try {
		await operation();
		return true;
	} catch (error) {
		logNonCriticalError(`Edit message failed (${context})`, error);
		return false;
	}
}
