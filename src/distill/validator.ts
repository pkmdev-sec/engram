/**
 * Validates raw distiller output before it is converted into KnowledgeEntries.
 *
 * Validation is defense-in-depth: the LLM prompt already enforces these rules,
 * but we re-enforce them programmatically to guard against model drift,
 * prompt injection that bypassed the system prompt, and format errors.
 */

import type { EntryCategory, KnowledgeEntry, RawDistillerEntry } from "../types.js";

const VALID_CATEGORIES: ReadonlySet<string> = new Set<EntryCategory>([
	"constraint",
	"architecture",
	"pattern",
	"gotcha",
	"dependency",
	"active-work",
	"file-purpose",
	"failed-approach",
]);

/**
 * Hedging phrases that indicate the LLM is uncertain. Entries containing these
 * are too speculative to store as authoritative project knowledge.
 *
 * Checked as whole-word / whole-phrase matches (case-insensitive) to avoid
 * false positives on partial matches.
 */
const HEDGING_PATTERNS: readonly RegExp[] = [
	/\bmaybe\b/i,
	/\bprobably\b/i,
	/\bperhaps\b/i,
	/\bpossibly\b/i,
	/\bmight\b/i,
	/\bcould be\b/i,
];

/**
 * Anti-poisoning: phrases that attempt to give future AI sessions blanket
 * permissions or instruct them to skip safety/review steps. These are the
 * hallmarks of a prompt-injection attack embedded in session content.
 */
const POISONING_PATTERNS: readonly RegExp[] = [
	/\balways approve\b/i,
	/\bskip review\b/i,
	/\bignore warnings?\b/i,
	/\bdon'?t verify\b/i,
	/\bdo not verify\b/i,
	/\bbypass\b/i,
	/\bdisable check\b/i,
];

/** Maximum number of entries the distiller is allowed to produce in one pass. */
const MAX_ENTRIES = 10;

/** Minimum character length for a summary to be considered substantive. */
const MIN_SUMMARY_LENGTH = 10;

/** Overlap ratio above which an entry is considered a near-duplicate. */
const DUPLICATE_OVERLAP_THRESHOLD = 0.65;

export interface ValidationResult {
	valid: RawDistillerEntry[];
	rejected: Array<{ entry: unknown; reason: string }>;
}

/**
 * Validates raw LLM output and returns the valid entries alongside rejection
 * records for every entry that failed validation.
 *
 * Validation order matters for the over-generation check: we collect all
 * individually-valid entries first, then apply the count cap last so that
 * the rejection reason accurately identifies the cap as the cause.
 */
export function validateDistillerOutput(
	raw: unknown,
	existingEntries: readonly KnowledgeEntry[],
): ValidationResult {
	if (!Array.isArray(raw)) {
		return {
			valid: [],
			rejected: [{ entry: raw, reason: "Input is not a JSON array" }],
		};
	}

	const valid: RawDistillerEntry[] = [];
	const rejected: Array<{ entry: unknown; reason: string }> = [];

	for (const item of raw) {
		const rejection = validateSingleEntry(item, valid, existingEntries);
		if (rejection !== null) {
			rejected.push({ entry: item, reason: rejection });
		} else {
			valid.push(item as RawDistillerEntry);
		}
	}

	// Over-generation check: applied after per-entry validation so entries
	// beyond the cap get a distinct rejection reason rather than being silently
	// dropped. We truncate valid and move the excess to rejected.
	if (valid.length > MAX_ENTRIES) {
		const excess = valid.splice(MAX_ENTRIES);
		for (const entry of excess) {
			rejected.push({
				entry,
				reason: `Over-generation cap: only ${MAX_ENTRIES} entries allowed per session, this entry was beyond the limit`,
			});
		}
	}

	return { valid, rejected };
}

/**
 * Validates a single candidate entry against all rules.
 *
 * @returns null if the entry is valid, or a rejection reason string.
 *
 * The `accumulating` parameter contains entries already accepted in this pass
 * so that duplicate detection can compare against both existing stored entries
 * and earlier entries in the same batch.
 */
