import { execFileSync } from "node:child_process";
import type { InjectionConfig, KnowledgeEntry, RankedEntry } from "../types.js";

/**
 * Scores and ranks knowledge entries for injection into a session context.
 *
 * Scoring formula (weights sum to 1.0):
 *   score = relevance * 0.4 + recency * 0.3 + effectiveImportance * 0.2 + feedbackScore * 0.1
 *
 * Entries below `config.importanceThreshold` (after decay) are excluded before
 * scoring to avoid polluting results with stale low-value knowledge.
 */
export function rankEntries(
	entries: readonly KnowledgeEntry[],
	queryFiles: readonly string[],
	queryTopics: readonly string[],
	config: InjectionConfig,
): RankedEntry[] {
	const queryFileSet = new Set(queryFiles);
	const queryTopicSet = new Set(queryTopics);
	const sessionStart = queryFiles.length === 0 && queryTopics.length === 0;
	const now = Date.now();

	const ranked: RankedEntry[] = [];

	for (const entry of entries) {
		const ageInDays = (now - Date.parse(entry.timestamp)) / 86_400_000;
		const decayFactor = decayForAge(ageInDays, config);
		const effectiveImportance = entry.importance * decayFactor;

		if (effectiveImportance < config.importanceThreshold) {
			continue;
		}

		const relevance = sessionStart
			? 0.5
			: computeRelevance(entry, queryFileSet, queryTopicSet, queryFiles.length, queryTopics.length);

		const recency = Math.max(0, Math.min(1, 1 - ageInDays / 365));

		const score =
			relevance * 0.4 +
			recency * 0.3 +
			effectiveImportance * 0.2 +
			entry.feedbackScore * 0.1;

		ranked.push({
			entry,
			score,
			isStale: entry.verified?.filesModified === true,
			filesExist: entry.verified?.filesExist !== false,
		});
	}

	ranked.sort((a, b) => b.score - a.score);
	return ranked;
}

/**
 * Returns the decay multiplier for an entry based on its age.
 *
 * Age buckets match the injection config:
 *   > 90 days  → config.decayDays90
 *   > 30 days  → config.decayDays30
 *   ≤ 30 days  → 1.0 (no decay)
 */
function decayForAge(ageInDays: number, config: InjectionConfig): number {
	if (ageInDays > 90) return config.decayDays90;
	if (ageInDays > 30) return config.decayDays30;
	return 1.0;
}

/**
 * Computes a [0, 1] relevance score as the average of file-overlap and
 * topic-overlap fractions relative to the query (not the entry).
 *
 * Using query length as the denominator rewards entries that cover a large
 * fraction of *what was asked about*, not entries that merely have many files.
 */
function computeRelevance(
	entry: KnowledgeEntry,
	queryFileSet: ReadonlySet<string>,
	queryTopicSet: ReadonlySet<string>,
	queryFileCount: number,
	queryTopicCount: number,
): number {
	const fileOverlap = countIntersection(entry.files, queryFileSet) / Math.max(queryFileCount, 1);
	const topicOverlap =
		countIntersection(entry.topics, queryTopicSet) / Math.max(queryTopicCount, 1);
	return (fileOverlap + topicOverlap) / 2;
}

function countIntersection(
	items: readonly string[],
	querySet: ReadonlySet<string>,
): number {
	let count = 0;
	for (const item of items) {
		if (querySet.has(item)) count++;
	}
	return count;
}

/**
 * Returns relative file paths modified in the last `days` days via git log.
 * Falls back to an empty array if git is unavailable or the project isn't a repo.
 */
export function getRecentActivity(projectDir: string, days: number): string[] {
	try {
		const output = execFileSync(
			"git",
			["log", `--since=${days} days ago`, "--name-only", "--format=", "--", "."],
			{ cwd: projectDir, encoding: "utf8" },
		);
		const seen = new Set<string>();
		for (const line of output.split("\n")) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith(".")) seen.add(trimmed);
		}
		return [...seen];
	} catch {
		return [];
	}
}

/**
 * Derives topic keywords from a list of file paths by extracting
 * directory names and file stems. `src/auth/token.ts` → ["auth", "token"].
 * Filters out generic names that carry no topical signal.
 */
export function deriveTopicsFromFiles(files: readonly string[]): string[] {
	const NOISE = new Set([
		"src", "lib", "dist", "build", "test", "tests", "spec",
		"index", "main", "utils", "util", "helpers", "helper",
		"types", "config", "node_modules", "scripts",
	]);
	const topics = new Set<string>();
	for (const filePath of files) {
		const parts = filePath.split("/");
		for (const part of parts) {
			const stem = part.replace(/\.[^.]+$/, "").toLowerCase();
			if (stem.length > 2 && !NOISE.has(stem)) {
				topics.add(stem);
			}
		}
	}
	return [...topics];
}
