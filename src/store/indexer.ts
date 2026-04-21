import type { BrainIndex, KnowledgeEntry } from "../types.js";

/**
 * Constructs an inverted index from a list of knowledge entries.
 *
 * Three lookup maps are built in a single pass:
 *   byTopic    — topic string  → entry IDs that carry that topic
 *   byFile     — file path     → entry IDs that reference that file
 *   byCategory — category name → entry IDs in that category
 */
export function buildIndex(
	entries: readonly KnowledgeEntry[],
	projectId: string,
): BrainIndex {
	const byTopic: Record<string, string[]> = {};
	const byFile: Record<string, string[]> = {};
	const byCategory: Record<string, string[]> = {};

	for (const entry of entries) {
		for (const topic of entry.topics) {
			(byTopic[topic] ??= []).push(entry.id);
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
		const ids = index.byFile[file];
		if (ids) {
			for (const id of ids) matched.add(id);
		}
	}

	for (const topic of topics) {
		const ids = index.byTopic[topic];
		if (ids) {
			for (const id of ids) matched.add(id);
		}
	}

	return Array.from(matched);
}
