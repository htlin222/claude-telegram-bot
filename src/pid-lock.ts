/**
 * PID lock mechanism to prevent multiple bot instances from running simultaneously.
 *
 * When two instances poll the same Telegram bot token, both receive the same updates.
 * In-process deduplication can't help across processes, so we use a PID lock file
 * to ensure only one instance runs at a time.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Check if a process with the given PID is currently running.
 */
function isProcessAlive(pid: number): boolean {
	try {
		// signal 0 doesn't kill the process, just checks if it exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface PidLockResult {
	acquired: boolean;
	/** The PID of the existing process if lock was not acquired */
	existingPid?: number;
}

/**
 * Try to acquire a PID lock file.
 *
 * - If no lock file exists, writes the current PID and returns success.
 * - If a lock file exists with a dead process (stale lock), overwrites it.
 * - If a lock file exists with a live process, returns failure with the existing PID.
 */
export function acquirePidLock(lockPath: string): PidLockResult {
	const currentPid = process.pid;

	if (existsSync(lockPath)) {
		try {
			const content = readFileSync(lockPath, "utf-8").trim();
			const existingPid = Number.parseInt(content, 10);

			if (!Number.isNaN(existingPid) && existingPid > 0) {
				if (isProcessAlive(existingPid)) {
					return { acquired: false, existingPid };
				}
				// Stale lock from a dead process - take over
				console.log(
					`Removing stale PID lock (PID ${existingPid} is no longer running)`,
				);
			}
		} catch {
			// Corrupted lock file - overwrite it
			console.log("Removing corrupted PID lock file");
		}
	}

	writeFileSync(lockPath, String(currentPid), "utf-8");
	return { acquired: true };
}

/**
 * Release the PID lock file. Only removes it if it contains our own PID
 * (prevents accidentally removing a lock held by another process).
 */
export function releasePidLock(lockPath: string): void {
	try {
		if (!existsSync(lockPath)) return;

		const content = readFileSync(lockPath, "utf-8").trim();
		const lockedPid = Number.parseInt(content, 10);

		if (lockedPid === process.pid) {
			unlinkSync(lockPath);
		}
	} catch {
		// Best-effort cleanup
	}
}
