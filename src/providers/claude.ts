/**
 * Claude provider implementation using the Agent SDK V1.
 */

import {
	query,
	type Options,
	type Query,
	type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentProvider } from "./types";

export type ClaudeOptions = Options;
export type ClaudeQuery = Query;
export type ClaudeSDKMessage = SDKMessage;

export class ClaudeProvider
	implements AgentProvider<SDKMessage, Options, Query>
{
	readonly id = "claude";

	createQuery(args: {
		prompt: string;
		options: Options;
		abortController: AbortController;
	}): Query {
		const { prompt, options, abortController } = args;
		return query({
			prompt,
			options: {
				...options,
				abortController,
			},
		});
	}
}
