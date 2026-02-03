/**
 * Shared utilities for temporary file cleanup.
 * Extracted from handlers to avoid duplication.
 */

import { existsSync, unlinkSync } from "node:fs";

/**
 * Safely cleanup a single temporary file.
 * Logs errors but does not throw.
 *
 * @param filePath - Path to the temporary file to delete
 * @param silent - If true, suppress error logging (default: false)
 */
export function cleanupTempFile(filePath: string, silent = false): void {
	try {
		if (existsSync(filePath)) {
			unlinkSync(filePath);
		}
	} catch (error) {
		if (!silent) {
			console.warn(`Failed to cleanup temp file ${filePath}:`, error);
		}
	}
}

/**
 * Safely cleanup multiple temporary files.
 * Logs errors but does not throw.
 *
 * @param filePaths - Array of paths to temporary files to delete
 * @param silent - If true, suppress error logging (default: false)
 */
export function cleanupTempFiles(filePaths: string[], silent = false): void {
	for (const path of filePaths) {
		cleanupTempFile(path, silent);
	}
}

/**
 * Safely delete a file, ignoring errors if it doesn't exist.
 * Used for cleanup operations where failure is acceptable.
 *
 * @param filePath - Path to the file to delete
 * @returns true if file was deleted or didn't exist, false on error
 */
export function safeUnlink(filePath: string): boolean {
	try {
		if (existsSync(filePath)) {
			unlinkSync(filePath);
		}
		return true;
	} catch (error) {
		console.debug(`safeUnlink failed for ${filePath}:`, error);
		return false;
	}
}
