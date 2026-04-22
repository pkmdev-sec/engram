/**
 * Brain compaction: prunes stale/low-value entries and uses Sonnet to merge
 * overlapping entries. Keeps the brain bounded at maxEntriesPerProject.
 *
 * Two-phase approach:
 *   Phase 1 (deterministic, no LLM): delete expired, dead-file, low-importance,
 *           low-feedback entries.
 *   Phase 2 (LLM-assisted): send remaining entries to Sonnet for merge/dedup.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { CompactionConfig, InjectionConfig, KnowledgeEntry } from "../types.js";
import { callAnthropic } from "../api/anthropic.js";
import { isValidEntry } from "./brain-store.js";

interface CompactionResult {
	readonly before: number;
	readonly after: number;
	readonly pruned: number;
	readonly merged: number;
	readonly entries: KnowledgeEntry[];
}

/**
 * Run compaction on a set of entries.
 *
 * @param entries - All entries currently in the brain
 * @param projectDir - Project directory (for file existence checks)
 * @param compactionConfig - Compaction settings (model, thresholds)
 * @param injectionConfig - Injection settings (for decay calculations)
 * @returns Compacted entry set with stats
 */
export async function compact(
	entries: readonly KnowledgeEntry[],
	projectDir: string,
	compactionConfig: CompactionConfig,
	injectionConfig: InjectionConfig,
): Promise<CompactionResult> {
	const before = entries.length;

	// Phase 1: deterministic pruning
	const afterPrune = deterministicPrune(entries, projectDir, injectionConfig);
	const pruned = before - afterPrune.length;

	// Phase 2: LLM merge — only for entries without positive feedback.
	// Entries with positive feedback have proven their value through actual usage.
	// They are preserved exactly as-is and never sent to the LLM for rewriting.
	const proven = afterPrune.filter((e) => e.feedbackScore > 0);
	const unproven = afterPrune.filter((e) => e.feedbackScore <= 0);
	let final: KnowledgeEntry[];
	let merged = 0;

	if (unproven.length > 15) {
		const mergeResult = await llmMerge(unproven, projectDir, compactionConfig);
		final = [...proven, ...mergeResult.entries];
		merged = unproven.length - mergeResult.entries.length;
	} else {
		final = afterPrune;
	}

	// Cap at max
	if (final.length > compactionConfig.maxEntriesPerProject) {
		final = final
			.slice()
			.sort((a, b) => b.importance - a.importance)
			.slice(0, compactionConfig.maxEntriesPerProject);
	}

	return {
		before,
		after: final.length,
		pruned,
		merged: Math.max(0, merged),
		entries: final,
	};
}

/**
 * Phase 1: deterministic rules that don't need an LLM.
 */
function deterministicPrune(
	entries: readonly KnowledgeEntry[],
	projectDir: string,
	config: InjectionConfig,
): KnowledgeEntry[] {
	const now = Date.now();
	const projectFiles = listProjectFiles(projectDir);

	return entries.filter((entry) => {
		// Rule 1: delete expired entries
		if (entry.expiresAt) {
			const expiry = Date.parse(entry.expiresAt);
			if (!Number.isNaN(expiry) && expiry < now) return false;
		}

		// Rule 2: delete file-purpose and pattern entries where ALL files are gone
		if (
			(entry.category === "file-purpose" || entry.category === "pattern") &&
			entry.files.length > 0
		) {
			const anyFileExists = entry.files.some((f) => projectFiles.has(f));
			if (!anyFileExists) return false;
		}

		// Rule 3: delete entries with effective importance < 0.3
		const parsedTs = Date.parse(entry.timestamp);
		const ageInDays = Number.isNaN(parsedTs) ? 0 : (now - parsedTs) / 86_400_000;
		const decayFactor =
			ageInDays > 90
				? config.decayDays90
				: ageInDays > 30
					? config.decayDays30
					: 1.0;
		const effectiveImportance = entry.importance * decayFactor;
		if (effectiveImportance < 0.3) return false;

		// Rule 4: delete entries with consistently negative feedback
		if (entry.feedbackScore < -0.2) return false;

		return true;
	});
}

/**
 * Phase 2: send entries to Sonnet for intelligent merge/dedup.
 */
