import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { BrainIndex, KnowledgeEntry } from "../types.js";

const POISONING_PATTERNS: readonly RegExp[] = [
    /\balways approve\b/i,
    /\bskip review\b/i,
    /\bignore warnings?\b/i,
    /\bdon'?t verify\b/i,
    /\bdo not verify\b/i,
    /\bbypass\b/i,
    /\bdisable check\b/i,
];

export function isValidEntry(entry: unknown): entry is KnowledgeEntry {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;

    // Required field checks
    if (typeof record.id !== "string") return false;
    if (typeof record.summary !== "string") return false;
    if (typeof record.reasoning !== "string") return false;
    if (typeof record.category !== "string") return false;
    if (typeof record.confidence !== "number") return false;
    if (typeof record.importance !== "number") return false;

    // Poisoning check on summary and reasoning
    for (const pattern of POISONING_PATTERNS) {
        if (pattern.test(record.summary as string)) return false;
        if (pattern.test(record.reasoning as string)) return false;
    }

    return true;
}

const BRAIN_FILE = "brain.jsonl";
const INDEX_FILE = "index.json";

/**
 * Persistent storage layer for a single project's knowledge base.
 *
 * Layout on disk:
 *   ~/.engram/projects/<projectId>/brain.jsonl  — one KnowledgeEntry per line
 *   ~/.engram/projects/<projectId>/index.json   — BrainIndex snapshot
 *
 * All I/O is synchronous. The brain is small (≤100 entries after compaction) and
 * synchronous reads/writes simplify integration with CLAUDE.md hook entry-points
 * that run in a blocking context.
 */
export class BrainStore {
	private readonly storageDir: string;
	private readonly brainPath: string;
	private readonly indexPath: string;

	constructor(projectId: string, basePath?: string) {
		this.storageDir = basePath
			? basePath
			: path.join(os.homedir(), ".engram", "projects", projectId);
		this.brainPath = path.join(this.storageDir, BRAIN_FILE);
		this.indexPath = path.join(this.storageDir, INDEX_FILE);

		fs.mkdirSync(this.storageDir, { recursive: true });
	}

	/** Absolute path to the project storage directory. */
	getStorageDir(): string {
		return this.storageDir;
	}

	/**
	 * Load all entries from brain.jsonl.
	 *
	 * Lines that are empty (e.g. trailing newline) are skipped. Lines that fail
	 * JSON parsing are also skipped rather than crashing — a partially-written
	 * tail line after an interrupted write should not destroy the whole store.
	 */
	loadEntries(): KnowledgeEntry[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.brainPath, "utf8");
		} catch (err: unknown) {
			if (isNodeError(err) && err.code === "ENOENT") return [];
			throw err;
		}

		const entries: KnowledgeEntry[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (isValidEntry(parsed)) {
					entries.push(parsed);
				}
				// else: silently skip invalid/poisoned entries (same as corrupt JSON)
			} catch {
				// Tolerate a corrupt tail line from an interrupted write.
			}
		}
		return entries;
	}

	/**
	 * Append entries to brain.jsonl without loading existing content.
	 *
	 * Each entry is written as a single JSON line followed by a newline character.
	 * Appending is atomic at the line level — the OS write syscall for a small
	 * JSON object will not be torn across lines on any POSIX filesystem.
	 */
	appendEntries(entries: readonly KnowledgeEntry[]): void {
		if (entries.length === 0) return;

		const payload = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		fs.appendFileSync(this.brainPath, payload, "utf8");
	}

	/**
	 * Overwrite brain.jsonl with the given entries.
	 *
	 * Used by compaction, which replaces the full store with a deduplicated,
	 * pruned set of entries. Writes to a temp file first, then renames into
	 * place — rename is atomic on POSIX filesystems, so a crash mid-write
	 * leaves the original file intact rather than truncated/empty.
	 */
	replaceEntries(entries: readonly KnowledgeEntry[]): void {
		const payload =
			entries.length > 0
				? entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
				: "";
		const tmpPath = this.brainPath + ".tmp";
		fs.writeFileSync(tmpPath, payload, "utf8");
		fs.renameSync(tmpPath, this.brainPath);
	}

	/**
	 * Update a single entry's feedbackScore in place.
	 *
	 * Delegates to updateFeedbackBatch. Prefer calling updateFeedbackBatch
	 * directly when updating multiple entries to avoid repeated I/O.
	 */
	updateFeedback(entryId: string, newScore: number): void {
		this.updateFeedbackBatch(new Map([[entryId, newScore]]));
	}

	/**
	 * Batch-update feedbackScores for multiple entries in a single
	 * read-modify-write cycle.
	 *
	 * Entries whose IDs don't match any key in `changes` are left untouched.
	 * If no matching entries are found, the file is not rewritten.
	 */
	updateFeedbackBatch(changes: ReadonlyMap<string, number>): void {
		if (changes.size === 0) return;

		const entries = this.loadEntries();
		let mutated = false;

		const updated = entries.map((entry) => {
			const newScore = changes.get(entry.id);
			if (newScore === undefined) return entry;
			mutated = true;
			return { ...entry, feedbackScore: newScore };
		});

		if (mutated) {
			this.replaceEntries(updated);
		}
	}

	/**
	 * Load the brain index from index.json, or return null if not yet built.
	 */
	loadIndex(): BrainIndex | null {
		let raw: string;
		try {
			raw = fs.readFileSync(this.indexPath, "utf8");
		} catch (err: unknown) {
			if (isNodeError(err) && err.code === "ENOENT") return null;
			throw err;
		}

		return JSON.parse(raw) as BrainIndex;
	}

	/**
	 * Persist the brain index to index.json.
	 */
	saveIndex(index: BrainIndex): void {
		fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2), "utf8");
	}

	/**
	 * Return the number of stored entries without parsing JSON for each line.
	 *
	 * Counts non-empty lines in brain.jsonl. This is O(file size) in I/O but
	 * avoids the JSON parse overhead of a full loadEntries() call — useful when
	 * the caller only needs to check the compaction threshold.
	 */
	entryCount(): number {
		let raw: string;
		try {
			raw = fs.readFileSync(this.brainPath, "utf8");
		} catch (err: unknown) {
			if (isNodeError(err) && err.code === "ENOENT") return 0;
			throw err;
		}

		return raw.split("\n").filter((line) => line.trim().length > 0).length;
	}
}

// -- Internal helpers --

interface NodeError extends Error {
	code: string;
}

function isNodeError(err: unknown): err is NodeError {
	return err instanceof Error && "code" in err;
}
