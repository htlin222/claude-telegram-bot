/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, voice transcription, typing indicator.
 */

import type { Context } from "grammy";
import type { Chat } from "grammy/types";
import OpenAI from "openai";
import {
	AUDIT_LOG_JSON,
	AUDIT_LOG_MAX_FILES,
	AUDIT_LOG_MAX_SIZE,
	AUDIT_LOG_PATH,
	OPENAI_API_KEY,
	TRANSCRIPTION_AVAILABLE,
	TRANSCRIPTION_PROMPT,
} from "./config";
import { botEvents } from "./events";
import type { AuditEvent } from "./types";

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
let openaiApiValid: boolean | null = null; // null = untested, true = valid, false = invalid

if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
	openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

/**
 * Validate OpenAI API key by making a test request.
 * Returns true if valid, false otherwise.
 * Caches result to avoid repeated validation.
 */
export async function validateOpenAIApi(): Promise<boolean> {
	// Return cached result if available
	if (openaiApiValid !== null) {
		return openaiApiValid;
	}

	if (!openaiClient) {
		openaiApiValid = false;
		return false;
	}

	try {
		// Make a lightweight API call to validate the key
		// Using models.list() is a simple way to check API access
		await openaiClient.models.list();
		openaiApiValid = true;
		console.log("✓ OpenAI API key validated successfully");
		return true;
	} catch (error) {
		openaiApiValid = false;
		const errorMsg = String(error);

		if (errorMsg.includes("401") || errorMsg.includes("Unauthorized")) {
			console.error("✗ OpenAI API key is invalid or unauthorized");
		} else if (errorMsg.includes("429") || errorMsg.includes("rate limit")) {
			console.error("✗ OpenAI API rate limit exceeded");
		} else if (
			errorMsg.includes("network") ||
			errorMsg.includes("ECONNREFUSED")
		) {
			console.error("✗ Cannot reach OpenAI API (network issue)");
		} else {
			console.error("✗ OpenAI API validation failed:", errorMsg);
		}

		return false;
	}
}

/**
 * Get current OpenAI API status without triggering validation.
 * Returns: "unchecked" | "valid" | "invalid" | "unavailable"
 */
export function getOpenAIApiStatus(): string {
	if (!openaiClient) {
		return "unavailable";
	}
	if (openaiApiValid === null) {
		return "unchecked";
	}
	return openaiApiValid ? "valid" : "invalid";
}

/**
 * Force reset of API validation cache (useful after key rotation).
 */
export function resetOpenAIApiValidation(): void {
	openaiApiValid = null;
	console.log("OpenAI API validation cache cleared");
}

// ============== Audit Logging ==============

// Track last rotation check time to avoid checking on every write
let lastRotationCheck = 0;
const ROTATION_CHECK_INTERVAL_MS = Number.parseInt(
	process.env.ROTATION_CHECK_INTERVAL_MS || "60000",
	10,
); // Check every minute

/**
 * Rotate audit log if it exceeds max size.
 * Keeps up to AUDIT_LOG_MAX_FILES rotated files (.log.1, .log.2, etc.)
 */
async function rotateAuditLogIfNeeded(): Promise<void> {
	const now = Date.now();
	if (now - lastRotationCheck < ROTATION_CHECK_INTERVAL_MS) {
		return; // Skip check if we checked recently
	}
	lastRotationCheck = now;

	try {
		const fs = await import("node:fs/promises");
		const stats = await fs.stat(AUDIT_LOG_PATH).catch(() => null);

		if (!stats || stats.size < AUDIT_LOG_MAX_SIZE) {
			return; // File doesn't exist or is under limit
		}

		console.log(
			`Rotating audit log (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${(AUDIT_LOG_MAX_SIZE / 1024 / 1024).toFixed(1)}MB limit)`,
		);

		// Rotate existing files: .log.2 -> .log.3, .log.1 -> .log.2, etc.
		for (let i = AUDIT_LOG_MAX_FILES - 1; i >= 1; i--) {
			const oldPath = i === 1 ? AUDIT_LOG_PATH : `${AUDIT_LOG_PATH}.${i - 1}`;
			const newPath = `${AUDIT_LOG_PATH}.${i}`;
			try {
				await fs.rename(oldPath, newPath);
			} catch {
				// File doesn't exist, skip
			}
		}

		// Delete oldest file if it exceeds max files
		const oldestPath = `${AUDIT_LOG_PATH}.${AUDIT_LOG_MAX_FILES}`;
		await fs.unlink(oldestPath).catch(() => {});

		console.log("Audit log rotated successfully");
	} catch (error) {
		console.error("Failed to rotate audit log:", error);
	}
}

async function writeAuditLog(event: AuditEvent): Promise<void> {
	try {
		// Check if rotation is needed (throttled)
		await rotateAuditLogIfNeeded();

		let content: string;
		if (AUDIT_LOG_JSON) {
			content = `${JSON.stringify(event)}\n`;
		} else {
			// Plain text format for readability
			const lines = [`\n${"=".repeat(60)}`];
			for (const [key, value] of Object.entries(event)) {
				let displayValue = value;
				if (
					(key === "content" || key === "response") &&
					String(value).length > 500
				) {
					displayValue = `${String(value).slice(0, 500)}...`;
				}
				lines.push(`${key}: ${displayValue}`);
			}
			content = `${lines.join("\n")}\n`;
		}

		// Append to audit log file
		const fs = await import("node:fs/promises");
		await fs.appendFile(AUDIT_LOG_PATH, content);
	} catch (error) {
		console.error("Failed to write audit log:", error);
	}
}

