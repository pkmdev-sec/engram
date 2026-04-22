import * as path from "node:path";

import type { BrainIndex, KnowledgeEntry } from "../types.js";

/**
 * Constructs an inverted index from a list of knowledge entries.
 *
 * Three lookup maps are built in a single pass:
 *   byTopic    — lowercased topic → entry IDs that carry that topic
 *   byFile     — file path        → entry IDs that reference that file
 *   byCategory — category name    → entry IDs in that category
 *
 * Topics are lowercased at index time so that queries don't need exact case.
 */
export function buildIndex(entries: readonly KnowledgeEntry[], projectId: string): BrainIndex {
	const byTopic: Record<string, string[]> = {};
	const byFile: Record<string, string[]> = {};
	const byCategory: Record<string, string[]> = {};

	for (const entry of entries) {
		for (const topic of entry.topics) {
			const key = topic.toLowerCase();
			(byTopic[key] ??= []).push(entry.id);
		}

		for (const file of entry.files) {
			(byFile[file] ??= []).push(entry.id);
		}

		(byCategory[entry.category] ??= []).push(entry.id);
	}

	return {
		projectId,
		lastUpdated: new Date().toISOString(),
		entryCount: entries.length,
		byTopic,
		byFile,
		byCategory,
	};
}

/**
 * Returns entry IDs matching ANY of the given files OR topics (union semantics).
 *
 * File matching: both exact path matches AND directory-prefix matches. An
 * entry tagged with `src/auth/token.ts` will match a query for any file
 * under `src/auth/` (e.g., `src/auth/middleware.ts`).
 *
 * Topic matching: case-insensitive (queries are lowercased before lookup
 * against the already-lowercased index keys).
 *
 * Deduplication is done via a Set so a single entry appearing under multiple
 * matching keys is reported only once.
 */
export function queryIndex(
	index: BrainIndex,
	files: readonly string[],
	topics: readonly string[],
): string[] {
	const matched = new Set<string>();

	for (const file of files) {
		// Exact match
		const exactIds = index.byFile[file];
		if (exactIds) {
			for (const id of exactIds) matched.add(id);
		}

		// Directory-prefix match: find entries whose files share a parent dir.
		// Only activates when the directory is at least 2 levels deep (e.g.,
		// src/auth) to avoid overly broad matches from top-level dirs like src/.
		const queryDir = path.dirname(file);
		if (queryDir && queryDir !== "." && queryDir.includes("/")) {
			const prefix = `${queryDir}/`;
			for (const indexedPath of Object.keys(index.byFile)) {
				if (indexedPath === file) continue;
				if (indexedPath.startsWith(prefix)) {
					const ids = index.byFile[indexedPath]!;
					for (const id of ids) matched.add(id);
				}
			}
		}
	}

	for (const topic of topics) {
		const key = topic.toLowerCase();
		const ids = index.byTopic[key];
		if (ids) {
			for (const id of ids) matched.add(id);
		}
	}

	return Array.from(matched);
}
