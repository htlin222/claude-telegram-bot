import Database from "better-sqlite3";
import { Glob } from "bun";
import { stat } from "fs/promises";
import { existsSync } from "fs";
import type { FSWatcher } from "chokidar";
import chokidar from "chokidar";

export interface FileRecord {
	path: string;
	mtime: number;
	size: number;
	last_accessed: number;
}

export interface IndexStats {
	totalFiles: number;
	dbSize: string;
	lastUpdate: string;
}

export class FileIndexer {
	private db: Database.Database;
	private dbPath: string;
	private watcher: FSWatcher | null = null;
	private isWatching = false;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
		this.db = new Database(dbPath);
		this.init();
	}

	private init() {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime INTEGER,
        size INTEGER,
        last_accessed INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_accessed ON files(last_accessed DESC);

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
	}

	/**
	 * Rebuild the entire file index from scratch
	 */
	async rebuildIndex(allowedPaths: string[]): Promise<void> {
		const startTime = Date.now();

		// Clear existing data
		this.db.prepare("DELETE FROM files").run();

		// Prepare insert statement
		const insert = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, mtime, size, last_accessed)
      VALUES (?, ?, ?, 0)
    `);

		let totalFiles = 0;

		for (const basePath of allowedPaths) {
			if (!existsSync(basePath)) {
				console.warn(`⚠️  Skipping non-existent path: ${basePath}`);
				continue;
			}

			try {
				// Scan all files in this path using Bun's Glob
				const glob = new Glob("**/*");
				const files: string[] = [];

				for await (const file of glob.scan({
					cwd: basePath,
					onlyFiles: true,
				})) {
					const fullPath = `${basePath}/${file}`;

					// Skip ignored patterns
					if (
						file.includes("node_modules/") ||
						file.includes("/.git/") ||
						file.includes("/dist/") ||
						file.includes("/build/") ||
						file.endsWith(".log") ||
						file.startsWith(".")
					) {
						continue;
					}

					files.push(fullPath);
				}

				// Batch insert with transaction for better performance
				const insertMany = this.db.transaction((filePaths: string[]) => {
					for (const filePath of filePaths) {
						try {
							const stats = Bun.file(filePath);
							if (stats.size !== undefined) {
								insert.run(filePath, Date.now(), stats.size);
								totalFiles++;
							}
						} catch (err) {
							// Skip files that can't be accessed
							console.warn(`⚠️  Could not index: ${filePath}`);
						}
					}
				});

				insertMany(files);
			} catch (err) {
				console.error(`❌ Error scanning ${basePath}:`, err);
			}
		}

		// Update metadata
		const elapsed = Date.now() - startTime;
		this.db
			.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
			.run("last_rebuild", new Date().toISOString());
		this.db
			.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
			.run("total_files", totalFiles.toString());

		console.log(`✅ Indexed ${totalFiles} files in ${elapsed}ms`);
	}

	/**
	 * Search for files by path pattern
	 */
	search(query: string, limit = 10): FileRecord[] {
		const results = this.db
			.prepare(
				`
      SELECT path, mtime, size, last_accessed
      FROM files
      WHERE path LIKE ?
      ORDER BY last_accessed DESC, path
      LIMIT ?
    `,
			)
			.all(`%${query}%`, limit) as FileRecord[];

		return results;
	}

	/**
	 * Update last accessed time for a file
	 */
	markAccessed(path: string): void {
		this.db
			.prepare("UPDATE files SET last_accessed = ? WHERE path = ?")
			.run(Date.now(), path);
	}

	/**
	 * Update a single file in the index
	 */
	async updateFile(path: string): Promise<void> {
		try {
			const stats = await stat(path);
			this.db
				.prepare(
					`
        INSERT OR REPLACE INTO files (path, mtime, size, last_accessed)
        VALUES (?, ?, ?, COALESCE((SELECT last_accessed FROM files WHERE path = ?), 0))
      `,
				)
				.run(path, stats.mtimeMs, stats.size, path);
		} catch (err) {
			console.warn(`⚠️  Could not update file: ${path}`);
		}
	}

	/**
	 * Remove a file from the index
	 */
	removeFile(path: string): void {
		this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
	}

	/**
	 * Get index statistics
	 */
	getStats(): IndexStats {
		const totalFiles = (
			this.db.prepare("SELECT COUNT(*) as count FROM files").get() as {
				count: number;
			}
		).count;

		const dbSizeBytes = existsSync(this.dbPath)
			? Bun.file(this.dbPath).size || 0
			: 0;
		const dbSize = this.formatBytes(dbSizeBytes);

		const lastUpdate =
			(
				this.db
					.prepare("SELECT value FROM metadata WHERE key = 'last_rebuild'")
					.get() as { value: string } | undefined
			)?.value || "Never";

		return {
			totalFiles,
			dbSize,
			lastUpdate,
		};
	}

	/**
	 * Get recently accessed files
	 */
	getRecentFiles(limit = 10): FileRecord[] {
		return this.db
			.prepare(
				`
      SELECT path, mtime, size, last_accessed
      FROM files
      WHERE last_accessed > 0
      ORDER BY last_accessed DESC
      LIMIT ?
    `,
			)
			.all(limit) as FileRecord[];
	}

	/**
	 * Start watching files for changes
	 */
	startWatching(allowedPaths: string[]): void {
		if (this.isWatching) {
			console.log("⚠️  File watcher already running");
			return;
		}

		// Filter out non-existent paths
		const validPaths = allowedPaths.filter((p) => existsSync(p));

		if (validPaths.length === 0) {
			console.warn("⚠️  No valid paths to watch");
			return;
		}

		this.watcher = chokidar.watch(validPaths, {
			ignored: [
				/(^|[\/\\])\../, // dotfiles
				/node_modules/,
				/\.git/,
				/dist/,
				/build/,
				/\.log$/,
			],
			persistent: true,
			ignoreInitial: true, // Don't trigger for existing files
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100,
			},
		});

		this.watcher
			.on("add", (path: string) => {
				console.log(`📝 File added: ${path}`);
				this.updateFile(path).catch((err) =>
					console.error(`Failed to index new file ${path}:`, err),
				);
			})
			.on("change", (path: string) => {
				console.log(`📝 File changed: ${path}`);
				this.updateFile(path).catch((err) =>
					console.error(`Failed to update file ${path}:`, err),
				);
			})
			.on("unlink", (path: string) => {
				console.log(`🗑️  File deleted: ${path}`);
				this.removeFile(path);
			})
			.on("error", (error: unknown) => {
				console.error("File watcher error:", error);
			});

		this.isWatching = true;
		console.log(
			`👀 Watching ${validPaths.length} directories for file changes`,
		);
	}

	/**
	 * Stop watching files
	 */
	async stopWatching(): Promise<void> {
		if (this.watcher) {
			await this.watcher.close();
			this.watcher = null;
			this.isWatching = false;
			console.log("🛑 File watcher stopped");
		}
	}

	/**
	 * Check if file watcher is active
	 */
	isWatcherActive(): boolean {
		return this.isWatching;
	}

	/**
	 * Close the database connection and stop watcher
	 */
	async close(): Promise<void> {
		await this.stopWatching();
		this.db.close();
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
	}
}