export async function auditLog(
	userId: number,
	username: string,
	messageType: string,
	content: string,
	response = "",
): Promise<void> {
	const event: AuditEvent = {
		timestamp: new Date().toISOString(),
		event: "message",
		user_id: userId,
		username,
		message_type: messageType,
		content,
	};
	if (response) {
		event.response = response;
	}
	await writeAuditLog(event);
}

export async function auditLogAuth(
	userId: number,
	username: string,
	authorized: boolean,
): Promise<void> {
	await writeAuditLog({
		timestamp: new Date().toISOString(),
		event: "auth",
		user_id: userId,
		username,
		authorized,
	});
}

export async function auditLogTool(
	userId: number,
	username: string,
	toolName: string,
	toolInput: Record<string, unknown>,
	blocked = false,
	reason = "",
): Promise<void> {
	const event: AuditEvent = {
		timestamp: new Date().toISOString(),
		event: "tool_use",
		user_id: userId,
		username,
		tool_name: toolName,
		tool_input: toolInput,
		blocked,
	};
	if (blocked && reason) {
		event.reason = reason;
	}
	await writeAuditLog(event);
}

export async function auditLogError(
	userId: number,
	username: string,
	error: string,
	context = "",
): Promise<void> {
	const event: AuditEvent = {
		timestamp: new Date().toISOString(),
		event: "error",
		user_id: userId,
		username,
		error,
	};
	if (context) {
		event.context = context;
	}
	await writeAuditLog(event);
}

export async function auditLogRateLimit(
	userId: number,
	username: string,
	retryAfter: number,
): Promise<void> {
	await writeAuditLog({
		timestamp: new Date().toISOString(),
		event: "rate_limit",
		user_id: userId,
		username,
		retry_after: retryAfter,
	});
}

// ============== Voice Transcription ==============

export async function transcribeVoice(
	filePath: string,
): Promise<string | null> {
	if (!openaiClient) {
		console.warn("OpenAI client not available for transcription");
		return null;
	}

	// Validate API before attempting transcription
	const isValid = await validateOpenAIApi();
	if (!isValid) {
		console.error("OpenAI API validation failed, cannot transcribe");
		return null;
	}

	try {
		const file = Bun.file(filePath);

		// Check if file exists and has content
		if (!(await file.exists())) {
			console.error("Voice file does not exist:", filePath);
			return null;
		}

		const fileSize = file.size;
		if (fileSize === 0) {
			console.error("Voice file is empty:", filePath);
			return null;
		}

		// OpenAI has a 25MB limit for audio files
		const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB in bytes
		if (fileSize > MAX_FILE_SIZE) {
			console.error(
				`Voice file too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB (max 25MB)`,
			);
			return null;
		}

		console.log(
			`Transcribing voice file (${(fileSize / 1024).toFixed(1)}KB)...`,
		);

		const transcript = await openaiClient.audio.transcriptions.create({
			model: "gpt-4o-transcribe",
			file: file,
			prompt: TRANSCRIPTION_PROMPT,
		});

		if (!transcript.text || transcript.text.trim().length === 0) {
			console.warn("Transcription returned empty text");
			return null;
		}

		console.log(
			`Transcription successful (${transcript.text.length} characters)`,
		);
		return transcript.text;
	} catch (error) {
		const errorMsg = String(error);
		console.error("Transcription failed:", errorMsg);

		// Invalidate API cache if we get auth errors
		if (errorMsg.includes("401") || errorMsg.includes("Unauthorized")) {
			openaiApiValid = false;
			console.error("OpenAI API key appears to be invalid");
		} else if (errorMsg.includes("429")) {
			console.error("OpenAI API rate limit exceeded");
		} else if (errorMsg.includes("insufficient_quota")) {
			openaiApiValid = false;
			console.error("OpenAI API quota exceeded");
		}

		return null;
	}
}

// ============== Typing Indicator ==============

export interface TypingController {
	stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
	let running = true;

	const loop = async () => {
		while (running) {
			try {
				await ctx.replyWithChatAction("typing");
			} catch (error) {
				// Stop loop if context is no longer valid
				if (
					String(error).includes("chat not found") ||
					String(error).includes("bot was blocked")
				) {
					running = false;
					return;
				}
				console.debug("Typing indicator failed:", error);
			}
			await Bun.sleep(4000);
		}
	};

	// Start the loop with proper error handling
	loop().catch((error) => {
		console.debug("Typing indicator loop error:", error);
	});

	return {
		stop: () => {
			running = false;
		},
	};
}

// ============== Message Interrupt ==============

export async function checkInterrupt(text: string): Promise<string> {
	if (!text || !text.startsWith("!")) {
		return text;
	}

	const strippedText = text.slice(1).trimStart();

	if (botEvents.getSessionState()) {
		console.log("! prefix - requesting interrupt");
		botEvents.emit("interruptRequested", undefined);
		await Bun.sleep(100);
	}

	return strippedText;
}
