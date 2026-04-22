import { describe, expect, it } from "vitest";
import { compose } from "../../src/compose/composer.js";
import { DEFAULT_CONFIG, type KnowledgeEntry, type RankedEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextId = 1;

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	const id = overrides.id ?? `entry-${_nextId++}`;
	return {
		id,
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		projectId: overrides.projectId ?? "test-project",
		category: overrides.category ?? "architecture",
		summary: overrides.summary ?? "Test summary",
		reasoning: overrides.reasoning ?? "Test reasoning",
		confidence: overrides.confidence ?? 0.9,
		files: overrides.files ?? [],
		topics: overrides.topics ?? [],
		importance: overrides.importance ?? 0.8,
		feedbackScore: overrides.feedbackScore ?? 0,
		sourceSession: overrides.sourceSession ?? {
			tool: "claude",
			sessionId: "sess-1",
			conversationHash: "abc123",
		},
		expiresAt: overrides.expiresAt ?? null,
		verified: overrides.verified ?? null,
	};
}

function makeRankedEntry(
	overrides: {
		entry?: Partial<KnowledgeEntry>;
		score?: number;
		isStale?: boolean;
		filesExist?: boolean;
	} = {},
): RankedEntry {
	return {
		entry: makeEntry(overrides.entry),
		score: overrides.score ?? 0.5,
		isStale: overrides.isStale ?? false,
		filesExist: overrides.filesExist ?? true,
	};
}

const cfg = DEFAULT_CONFIG.injection;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compose", () => {
	it("splits entries into imperative and informational", () => {
		// IMPERATIVE_CATEGORIES = { "constraint", "gotcha", "failed-approach" }.
		// All other categories (architecture, pattern, etc.) are informational.
		// Both buckets are well within default caps, so all four are included.
		const constraint = makeRankedEntry({
			entry: { category: "constraint", summary: "No circular deps", reasoning: "breaks builds" },
		});
		const gotcha = makeRankedEntry({
			entry: { category: "gotcha", summary: "Gotcha one", reasoning: "watch out" },
		});
		const architecture = makeRankedEntry({
			entry: { category: "architecture", summary: "Layered arch", reasoning: "clean separation" },
		});
		const pattern = makeRankedEntry({
			entry: { category: "pattern", summary: "Factory pattern", reasoning: "decouples creation" },
		});

		const result = compose([constraint, gotcha, architecture, pattern], cfg, "session-start");

		expect(result.includedIds).toContain(constraint.entry.id);
		expect(result.includedIds).toContain(gotcha.entry.id);
		expect(result.includedIds).toContain(architecture.entry.id);
		expect(result.includedIds).toContain(pattern.entry.id);

		// The rendered session-start text groups entries into sections; all summaries
		// should appear somewhere in the output.
		expect(result.text).toContain("No circular deps");
		expect(result.text).toContain("Gotcha one");
		expect(result.text).toContain("Layered arch");
		expect(result.text).toContain("Factory pattern");
	});

	it("respects maxImperativeEntries cap", () => {
		// Lower the cap to 2. Provide 5 imperative entries already sorted by
		// descending score (as the ranker would deliver them). Only the first 2
		// should appear in the output.
		const restrictedCfg = { ...cfg, maxImperativeEntries: 2 };

		const entries = Array.from({ length: 5 }, (_, i) =>
			makeRankedEntry({
				entry: { category: "constraint", summary: `Constraint ${i}` },
				score: 1 - i * 0.1,
			}),
		);

		const result = compose(entries, restrictedCfg, "session-start");

		expect(result.includedIds).toHaveLength(2);
		expect(result.includedIds).toContain(entries[0].entry.id);
		expect(result.includedIds).toContain(entries[1].entry.id);
		expect(result.includedIds).not.toContain(entries[2].entry.id);
	});

	it("respects maxInformationalEntries cap", () => {
		const restrictedCfg = { ...cfg, maxInformationalEntries: 2 };

		const entries = Array.from({ length: 5 }, (_, i) =>
			makeRankedEntry({
				entry: { category: "architecture", summary: `Architecture ${i}` },
				score: 1 - i * 0.1,
			}),
		);

		const result = compose(entries, restrictedCfg, "session-start");

		expect(result.includedIds).toHaveLength(2);
		expect(result.includedIds).toContain(entries[0].entry.id);
		expect(result.includedIds).toContain(entries[1].entry.id);
		expect(result.includedIds).not.toContain(entries[2].entry.id);
	});

	it("returns included IDs and covered files/topics", () => {
		// Two entries with partially overlapping files and topics.
		// The returned Sets must contain the union of all references.
		const entry1 = makeRankedEntry({
			entry: {
				category: "constraint",
				files: ["src/api.ts", "src/router.ts"],
				topics: ["routing", "validation"],
			},
		});
		const entry2 = makeRankedEntry({
			entry: {
				category: "architecture",
				files: ["src/router.ts", "src/db.ts"],
				topics: ["database", "routing"],
			},
		});

		const result = compose([entry1, entry2], cfg, "session-start");

		expect(result.includedIds).toEqual(expect.arrayContaining([entry1.entry.id, entry2.entry.id]));

		// File union: all three distinct paths present.
		expect(result.files.has("src/api.ts")).toBe(true);
		expect(result.files.has("src/router.ts")).toBe(true);
		expect(result.files.has("src/db.ts")).toBe(true);
		expect(result.files.size).toBe(3);

		// Topic union: "routing" appears in both entries but is deduplicated by Set.
		expect(result.topics.has("routing")).toBe(true);
		expect(result.topics.has("validation")).toBe(true);
		expect(result.topics.has("database")).toBe(true);
		expect(result.topics.size).toBe(3);
	});
});
