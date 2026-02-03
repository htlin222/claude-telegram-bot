/**
 * Git worktree helpers.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type WorktreeResult =
	| {
			success: true;
			branch: string;
			path: string;
			reused: boolean;
			message: string;
	  }
	| {
			success: false;
			message: string;
	  };

export type BranchListResult =
	| {
			success: true;
			branches: string[];
			current: string | null;
			repoRoot: string;
	  }
	| {
			success: false;
			message: string;
	  };

export function sanitizeWorktreeName(branch: string): string {
	return branch
		.trim()
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

async function execGit(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd });
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});

		proc.on("error", (err) => {
			resolve({ stdout, stderr: err.message, exitCode: 1 });
		});
	});
}

async function getRepoRoot(cwd: string): Promise<string | null> {
	const result = await execGit(["rev-parse", "--show-toplevel"], cwd);
	if (result.exitCode !== 0) {
		return null;
	}
	return result.stdout.trim() || null;
}

async function getWorktreeMap(repoRoot: string): Promise<Map<string, string>> {
	const result = await execGit(["worktree", "list", "--porcelain"], repoRoot);
	if (result.exitCode !== 0) {
		return new Map();
	}

	const map = new Map<string, string>();
	const lines = result.stdout.split("\n");
	let currentPath: string | null = null;
	let currentBranch: string | null = null;

	for (const line of lines) {
		if (line.startsWith("worktree ")) {
			currentPath = line.slice("worktree ".length).trim();
			currentBranch = null;
			continue;
		}
		if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			const prefix = "refs/heads/";
			currentBranch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
			continue;
		}
		if (line.trim() === "") {
			if (currentPath && currentBranch) {
				map.set(currentBranch, currentPath);
			}
			currentPath = null;
			currentBranch = null;
		}
	}

	if (currentPath && currentBranch) {
		map.set(currentBranch, currentPath);
	}

	return map;
}

async function branchExists(
	repoRoot: string,
	branch: string,
): Promise<boolean> {
	const result = await execGit(
		["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
		repoRoot,
	);
	return result.exitCode === 0;
}

export async function listBranches(cwd: string): Promise<BranchListResult> {
	const repoRoot = await getRepoRoot(cwd);
	if (!repoRoot) {
		return { success: false, message: "Not inside a git repository." };
	}

	const currentResult = await execGit(["branch", "--show-current"], repoRoot);
	const current =
		currentResult.exitCode === 0 ? currentResult.stdout.trim() || null : null;

	const listResult = await execGit(
		["branch", "--format=%(refname:short)"],
		repoRoot,
	);
	if (listResult.exitCode !== 0) {
		return {
			success: false,
			message: listResult.stderr.trim() || "Failed to list branches.",
		};
	}

	const branches = listResult.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	return { success: true, branches, current, repoRoot };
}

export type MergeInfo =
	| {
			success: true;
			currentBranch: string;
			mainBranch: string;
			mainWorktreePath: string;
			repoRoot: string;
	  }
	| {
			success: false;
			message: string;
	  };

async function getMainBranch(repoRoot: string): Promise<string | null> {
	// Check for main first, then master
	for (const branch of ["main", "master"]) {
		const exists = await branchExists(repoRoot, branch);
		if (exists) {
			return branch;
		}
	}
	return null;
}

/**
 * Get merge info: current branch, main branch, and main worktree path.
 * Used by /merge command.
 */
export async function getMergeInfo(cwd: string): Promise<MergeInfo> {
	const repoRoot = await getRepoRoot(cwd);
	if (!repoRoot) {
		return { success: false, message: "Not inside a git repository." };
	}

	// Get current branch
	const currentResult = await execGit(["branch", "--show-current"], repoRoot);
	const currentBranch =
		currentResult.exitCode === 0 ? currentResult.stdout.trim() : null;

	if (!currentBranch) {
		return { success: false, message: "Not on a branch (detached HEAD)." };
	}

	// Find main/master
	const mainBranch = await getMainBranch(repoRoot);
	if (!mainBranch) {
		return { success: false, message: "No main or master branch found." };
	}

	if (currentBranch === mainBranch) {
		return { success: false, message: `Already on ${mainBranch} branch.` };
	}

	// Find or determine main worktree path
	const worktreeMap = await getWorktreeMap(repoRoot);
	const mainWorktreePath = worktreeMap.get(mainBranch) ?? repoRoot;

	return {
		success: true,
		currentBranch,
		mainBranch,
		mainWorktreePath,
		repoRoot,
	};
}

export async function createOrReuseWorktree(
	cwd: string,
	branch: string,
): Promise<WorktreeResult> {
	const trimmed = branch.trim();
	if (!trimmed) {
		return { success: false, message: "Branch name cannot be empty." };
	}

	const repoRoot = await getRepoRoot(cwd);
	if (!repoRoot) {
		return { success: false, message: "Not inside a git repository." };
	}

	const worktreeMap = await getWorktreeMap(repoRoot);
	const existing = worktreeMap.get(trimmed);
	if (existing) {
		return {
			success: true,
			branch: trimmed,
			path: existing,
			reused: true,
			message: `Using existing worktree for ${trimmed}.`,
		};
	}

	const folderName = sanitizeWorktreeName(trimmed);
	if (!folderName) {
		return {
			success: false,
			message: "Branch name results in an invalid worktree path.",
		};
	}

	const baseDir = resolve(repoRoot, "..", "worktree");
	mkdirSync(baseDir, { recursive: true });

	const targetPath = join(baseDir, folderName);
	const exists = await branchExists(repoRoot, trimmed);
	const args = exists
		? ["worktree", "add", targetPath, trimmed]
		: ["worktree", "add", "-b", trimmed, targetPath];

	const addResult = await execGit(args, repoRoot);
	if (addResult.exitCode !== 0) {
		return {
			success: false,
			message: addResult.stderr.trim() || "Failed to create git worktree.",
		};
	}

	return {
		success: true,
		branch: trimmed,
		path: targetPath,
		reused: false,
		message: `Created worktree for ${trimmed}.`,
	};
}
