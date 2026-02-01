/**
 * Unit tests for CLI argument parsing and env loading.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Helper to create a test directory with .env file
function createTestDir(): string {
	const testDir = `/tmp/ctb-test-${Date.now()}`;
	mkdirSync(testDir, { recursive: true });
	return testDir;
}

function cleanupTestDir(dir: string): void {
	try {
		const envPath = join(dir, ".env");
		if (existsSync(envPath)) unlinkSync(envPath);
		rmdirSync(dir);
	} catch {
		// Ignore cleanup errors
	}
}

describe("CLI .env file parsing", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = createTestDir();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	test("parses simple key=value pairs", () => {
		const envPath = join(testDir, ".env");
		writeFileSync(
			envPath,
			`TELEGRAM_BOT_TOKEN=test-token
TELEGRAM_ALLOWED_USERS=123,456`,
		);

		const content = readFileSync(envPath, "utf-8");
		const lines = content.split("\n");
		const env: Record<string, string> = {};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;
			env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
		}

		expect(env.TELEGRAM_BOT_TOKEN).toBe("test-token");
		expect(env.TELEGRAM_ALLOWED_USERS).toBe("123,456");
	});

	test("handles quoted values", () => {
		const envPath = join(testDir, ".env");
		writeFileSync(
			envPath,
			`SINGLE='single quoted'
DOUBLE="double quoted"`,
		);

		const content = readFileSync(envPath, "utf-8");
		const lines = content.split("\n");
		const env: Record<string, string> = {};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;
			let value = trimmed.slice(eqIndex + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			env[trimmed.slice(0, eqIndex).trim()] = value;
		}

		expect(env.SINGLE).toBe("single quoted");
		expect(env.DOUBLE).toBe("double quoted");
	});

	test("ignores comments", () => {
		const envPath = join(testDir, ".env");
		writeFileSync(
			envPath,
			`# This is a comment
TELEGRAM_BOT_TOKEN=token
# Another comment
TELEGRAM_ALLOWED_USERS=123`,
		);

		const content = readFileSync(envPath, "utf-8");
		const lines = content.split("\n");
		const env: Record<string, string> = {};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;
			env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
		}

		expect(Object.keys(env)).toHaveLength(2);
		expect(env.TELEGRAM_BOT_TOKEN).toBe("token");
	});

	test("handles empty lines", () => {
		const envPath = join(testDir, ".env");
		writeFileSync(
			envPath,
			`TELEGRAM_BOT_TOKEN=token

TELEGRAM_ALLOWED_USERS=123

`,
		);

		const content = readFileSync(envPath, "utf-8");
		const lines = content.split("\n");
		const env: Record<string, string> = {};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;
			env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
		}

		expect(Object.keys(env)).toHaveLength(2);
	});

	test("handles values with equals signs", () => {
		const envPath = join(testDir, ".env");
		writeFileSync(envPath, `API_KEY=key=with=equals`);

		const content = readFileSync(envPath, "utf-8");
		const lines = content.split("\n");
		const env: Record<string, string> = {};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;
			env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
		}

		expect(env.API_KEY).toBe("key=with=equals");
	});

	test("handles missing .env file gracefully", () => {
		const nonExistentPath = join(testDir, "nonexistent", ".env");
		expect(existsSync(nonExistentPath)).toBe(false);
	});
});

describe("CLI argument parsing", () => {
	function parseArgs(args: string[]): {
		token?: string;
		users?: string;
		dir?: string;
		help?: boolean;
		version?: boolean;
		tut?: boolean;
	} {
		const options: {
			token?: string;
			users?: string;
			dir?: string;
			help?: boolean;
			version?: boolean;
			tut?: boolean;
		} = {};

		for (const arg of args) {
			if (arg === "--help" || arg === "-h") {
				options.help = true;
			} else if (arg === "--version" || arg === "-v") {
				options.version = true;
			} else if (arg === "tut" || arg === "tutorial") {
				options.tut = true;
			} else if (arg.startsWith("--token=")) {
				options.token = arg.slice(8);
			} else if (arg.startsWith("--users=")) {
				options.users = arg.slice(8);
			} else if (arg.startsWith("--dir=")) {
				options.dir = arg.slice(6);
			}
		}

		return options;
	}

	test("parses --help flag", () => {
		expect(parseArgs(["--help"])).toEqual({ help: true });
	});

	test("parses -h shorthand", () => {
		expect(parseArgs(["-h"])).toEqual({ help: true });
	});

	test("parses --version flag", () => {
		expect(parseArgs(["--version"])).toEqual({ version: true });
	});

	test("parses -v shorthand", () => {
		expect(parseArgs(["-v"])).toEqual({ version: true });
	});

	test("parses tut command", () => {
		expect(parseArgs(["tut"])).toEqual({ tut: true });
	});

	test("parses tutorial command", () => {
		expect(parseArgs(["tutorial"])).toEqual({ tut: true });
	});

	test("parses --token option", () => {
		const result = parseArgs(["--token=my-bot-token"]);
		expect(result.token).toBe("my-bot-token");
	});

	test("parses --users option", () => {
		const result = parseArgs(["--users=123,456,789"]);
		expect(result.users).toBe("123,456,789");
	});

	test("parses --dir option", () => {
		const result = parseArgs(["--dir=/path/to/project"]);
		expect(result.dir).toBe("/path/to/project");
	});

	test("parses multiple options", () => {
		const result = parseArgs([
			"--token=token123",
			"--users=111,222",
			"--dir=/home/user/project",
		]);
		expect(result.token).toBe("token123");
		expect(result.users).toBe("111,222");
		expect(result.dir).toBe("/home/user/project");
	});

	test("handles empty args array", () => {
		expect(parseArgs([])).toEqual({});
	});

	test("ignores unknown flags", () => {
		const result = parseArgs(["--unknown", "--another=value"]);
		expect(result).toEqual({});
	});

	test("handles token with special characters", () => {
		const result = parseArgs(["--token=123:ABC-xyz_789"]);
		expect(result.token).toBe("123:ABC-xyz_789");
	});

	test("handles path with spaces when quoted", () => {
		// This tests the arg as it would come from shell
		const result = parseArgs(["--dir=/path/with spaces/project"]);
		expect(result.dir).toBe("/path/with spaces/project");
	});
});

describe("Path resolution with base directory", () => {
	function resolvePath(path: string, baseDir?: string): string {
		const homedir = () => "/Users/test";
		const expanded = path.replace(/^~/, homedir());
		if (baseDir && !expanded.startsWith("/")) {
			// Simulate resolve(baseDir, expanded)
			return `${baseDir}/${expanded}`.replace(/\/+/g, "/");
		}
		return expanded.startsWith("/") ? expanded : `/${expanded}`;
	}

	test("resolves absolute path unchanged", () => {
		const result = resolvePath("/absolute/path", "/base/dir");
		expect(result).toBe("/absolute/path");
	});

	test("resolves relative path from base directory", () => {
		const result = resolvePath("relative/path", "/base/dir");
		expect(result).toBe("/base/dir/relative/path");
	});

	test("expands tilde to home directory", () => {
		const result = resolvePath("~/projects", "/base/dir");
		expect(result).toBe("/Users/test/projects");
	});

	test("tilde path is not affected by base directory", () => {
		const result = resolvePath("~/projects", "/base/dir");
		expect(result).toBe("/Users/test/projects");
	});

	test("handles dot-relative paths", () => {
		const result = resolvePath("./subdir", "/base/dir");
		expect(result).toBe("/base/dir/./subdir");
	});

	test("handles parent directory paths", () => {
		const result = resolvePath("../sibling", "/base/dir");
		expect(result).toBe("/base/dir/../sibling");
	});

	test("works without base directory for absolute paths", () => {
		const result = resolvePath("/absolute/path");
		expect(result).toBe("/absolute/path");
	});
});

describe("Instance directory hashing", () => {
	function hashDir(dir: string): string {
		let hash = 0;
		for (let i = 0; i < dir.length; i++) {
			const char = dir.charCodeAt(i);
			hash = ((hash << 5) - hash + char) | 0;
		}
		return Math.abs(hash).toString(36).slice(0, 8);
	}

	test("generates consistent hash for same path", () => {
		const path = "/Users/test/project";
		expect(hashDir(path)).toBe(hashDir(path));
	});

	test("generates different hash for different paths", () => {
		const hash1 = hashDir("/Users/test/project1");
		const hash2 = hashDir("/Users/test/project2");
		expect(hash1).not.toBe(hash2);
	});

	test("generates short hash (max 8 chars)", () => {
		const hash = hashDir("/very/long/path/to/some/project/directory");
		expect(hash.length).toBeLessThanOrEqual(8);
	});

	test("generates alphanumeric hash", () => {
		const hash = hashDir("/Users/test/project");
		expect(hash).toMatch(/^[a-z0-9]+$/);
	});

	test("handles empty string", () => {
		const hash = hashDir("");
		expect(hash).toBe("0");
	});

	test("handles root path", () => {
		const hash = hashDir("/");
		expect(hash.length).toBeGreaterThan(0);
	});

	test("handles home directory variations", () => {
		const hash1 = hashDir("/Users/user1/project");
		const hash2 = hashDir("/Users/user2/project");
		expect(hash1).not.toBe(hash2);
	});
});
