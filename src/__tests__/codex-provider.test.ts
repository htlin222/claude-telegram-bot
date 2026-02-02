import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CodexProvider } from "../providers/codex";

function createMockSpawn(events: Array<Record<string, unknown>>) {
	return function spawnMock(): ChildProcess {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const stdin = new PassThrough();
		const child = new EventEmitter() as ChildProcess & {
			stdout: PassThrough;
			stderr: PassThrough;
			stdin: PassThrough;
			exitCode: number | null;
			kill: (signal?: NodeJS.Signals) => boolean;
		};

		child.stdout = stdout;
		child.stderr = stderr;
		child.stdin = stdin;
		child.exitCode = null;
		child.kill = () => {
			child.exitCode = 143;
			stdout.end();
			stderr.end();
			child.emit("exit", 143);
			return true;
		};

		queueMicrotask(() => {
			for (const event of events) {
				stdout.write(`${JSON.stringify(event)}\n`);
			}
			stdout.end();
			child.exitCode = 0;
			child.emit("exit", 0);
		});

		return child;
	};
}

describe("CodexProvider", () => {
	test("streams text, thinking, tools, and result usage", async () => {
		const events: Array<Record<string, unknown>> = [
			{ type: "thread.started", thread_id: "thread-123" },
			{ type: "item.started", item: { id: "r1", type: "reasoning", text: "Thinking..." } },
			{ type: "item.completed", item: { id: "r1", type: "reasoning", text: "Thinking..." } },
			{ type: "item.started", item: { id: "m1", type: "agent_message", text: "Hello" } },
			{ type: "item.updated", item: { id: "m1", type: "agent_message", text: "Hello world" } },
			{
				type: "item.started",
				item: {
					id: "c1",
					type: "command_execution",
					command: "ls",
					aggregated_output: "",
					status: "in_progress",
				},
			},
			{
				type: "item.completed",
				item: {
					id: "c1",
					type: "command_execution",
					command: "ls",
					aggregated_output: "",
					status: "completed",
					exit_code: 0,
				},
			},
			{
				type: "item.completed",
				item: {
					id: "f1",
					type: "file_change",
					status: "completed",
					changes: [{ path: "/tmp/a.txt", kind: "update" }],
				},
			},
			{
				type: "item.completed",
				item: {
					id: "mcp1",
					type: "mcp_tool_call",
					server: "foo",
					tool: "bar",
					arguments: { q: 1 },
					status: "completed",
				},
			},
			{ type: "item.started", item: { id: "w1", type: "web_search", query: "test query" } },
			{
				type: "item.completed",
				item: {
					id: "t1",
					type: "todo_list",
					items: [{ text: "step", completed: false }],
				},
			},
			{
				type: "turn.completed",
				usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
			},
		];

		const provider = new CodexProvider({
			spawn: createMockSpawn(events) as unknown as typeof import("node:child_process").spawn,
			workerPath: "/tmp/codex-worker.js",
			nodePath: "node",
		});

		const query = provider.createQuery({
			prompt: "Hi",
			options: { cwd: "/tmp" } as never,
			abortController: new AbortController(),
		});

		const messages = [] as Array<Record<string, unknown>>;
		for await (const message of query) {
			messages.push(message as Record<string, unknown>);
		}

		const textBlocks = messages
			.filter((msg) => msg.type === "assistant")
			.flatMap((msg) => (msg.message as { content: Array<Record<string, unknown>> }).content)
			.filter((block) => block.type === "text")
			.map((block) => String(block.text));
		expect(textBlocks.join("")).toBe("Hello world");

		const thinkingBlocks = messages
			.filter((msg) => msg.type === "assistant")
			.flatMap((msg) => (msg.message as { content: Array<Record<string, unknown>> }).content)
			.filter((block) => block.type === "thinking")
			.map((block) => String(block.thinking));
		expect(thinkingBlocks.join("")).toContain("Thinking");

		const toolNames = messages
			.filter((msg) => msg.type === "assistant")
			.flatMap((msg) => (msg.message as { content: Array<Record<string, unknown>> }).content)
			.filter((block) => block.type === "tool_use")
			.map((block) => String(block.name));

		expect(toolNames).toContain("CodexBash");
		expect(toolNames).toContain("CodexFileChange");
		expect(toolNames).toContain("WebSearch");
		expect(toolNames).toContain("TodoWrite");
		expect(toolNames).toContain("mcp__foo__bar");

		const result = messages.find((msg) => msg.type === "result") as {
			usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
		};
		expect(result?.usage?.input_tokens).toBe(10);
		expect(result?.usage?.output_tokens).toBe(5);
		expect(result?.usage?.cache_read_input_tokens).toBe(2);
	});
});
