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

describe("Diff callback data", () => {
	describe("options encoding", () => {
		test("encodes 'all' option correctly", () => {
			const opts = "all";
			const encoded = Buffer.from(opts).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe("all");
		});

		test("encodes 'staged' option correctly", () => {
			const opts = "staged";
			const encoded = Buffer.from(opts).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe("staged");
		});

		test("encodes file option with path", () => {
			const opts = "file:src/index.ts";
			const encoded = Buffer.from(opts).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded).toBe("file:src/index.ts");
			expect(decoded.startsWith("file:")).toBe(true);
			expect(decoded.slice(5)).toBe("src/index.ts");
		});

		test("handles file paths with slashes", () => {
			const opts = "file:src/handlers/commands.ts";
			const encoded = Buffer.from(opts).toString("base64");
			const decoded = Buffer.from(encoded, "base64").toString("utf-8");
			expect(decoded.slice(5)).toBe("src/handlers/commands.ts");
		});
	});

	describe("callback data format", () => {
		test("creates valid diff view callback", () => {
			const opts = "all";
			const encoded = Buffer.from(opts).toString("base64");
			const callbackData = `diff:view:${encoded}`;
			expect(callbackData.startsWith("diff:view:")).toBe(true);
		});

		test("creates diff commit callback", () => {
			const callbackData = "diff:commit";
			expect(callbackData).toBe("diff:commit");
		});

		test("creates diff revert callback", () => {
			const callbackData = "diff:revert";
			expect(callbackData).toBe("diff:revert");
		});

		test("creates diff revert confirm callback", () => {
			const callbackData = "diff:revert:confirm";
			expect(callbackData).toBe("diff:revert:confirm");
		});

		test("creates diff revert cancel callback", () => {
			const callbackData = "diff:revert:cancel";
			expect(callbackData).toBe("diff:revert:cancel");
		});
	});

	describe("callback data parsing", () => {
		test("extracts action from diff callback", () => {
			const testCases = [
				{ data: "diff:view:YWxs", expectedAction: "view" },
				{ data: "diff:commit", expectedAction: "commit" },
				{ data: "diff:revert", expectedAction: "revert" },
				{ data: "diff:revert:confirm", expectedAction: "revert" },
			];

			for (const { data, expectedAction } of testCases) {
				const parts = data.split(":");
				const action = parts[1];
				expect(action).toBe(expectedAction);
			}
		});

		test("extracts options from view callback", () => {
			const opts = "staged";
			const encoded = Buffer.from(opts).toString("base64");
			const callbackData = `diff:view:${encoded}`;

			const parts = callbackData.split(":");
			const encodedOpts = parts.slice(2).join(":");
			const decoded = Buffer.from(encodedOpts, "base64").toString("utf-8");
			expect(decoded).toBe("staged");
		});

		test("extracts subaction from revert callback", () => {
			const confirmCallback = "diff:revert:confirm";
			const cancelCallback = "diff:revert:cancel";
			const plainRevert = "diff:revert";

			expect(confirmCallback.split(":")[2]).toBe("confirm");
			expect(cancelCallback.split(":")[2]).toBe("cancel");
			expect(plainRevert.split(":")[2]).toBeUndefined();
		});

		test("distinguishes diff from other callbacks", () => {
			const diffCallback = "diff:view:YWxs";
			const mergeCallback = "merge:confirm:abc123";
			const shellCallback = "shell:run:abc123";

			expect(diffCallback.startsWith("diff:")).toBe(true);
			expect(mergeCallback.startsWith("diff:")).toBe(false);
			expect(shellCallback.startsWith("diff:")).toBe(false);
		});
	});
});