async function llmMerge(
	entries: KnowledgeEntry[],
	projectDir: string,
	config: CompactionConfig,
): Promise<{ entries: KnowledgeEntry[] }> {
	const projectFiles = listProjectFiles(projectDir);
	const fileList = [...projectFiles].slice(0, 200).join("\n");

	const entriesJson = JSON.stringify(
		entries.map((e) => ({
			id: e.id,
			category: e.category,
			summary: e.summary,
			reasoning: e.reasoning,
			confidence: e.confidence,
			files: e.files,
			topics: e.topics,
			importance: e.importance,
			feedbackScore: e.feedbackScore,
			timestamp: e.timestamp,
			expiresAt: e.expiresAt,
		})),
		null,
		2,
	);

	const system = `You are compacting a knowledge base for an AI coding agent. Your job is to reduce the number of entries while preserving all valuable information.

Rules:
1. Merge entries with overlapping files AND topics into single, more precise entries. Use the most recent timestamp.
2. When two entries contradict each other, keep ONLY the most recent one.
3. Remove entries that state things obvious from file names alone (e.g., "utils.ts contains utility functions").
4. PRESERVE all constraint and gotcha entries unless explicitly contradicted by a newer entry.
5. PRESERVE entries with high feedbackScore (>0.1) — the agent actively used them.
6. Combine reasoning fields when merging — keep the strongest reasoning.

Output a JSON array of compacted entries with the same schema as the input. For merged entries, set the id to the id of the most recent source entry. Do not invent new knowledge — only merge, deduplicate, or remove.

Output ONLY the JSON array, no markdown fences, no commentary.`;

	const user = `Compact these ${entries.length} knowledge entries.

Current project files (first 200):
${fileList}

Entries to compact:
${entriesJson}`;

	try {
		const response = await callAnthropic(config.model, system, user, 16384);
		const parsed = parseCompactionResponse(response);

		if (!Array.isArray(parsed)) {
			console.error("[compactor] Sonnet returned non-array, skipping LLM merge");
			console.error("[compactor] Response preview:", response.slice(0, 300));
			return { entries };
		}

		// Reconstruct full KnowledgeEntry objects from the LLM output
		// by matching IDs back to the originals and applying any merged summaries
		const entryMap = new Map(entries.map((e) => [e.id, e]));
		const result: KnowledgeEntry[] = [];

		for (const item of parsed) {
			const record = item as Record<string, unknown>;
			const id = record.id as string;
			const original = entryMap.get(id);

			if (original) {
				// Apply any changes from the LLM while preserving provenance
				const merged = {
					...original,
					summary: typeof record.summary === "string" ? record.summary : original.summary,
					reasoning:
						typeof record.reasoning === "string" ? record.reasoning : original.reasoning,
					importance:
						typeof record.importance === "number" ? record.importance : original.importance,
				};
				// Re-validate: LLM-rewritten summary/reasoning must pass poisoning checks
				if (isValidEntry(merged)) {
					result.push(merged);
				}
			}
		}

		return { entries: result.length > 0 ? result : entries };
	} catch (err) {
		console.error("[compactor] LLM merge failed, keeping entries as-is:", err);
		return { entries };
	}
}

function parseCompactionResponse(response: string): unknown {
	const trimmed = response.trim();

	// Direct parse
	try {
		return JSON.parse(trimmed);
	} catch {
		// Fall through
	}

	// Strip markdown fences
	const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
	if (fenceMatch) {
		try {
			return JSON.parse(fenceMatch[1].trim());
		} catch {
			// Fall through
		}
	}

	// Extract first JSON array from within text (Sonnet sometimes adds commentary)
	const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
	if (arrayMatch) {
		try {
			return JSON.parse(arrayMatch[0]);
		} catch {
			// Fall through
		}
	}

	return null;
}

/**
 * List all files in a project directory (relative paths), for checking
 * whether brain entry file references still exist.
 */
function listProjectFiles(projectDir: string): Set<string> {
	const files = new Set<string>();
	try {
		walk(projectDir, "", files, 0);
	} catch {
		// If we can't read the directory, return empty — entries won't be pruned for dead files
	}
	return files;
}

function walk(base: string, rel: string, out: Set<string>, depth: number): void {
	if (depth > 8) return; // Don't descend too deep
	const dir = rel ? join(base, rel) : base;

	let dirEntries: import("node:fs").Dirent[];
	try {
		dirEntries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
	} catch {
		return;
	}

	for (const entry of dirEntries) {
		const name = String(entry.name);
		if (name.startsWith(".") || name === "node_modules" || name === "dist") {
			continue;
		}
		const relPath = rel ? `${rel}/${name}` : name;
		if (entry.isFile()) {
			out.add(relPath);
		} else if (entry.isDirectory()) {
			walk(base, relPath, out, depth + 1);
		}
	}
}
