/**
 * Unit tests for security module.
 */

import { describe, expect, test } from "bun:test";
import { checkCommandSafety, isAuthorized, isPathAllowed } from "../security";

describe("isPathAllowed", () => {
	test("allows paths under ALLOWED_PATHS", () => {
		// Note: actual allowed paths depend on environment
		expect(isPathAllowed("/tmp/test")).toBe(true);
		expect(isPathAllowed("/tmp/telegram-bot/file.txt")).toBe(true);
	});

	test("allows temp paths", () => {
		expect(isPathAllowed("/tmp/foo")).toBe(true);
		expect(isPathAllowed("/private/tmp/bar")).toBe(true);
	});

	test("rejects system paths", () => {
		expect(isPathAllowed("/etc/passwd")).toBe(false);
		expect(isPathAllowed("/usr/bin/bash")).toBe(false);
		expect(isPathAllowed("/root/.ssh")).toBe(false);
	});

	test("handles path traversal attempts", () => {
		expect(isPathAllowed("/tmp/../etc/passwd")).toBe(false);
	});

	test("handles tilde expansion", () => {
		// Should expand ~ to home directory
		const result = isPathAllowed("~/Documents/test.txt");
		// Result depends on whether ~/Documents is in ALLOWED_PATHS
		expect(typeof result).toBe("boolean");
	});

	test("handles non-existent paths", () => {
		// Should not throw for non-existent paths
		expect(() => isPathAllowed("/nonexistent/path/file.txt")).not.toThrow();
	});
});

describe("checkCommandSafety", () => {
	test("allows safe commands", () => {
		expect(checkCommandSafety("ls -la")).toEqual([true, ""]);
		expect(checkCommandSafety("git status")).toEqual([true, ""]);
		expect(checkCommandSafety("cat file.txt")).toEqual([true, ""]);
	});

	test("blocks fork bomb", () => {
		const [safe, reason] = checkCommandSafety(":(){ :|:& };:");
		expect(safe).toBe(false);
		expect(reason).toContain("Blocked pattern");
	});

	test("blocks dangerous rm commands", () => {
		const [safe1, reason1] = checkCommandSafety("rm -rf /");
		expect(safe1).toBe(false);
		expect(reason1).toContain("Blocked pattern");

		const [safe2, reason2] = checkCommandSafety("rm -rf ~");
		expect(safe2).toBe(false);
		expect(reason2).toContain("Blocked pattern");

		const [safe3, reason3] = checkCommandSafety("sudo rm -rf /home");
		expect(safe3).toBe(false);
		expect(reason3).toContain("Blocked pattern");
	});

	test("blocks disk destruction commands", () => {
		const [safe1] = checkCommandSafety("> /dev/sda");
		expect(safe1).toBe(false);

		const [safe2] = checkCommandSafety("mkfs.ext4 /dev/sda");
		expect(safe2).toBe(false);

		const [safe3] = checkCommandSafety("dd if=/dev/zero of=/dev/sda");
		expect(safe3).toBe(false);
	});

	test("validates rm paths against allowed list", () => {
		// rm to temp directory should be allowed
		const [safe1] = checkCommandSafety("rm /tmp/test.txt");
		expect(safe1).toBe(true);

		// rm to system paths should be blocked
		const [safe2, reason2] = checkCommandSafety("rm /etc/passwd");
		expect(safe2).toBe(false);
		expect(reason2).toContain("outside allowed paths");
	});

	test("handles rm with flags", () => {
		// Should allow rm -f to temp
		const [safe1] = checkCommandSafety("rm -f /tmp/test.txt");
		expect(safe1).toBe(true);

		// Should block rm -rf to system paths
		const [safe2] = checkCommandSafety("rm -rf /var/log");
		expect(safe2).toBe(false);
	});
});

describe("isAuthorized", () => {
	const allowedUsers = [123, 456, 789];

	test("returns true for allowed users", () => {
		expect(isAuthorized(123, allowedUsers)).toBe(true);
		expect(isAuthorized(456, allowedUsers)).toBe(true);
		expect(isAuthorized(789, allowedUsers)).toBe(true);
	});

	test("returns false for unauthorized users", () => {
		expect(isAuthorized(999, allowedUsers)).toBe(false);
		expect(isAuthorized(0, allowedUsers)).toBe(false);
	});

	test("returns false for undefined userId", () => {
		expect(isAuthorized(undefined, allowedUsers)).toBe(false);
	});

	test("returns false when allowed users list is empty", () => {
		expect(isAuthorized(123, [])).toBe(false);
	});
});
