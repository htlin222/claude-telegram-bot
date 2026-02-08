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
if (OPENAI_API_KEY && TRANSCRIPTION_AVAILABLE) {
	openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
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

	try {
		const file = Bun.file(filePath);
		const transcript = await openaiClient.audio.transcriptions.create({
			model: "gpt-4o-transcribe",
			file: file,
			prompt: TRANSCRIPTION_PROMPT,
		});
		return transcript.text;
	} catch (error) {
		console.error("Transcription failed:", error);
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
