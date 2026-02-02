/**
 * Provider abstraction for agent backends (Claude, Codex, etc.).
 */

export interface AgentQuery<TEvent>
	extends AsyncGenerator<TEvent, void, unknown> {
	/**
	 * Rewind tracked files to a prior user message checkpoint.
	 * Optional because not all providers support file checkpointing.
	 */
	rewindFiles?(userMessageId: string): Promise<void>;
}

export interface AgentProvider<TEvent, TOptions, TQuery extends AgentQuery<TEvent>> {
	readonly id: string;
	createQuery(args: {
		prompt: string;
		options: TOptions;
		abortController: AbortController;
	}): TQuery;
}
