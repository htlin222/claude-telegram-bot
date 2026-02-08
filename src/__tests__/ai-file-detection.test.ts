/**
 * Test AI-based file request detection (manual test - requires API key)
 */

import { describe, test } from "bun:test";

describe("AI File Request Detection", () => {
	test.skip("Manual test - requires ANTHROPIC_API_KEY", () => {
		// To test manually:
		// 1. Ensure ANTHROPIC_API_KEY is set in .env
		// 2. Start the bot
		// 3. Send messages like:
		//    - "把檔案給我看" (should detect)
		//    - "這個檔案很重要" (should NOT detect)
		//    - "send me the file" (should detect)
		//    - "I need to file a report" (should NOT detect)
		//
		// The AI should be more accurate than regex patterns
	});
});
