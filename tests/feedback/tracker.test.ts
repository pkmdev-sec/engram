import { describe, it, expect } from "vitest";
import { trackFeedback } from "../../src/feedback/tracker.js";
import { DEFAULT_CONFIG, type KnowledgeEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helper
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

const cfg = DEFAULT_CONFIG.feedback;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trackFeedback", () => {
	it("boosts score when entry files appear in responses", () => {
		// entryWasUsed returns true if any response contains the file path as a
		// case-insensitive substring.
		const entry = makeEntry({
			feedbackScore: 0,
			files: ["src/auth/token.ts"],
			topics: [],
		});

		const changed = trackFeedback(
			[entry],
			["I edited src/auth/token.ts directly"],
			cfg,
		);

		expect(changed.has(entry.id)).toBe(true);
		expect(changed.get(entry.id)).toBeCloseTo(0 + cfg.boostPerUse, 10);
	});

	it("boosts score when entry topics appear in responses", () => {
		// entryWasUsed matches topics via word-boundary regex (case-insensitive).
		// "authentication" in the response must match the "authentication" topic.
		const entry = makeEntry({
			feedbackScore: 0,
			files: [],
			topics: ["authentication"],
		});

		const changed = trackFeedback(
			[entry],
			["The authentication flow needs to be updated"],
			cfg,
		);

		expect(changed.has(entry.id)).toBe(true);
		expect(changed.get(entry.id)).toBeCloseTo(0 + cfg.boostPerUse, 10);
	});

	it("penalizes score when entry is not found in responses", () => {
		const entry = makeEntry({
			feedbackScore: 0,
			files: ["src/payments.ts"],
			topics: ["stripe"],
		});

		// Neither the file path nor "stripe" appears in any response.
		const changed = trackFeedback(
			[entry],
			["Updated the logging module", "Refactored the router"],
			cfg,
		);

		expect(changed.has(entry.id)).toBe(true);
		expect(changed.get(entry.id)).toBeCloseTo(0 - cfg.penaltyPerIgnore, 10);
	});

	it("clamps score at maxFeedbackScore", () => {
		// Place feedbackScore one full boost below max so that one more boost would
		// overshoot — clamp should pin it to maxFeedbackScore exactly.
		const almostMax = cfg.maxFeedbackScore - cfg.boostPerUse + 0.001;
		const entry = makeEntry({
			feedbackScore: almostMax,
			files: ["src/core.ts"],
			topics: [],
		});

		const changed = trackFeedback([entry], ["Updated src/core.ts"], cfg);

		expect(changed.has(entry.id)).toBe(true);
		expect(changed.get(entry.id)).toBe(cfg.maxFeedbackScore);
	});

	it("clamps score at minFeedbackScore", () => {
		// Place feedbackScore one full penalty above min so that one more penalty
		// would overshoot — clamp should pin it to minFeedbackScore exactly.
		const almostMin = cfg.minFeedbackScore + cfg.penaltyPerIgnore - 0.001;
		const entry = makeEntry({
			feedbackScore: almostMin,
			files: ["src/irrelevant.ts"],
			topics: ["irrelevant"],
		});

		// Response does not mention the file or topic.
		const changed = trackFeedback([entry], ["Completely unrelated response"], cfg);

		expect(changed.has(entry.id)).toBe(true);
		expect(changed.get(entry.id)).toBe(cfg.minFeedbackScore);
	});

	it("returns empty map when no scores change", () => {
		// feedbackScore is already at maxFeedbackScore and the entry is used.
		// clamp(max + boost, min, max) === max === feedbackScore → no change → entry absent from map.
		const entry = makeEntry({
			feedbackScore: cfg.maxFeedbackScore,
			files: ["src/core.ts"],
			topics: [],
		});

		const changed = trackFeedback([entry], ["Updated src/core.ts"], cfg);

		expect(changed.size).toBe(0);
	});
});
