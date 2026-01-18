/**
 * Unit tests for formatting module.
 */

import { describe, expect, test } from "bun:test";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";

describe("escapeHtml", () => {
	test("escapes ampersand", () => {
		expect(escapeHtml("a & b")).toBe("a &amp; b");
	});

	test("escapes less than", () => {
		expect(escapeHtml("a < b")).toBe("a &lt; b");
	});

	test("escapes greater than", () => {
		expect(escapeHtml("a > b")).toBe("a &gt; b");
	});

	test("escapes quotes", () => {
		expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
	});

	test("escapes multiple special characters", () => {
		expect(escapeHtml('<script>"alert"</script>')).toBe(
			"&lt;script&gt;&quot;alert&quot;&lt;/script&gt;",
		);
	});

	test("handles empty string", () => {
		expect(escapeHtml("")).toBe("");
	});

	test("returns unchanged text without special chars", () => {
		expect(escapeHtml("Hello World")).toBe("Hello World");
	});
});

describe("convertMarkdownToHtml", () => {
	test("converts bold with double asterisks", () => {
		expect(convertMarkdownToHtml("**bold**")).toBe("<b>bold</b>");
	});

	test("converts bold with single asterisks", () => {
		expect(convertMarkdownToHtml("*bold*")).toBe("<b>bold</b>");
	});

	test("converts bold with double underscores", () => {
		expect(convertMarkdownToHtml("__bold__")).toBe("<b>bold</b>");
	});

	test("converts italic with single underscores", () => {
		expect(convertMarkdownToHtml("_italic_")).toBe("<i>italic</i>");
	});

	test("converts inline code", () => {
		expect(convertMarkdownToHtml("`code`")).toBe("<code>code</code>");
	});

	test("converts code blocks", () => {
		const input = "```\nconst x = 1;\n```";
		expect(convertMarkdownToHtml(input)).toContain("<pre>");
		expect(convertMarkdownToHtml(input)).toContain("const x = 1;");
		expect(convertMarkdownToHtml(input)).toContain("</pre>");
	});

	test("converts code blocks with language hint", () => {
		const input = "```javascript\nconst x = 1;\n```";
		expect(convertMarkdownToHtml(input)).toContain("<pre>");
	});

	test("converts headers to bold", () => {
		expect(convertMarkdownToHtml("# Header")).toContain("<b>Header</b>");
		expect(convertMarkdownToHtml("## Header")).toContain("<b>Header</b>");
		expect(convertMarkdownToHtml("### Header")).toContain("<b>Header</b>");
	});

	test("converts links", () => {
		expect(convertMarkdownToHtml("[text](https://example.com)")).toBe(
			'<a href="https://example.com">text</a>',
		);
	});

	test("converts bullet lists", () => {
		expect(convertMarkdownToHtml("- item")).toBe("• item");
		expect(convertMarkdownToHtml("* item")).toBe("• item");
	});

	test("escapes HTML in regular text", () => {
		expect(convertMarkdownToHtml("<script>")).toBe("&lt;script&gt;");
	});

	test("escapes HTML inside code blocks", () => {
		const input = "```\n<div>test</div>\n```";
		const result = convertMarkdownToHtml(input);
		expect(result).toContain("&lt;div&gt;");
	});

	test("handles nested formatting", () => {
		// Bold inside text
		const input = "This is **bold** text";
		expect(convertMarkdownToHtml(input)).toBe("This is <b>bold</b> text");
	});

	test("collapses multiple newlines", () => {
		const input = "line1\n\n\n\nline2";
		expect(convertMarkdownToHtml(input)).toBe("line1\n\nline2");
	});

	test("handles empty string", () => {
		expect(convertMarkdownToHtml("")).toBe("");
	});

	test("handles plain text without markdown", () => {
		expect(convertMarkdownToHtml("Hello World")).toBe("Hello World");
	});
});
