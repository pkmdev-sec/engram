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
	const result: KnowledgeEntry[] = [];

	for (const entry of entries) {
		const verified = buildVerificationState(entry, projectDir, now);

		// Exclude entries where every referenced file is gone — they are dead
		// knowledge. Entries with no files (topic-only) always pass through.
		if (entry.files.length > 0 && !verified.filesExist) {
			continue;
		}

		result.push({ ...entry, verified });
	}

	return result;
}

function buildVerificationState(
	entry: KnowledgeEntry,
	projectDir: string,
	now: string,
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
		const absolute = path.join(projectDir, filePath);

		if (fs.existsSync(absolute)) {
			anyExist = true;
		}

		if (wasModifiedSince(filePath, entry.timestamp, projectDir)) {
			anyModified = true;
		}
	}

	return {
		lastChecked: now,
		filesExist: anyExist,
		filesModified: anyModified,
	};
}

/**
 * Returns true if `git log` reports any commits touching `filePath` since
 * `since` (an ISO-8601 timestamp). Returns false on any error.
 */
function wasModifiedSince(
	filePath: string,
	since: string,
	projectDir: string,
): boolean {
	try {
		const output = execFileSync(
			"git",
			["log", `--since=${since}`, "--oneline", "--", filePath],
			{ cwd: projectDir, encoding: "utf8" },
		);
		return output.trim().length > 0;
	} catch {
		// git not available, not a git repo, or any other failure — treat as
		// unmodified rather than crashing the verification pass.
		return false;
	}
}
