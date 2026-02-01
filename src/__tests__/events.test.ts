/**
 * Unit tests for event emitter module.
 */

import { describe, expect, test } from "bun:test";
import { botEvents } from "../events";

describe("BotEvents", () => {
	test("emits and receives events", () => {
		let received = false;
		const unsubscribe = botEvents.on("sessionRunning", (running) => {
			received = running;
		});

		botEvents.emit("sessionRunning", true);
		expect(received).toBe(true);

		unsubscribe();
	});

	test("unsubscribe stops receiving events", () => {
		let count = 0;
		const unsubscribe = botEvents.on("sessionRunning", () => {
			count++;
		});

		botEvents.emit("sessionRunning", true);
		expect(count).toBe(1);

		unsubscribe();

		botEvents.emit("sessionRunning", true);
		expect(count).toBe(1);
	});

	test("getSessionState returns current state", () => {
		botEvents.emit("sessionRunning", false);
		expect(botEvents.getSessionState()).toBe(false);

		botEvents.emit("sessionRunning", true);
		expect(botEvents.getSessionState()).toBe(true);
	});
});
