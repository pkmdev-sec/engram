import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeEntry, VerificationState } from "../types.js";

/**
 * Checks each entry against the current codebase on disk and in git history.
 *
 * Entries whose every referenced file has been deleted are excluded from the
 * returned array (they are no longer actionable). All other entries are
 * returned with an updated `verified` field reflecting the current state.
 *
 * Git availability is best-effort: if `git log` fails for any reason (not a
 * git repo, git not installed, detached HEAD, etc.) `filesModified` is set to
 * `false` rather than throwing.
 */
export function verifyEntries(
	entries: readonly KnowledgeEntry[],
	projectDir: string,
): KnowledgeEntry[] {
	const now = new Date().toISOString();

	// Find oldest entry timestamp for a single batched git query
	let oldestTimestamp = now;
	for (const entry of entries) {
		if (entry.timestamp < oldestTimestamp) {
			oldestTimestamp = entry.timestamp;
		}
	}

	// Single git call: get ALL files modified since oldest entry
	const modifiedFiles = getModifiedFilesSince(oldestTimestamp, projectDir);

	const result: KnowledgeEntry[] = [];
	for (const entry of entries) {
		const verified = buildVerificationState(entry, projectDir, now, modifiedFiles);

		// Exclude entries where every referenced file is gone — they are dead
		// knowledge. Entries with no files (topic-only) always pass through.
		if (entry.files.length > 0 && !verified.filesExist) {
			continue;
		}

		result.push({ ...entry, verified });
	}

	return result;
}

/**
 * Returns the set of all file paths touched by any commit since `oldestTimestamp`.
 * Uses a single `git log --name-only` call rather than one call per file.
 * Returns an empty Set on any error (git unavailable, not a repo, etc.).
 */
function getModifiedFilesSince(oldestTimestamp: string, projectDir: string): Set<string> {
	try {
		const output = execFileSync(
			"git",
			["log", "--name-only", "--format=", `--since=${oldestTimestamp}`, "--", "."],
			{ cwd: projectDir, encoding: "utf8" },
		);
		const files = new Set<string>();
		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) files.add(trimmed);
		}
		return files;
	} catch {
		return new Set();
	}
}

function buildVerificationState(
	entry: KnowledgeEntry,
	projectDir: string,
	now: string,
	modifiedFiles: ReadonlySet<string>,
): VerificationState {
	if (entry.files.length === 0) {
		// Nothing to check on disk — carry forward any prior filesModified signal
		// but reset lastChecked so callers know we visited this entry.
		return {
			lastChecked: now,
			filesExist: true,
			filesModified: entry.verified?.filesModified ?? false,
		};
	}

	let anyExist = false;
	let anyModified = false;

	for (const filePath of entry.files) {
		// Skip paths that attempt directory traversal outside the project
		if (filePath.includes("..")) continue;

		const absolute = path.join(projectDir, filePath);

		if (fs.existsSync(absolute)) {
			anyExist = true;
		}

		if (modifiedFiles.has(filePath)) {
			anyModified = true;
		}
	}

	return {
		lastChecked: now,
		filesExist: anyExist,
		filesModified: anyModified,
	};
}
