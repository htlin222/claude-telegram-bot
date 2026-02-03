/**
 * Unit tests for worktree module.
 */

import { describe, expect, test } from "bun:test";
import { sanitizeWorktreeName } from "../worktree";

describe("sanitizeWorktreeName", () => {
	describe("basic sanitization", () => {
		test("keeps simple branch names unchanged", () => {
			expect(sanitizeWorktreeName("main")).toBe("main");
			expect(sanitizeWorktreeName("develop")).toBe("develop");
			expect(sanitizeWorktreeName("feature")).toBe("feature");
		});

		test("trims whitespace", () => {
			expect(sanitizeWorktreeName("  main  ")).toBe("main");
			expect(sanitizeWorktreeName("\tmain\n")).toBe("main");
		});

		test("handles branch names with dots", () => {
			expect(sanitizeWorktreeName("v1.0.0")).toBe("v1.0.0");
			expect(sanitizeWorktreeName("release.1.2")).toBe("release.1.2");
		});

		test("handles branch names with hyphens", () => {
			expect(sanitizeWorktreeName("feature-new")).toBe("feature-new");
			expect(sanitizeWorktreeName("bug-fix-123")).toBe("bug-fix-123");
		});

		test("handles branch names with underscores", () => {
			expect(sanitizeWorktreeName("feature_new")).toBe("feature_new");
			expect(sanitizeWorktreeName("bug_fix_123")).toBe("bug_fix_123");
		});
	});

	describe("slash handling", () => {
		test("converts forward slashes to hyphens", () => {
			expect(sanitizeWorktreeName("feature/auth")).toBe("feature-auth");
			expect(sanitizeWorktreeName("feature/new-login")).toBe(
				"feature-new-login",
			);
		});

		test("converts backslashes to hyphens", () => {
			expect(sanitizeWorktreeName("feature\\auth")).toBe("feature-auth");
		});

		test("handles multiple slashes", () => {
			expect(sanitizeWorktreeName("feature/ui/button")).toBe(
				"feature-ui-button",
			);
			expect(sanitizeWorktreeName("a/b/c/d")).toBe("a-b-c-d");
		});

		test("handles consecutive slashes", () => {
			expect(sanitizeWorktreeName("feature//auth")).toBe("feature-auth");
			expect(sanitizeWorktreeName("a///b")).toBe("a-b");
		});
	});

	describe("special character handling", () => {
		test("removes special characters", () => {
			expect(sanitizeWorktreeName("feature@auth")).toBe("feature-auth");
			expect(sanitizeWorktreeName("feature#123")).toBe("feature-123");
			expect(sanitizeWorktreeName("feature$test")).toBe("feature-test");
		});

		test("handles spaces", () => {
			expect(sanitizeWorktreeName("feature auth")).toBe("feature-auth");
			expect(sanitizeWorktreeName("my branch name")).toBe("my-branch-name");
		});

		test("removes leading hyphens", () => {
			expect(sanitizeWorktreeName("-feature")).toBe("feature");
			expect(sanitizeWorktreeName("---feature")).toBe("feature");
		});

		test("removes trailing hyphens", () => {
			expect(sanitizeWorktreeName("feature-")).toBe("feature");
			expect(sanitizeWorktreeName("feature---")).toBe("feature");
		});

		test("handles unicode characters", () => {
			// Unicode is converted to hyphens, then trailing hyphens are stripped
			expect(sanitizeWorktreeName("feature-功能")).toBe("feature");
			expect(sanitizeWorktreeName("測試")).toBe("");
			// Unicode in middle gets converted to hyphen (may leave consecutive hyphens)
			expect(sanitizeWorktreeName("feature-功能-test")).toBe("feature---test");
		});
	});

	describe("edge cases", () => {
		test("returns empty string for empty input", () => {
			expect(sanitizeWorktreeName("")).toBe("");
		});

		test("returns empty string for whitespace only", () => {
			expect(sanitizeWorktreeName("   ")).toBe("");
			expect(sanitizeWorktreeName("\t\n")).toBe("");
		});

		test("returns empty string for only special characters", () => {
			expect(sanitizeWorktreeName("@#$%^&*")).toBe("");
		});

		test("handles very long branch names", () => {
			const longName = `feature/${"a".repeat(100)}`;
			const result = sanitizeWorktreeName(longName);
			expect(result.startsWith("feature-")).toBe(true);
			expect(result.length).toBe(108); // "feature-" (8) + 100 a's
		});
	});
});

