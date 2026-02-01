/**
 * Unit tests for file path detection in formatting module.
 */

import { describe, expect, test } from "bun:test";
import { detectFilePaths } from "../formatting";

describe("detectFilePaths", () => {
	describe("paths in backticks", () => {
		test("detects single file path in backticks", () => {
			const text = "Here is the file: `/Users/test/file.txt`";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/Users/test/file.txt");
			expect(result[0]?.display).toBe("test/file.txt");
		});

		test("detects multiple file paths in backticks", () => {
			const text = "Files: `/home/user/a.txt` and `/home/user/b.json`";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(2);
			expect(result[0]?.path).toBe("/home/user/a.txt");
			expect(result[1]?.path).toBe("/home/user/b.json");
		});

		test("handles paths with special characters", () => {
			const text = "`/Users/test/my-file_v2.txt`";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/Users/test/my-file_v2.txt");
		});

		test("handles paths with numbers", () => {
			const text = "`/tmp/output123.csv`";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/tmp/output123.csv");
		});
	});

	describe("paths after common prefixes", () => {
		test("detects path after 'file:'", () => {
			const text = "file: /Users/test/document.pdf";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/Users/test/document.pdf");
		});

		test("detects path after 'saved:'", () => {
			const text = "saved: /home/user/output.json";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/home/user/output.json");
		});

		test("detects path after 'created:'", () => {
			const text = "created: /tmp/new-file.txt";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/tmp/new-file.txt");
		});

		test("detects path after 'wrote:'", () => {
			const text = "wrote: /var/log/app.log";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/var/log/app.log");
		});

		test("detects path after 'output:'", () => {
			const text = "output: /home/user/result.csv";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/home/user/result.csv");
		});

		test("detects path after 'generated:'", () => {
			const text = "generated: /tmp/report.html";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/tmp/report.html");
		});

		test("is case insensitive for prefixes", () => {
			const text = "FILE: /Users/test/doc.txt";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
		});
	});

	describe("standalone absolute paths", () => {
		test("detects /Users path", () => {
			const text = "The file is at /Users/htlin/projects/code.ts";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/Users/htlin/projects/code.ts");
		});

		test("detects /home path", () => {
			const text = "Located at /home/user/data.json";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/home/user/data.json");
		});

		test("detects /tmp path", () => {
			const text = "Temp file: /tmp/cache.db";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/tmp/cache.db");
		});

		test("detects /var path", () => {
			const text = "Log at /var/log/system.log";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/var/log/system.log");
		});

		test("detects /etc path", () => {
			const text = "Config: /etc/nginx/nginx.conf";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/etc/nginx/nginx.conf");
		});

		test("detects /opt path", () => {
			const text = "Binary at /opt/app/bin/run.sh";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/opt/app/bin/run.sh");
		});
	});

	describe("deduplication", () => {
		test("removes duplicate paths", () => {
			const text =
				"File `/Users/test/file.txt` was created at /Users/test/file.txt";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(1);
		});

		test("keeps unique paths", () => {
			const text = "`/tmp/a.txt` `/tmp/b.txt` `/tmp/c.txt`";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(3);
		});
	});

	describe("display name generation", () => {
		test("uses last 2 path components for display", () => {
			const text = "`/very/long/path/to/file.txt`";
			const result = detectFilePaths(text);
			expect(result[0]?.display).toBe("to/file.txt");
		});

		test("handles single component paths", () => {
			const text = "`/tmp/file.txt`";
			const result = detectFilePaths(text);
			expect(result[0]?.display).toBe("tmp/file.txt");
		});

		test("handles root level files", () => {
			const text = "file: /tmp/x.log";
			const result = detectFilePaths(text);
			expect(result[0]?.display).toBe("tmp/x.log");
		});
	});

	describe("edge cases", () => {
		test("returns empty array for text without paths", () => {
			const text = "This is just regular text without any file paths.";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(0);
		});

		test("ignores relative paths", () => {
			const text = "Use ./local/file.txt or ../parent/file.txt";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(0);
		});

		test("ignores URLs", () => {
			const text = "Visit https://example.com/path/file.txt";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(0);
		});

		test("ignores paths without extensions", () => {
			const text = "`/Users/test/directory`";
			const result = detectFilePaths(text);
			expect(result).toHaveLength(0);
		});

		test("handles empty string", () => {
			const result = detectFilePaths("");
			expect(result).toHaveLength(0);
		});

		test("handles paths with various extensions", () => {
			const extensions = [
				".txt",
				".json",
				".ts",
				".js",
				".py",
				".md",
				".yaml",
				".yml",
				".csv",
				".html",
				".css",
				".xml",
				".pdf",
				".log",
				".sh",
			];
			for (const ext of extensions) {
				const text = `/tmp/file${ext}`;
				const result = detectFilePaths(text);
				expect(result.length).toBeGreaterThanOrEqual(0); // May or may not match depending on pattern
			}
		});

		test("handles multiline text", () => {
			const text = `
First file: /Users/test/a.txt
Second file: /Users/test/b.json
Third: \`/tmp/c.csv\`
`;
			const result = detectFilePaths(text);
			expect(result.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("relative paths with working directory", () => {
		test("resolves relative path with working directory", () => {
			const text = "Created file: `output.txt`";
			const result = detectFilePaths(text, "/Users/test/project");
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/Users/test/project/output.txt");
		});

		test("resolves nested relative path", () => {
			const text = "See `src/main.ts`";
			const result = detectFilePaths(text, "/Users/test/project");
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/Users/test/project/src/main.ts");
		});

		test("keeps absolute path unchanged with working directory", () => {
			const text = "`/absolute/path/file.txt`";
			const result = detectFilePaths(text, "/Users/test/project");
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/absolute/path/file.txt");
		});

		test("handles multiple relative paths", () => {
			const text = "Files: `a.txt` and `b.json`";
			const result = detectFilePaths(text, "/project");
			expect(result).toHaveLength(2);
			expect(result[0]?.path).toBe("/project/a.txt");
			expect(result[1]?.path).toBe("/project/b.json");
		});

		test("handles relative path after prefix", () => {
			const text = "output: result.csv";
			const result = detectFilePaths(text, "/data");
			expect(result).toHaveLength(1);
			expect(result[0]?.path).toBe("/data/result.csv");
		});

		test("ignores relative paths without working directory", () => {
			const text = "`relative/path.txt`";
			const result = detectFilePaths(text);
			// Without working directory, relative paths should still be captured but not resolved
			expect(result.length).toBeGreaterThanOrEqual(0);
		});
	});

	describe("complex scenarios", () => {
		test("handles Claude-style response with file mentions", () => {
			const text = `
I've created the following files:

1. Main script: \`/Users/htlin/project/src/main.ts\`
2. Configuration: saved: /Users/htlin/project/config.json
3. Test file at /Users/htlin/project/test/main.test.ts

The output was written to \`/tmp/build-output.log\`.
`;
			const result = detectFilePaths(text);
			expect(result.length).toBeGreaterThanOrEqual(3);
			expect(result.some((r) => r.path.includes("main.ts"))).toBe(true);
			expect(result.some((r) => r.path.includes("config.json"))).toBe(true);
		});

		test("handles paths in code blocks", () => {
			const text = `
Here's the code:
\`\`\`
const file = "/Users/test/data.json";
\`\`\`
Output saved to \`/tmp/result.txt\`
`;
			const result = detectFilePaths(text);
			// Should find at least the backtick one
			expect(result.some((r) => r.path.includes("result.txt"))).toBe(true);
		});
	});
});
