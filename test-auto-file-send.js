#!/usr/bin/env bun
/**
 * Test script for auto file send feature.
 *
 * This simulates the bot's behavior when detecting file requests.
 */

import { existsSync, readFileSync } from "node:fs";

// Simulate session.lastBotResponse from bot
const simulatedBotResponse = `
測試檔案存在：<code>/Users/htlin/claude-telegram-bot/test-auto-send.txt</code> (420 bytes)

現在請在 Telegram 中發送「**把檔案給我看**」來測試自動檔案傳輸功能！
`;

console.log("=== Testing Auto File Send Feature ===\n");

// Step 1: Test file path detection
console.log("Step 1: Detecting file paths from bot response...");
const codeMatches = simulatedBotResponse.matchAll(/<code>([^<]+)<\/code>/g);
const candidates = [];

for (const m of codeMatches) {
	const content = m[1]?.trim();
	// Must have file extension
	if (content && /\.[a-zA-Z0-9]+$/.test(content)) {
		candidates.push(content);
		console.log(`  ✓ Found: ${content}`);
	}
}

if (candidates.length === 0) {
	console.log("  ✗ No file paths detected!");
	process.exit(1);
}

// Step 2: Test AI file request detection (simulate)
console.log("\nStep 2: Testing file request detection...");
const testMessages = [
	"把檔案給我看",
	"給我檔案",
	"send me the file",
	"show me the file",
	"download the file",
	"can i see the file",
];

for (const msg of testMessages) {
	// Simplified detection (without actual AI call)
	const isFileRequest =
		/把.*檔案.*給我/.test(msg) ||
		/檔案.*給我看/.test(msg) ||
		/給我.*檔案/.test(msg) ||
		/\b(send|give|show)\s+(me\s+)?(the\s+)?files?\b/i.test(msg) ||
		/\b(download|get)\s+(the\s+)?files?\b/i.test(msg) ||
		/\bcan\s+i\s+(see|have|get)\s+(the\s+)?files?\b/i.test(msg);

	console.log(
		`  ${isFileRequest ? "✓" : "✗"} "${msg}" -> ${isFileRequest ? "DETECTED" : "not detected"}`,
	);
}

// Step 3: Test file sending
console.log("\nStep 3: Testing file access...");
for (const filePath of candidates) {
	if (existsSync(filePath)) {
		const content = readFileSync(filePath, "utf-8");
		const preview =
			content.length > 100 ? content.slice(0, 100) + "..." : content;
		console.log(`  ✓ File exists: ${filePath}`);
		console.log(`  ✓ Content preview:\n${preview}\n`);
	} else {
		console.log(`  ✗ File not found: ${filePath}`);
	}
}

console.log("\n=== Test Complete ===");
console.log("\nTo test in actual Telegram bot:");
console.log(
	"1. Send a message that generates a response with file path in <code> tags",
);
console.log("2. Then send: 把檔案給我看");
console.log("3. Bot should auto-detect and send the file");
