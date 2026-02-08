/**
 * Unit tests for file request detection in formatting module.
 */

import { describe, expect, test } from "bun:test";
import { detectFileRequest } from "../formatting";

describe("detectFileRequest", () => {
	describe("Chinese patterns", () => {
		test("detects '把檔案給我看'", () => {
			expect(detectFileRequest("把檔案給我看")).toBe(true);
		});

		test("detects '把這個檔案給我'", () => {
			expect(detectFileRequest("把這個檔案給我")).toBe(true);
		});

		test("detects '檔案給我看下'", () => {
			expect(detectFileRequest("檔案給我看下")).toBe(true);
		});

		test("detects '給我那個檔案'", () => {
			expect(detectFileRequest("給我那個檔案")).toBe(true);
		});

		test("detects '傳檔案給我'", () => {
			expect(detectFileRequest("傳檔案給我")).toBe(true);
		});

		test("detects '下載檔案'", () => {
			expect(detectFileRequest("下載檔案")).toBe(true);
		});

		test("detects '看檔案'", () => {
			expect(detectFileRequest("看檔案")).toBe(true);
		});

		test("detects '檔案看一下'", () => {
			expect(detectFileRequest("檔案看一下")).toBe(true);
		});
	});

	describe("English patterns", () => {
		test("detects 'send me the file'", () => {
			expect(detectFileRequest("send me the file")).toBe(true);
		});

		test("detects 'Send me the files'", () => {
			expect(detectFileRequest("Send me the files")).toBe(true);
		});

		test("detects 'show me the file'", () => {
			expect(detectFileRequest("show me the file")).toBe(true);
		});

		test("detects 'give me the file'", () => {
			expect(detectFileRequest("give me the file")).toBe(true);
		});

		test("detects 'download the file'", () => {
			expect(detectFileRequest("download the file")).toBe(true);
		});

		test("detects 'get the file'", () => {
			expect(detectFileRequest("get the file")).toBe(true);
		});

		test("detects 'can i see the file'", () => {
			expect(detectFileRequest("can i see the file")).toBe(true);
		});

		test("detects 'let me see the file'", () => {
			expect(detectFileRequest("let me see the file")).toBe(true);
		});

		test("detects 'i want the file'", () => {
			expect(detectFileRequest("i want the file")).toBe(true);
		});

		test("detects 'i need the file'", () => {
			expect(detectFileRequest("i need the file")).toBe(true);
		});

		test("detects 'file please'", () => {
			expect(detectFileRequest("file please")).toBe(true);
		});

		test("detects 'files pls'", () => {
			expect(detectFileRequest("files pls")).toBe(true);
		});

		test("detects without 'the' article", () => {
			expect(detectFileRequest("send me file")).toBe(true);
			expect(detectFileRequest("show me files")).toBe(true);
		});

		test("is case insensitive", () => {
			expect(detectFileRequest("SEND ME THE FILE")).toBe(true);
			expect(detectFileRequest("Show Me The File")).toBe(true);
		});
	});

	describe("negative cases", () => {
		test("does not detect unrelated text", () => {
			expect(detectFileRequest("hello world")).toBe(false);
			expect(detectFileRequest("how are you")).toBe(false);
			expect(detectFileRequest("what is the weather")).toBe(false);
		});

		test("does not detect 'file' in other contexts", () => {
			expect(detectFileRequest("I need to file a report")).toBe(false);
			expect(detectFileRequest("the nail file is broken")).toBe(false);
		});

		test("does not detect '檔案' in other contexts", () => {
			expect(detectFileRequest("檔案管理系統")).toBe(false);
			expect(detectFileRequest("這是一個檔案")).toBe(false);
		});

		test("handles empty string", () => {
			expect(detectFileRequest("")).toBe(false);
		});
	});

	describe("mixed language and context", () => {
		test("detects in sentences with context", () => {
			expect(detectFileRequest("Can you send me the file you mentioned?")).toBe(
				true,
			);
			expect(detectFileRequest("I'd like to see the files please")).toBe(true);
			expect(detectFileRequest("請把剛才的檔案給我看一下")).toBe(true);
		});

		test("detects with extra whitespace", () => {
			expect(detectFileRequest("  send me the file  ")).toBe(true);
			expect(detectFileRequest("把檔案給我  ")).toBe(true);
		});
	});
});
