import { createInterface } from "node:readline";
import process from "node:process";

console.log = (...args) => {
	process.stderr.write(`${args.join(" ")}\n`);
};
console.info = console.log;
console.warn = console.log;

let Codex;
try {
	({ Codex } = await import("@openai/codex-sdk"));
} catch (error) {
	process.stderr.write(`Failed to load @openai/codex-sdk: ${error}\n`);
	process.exit(1);
}

const codex = new Codex();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let handled = false;
rl.on("line", async (line) => {
	if (handled || !line.trim()) return;
	handled = true;
	try {
		const request = JSON.parse(line);
		if (request.cwd) {
			process.chdir(request.cwd);
		}

		const prompt = request.prompt;
		if (!prompt) {
			throw new Error("Missing prompt");
		}

		const threadOptions = {
			workingDirectory: request.cwd,
			skipGitRepoCheck: true,
		};
		const thread = request.threadId
			? codex.resumeThread(request.threadId, threadOptions)
			: codex.startThread(threadOptions);

		const { events } = await thread.runStreamed(prompt);
		for await (const event of events) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
		process.exit(0);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({
				type: "error",
				message: String(error),
			})}\n`,
		);
		process.exit(1);
	}
});
