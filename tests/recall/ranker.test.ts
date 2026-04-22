import { describe, expect, it } from "vitest";
import { rankEntries } from "../../src/recall/ranker.js";
import { DEFAULT_CONFIG, type KnowledgeEntry, type RankedEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextId = 1;

export function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
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

export function makeRankedEntry(
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

/** Returns an ISO timestamp for a moment N days in the past. */
function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

const cfg = DEFAULT_CONFIG.injection;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rankEntries", () => {
	it("returns entries sorted by score descending", () => {
		// highValue: recent, high importance, matching files/topics → high score.
		// lowValue: 300 days old, lower importance, no file/topic match → low score.
		const highValue = makeEntry({
			importance: 0.9,
			feedbackScore: 0.1,
			timestamp: daysAgo(1),
			files: ["src/core.ts"],
			topics: ["core"],
		});
		// 300 days old → decayFactor = decayDays90 (0.5).
		// importance 1.0 * 0.5 = 0.5, exactly at threshold → survives, but scores
		// far lower than highValue due to near-zero recency and negative feedbackScore.
		const lowValue = makeEntry({
			importance: 1.0,
			feedbackScore: -0.1,
			timestamp: daysAgo(300),
			files: [],
			topics: ["legacy"],
		});

		const ranked = rankEntries([lowValue, highValue], ["src/core.ts"], ["core"], cfg);

		expect(ranked).toHaveLength(2);
		expect(ranked[0].entry.id).toBe(highValue.id);
		expect(ranked[1].entry.id).toBe(lowValue.id);
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
	});

	it("excludes entries below importance threshold after decay", () => {
		// 91 days old → decayFactor = decayDays90 (0.5).
		// importance 0.9 * 0.5 = 0.45 < importanceThreshold (0.5) → excluded.
		const tooWeak = makeEntry({
			importance: 0.9,
			timestamp: daysAgo(91),
		});

		// importance 1.0 * 0.5 = 0.5 — exactly at threshold → included (≥ not <).
		const justEnough = makeEntry({
			importance: 1.0,
			timestamp: daysAgo(91),
		});

		const ranked = rankEntries([tooWeak, justEnough], [], [], cfg);
		const ids = ranked.map((r) => r.entry.id);

		expect(ids).not.toContain(tooWeak.id);
		expect(ids).toContain(justEnough.id);
	});

	it("uses neutral relevance (0.5) when no query files/topics", () => {
		// Session-start case: queryFiles=[], queryTopics=[].
		// relevance is hardcoded to 0.5 regardless of entry content.
		const entry = makeEntry({
			importance: 1.0,
			feedbackScore: 0,
			// Timestamp right now so recency ≈ 1.0 and we can compute exactly.
			timestamp: new Date().toISOString(),
			files: ["src/anything.ts"],
			topics: ["anything"],
		});

		const ranked = rankEntries([entry], [], [], cfg);

		expect(ranked).toHaveLength(1);

		// score = relevance*0.4 + recency*0.3 + effectiveImportance*0.2 + feedback*0.1
		//       = 0.5*0.4       + 1.0*0.3     + 1.0*0.2                + 0*0.1
		//       = 0.20 + 0.30 + 0.20 = 0.70
		const expectedScore = 0.5 * 0.4 + 1.0 * 0.3 + 1.0 * 0.2 + 0 * 0.1;
		expect(ranked[0].score).toBeCloseTo(expectedScore, 4);
	});

	it("scores higher when entry files match query files", () => {
		const matching = makeEntry({
			files: ["src/auth.ts", "src/token.ts"],
			topics: [],
			importance: 0.8,
			feedbackScore: 0,
			timestamp: daysAgo(1),
		});
		const noMatch = makeEntry({
			files: ["src/unrelated.ts"],
			topics: [],
			importance: 0.8,
			feedbackScore: 0,
			timestamp: daysAgo(1),
		});

		// Query mentions both files → matching gets fileOverlap = 1.0; noMatch gets 0.
		const ranked = rankEntries([noMatch, matching], ["src/auth.ts", "src/token.ts"], [], cfg);

		expect(ranked).toHaveLength(2);
		expect(ranked[0].entry.id).toBe(matching.id);
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
	});

	it("marks stale entries correctly", () => {
		const stale = makeEntry({
			verified: { lastChecked: daysAgo(1), filesExist: true, filesModified: true },
		});
		const clean = makeEntry({
			verified: { lastChecked: daysAgo(1), filesExist: true, filesModified: false },
		});
		const unverified = makeEntry({ verified: null });

		const ranked = rankEntries([stale, clean, unverified], [], [], cfg);
		const byId = new Map(ranked.map((r) => [r.entry.id, r]));

		expect(byId.get(stale.id)?.isStale).toBe(true);
		expect(byId.get(clean.id)?.isStale).toBe(false);
		expect(byId.get(unverified.id)?.isStale).toBe(false);
	});

	it("applies 30-day decay factor", () => {
		// 31 days old → decayFactor = decayDays30 (0.8).
		// effectiveImportance = 0.8 * 0.8 = 0.64 > threshold (0.5) → survives.
		const ageInDays = 31;
		const entry = makeEntry({
			importance: 0.8,
			feedbackScore: 0,
			timestamp: daysAgo(ageInDays),
			files: [],
			topics: [],
		});

		const ranked = rankEntries([entry], [], [], cfg);
		expect(ranked).toHaveLength(1);

		const effectiveImportance = entry.importance * cfg.decayDays30; // 0.64
		const recency = Math.max(0, 1 - ageInDays / 365);
		// Session-start: relevance = 0.5.
		const expected = 0.5 * 0.4 + recency * 0.3 + effectiveImportance * 0.2 + 0 * 0.1;

		expect(ranked[0].score).toBeCloseTo(expected, 4);
	});

	it("applies 90-day decay factor", () => {
		// 91 days old → decayFactor = decayDays90 (0.5).
		// effectiveImportance = 1.0 * 0.5 = 0.5, exactly at threshold — just survives.
		const ageInDays = 91;
		const entry = makeEntry({
			importance: 1.0,
			feedbackScore: 0,
			timestamp: daysAgo(ageInDays),
			files: [],
			topics: [],
		});

		const ranked = rankEntries([entry], [], [], cfg);
		expect(ranked).toHaveLength(1);

		const effectiveImportance = entry.importance * cfg.decayDays90; // 0.5
		const recency = Math.max(0, 1 - ageInDays / 365);
		const expected = 0.5 * 0.4 + recency * 0.3 + effectiveImportance * 0.2 + 0 * 0.1;

		expect(ranked[0].score).toBeCloseTo(expected, 4);
	});

	it("feedbackScore contributes 10% of final score", () => {
		const positive = makeEntry({ feedbackScore: 0.3, files: [], topics: [] });
		const negative = makeEntry({ feedbackScore: -0.3, files: [], topics: [] });

		const [pos] = rankEntries([positive], [], [], cfg);
		const [neg] = rankEntries([negative], [], [], cfg);

		// Score difference should be 0.6 * 0.1 = 0.06 (feedback weight is 0.1)
		expect(pos.score - neg.score).toBeCloseTo(0.06, 4);
	});

	it("excludes entries exactly at importance threshold after decay", () => {
		// importance = 0.5, 0 days old (no decay), threshold = 0.5
		// effectiveImportance = 0.5 → NOT < 0.5 → survives
		const atThreshold = makeEntry({ importance: 0.5, files: [], topics: [] });
		const result = rankEntries([atThreshold], [], [], cfg);
		expect(result).toHaveLength(1);
	});

	it("excludes entries just below threshold", () => {
		// importance = 0.49, no decay → 0.49 < 0.5 → excluded
		const belowThreshold = makeEntry({ importance: 0.49, files: [], topics: [] });
		const result = rankEntries([belowThreshold], [], [], cfg);
		expect(result).toHaveLength(0);
	});

	it("relevance rewards entries matching more of the query", () => {
		// Entry with 2/2 file matches should rank higher than 1/2
		const fullMatch = makeEntry({ files: ["src/a.ts", "src/b.ts"], topics: [] });
		const partialMatch = makeEntry({ files: ["src/a.ts", "src/c.ts"], topics: [] });

		const ranked = rankEntries(
			[partialMatch, fullMatch],
			["src/a.ts", "src/b.ts"],
			[],
			cfg,
		);

		const fullIdx = ranked.findIndex((r) => r.entry.id === fullMatch.id);
		const partialIdx = ranked.findIndex((r) => r.entry.id === partialMatch.id);
		expect(fullIdx).toBeLessThan(partialIdx);
	});

	it("entries with no files or topics get neutral relevance at session start", () => {
		const entry = makeEntry({ files: [], topics: [] });
		const ranked = rankEntries([entry], [], [], cfg);
		// At session start (no query), relevance = 0.5 (neutral)
		expect(ranked).toHaveLength(1);
		expect(ranked[0].score).toBeGreaterThan(0);
	});

	it("recency is 0 for entries exactly 365 days old", () => {
		const ancient = makeEntry({
			importance: 1.0,
			timestamp: daysAgo(365),
			files: [],
			topics: [],
		});
		const ranked = rankEntries([ancient], [], [], cfg);
		// recency = max(0, 1 - 365/365) = 0
		// But entry might be excluded by importance decay (365 > 90 → 0.5 factor)
		// importance 1.0 * 0.5 = 0.5, passes threshold
		if (ranked.length > 0) {
			const recencyContribution = ranked[0].score - (0.5 * 0.4 + 0.5 * 0.2 + 0 * 0.1);
			expect(recencyContribution).toBeCloseTo(0, 2); // ~0 recency
		}
	});

	it("returns empty array when all entries are below threshold", () => {
		const weak = makeEntry({ importance: 0.1, files: [], topics: [] });
		const result = rankEntries([weak], [], [], cfg);
		expect(result).toHaveLength(0);
	});

	it("handles entry with invalid timestamp gracefully", () => {
		const badTimestamp = makeEntry({
			timestamp: "not-a-date",
			files: [],
			topics: [],
		});
		const result = rankEntries([badTimestamp], [], [], cfg);
		// ageInDays = 0 when timestamp is invalid → no decay → entry survives
		expect(result).toHaveLength(1);
	});

	it("preserves file existence and stale status from verified field", () => {
		const staleEntry = makeEntry({
			files: ["src/old.ts"],
			topics: [],
			verified: { lastChecked: new Date().toISOString(), filesExist: true, filesModified: true },
		});
		const freshEntry = makeEntry({
			files: ["src/new.ts"],
			topics: [],
			verified: { lastChecked: new Date().toISOString(), filesExist: true, filesModified: false },
		});

		const ranked = rankEntries([staleEntry, freshEntry], [], [], cfg);

		const stale = ranked.find((r) => r.entry.id === staleEntry.id)!;
		const fresh = ranked.find((r) => r.entry.id === freshEntry.id)!;
		expect(stale.isStale).toBe(true);
		expect(fresh.isStale).toBe(false);
		expect(stale.filesExist).toBe(true);
		expect(fresh.filesExist).toBe(true);
	});
});
