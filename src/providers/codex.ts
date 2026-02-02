/**
 * Codex provider implementation via a Node.js worker using @openai/codex-sdk.
 *
 * Notes:
 * - Codex SDK requires Node.js 18+.
 * - We spawn a worker per query to avoid long-lived Node state in the Bun process.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentProvider } from "./types";
import type {
	ClaudeOptions as Options,
	ClaudeQuery as Query,
	ClaudeSDKMessage as SDKMessage,
} from "./claude";

type CodexThreadEvent =
	| { type: "thread.started"; thread_id: string }
	| { type: "turn.started" }
	| { type: "turn.completed"; usage: CodexUsage }
	| { type: "turn.failed"; error: CodexThreadError }
	| { type: "item.started"; item: CodexThreadItem }
	| { type: "item.updated"; item: CodexThreadItem }
	| { type: "item.completed"; item: CodexThreadItem }
	| { type: "error"; message: string };

type CodexUsage = {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
};

type CodexThreadError = {
	message: string;
};

type CodexThreadItem =
	| CodexAgentMessageItem
	| CodexReasoningItem
	| CodexCommandExecutionItem
	| CodexFileChangeItem
	| CodexMcpToolCallItem
	| CodexWebSearchItem
	| CodexTodoListItem
	| CodexErrorItem;

type CodexAgentMessageItem = {
	id: string;
	type: "agent_message";
	text: string;
};

type CodexReasoningItem = {
	id: string;
	type: "reasoning";
	text: string;
};

type CodexCommandExecutionItem = {
	id: string;
	type: "command_execution";
	command: string;
	aggregated_output: string;
	exit_code?: number;
	status: "in_progress" | "completed" | "failed";
};

type CodexFileChangeItem = {
	id: string;
	type: "file_change";
	changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
	status: "completed" | "failed";
};

type CodexMcpToolCallItem = {
	id: string;
	type: "mcp_tool_call";
	server: string;
	tool: string;
	arguments: unknown;
	result?: {
		content: unknown[];
		structured_content: unknown;
	};
	error?: {
		message: string;
	};
	status: "in_progress" | "completed" | "failed";
};

type CodexWebSearchItem = {
	id: string;
	type: "web_search";
	query: string;
};

type CodexTodoListItem = {
	id: string;
	type: "todo_list";
	items: Array<{ text: string; completed: boolean }>;
};

type CodexErrorItem = {
	id: string;
	type: "error";
	message: string;
};

export class CodexProvider implements AgentProvider<SDKMessage, Options, Query> {
	readonly id = "codex";
	private readonly spawnFn: typeof spawn;
	private readonly workerPathOverride?: string;
	private readonly nodePathOverride?: string;

	constructor(options?: {
		spawn?: typeof spawn;
		workerPath?: string;
		nodePath?: string;
	}) {
		this.spawnFn = options?.spawn ?? spawn;
		this.workerPathOverride = options?.workerPath;
		this.nodePathOverride = options?.nodePath;
	}

	createQuery(args: {
		prompt: string;
		options: Options;
		abortController: AbortController;
	}): Query {
		const iterator = this.runCodex(args);
		(iterator as Query).rewindFiles = async () => {
			throw new Error("Undo is not supported for the Codex provider.");
		};
		return iterator as Query;
	}

	private async *runCodex(args: {
		prompt: string;
		options: Options;
		abortController: AbortController;
	}): AsyncGenerator<SDKMessage, void, unknown> {
		const { prompt, options, abortController } = args;
		const workerPath =
			this.workerPathOverride ??
			fileURLToPath(new URL("./codex-worker.js", import.meta.url));
		const nodePath = this.nodePathOverride || process.env.CODEX_NODE_PATH || "node";

		const child = this.spawnFn(nodePath, [workerPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		const stderrChunks: string[] = [];
		child.stderr.on("data", (chunk) => {
			stderrChunks.push(String(chunk));
		});

		const onAbort = () => {
			child.kill("SIGTERM");
		};
		abortController.signal.addEventListener("abort", onAbort, { once: true });

		const request = {
			prompt,
			threadId: options.resume ?? null,
			cwd: options.cwd,
		};
		child.stdin.write(`${JSON.stringify(request)}\n`);
		child.stdin.end();

		const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
		let threadId: string | null =
			options.resume !== undefined ? String(options.resume) : null;
		let finalResponse = "";
		let sawTurnCompleted = false;
		const textByItemId = new Map<string, string>();
		const thinkingByItemId = new Map<string, string>();
		const toolStatusByItemId = new Map<string, string>();

		const toSDKMessage = (value: unknown): SDKMessage =>
			value as SDKMessage;

		const flushTextDelta = (
			itemId: string,
			text: string,
			type: "text" | "thinking",
		): SDKMessage | null => {
			if (!text) return null;
			const map = type === "text" ? textByItemId : thinkingByItemId;
			const prev = map.get(itemId) || "";
			const delta = text.startsWith(prev) ? text.slice(prev.length) : text;
			if (!delta) return null;
			map.set(itemId, text);
			if (type === "text") {
				finalResponse += delta;
				return toSDKMessage({
					type: "assistant",
					session_id: threadId || undefined,
					message: {
						content: [{ type: "text", text: delta }],
					},
				});
			}
			return toSDKMessage({
				type: "assistant",
				session_id: threadId || undefined,
				message: {
					content: [{ type: "thinking", thinking: delta }],
				},
			});
		};

		const emitToolUse = (
			toolName: string,
			toolInput: Record<string, unknown>,
		): SDKMessage => {
			return toSDKMessage({
				type: "assistant",
				session_id: threadId || undefined,
				message: {
					content: [
						{
							type: "tool_use",
							name: toolName,
							input: toolInput,
						},
					],
				},
			});
		};

		try {
			for await (const line of rl) {
				if (!line.trim()) continue;
				let event: CodexThreadEvent;
				try {
					event = JSON.parse(line) as CodexThreadEvent;
				} catch (error) {
					throw new Error(`Failed to parse Codex event: ${error}\n${line}`);
				}

				if (event.type === "thread.started") {
					threadId = event.thread_id;
					continue;
				}

				if (event.type === "turn.failed") {
					throw new Error(event.error?.message || "Codex turn failed.");
				}

				if (event.type === "error") {
					throw new Error(event.message || "Codex stream error.");
				}

				if (event.type === "turn.completed") {
					sawTurnCompleted = true;
					const usage = event.usage || {
						input_tokens: 0,
						output_tokens: 0,
						cached_input_tokens: 0,
					};
					yield {
						type: "result",
						session_id: threadId || undefined,
						usage: {
							input_tokens: usage.input_tokens ?? 0,
							output_tokens: usage.output_tokens ?? 0,
							cache_read_input_tokens: usage.cached_input_tokens ?? 0,
						},
					} as unknown as SDKMessage;
					continue;
				}

				if (
					event.type === "item.started" ||
					event.type === "item.updated" ||
					event.type === "item.completed"
				) {
					const item = event.item;
					switch (item.type) {
						case "agent_message": {
							const message = flushTextDelta(item.id, item.text, "text");
							if (message) yield message;
							break;
						}
						case "reasoning": {
							const message = flushTextDelta(item.id, item.text, "thinking");
							if (message) yield message;
							break;
						}
						case "command_execution": {
							if (
								event.type === "item.started" ||
								event.type === "item.completed"
							) {
								const statusKey = `${item.status}:${item.exit_code ?? ""}`;
								if (toolStatusByItemId.get(item.id) !== statusKey) {
									toolStatusByItemId.set(item.id, statusKey);
									yield emitToolUse("CodexBash", {
										command: item.command,
										status: item.status,
										exit_code: item.exit_code,
									});
								}
							}
							break;
						}
						case "file_change": {
							if (
								event.type === "item.started" ||
								event.type === "item.completed"
							) {
								const statusKey = `${item.status}:${item.changes.length}`;
								if (toolStatusByItemId.get(item.id) !== statusKey) {
									toolStatusByItemId.set(item.id, statusKey);
									yield emitToolUse("CodexFileChange", {
										status: item.status,
										changes: item.changes,
									});
								}
							}
							break;
						}
						case "mcp_tool_call": {
							if (
								event.type === "item.started" ||
								event.type === "item.completed"
							) {
								const statusKey = `${item.status}`;
								if (toolStatusByItemId.get(item.id) !== statusKey) {
									toolStatusByItemId.set(item.id, statusKey);
									yield emitToolUse(`mcp__${item.server}__${item.tool}`, {
										status: item.status,
										query: item.arguments,
										error: item.error?.message,
									});
								}
							}
							break;
						}
						case "web_search": {
							if (event.type === "item.started") {
								yield emitToolUse("WebSearch", {
									query: item.query,
								});
							}
							break;
						}
						case "todo_list": {
							if (event.type === "item.completed") {
								yield emitToolUse("TodoWrite", {
									items: item.items,
								});
							}
							break;
						}
						case "error": {
							const message = flushTextDelta(
								item.id,
								`⚠️ ${item.message}`,
								"text",
							);
							if (message) yield message;
							break;
						}
						default:
							break;
					}
				}
			}

			if (!sawTurnCompleted && finalResponse) {
				yield {
					type: "result",
					session_id: threadId || undefined,
				} as unknown as SDKMessage;
			}

			const exitCode =
				child.exitCode ??
				(await new Promise<number | null>((resolve) => {
					child.once("exit", (code) => resolve(code));
				}));
			if (exitCode && exitCode !== 0 && !abortController.signal.aborted) {
				throw new Error(
					`Codex worker exited with code=${exitCode}. ${stderrChunks.join("")}`,
				);
			}
		} finally {
			abortController.signal.removeEventListener("abort", onAbort);
			rl.close();
		}
	}
}
