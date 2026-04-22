import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compact } from "../../src/store/compactor.js";
import type { CompactionConfig, InjectionConfig, KnowledgeEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock callAnthropic — hoisted before module import resolves
// ---------------------------------------------------------------------------

vi.mock("../../src/api/anthropic.js", () => ({
	callAnthropic: vi.fn(),
}));

import { callAnthropic } from "../../src/api/anthropic.js";

const mockCallAnthropic = vi.mocked(callAnthropic);

// ---------------------------------------------------------------------------
// Default configs
// ---------------------------------------------------------------------------

const defaultCompactionConfig: CompactionConfig = {
	model: "claude-sonnet-4-6",
	maxEntriesPerProject: 100,
	triggerThreshold: 100,
	maxDaysBetweenCompactions: 60,
};

const defaultInjectionConfig: InjectionConfig = {
	maxImperativeEntries: 20,
	maxInformationalEntries: 15,
	importanceThreshold: 0.5,
	decayDays30: 0.8,
	decayDays90: 0.5,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
	return {
		timestamp: new Date().toISOString(),
		projectId: "test",
		category: "pattern",
		summary: `Entry ${overrides.id}`,
		reasoning: "test reasoning",
		confidence: 0.9,
		files: [],
		topics: ["testing"],
		importance: 0.7,
		feedbackScore: 0,
		sourceSession: { tool: "claude", sessionId: "s1", conversationHash: "h1" },
		expiresAt: null,
		verified: null,
		...overrides,
	};
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

function healthyEntries(count: number): KnowledgeEntry[] {
	return Array.from({ length: count }, (_, i) =>
		makeEntry({ id: `healthy-${i}`, importance: 0.8, feedbackScore: 0, files: [] }),
	);
}

function bulkHealthyEntries(count: number): KnowledgeEntry[] {
	return Array.from({ length: count }, (_, i) =>
		makeEntry({ id: `bulk-${i}`, importance: 0.8, feedbackScore: 0, files: [] }),
	);
}

function llmPassthrough(entries: KnowledgeEntry[]): string {
	return JSON.stringify(
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
	);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compactor-test-"));
	mockCallAnthropic.mockReset();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Phase 1: expired entries
// ---------------------------------------------------------------------------

describe("deterministicPrune — expired entries", () => {
	it("removes entries whose expiresAt is in the past", async () => {
		const expired = makeEntry({ id: "expired", expiresAt: daysAgo(1) });
		const live = makeEntry({ id: "live", expiresAt: null });

		const result = await compact([expired, live], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).not.toContain("expired");
		expect(result.entries.map((e) => e.id)).toContain("live");
		expect(result.pruned).toBe(1);
	});

	it("keeps entries whose expiresAt is in the future", async () => {
		const future = makeEntry({
			id: "future",
			expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
		});

		const result = await compact([future], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("future");
		expect(result.pruned).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Phase 1: importance decay
// ---------------------------------------------------------------------------

describe("deterministicPrune — importance decay", () => {
	it("removes entry with importance 0.5 at 91 days (0.5 * decayDays90=0.5 = 0.25 < 0.3)", async () => {
		const decayed = makeEntry({
			id: "decayed",
			importance: 0.5,
			timestamp: daysAgo(91),
		});

		const result = await compact([decayed], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).not.toContain("decayed");
		expect(result.pruned).toBe(1);
	});

	it("keeps entry with importance 0.7 at 91 days (0.7 * 0.5 = 0.35 > 0.3)", async () => {
		const survives = makeEntry({
			id: "survives",
			importance: 0.7,
			timestamp: daysAgo(91),
		});

		const result = await compact([survives], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("survives");
	});

	it("removes entry with importance 0.35 at 35 days (0.35 * decayDays30=0.8 = 0.28 < 0.3)", async () => {
		const thirtyDay = makeEntry({
			id: "thirty-day",
			importance: 0.35,
			timestamp: daysAgo(35),
		});

		const result = await compact([thirtyDay], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).not.toContain("thirty-day");
	});

	it("keeps entry with importance 0.31 at 10 days (no decay applied, 0.31 > 0.3)", async () => {
		const fresh = makeEntry({
			id: "fresh",
			importance: 0.31,
			timestamp: daysAgo(10),
		});

		const result = await compact([fresh], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("fresh");
	});
});

// ---------------------------------------------------------------------------
// Phase 1: negative feedback
// ---------------------------------------------------------------------------

describe("deterministicPrune — negative feedback", () => {
	it("removes entries with feedbackScore < -0.2", async () => {
		const negative = makeEntry({ id: "negative", feedbackScore: -0.25 });

		const result = await compact([negative], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).not.toContain("negative");
		expect(result.pruned).toBe(1);
	});

	it("keeps entries with feedbackScore exactly -0.2 (boundary is not < -0.2)", async () => {
		const boundary = makeEntry({ id: "boundary", feedbackScore: -0.2 });

		const result = await compact([boundary], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("boundary");
	});

	it("keeps entries with feedbackScore 0 or positive", async () => {
		const fine = makeEntry({ id: "fine", feedbackScore: 0.1 });

		const result = await compact([fine], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("fine");
	});
});

// ---------------------------------------------------------------------------
// Phase 1: dead file pruning
// ---------------------------------------------------------------------------

describe("deterministicPrune — dead file pruning", () => {
	it("removes pattern entries where ALL referenced files are gone", async () => {
		const entry = makeEntry({
			id: "dead-pattern",
			category: "pattern",
			files: ["src/gone.ts", "src/also-gone.ts"],
		});

		const result = await compact([entry], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).not.toContain("dead-pattern");
	});

	it("removes file-purpose entries where ALL referenced files are gone", async () => {
		const entry = makeEntry({
			id: "dead-fp",
			category: "file-purpose",
			files: ["src/gone.ts"],
		});

		const result = await compact([entry], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).not.toContain("dead-fp");
	});

	it("keeps pattern entries when at least one file still exists", async () => {
		fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src", "alive.ts"), "// exists");

		const entry = makeEntry({
			id: "partial",
			category: "pattern",
			files: ["src/alive.ts", "src/dead.ts"],
		});

		const result = await compact([entry], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("partial");
	});

	it("keeps file-purpose entries when at least one file still exists", async () => {
		fs.mkdirSync(path.join(tmpDir, "lib"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "lib", "helper.ts"), "// exists");

		const entry = makeEntry({
			id: "fp-alive",
			category: "file-purpose",
			files: ["lib/helper.ts"],
		});

		const result = await compact([entry], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("fp-alive");
	});

	it("keeps pattern entries with empty files array (rule only fires when files.length > 0)", async () => {
		const noFiles = makeEntry({ id: "no-files", category: "pattern", files: [] });

		const result = await compact([noFiles], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("no-files");
	});

	it("does not apply dead-file rule to architecture category", async () => {
		const arch = makeEntry({
			id: "arch",
			category: "architecture",
			files: ["src/gone.ts"],
		});

		const result = await compact([arch], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries.map((e) => e.id)).toContain("arch");
	});
});

// ---------------------------------------------------------------------------
// LLM merge — threshold gating
// ---------------------------------------------------------------------------

describe("LLM merge — threshold gating", () => {
	it("skips LLM merge when exactly 15 entries remain after pruning", async () => {
		const entries = healthyEntries(15);

		await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(mockCallAnthropic).not.toHaveBeenCalled();
	});

	it("calls LLM when 16 entries remain after pruning", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockResolvedValueOnce(llmPassthrough(entries));

		await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(mockCallAnthropic).toHaveBeenCalledOnce();
	});

	it("passes configured model to callAnthropic", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockResolvedValueOnce(llmPassthrough(entries));

		const customConfig = { ...defaultCompactionConfig, model: "test-model-xyz" };
		await compact(entries, tmpDir, customConfig, defaultInjectionConfig);

		expect(mockCallAnthropic).toHaveBeenCalledWith(
			"test-model-xyz",
			expect.any(String),
			expect.any(String),
			16384,
		);
	});
});

// ---------------------------------------------------------------------------
// LLM merge — valid JSON response
// ---------------------------------------------------------------------------

describe("LLM merge — valid JSON response", () => {
	it("reduces entry count when LLM returns a merged subset", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockResolvedValueOnce(llmPassthrough(entries.slice(0, 10)));

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(10);
		expect(result.merged).toBe(6);
	});

	it("applies summary updates from LLM response", async () => {
		const entries = bulkHealthyEntries(16);
		const withUpdate = entries.map((e) => ({
			...e,
			summary: e.id === "bulk-0" ? "LLM-merged summary" : e.summary,
		}));
		mockCallAnthropic.mockResolvedValueOnce(llmPassthrough(withUpdate));

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		const updated = result.entries.find((e) => e.id === "bulk-0");
		expect(updated?.summary).toBe("LLM-merged summary");
	});

	it("preserves sourceSession from original (not in LLM schema)", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockResolvedValueOnce(llmPassthrough(entries));

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		for (const entry of result.entries) {
			expect(entry.sourceSession.tool).toBe("claude");
			expect(entry.sourceSession.sessionId).toBe("s1");
		}
	});

	it("does not let LLM inject category, feedbackScore, or other provenance fields", async () => {
		const entries = bulkHealthyEntries(16);
		// LLM response tries to change category, feedbackScore, confidence, and files
		const tampered = entries.map((e) => ({
			id: e.id,
			summary: e.summary,
			reasoning: e.reasoning,
			importance: e.importance,
			category: "gotcha",
			feedbackScore: 999,
			confidence: 0.01,
			files: ["INJECTED.ts"],
			topics: ["INJECTED"],
		}));
		mockCallAnthropic.mockResolvedValueOnce(JSON.stringify(tampered));

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		for (const entry of result.entries) {
			// All provenance fields should be from the original, not the LLM response
			expect(entry.category).toBe("pattern");
			expect(entry.feedbackScore).toBe(0);
			expect(entry.confidence).toBe(0.9);
			expect(entry.files).not.toContain("INJECTED.ts");
			expect(entry.topics).not.toContain("INJECTED");
		}
	});
});

// ---------------------------------------------------------------------------
// LLM merge — fallback cases
// ---------------------------------------------------------------------------

describe("LLM merge — fallback on bad response", () => {
	it("falls back when LLM returns non-array JSON", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockResolvedValueOnce(JSON.stringify({ error: "oops" }));

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(16);
		expect(result.merged).toBe(0);
	});

	it("falls back when LLM returns completely invalid JSON", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockResolvedValueOnce("not json at all");

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(16);
	});

	it("falls back when callAnthropic throws", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockRejectedValueOnce(new Error("rate limited"));

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(16);
		expect(result.merged).toBe(0);
	});

	it("falls back when LLM returns array with only unknown IDs (result would be empty)", async () => {
		const entries = bulkHealthyEntries(16);
		mockCallAnthropic.mockResolvedValueOnce(JSON.stringify([{ id: "bogus-id-1" }, { id: "bogus-id-2" }]));

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		// result would be empty array → fallback to original
		expect(result.entries).toHaveLength(16);
	});
});

describe("LLM merge — markdown-fenced JSON", () => {
	it("parses JSON wrapped in ```json fences", async () => {
		const entries = bulkHealthyEntries(16);
		const subset = entries.slice(0, 12);
		const fenced = "```json\n" + llmPassthrough(subset) + "\n```";
		mockCallAnthropic.mockResolvedValueOnce(fenced);

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(12);
	});

	it("parses JSON wrapped in plain ``` fences", async () => {
		const entries = bulkHealthyEntries(16);
		const subset = entries.slice(0, 14);
		const fenced = "```\n" + llmPassthrough(subset) + "\n```";
		mockCallAnthropic.mockResolvedValueOnce(fenced);

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(14);
	});
});

// ---------------------------------------------------------------------------
// maxEntriesPerProject cap
// ---------------------------------------------------------------------------

describe("maxEntriesPerProject cap", () => {
	it("caps result at maxEntriesPerProject after LLM merge", async () => {
		const entries = bulkHealthyEntries(20);
		mockCallAnthropic.mockResolvedValueOnce(llmPassthrough(entries));

		const cappedConfig = { ...defaultCompactionConfig, maxEntriesPerProject: 12 };
		const result = await compact(entries, tmpDir, cappedConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(12);
		expect(result.after).toBe(12);
	});

	it("selects highest-importance entries when capping", async () => {
		const entries = bulkHealthyEntries(16).map((e, i) => ({
			...e,
			importance: i === 5 ? 0.99 : 0.5,
		}));
		mockCallAnthropic.mockResolvedValueOnce(llmPassthrough(entries));

		const cappedConfig = { ...defaultCompactionConfig, maxEntriesPerProject: 5 };
		const result = await compact(entries, tmpDir, cappedConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(5);
		expect(result.entries.map((e) => e.id)).toContain("bulk-5");
	});

	it("applies cap even without LLM merge (≤15 entries after prune)", async () => {
		const entries = healthyEntries(10);

		const cappedConfig = { ...defaultCompactionConfig, maxEntriesPerProject: 3 };
		const result = await compact(entries, tmpDir, cappedConfig, defaultInjectionConfig);

		expect(result.entries).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe("compact — stats", () => {
	it("reports before = total input count", async () => {
		const entries = [makeEntry({ id: "a" }), makeEntry({ id: "b" }), makeEntry({ id: "c" })];

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.before).toBe(3);
	});

	it("reports correct pruned count", async () => {
		const entries = [
			makeEntry({ id: "expired", expiresAt: daysAgo(1) }),
			makeEntry({ id: "live" }),
			makeEntry({ id: "negative", feedbackScore: -0.5 }),
		];

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.pruned).toBe(2);
		expect(result.before).toBe(3);
		expect(result.after).toBe(1);
	});

	it("reports merged = 0 when LLM was not called", async () => {
		const entries = healthyEntries(5);

		const result = await compact(entries, tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.merged).toBe(0);
	});

	it("returns zero stats for empty input", async () => {
		const result = await compact([], tmpDir, defaultCompactionConfig, defaultInjectionConfig);

		expect(result.before).toBe(0);
		expect(result.after).toBe(0);
		expect(result.pruned).toBe(0);
		expect(result.merged).toBe(0);
		expect(result.entries).toEqual([]);
	});
});