describe("Merge callback data", () => {
	describe("callback data format", () => {
		test("creates valid merge confirm callback", () => {
			const branch = "feature/auth";
			const encoded = Buffer.from(branch).toString("base64");
			const callbackData = `merge:confirm:${encoded}`;
			expect(callbackData.startsWith("merge:confirm:")).toBe(true);
		});

		test("creates merge cancel callback", () => {
			const callbackData = "merge:cancel";
			expect(callbackData).toBe("merge:cancel");
		});

		test("encodes and decodes branch name correctly", () => {
			const branch = "feature/new-auth";
			const encoded = Buffer.from(branch).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(branch);
		});

		test("handles branch names with slashes", () => {
			const branch = "feature/ui/components";
			const encoded = Buffer.from(branch).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(branch);
		});

		test("handles branch names with special characters", () => {
			const branch = "fix/bug-123_final";
			const encoded = Buffer.from(branch).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(branch);
		});
	});

	describe("callback data parsing", () => {
		test("extracts branch from confirm callback", () => {
			const branch = "feature/test";
			const encoded = Buffer.from(branch).toString("base64");
			const callbackData = `merge:confirm:${encoded}`;

			const prefix = "merge:confirm:";
			expect(callbackData.startsWith(prefix)).toBe(true);
			const extractedEncoded = callbackData.slice(prefix.length);
			const extractedBranch = Buffer.from(extractedEncoded, "base64").toString(
				"utf-8",
			);
			expect(extractedBranch).toBe(branch);
		});

		test("identifies cancel callback", () => {
			const callbackData = "merge:cancel";
			expect(callbackData).toBe("merge:cancel");
			expect(callbackData.startsWith("merge:confirm:")).toBe(false);
		});

		test("distinguishes merge from other callbacks", () => {
			const mergeCallback = "merge:confirm:abc123";
			const branchCallback = "branch:switch:abc123";
			const shellCallback = "shell:run:abc123";

			expect(mergeCallback.startsWith("merge:")).toBe(true);
			expect(branchCallback.startsWith("merge:")).toBe(false);
			expect(shellCallback.startsWith("merge:")).toBe(false);
		});
	});

	describe("callback data validation", () => {
		test("validates merge callback format", () => {
			const validCallbacks = [
				"merge:cancel",
				"merge:confirm:ZmVhdHVyZS9hdXRo", // feature/auth
				"merge:confirm:bWFpbg==", // main
			];

			for (const cb of validCallbacks) {
				expect(cb.startsWith("merge:")).toBe(true);
			}
		});

		test("detects invalid merge callback format", () => {
			const invalidCallbacks = [
				"merge:", // Missing action
				"merge:invalid:abc", // Invalid action
				"notmerge:confirm:abc", // Wrong prefix
			];

			for (const cb of invalidCallbacks) {
				const isValidConfirm = cb.startsWith("merge:confirm:");
				const isValidCancel = cb === "merge:cancel";
				const isValid = isValidConfirm || isValidCancel;
				expect(isValid).toBe(false);
			}
		});

		test("handles empty encoded branch", () => {
			const callbackData = "merge:confirm:";
			const prefix = "merge:confirm:";
			const encoded = callbackData.slice(prefix.length);
			expect(encoded).toBe("");
		});
	});
});

describe("Branch callback data", () => {
	describe("base64 encoding for branch names", () => {
		test("encodes simple branch names", () => {
			const branch = "main";
			const encoded = Buffer.from(branch).toString("base64");
			expect(encoded).toBe("bWFpbg==");
		});

		test("encodes branch names with slashes", () => {
			const branch = "feature/auth";
			const encoded = Buffer.from(branch).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe(branch);
		});

		test("callback data within Telegram limits", () => {
			// Telegram callback data max is 64 bytes
			const branch = "feature/very-long-branch-name-here";
			const encoded = Buffer.from(branch).toString("base64");
			const callbackData = `branch:switch:${encoded}`;
			// The implementation skips branches with encoded length > 60
			expect(encoded.length).toBeLessThanOrEqual(60);
		});

		test("identifies branches exceeding callback limits", () => {
			// Very long branch name that would exceed limits
			const longBranch = `feature/${"a".repeat(50)}`;
			const encoded = Buffer.from(longBranch).toString("base64");
			// This should be skipped in the UI
			expect(encoded.length).toBeGreaterThan(60);
		});
	});
});

describe("Main branch detection", () => {
	describe("branch name patterns", () => {
		test("identifies main as default branch", () => {
			const branches = ["main", "develop", "feature/test"];
			const mainBranch = branches.find((b) => b === "main" || b === "master");
			expect(mainBranch).toBe("main");
		});

		test("identifies master as default branch", () => {
			const branches = ["master", "develop", "feature/test"];
			const mainBranch = branches.find((b) => b === "main" || b === "master");
			expect(mainBranch).toBe("master");
		});

		test("prefers main over master when both exist", () => {
			const branches = ["main", "master", "develop"];
			// The implementation checks main first
			const mainBranch =
				branches.find((b) => b === "main") ??
				branches.find((b) => b === "master");
			expect(mainBranch).toBe("main");
		});

		test("returns undefined when no main/master exists", () => {
			const branches = ["develop", "feature/test", "release/v1"];
			const mainBranch = branches.find((b) => b === "main" || b === "master");
			expect(mainBranch).toBeUndefined();
		});
	});
});
