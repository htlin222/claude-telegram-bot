/**
 * Structured logging utility for Claude Telegram Bot.
 *
 * Provides leveled logging with timestamps and structured data support.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/**
 * Logger class with support for log levels and structured data.
 */
export class Logger {
	private level: LogLevel;

	constructor(level: LogLevel = "info") {
		this.level = level;
	}

	/**
	 * Set the minimum log level.
	 */
	setLevel(level: LogLevel): void {
		this.level = level;
	}

	/**
	 * Get the current log level.
	 */
	getLevel(): LogLevel {
		return this.level;
	}

	/**
	 * Check if a given level should be logged.
	 */
	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
	}

	/**
	 * Format timestamp in ISO format.
	 */
	private formatTimestamp(): string {
		return new Date().toISOString();
	}

	/**
	 * Format context object for logging.
	 */
	private formatContext(context?: Record<string, unknown>): string {
		if (!context || Object.keys(context).length === 0) {
			return "";
		}
		return ` ${JSON.stringify(context)}`;
	}

	/**
	 * Log a message at the specified level.
	 */
	private log(
		level: LogLevel,
		message: string,
		context?: Record<string, unknown>,
	): void {
		if (!this.shouldLog(level)) {
			return;
		}

		const timestamp = this.formatTimestamp();
		const levelUpper = level.toUpperCase().padEnd(5);
		const contextStr = this.formatContext(context);

		const output = `[${timestamp}] ${levelUpper} ${message}${contextStr}`;

		if (level === "error") {
			console.error(output);
		} else if (level === "warn") {
			console.warn(output);
		} else {
			console.log(output);
		}
	}

	/**
	 * Log a debug message.
	 */
	debug(message: string, context?: Record<string, unknown>): void {
		this.log("debug", message, context);
	}

	/**
	 * Log an info message.
	 */
	info(message: string, context?: Record<string, unknown>): void {
		this.log("info", message, context);
	}

	/**
	 * Log a warning message.
	 */
	warn(message: string, context?: Record<string, unknown>): void {
		this.log("warn", message, context);
	}

	/**
	 * Log an error message.
	 */
	error(message: string, context?: Record<string, unknown>): void {
		this.log("error", message, context);
	}
}

/**
 * Parse LOG_LEVEL from environment variable.
 */
function parseLogLevel(): LogLevel {
	const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
	if (envLevel in LOG_LEVELS) {
		return envLevel as LogLevel;
	}
	return "info";
}

/**
 * Singleton logger instance configured from environment.
 */
export const logger = new Logger(parseLogLevel());
