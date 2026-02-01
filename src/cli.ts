#!/usr/bin/env bun
/**
 * CLI entry point for ctb (Claude Telegram Bot)
 *
 * Usage:
 *   ctb              # Start bot using .env in current directory
 *   ctb --help       # Show usage
 *   ctb --version    # Show version
 *   ctb --token=xxx  # Override TELEGRAM_BOT_TOKEN
 *   ctb --users=123  # Override TELEGRAM_ALLOWED_USERS
 *   ctb --dir=/path  # Override working directory
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "1.0.0";

interface CliOptions {
	token?: string;
	users?: string;
	dir?: string;
	help?: boolean;
	version?: boolean;
	tut?: boolean;
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {};

	for (const arg of args) {
		if (arg === "--help" || arg === "-h") {
			options.help = true;
		} else if (arg === "--version" || arg === "-v") {
			options.version = true;
		} else if (arg === "tut" || arg === "tutorial") {
			options.tut = true;
		} else if (arg.startsWith("--token=")) {
			options.token = arg.slice(8);
		} else if (arg.startsWith("--users=")) {
			options.users = arg.slice(8);
		} else if (arg.startsWith("--dir=")) {
			options.dir = arg.slice(6);
		}
	}

	return options;
}

function showHelp(): void {
	console.log(`
ctb - Claude Telegram Bot

Run a Telegram bot that controls Claude Code in your project directory.

USAGE:
  ctb [options]
  ctb tut              Show setup tutorial

OPTIONS:
  --help, -h       Show this help message
  --version, -v    Show version
  --token=TOKEN    Override TELEGRAM_BOT_TOKEN from .env
  --users=IDS      Override TELEGRAM_ALLOWED_USERS (comma-separated)
  --dir=PATH       Override working directory (default: current directory)

ENVIRONMENT:
  Reads .env from current directory. Required variables:
    TELEGRAM_BOT_TOKEN      - Bot token from @BotFather
    TELEGRAM_ALLOWED_USERS  - Comma-separated Telegram user IDs

EXAMPLES:
  cd ~/my-project && ctb           # Start bot for this project
  ctb --dir=/path/to/project       # Start bot for specific directory
  ctb --token=xxx --users=123,456  # Override env vars

Multiple instances can run simultaneously in different directories.
`);
}

function showTutorial(): void {
	console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    CTB Setup Tutorial                            ║
╚══════════════════════════════════════════════════════════════════╝

Follow these steps to set up your Claude Telegram Bot:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1: Create a Telegram Bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open Telegram and search for @BotFather
2. Send /newbot
3. Follow the prompts:
   - Choose a name (e.g., "My Claude Bot")
   - Choose a username (must end in "bot", e.g., "my_claude_bot")
4. Copy the token that looks like:
   1234567890:ABCdefGHIjklMNOpqrsTUVwxyz

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2: Get Your Telegram User ID
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Open Telegram and search for @userinfobot
2. Send any message to it
3. It will reply with your user ID (a number like 123456789)
4. Copy this number

   Tip: Add multiple user IDs separated by commas for team access

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3: Configure the Bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Option A: Interactive setup (easiest)
  Just run: ctb
  It will prompt you for the token and user IDs.

Option B: Create a .env file
  Create a file named .env in your project directory:

  TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
  TELEGRAM_ALLOWED_USERS=123456789,987654321

Option C: Use command-line arguments
  ctb --token=YOUR_TOKEN --users=YOUR_USER_ID

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4: Set Up Bot Commands (Optional)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Go back to @BotFather
2. Send /setcommands
3. Select your bot
4. Paste this command list:

start - Show status and user ID
new - Start a fresh session
resume - Resume last session
stop - Interrupt current query
status - Check what Claude is doing
undo - Revert file changes
cd - Change working directory
file - Download a file
bookmarks - Manage directory bookmarks
retry - Retry last message
restart - Restart the bot

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5: Start the Bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  cd ~/your-project
  ctb

The bot will start and show "Bot started: @your_bot_username"
Open Telegram and message your bot to start using Claude!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Need help? https://github.com/htlin/claude-telegram-bot
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

async function prompt(question: string): Promise<string> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function loadEnvFile(dir: string): Record<string, string> {
	const envPath = resolve(dir, ".env");
	const env: Record<string, string> = {};

	if (!existsSync(envPath)) {
		return env;
	}

	const content = readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;

		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();

		// Remove quotes if present
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		env[key] = value;
	}

	return env;
}

function saveEnvFile(dir: string, env: Record<string, string>): void {
	const envPath = resolve(dir, ".env");
	const lines: string[] = [];

	// Preserve existing content
	if (existsSync(envPath)) {
		const existing = readFileSync(envPath, "utf-8");
		const existingKeys = new Set<string>();

		for (const line of existing.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				lines.push(line);
				continue;
			}

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex !== -1) {
				const key = trimmed.slice(0, eqIndex).trim();
				existingKeys.add(key);
				// Use new value if provided, otherwise keep original
				if (key in env) {
					lines.push(`${key}=${env[key]}`);
				} else {
					lines.push(line);
				}
			} else {
				lines.push(line);
			}
		}

		// Add new keys not in existing file
		for (const [key, value] of Object.entries(env)) {
			if (!existingKeys.has(key)) {
				lines.push(`${key}=${value}`);
			}
		}
	} else {
		// New file
		for (const [key, value] of Object.entries(env)) {
			lines.push(`${key}=${value}`);
		}
	}

	writeFileSync(envPath, `${lines.join("\n")}\n`);
}

async function interactiveSetup(
	dir: string,
	existingEnv: Record<string, string>,
): Promise<{ token: string; users: string }> {
	console.log(`\nNo .env found or missing required variables in ${dir}\n`);

	let token = existingEnv.TELEGRAM_BOT_TOKEN || "";
	let users = existingEnv.TELEGRAM_ALLOWED_USERS || "";

	if (!token) {
		console.log("Get a bot token from @BotFather on Telegram");
		token = await prompt("Enter TELEGRAM_BOT_TOKEN: ");
		if (!token) {
			console.error("Token is required");
			process.exit(1);
		}
	}

	if (!users) {
		console.log(
			"\nEnter your Telegram user ID(s). Find yours by messaging @userinfobot",
		);
		users = await prompt("Enter TELEGRAM_ALLOWED_USERS (comma-separated): ");
		if (!users) {
			console.error("At least one user ID is required");
			process.exit(1);
		}
	}

	// Ask to save
	const save = await prompt("\nSave to .env? (Y/n): ");
	if (save.toLowerCase() !== "n") {
		saveEnvFile(dir, {
			...existingEnv,
			TELEGRAM_BOT_TOKEN: token,
			TELEGRAM_ALLOWED_USERS: users,
		});
		console.log(`Saved to ${resolve(dir, ".env")}\n`);
	}

	return { token, users };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const options = parseArgs(args);

	if (options.help) {
		showHelp();
		process.exit(0);
	}

	if (options.version) {
		console.log(`ctb version ${VERSION}`);
		process.exit(0);
	}

	if (options.tut) {
		showTutorial();
		process.exit(0);
	}

	// Determine working directory
	const workingDir = options.dir ? resolve(options.dir) : process.cwd();

	// Load .env from working directory
	const envFile = loadEnvFile(workingDir);

	// Merge: CLI args > .env file > process.env
	let token =
		options.token ||
		envFile.TELEGRAM_BOT_TOKEN ||
		process.env.TELEGRAM_BOT_TOKEN ||
		"";
	let users =
		options.users ||
		envFile.TELEGRAM_ALLOWED_USERS ||
		process.env.TELEGRAM_ALLOWED_USERS ||
		"";

	// Interactive setup if missing required vars
	if (!token || !users) {
		const setup = await interactiveSetup(workingDir, envFile);
		token = token || setup.token;
		users = users || setup.users;
	}

	// Set environment variables for the bot
	process.env.TELEGRAM_BOT_TOKEN = token;
	process.env.TELEGRAM_ALLOWED_USERS = users;
	process.env.CLAUDE_WORKING_DIR = workingDir;

	// Pass through other env vars from .env file
	for (const [key, value] of Object.entries(envFile)) {
		if (!(key in process.env)) {
			process.env[key] = value;
		}
	}

	// Set CTB_INSTANCE_DIR for session isolation
	process.env.CTB_INSTANCE_DIR = workingDir;

	console.log(`\nStarting ctb in ${workingDir}...\n`);

	// Import and start the bot
	await import("./bot.js");
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
