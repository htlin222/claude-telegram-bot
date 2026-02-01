/**
 * Unit tests for session module - model, cost, thinking, and plan mode features.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { ClaudeSession, getThinkingLevel } from "../session";

describe("getThinkingLevel", () => {
	// Default keywords from config.ts:
	// THINKING_KEYWORDS: "think,pensa,ragiona"
	// THINKING_DEEP_KEYWORDS: "ultrathink,think hard,pensa bene"

	describe("deep thinking triggers", () => {
		test("triggers on 'think hard'", () => {
			expect(getThinkingLevel("Please think hard about this")).toBe(50000);
		});

		test("triggers on 'ultrathink'", () => {
			expect(getThinkingLevel("ultrathink about the problem")).toBe(50000);
		});

		test("triggers on 'pensa bene' (Italian)", () => {
			expect(getThinkingLevel("pensa bene prima di rispondere")).toBe(50000);
		});

		test("is case insensitive", () => {
			expect(getThinkingLevel("THINK HARD about this")).toBe(50000);
			expect(getThinkingLevel("ULTRATHINK")).toBe(50000);
		});
	});

	describe("normal thinking triggers", () => {
		test("triggers on 'think'", () => {
			expect(getThinkingLevel("Let me think about this")).toBe(10000);
		});

		test("triggers on 'pensa' (Italian)", () => {
			expect(getThinkingLevel("pensa a questo problema")).toBe(10000);
		});

		test("triggers on 'ragiona' (Italian)", () => {
			expect(getThinkingLevel("ragiona sul codice")).toBe(10000);
		});

		test("is case insensitive", () => {
			expect(getThinkingLevel("THINK about it")).toBe(10000);
			expect(getThinkingLevel("PENSA attentamente")).toBe(10000);
		});
	});

	describe("no thinking triggers", () => {
		test("returns 0 for simple messages", () => {
			expect(getThinkingLevel("Hello")).toBe(0);
			expect(getThinkingLevel("What time is it?")).toBe(0);
			expect(getThinkingLevel("Show me the file")).toBe(0);
		});

		test("returns 0 for empty string", () => {
			expect(getThinkingLevel("")).toBe(0);
		});

		test("returns 0 for unrelated words", () => {
			expect(getThinkingLevel("analyze this code")).toBe(0);
			expect(getThinkingLevel("consider the options")).toBe(0);
			expect(getThinkingLevel("evaluate this approach")).toBe(0);
		});
	});

	describe("priority", () => {
		test("deep triggers take precedence over normal", () => {
			// "think hard" should trigger deep (50000), not normal "think" (10000)
			expect(getThinkingLevel("think hard")).toBe(50000);
		});
	});
});

describe("ClaudeSession", () => {
	let session: ClaudeSession;

	beforeEach(() => {
		session = new ClaudeSession();
	});

	describe("model selection", () => {
		test("defaults to sonnet", () => {
			expect(session.currentModel).toBe("sonnet");
		});

		test("can be set to opus", () => {
			session.currentModel = "opus";
			expect(session.currentModel).toBe("opus");
		});

		test("can be set to haiku", () => {
			session.currentModel = "haiku";
			expect(session.currentModel).toBe("haiku");
		});

		test("can switch between models", () => {
			session.currentModel = "opus";
			expect(session.currentModel).toBe("opus");

			session.currentModel = "haiku";
			expect(session.currentModel).toBe("haiku");

			session.currentModel = "sonnet";
			expect(session.currentModel).toBe("sonnet");
		});
	});

	describe("forceThinking", () => {
		test("defaults to null", () => {
			expect(session.forceThinking).toBeNull();
		});

		test("can be set to specific token count", () => {
			session.forceThinking = 10000;
			expect(session.forceThinking).toBe(10000);
		});

		test("can be set to 0 (off)", () => {
			session.forceThinking = 0;
			expect(session.forceThinking).toBe(0);
		});

		test("can be set to deep (50000)", () => {
			session.forceThinking = 50000;
			expect(session.forceThinking).toBe(50000);
		});
	});

	describe("planMode", () => {
		test("defaults to false", () => {
			expect(session.planMode).toBe(false);
		});

		test("can be toggled on", () => {
			session.planMode = true;
			expect(session.planMode).toBe(true);
		});

		test("can be toggled off", () => {
			session.planMode = true;
			session.planMode = false;
			expect(session.planMode).toBe(false);
		});
	});

	describe("token usage tracking", () => {
		test("starts with zero totals", () => {
			expect(session.totalInputTokens).toBe(0);
			expect(session.totalOutputTokens).toBe(0);
			expect(session.totalCacheReadTokens).toBe(0);
		});

		test("can accumulate input tokens", () => {
			session.totalInputTokens += 1000;
			session.totalInputTokens += 500;
			expect(session.totalInputTokens).toBe(1500);
		});

		test("can accumulate output tokens", () => {
			session.totalOutputTokens += 2000;
			session.totalOutputTokens += 800;
			expect(session.totalOutputTokens).toBe(2800);
		});

		test("can accumulate cache read tokens", () => {
			session.totalCacheReadTokens += 500;
			session.totalCacheReadTokens += 300;
			expect(session.totalCacheReadTokens).toBe(800);
		});
	});

	describe("estimateCost", () => {
		describe("sonnet pricing", () => {
			test("calculates zero cost for zero tokens", () => {
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(0);
				expect(cost.outputCost).toBe(0);
				expect(cost.total).toBe(0);
			});

			test("calculates cost for 1M input tokens", () => {
				session.totalInputTokens = 1_000_000;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(3); // $3 per 1M input
				expect(cost.outputCost).toBe(0);
				expect(cost.total).toBe(3);
			});

			test("calculates cost for 1M output tokens", () => {
				session.totalOutputTokens = 1_000_000;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(0);
				expect(cost.outputCost).toBe(15); // $15 per 1M output
				expect(cost.total).toBe(15);
			});

			test("calculates combined cost", () => {
				session.totalInputTokens = 500_000;
				session.totalOutputTokens = 100_000;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(1.5); // $3 * 0.5
				expect(cost.outputCost).toBe(1.5); // $15 * 0.1
				expect(cost.total).toBe(3);
			});
		});

		describe("opus pricing", () => {
			beforeEach(() => {
				session.currentModel = "opus";
			});

			test("calculates cost for 1M input tokens", () => {
				session.totalInputTokens = 1_000_000;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(15); // $15 per 1M input
			});

			test("calculates cost for 1M output tokens", () => {
				session.totalOutputTokens = 1_000_000;
				const cost = session.estimateCost();
				expect(cost.outputCost).toBe(75); // $75 per 1M output
			});

			test("calculates combined cost", () => {
				session.totalInputTokens = 100_000;
				session.totalOutputTokens = 50_000;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(1.5); // $15 * 0.1
				expect(cost.outputCost).toBe(3.75); // $75 * 0.05
				expect(cost.total).toBe(5.25);
			});
		});

		describe("haiku pricing", () => {
			beforeEach(() => {
				session.currentModel = "haiku";
			});

			test("calculates cost for 1M input tokens", () => {
				session.totalInputTokens = 1_000_000;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(0.25); // $0.25 per 1M input
			});

			test("calculates cost for 1M output tokens", () => {
				session.totalOutputTokens = 1_000_000;
				const cost = session.estimateCost();
				expect(cost.outputCost).toBe(1.25); // $1.25 per 1M output
			});

			test("calculates combined cost", () => {
				session.totalInputTokens = 4_000_000;
				session.totalOutputTokens = 800_000;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBe(1); // $0.25 * 4
				expect(cost.outputCost).toBe(1); // $1.25 * 0.8
				expect(cost.total).toBe(2);
			});
		});

		describe("small token counts", () => {
			test("calculates fractional costs", () => {
				session.totalInputTokens = 1000;
				session.totalOutputTokens = 500;
				const cost = session.estimateCost();
				expect(cost.inputCost).toBeCloseTo(0.003, 5); // $3 * 0.001
				expect(cost.outputCost).toBeCloseTo(0.0075, 5); // $15 * 0.0005
				expect(cost.total).toBeCloseTo(0.0105, 5);
			});
		});
	});

	describe("kill", () => {
		test("resets sessionId", async () => {
			session.sessionId = "test-session-123";
			await session.kill();
			expect(session.sessionId).toBeNull();
		});

		test("resets lastActivity", async () => {
			session.lastActivity = new Date();
			await session.kill();
			expect(session.lastActivity).toBeNull();
		});

		test("resets token totals", async () => {
			session.totalInputTokens = 10000;
			session.totalOutputTokens = 5000;
			session.totalCacheReadTokens = 2000;
			await session.kill();
			expect(session.totalInputTokens).toBe(0);
			expect(session.totalOutputTokens).toBe(0);
			expect(session.totalCacheReadTokens).toBe(0);
		});

		test("resets planMode", async () => {
			session.planMode = true;
			await session.kill();
			expect(session.planMode).toBe(false);
		});

		test("resets forceThinking", async () => {
			session.forceThinking = 50000;
			await session.kill();
			expect(session.forceThinking).toBeNull();
		});

		test("preserves currentModel", async () => {
			session.currentModel = "opus";
			await session.kill();
			expect(session.currentModel).toBe("opus");
		});
	});

	describe("isActive", () => {
		test("returns false when no sessionId", () => {
			expect(session.isActive).toBe(false);
		});

		test("returns true when sessionId exists", () => {
			session.sessionId = "test-session-123";
			expect(session.isActive).toBe(true);
		});
	});

	describe("workingDir", () => {
		test("can get working directory", () => {
			expect(typeof session.workingDir).toBe("string");
		});

		test("setWorkingDir changes directory", () => {
			const newDir = "/tmp/test-dir";
			session.setWorkingDir(newDir);
			expect(session.workingDir).toBe(newDir);
		});

		test("setWorkingDir clears sessionId", () => {
			session.sessionId = "test-session-123";
			session.setWorkingDir("/tmp/new-dir");
			expect(session.sessionId).toBeNull();
		});
	});

	describe("stop", () => {
		test("returns false when nothing is running", async () => {
			const result = await session.stop();
			expect(result).toBe(false);
		});
	});

	describe("interrupt flags", () => {
		test("markInterrupt and consumeInterruptFlag work together", () => {
			expect(session.consumeInterruptFlag()).toBe(false);
			session.markInterrupt();
			expect(session.consumeInterruptFlag()).toBe(true);
			expect(session.consumeInterruptFlag()).toBe(false); // Consumed
		});
	});

	describe("processing state", () => {
		test("startProcessing returns cleanup function", () => {
			expect(session.isRunning).toBe(false);
			const cleanup = session.startProcessing();
			expect(session.isRunning).toBe(true);
			cleanup();
			expect(session.isRunning).toBe(false);
		});
	});
});