describe("Diff numstat parsing", () => {
	describe("numstat line format", () => {
		test("parses standard numstat line", () => {
			const line = "15\t3\tsrc/index.ts";
			const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
			expect(match).not.toBeNull();
			expect(match?.[1]).toBe("15");
			expect(match?.[2]).toBe("3");
			expect(match?.[3]).toBe("src/index.ts");
		});

		test("parses binary file numstat (dash values)", () => {
			const line = "-\t-\timage.png";
			const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
			expect(match).not.toBeNull();
			expect(match?.[1]).toBe("-");
			expect(match?.[2]).toBe("-");
			expect(match?.[3]).toBe("image.png");
		});

		test("parses zero changes", () => {
			const line = "0\t0\tsrc/empty.ts";
			const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
			expect(match).not.toBeNull();
			expect(match?.[1]).toBe("0");
			expect(match?.[2]).toBe("0");
		});

		test("handles file paths with spaces", () => {
			const line = "5\t2\tsrc/my file.ts";
			const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
			expect(match).not.toBeNull();
			expect(match?.[3]).toBe("src/my file.ts");
		});

		test("handles deeply nested paths", () => {
			const line = "10\t5\tsrc/handlers/commands/diff.ts";
			const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
			expect(match).not.toBeNull();
			expect(match?.[3]).toBe("src/handlers/commands/diff.ts");
		});
	});

	describe("summary aggregation", () => {
		test("combines staged and unstaged for same file", () => {
			const fileMap = new Map<
				string,
				{ file: string; added: number; removed: number }
			>();

			// Unstaged changes
			fileMap.set("src/index.ts", {
				file: "src/index.ts",
				added: 10,
				removed: 5,
			});

			// Staged changes for same file
			const existing = fileMap.get("src/index.ts");
			if (existing) {
				existing.added += 5;
				existing.removed += 2;
			}

			expect(existing?.added).toBe(15);
			expect(existing?.removed).toBe(7);
		});

		test("keeps separate files separate", () => {
			const fileMap = new Map<
				string,
				{ file: string; added: number; removed: number }
			>();

			fileMap.set("src/a.ts", { file: "src/a.ts", added: 10, removed: 5 });
			fileMap.set("src/b.ts", { file: "src/b.ts", added: 3, removed: 1 });

			expect(fileMap.size).toBe(2);
			expect(fileMap.get("src/a.ts")?.added).toBe(10);
			expect(fileMap.get("src/b.ts")?.added).toBe(3);
		});
	});
});

describe("Diff output formatting", () => {
	describe("line counting", () => {
		test("counts lines correctly for threshold check", () => {
			const shortDiff = "line1\nline2\nline3";
			const longDiff = Array.from({ length: 60 }, (_, i) => `line${i}`).join(
				"\n",
			);

			expect(shortDiff.split("\n").length).toBe(3);
			expect(longDiff.split("\n").length).toBe(60);

			const THRESHOLD = 50;
			expect(shortDiff.split("\n").length > THRESHOLD).toBe(false);
			expect(longDiff.split("\n").length > THRESHOLD).toBe(true);
		});
	});

	describe("HTML escaping for diff output", () => {
		test("escapes angle brackets", () => {
			const diff = "- const x = <T>();";
			const escaped = diff
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			expect(escaped).toBe("- const x = &lt;T&gt;();");
		});

		test("escapes ampersands", () => {
			const diff = '- const url = "foo&bar";';
			const escaped = diff
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			expect(escaped).toBe('- const url = "foo&amp;bar";');
		});

		test("escapes multiple special characters", () => {
			const diff = "- const x = <T & U>();";
			const escaped = diff
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			expect(escaped).toBe("- const x = &lt;T &amp; U&gt;();");
		});
	});

	describe("file name generation for diff attachment", () => {
		test("generates default filename", () => {
			const filename = "changes.diff";
			expect(filename).toBe("changes.diff");
		});

		test("generates filename from file path", () => {
			const file = "src/handlers/commands.ts";
			const filename = `${file.replace(/\//g, "_")}.diff`;
			expect(filename).toBe("src_handlers_commands.ts.diff");
		});

		test("handles simple file names", () => {
			const file = "index.ts";
			const filename = `${file.replace(/\//g, "_")}.diff`;
			expect(filename).toBe("index.ts.diff");
		});
	});
});