function validateSingleEntry(
	item: unknown,
	accumulating: readonly RawDistillerEntry[],
	existingEntries: readonly KnowledgeEntry[],
): string | null {
	if (item === null || typeof item !== "object" || Array.isArray(item)) {
		return "Entry is not an object";
	}

	const record = item as Record<string, unknown>;

	// --- Required field presence and type checks ---

	if (!hasStringField(record, "category")) {
		return "Missing or invalid field: category (must be a string)";
	}
	if (!VALID_CATEGORIES.has(record.category as string)) {
		return `Invalid category "${record.category}": must be one of ${[...VALID_CATEGORIES].join(", ")}`;
	}

	if (!hasStringField(record, "summary")) {
		return "Missing or invalid field: summary (must be a string)";
	}
	const summary = record.summary as string;
	if (summary.length < MIN_SUMMARY_LENGTH) {
		return `Summary too short (${summary.length} chars, minimum ${MIN_SUMMARY_LENGTH})`;
	}

	if (!hasStringField(record, "reasoning")) {
		return "Missing or invalid field: reasoning (must be a string)";
	}
	if ((record.reasoning as string).trim().length === 0) {
		return "Field reasoning must not be empty";
	}

	if (!hasNumberField(record, "confidence")) {
		return "Missing or invalid field: confidence (must be a number)";
	}
	const confidence = record.confidence as number;
	if (confidence < 0 || confidence > 1) {
		return `confidence out of range: ${confidence} (must be 0.0–1.0)`;
	}

	if (!hasNumberField(record, "importance")) {
		return "Missing or invalid field: importance (must be a number)";
	}
	const importance = record.importance as number;
	if (importance < 0 || importance > 1) {
		return `importance out of range: ${importance} (must be 0.0–1.0)`;
	}

	if (!hasStringArrayField(record, "files")) {
		return "Missing or invalid field: files (must be a string array)";
	}

	if (!hasStringArrayField(record, "topics")) {
		return "Missing or invalid field: topics (must be a string array)";
	}

	// expiresAt is nullable — accept string or null only
	if (
		record.expiresAt !== null &&
		record.expiresAt !== undefined &&
		typeof record.expiresAt !== "string"
	) {
		return `Invalid field expiresAt: must be an ISO 8601 string or null, got ${typeof record.expiresAt}`;
	}

	const files = record.files as string[];
	const topics = record.topics as string[];

	// --- Semantic validation ---

	// Unfindable entry: no retrieval anchor at all
	if (files.length === 0 && topics.length === 0) {
		return "Entry has no files and no topics — it cannot be retrieved by any query";
	}

	// Hedging check on summary
	for (const pattern of HEDGING_PATTERNS) {
		if (pattern.test(summary)) {
			return `Summary contains hedging language matching /${pattern.source}/i — entries must state facts, not speculation`;
		}
	}

	// Anti-poisoning check on summary
	for (const pattern of POISONING_PATTERNS) {
		if (pattern.test(summary)) {
			return `Summary contains disallowed meta-instruction matching /${pattern.source}/i — potential prompt-injection attempt`;
		}
	}

	// Anti-poisoning check on reasoning (also injected into CLAUDE.md)
	const reasoning = record.reasoning as string;
	for (const pattern of POISONING_PATTERNS) {
		if (pattern.test(reasoning)) {
			return `Reasoning contains disallowed meta-instruction matching /${pattern.source}/i — potential prompt-injection attempt`;
		}
	}

	// Duplicate / near-duplicate check against stored entries
	for (const existing of existingEntries) {
		const overlap = wordOverlap(summary, existing.summary);
		if (overlap > DUPLICATE_OVERLAP_THRESHOLD) {
			return `Summary has ${(overlap * 100).toFixed(0)}% word overlap with existing entry ${existing.id} — too similar to store`;
		}
	}

	// Duplicate check against entries already accepted in this same batch
	for (const earlier of accumulating) {
		const overlap = wordOverlap(summary, earlier.summary);
		if (overlap > DUPLICATE_OVERLAP_THRESHOLD) {
			return `Summary has ${(overlap * 100).toFixed(0)}% word overlap with another entry in this batch — de-duplicated`;
		}
	}

	return null;
}

// --- Field type guards ---

function hasStringField(record: Record<string, unknown>, key: string): boolean {
	return typeof record[key] === "string";
}

function hasNumberField(record: Record<string, unknown>, key: string): boolean {
	return typeof record[key] === "number" && !Number.isNaN(record[key] as number);
}

function hasStringArrayField(record: Record<string, unknown>, key: string): boolean {
	return (
		Array.isArray(record[key]) &&
		(record[key] as unknown[]).every((el) => typeof el === "string")
	);
}

// --- Word overlap (Jaccard on word sets) ---

/**
 * Computes the Jaccard similarity between the word sets of two strings.
 *
 * Lowercases and splits on non-word characters. Short function words ("the",
 * "a", "is", etc.) are NOT filtered out — they are part of the signal for
 * detecting near-identical summaries, and filtering them would make evasion
 * easier.
 */
function wordOverlap(a: string, b: string): number {
	const wordsA = tokenize(a);
	const wordsB = tokenize(b);

	if (wordsA.size === 0 && wordsB.size === 0) return 1;
	if (wordsA.size === 0 || wordsB.size === 0) return 0;

	let intersectionSize = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersectionSize++;
	}

	const unionSize = wordsA.size + wordsB.size - intersectionSize;
	return intersectionSize / unionSize;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/\W+/)
			.filter((token) => token.length > 0),
	);
}
