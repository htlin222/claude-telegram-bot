/**
 * Bookmarks management for Claude Telegram Bot.
 *
 * Stores and retrieves directory bookmarks.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const BOOKMARKS_FILE = "/tmp/claude-telegram-bookmarks.json";

export interface Bookmark {
	path: string;
	name: string;
	addedAt: string;
}

/**
 * Load bookmarks from file.
 */
export function loadBookmarks(): Bookmark[] {
	try {
		if (!existsSync(BOOKMARKS_FILE)) {
			return [];
		}
		const text = readFileSync(BOOKMARKS_FILE, "utf-8");
		const data = JSON.parse(text);
		return Array.isArray(data) ? data : [];
	} catch (error) {
		console.warn("Failed to load bookmarks:", error);
		return [];
	}
}

/**
 * Save bookmarks to file.
 */
export function saveBookmarks(bookmarks: Bookmark[]): void {
	try {
		writeFileSync(BOOKMARKS_FILE, JSON.stringify(bookmarks, null, 2));
	} catch (error) {
		console.error("Failed to save bookmarks:", error);
	}
}

/**
 * Add a bookmark.
 */
export function addBookmark(path: string): boolean {
	const bookmarks = loadBookmarks();

	// Resolve and normalize path
	const resolvedPath = resolvePath(path);

	// Check if already bookmarked
	if (bookmarks.some((b) => b.path === resolvedPath)) {
		return false;
	}

	// Extract name from path
	const name = resolvedPath.split("/").pop() || resolvedPath;

	bookmarks.push({
		path: resolvedPath,
		name,
		addedAt: new Date().toISOString(),
	});

	saveBookmarks(bookmarks);
	return true;
}

/**
 * Remove a bookmark by path.
 */
export function removeBookmark(path: string): boolean {
	const bookmarks = loadBookmarks();
	const resolvedPath = resolvePath(path);

	const index = bookmarks.findIndex((b) => b.path === resolvedPath);
	if (index === -1) {
		return false;
	}

	bookmarks.splice(index, 1);
	saveBookmarks(bookmarks);
	return true;
}

/**
 * Check if a path is bookmarked.
 */
export function isBookmarked(path: string): boolean {
	const bookmarks = loadBookmarks();
	const resolvedPath = resolvePath(path);
	return bookmarks.some((b) => b.path === resolvedPath);
}

/**
 * Resolve path with ~ expansion.
 */
export function resolvePath(path: string): string {
	const expanded = path.replace(/^~/, homedir());
	return resolve(expanded);
}
