/**
 * Lightweight event emitter for decoupling modules.
 * Eliminates circular dependencies between session and utils.
 */

type EventCallback<T> = (data: T) => void;

interface BotEventsMap {
	sessionRunning: boolean;
	stopRequested: undefined;
	interruptRequested: undefined;
	queryFinished: undefined;
}

class BotEventEmitter {
	private listeners = new Map<
		keyof BotEventsMap,
		Set<EventCallback<unknown>>
	>();
	private sessionRunning = false;

	on<K extends keyof BotEventsMap>(
		event: K,
		callback: EventCallback<BotEventsMap[K]>,
	): () => void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)?.add(callback as EventCallback<unknown>);

		return () => {
			this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
		};
	}

	emit<K extends keyof BotEventsMap>(event: K, data: BotEventsMap[K]): void {
		if (event === "sessionRunning") {
			this.sessionRunning = data as boolean;
		}

		const callbacks = this.listeners.get(event);
		if (callbacks) {
			for (const callback of callbacks) {
				try {
					callback(data);
				} catch (error) {
					console.error(`Event handler error for ${event}:`, error);
				}
			}
		}
	}

	getSessionState(): boolean {
		return this.sessionRunning;
	}
}

export const botEvents = new BotEventEmitter();
