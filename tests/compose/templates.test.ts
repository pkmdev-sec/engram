import { describe, it, expect } from "vitest";
import { composeSessionStart, composeDriftContext } from "../../src/compose/templates.js";
import type { RankedEntry, KnowledgeEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRanked(
	overrides: Partial<KnowledgeEntry> & { category: KnowledgeEntry["category"] },
	opts?: { isStale?: boolean },
): RankedEntry {
	const entry: KnowledgeEntry = {
		id: "test-1",
		timestamp: new Date().toISOString(),
		projectId: "test",
		summary: "Test summary",
		reasoning: "Test reasoning",
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
	return {
		entry,
		score: 0.8,
		isStale: opts?.isStale ?? false,
		filesExist: true,
	};
}

// ---------------------------------------------------------------------------
// composeSessionStart
// ---------------------------------------------------------------------------

describe("composeSessionStart", () => {
	const TIMESTAMP = "2024-01-15T10:00:00.000Z";

	it("output contains BEGIN and END pi-brain markers", () => {
		const result = composeSessionStart([], TIMESTAMP);
		expect(result).toContain("<!-- BEGIN:pi-brain");
		expect(result).toContain("<!-- END:pi-brain -->");
	});

	it("contains Project Intelligence header with sync timestamp", () => {
		const result = composeSessionStart([], TIMESTAMP);
		expect(result).toContain(`## Project Intelligence -- Last synced: ${TIMESTAMP}`);
	});

	it("contains the Auto-extracted disclaimer", () => {
		const result = composeSessionStart([], TIMESTAMP);
		expect(result).toContain("Auto-extracted from prior coding sessions");
	});

	it("only sections with entries are rendered — empty sections omitted", () => {
		const entries = [
			makeRanked({ category: "architecture", summary: "Layered approach" }),
		];
		const result = composeSessionStart(entries, TIMESTAMP);

		expect(result).toContain("### Architecture");
		expect(result).not.toContain("### Constraints");
		expect(result).not.toContain("### Gotchas");
		expect(result).not.toContain("### User Preferences");
		expect(result).not.toContain("### Active Work");
		expect(result).not.toContain("### Failed Approaches");
		expect(result).not.toContain("### Patterns");
		expect(result).not.toContain("### Dependencies");
		expect(result).not.toContain("### File Map");
	});

	it("section headings appear in correct order", () => {
		const entries = [
			makeRanked({ category: "file-purpose", summary: "File entry" }),
			makeRanked({ category: "dependency", summary: "Dep entry" }),
			makeRanked({ category: "pattern", summary: "Pattern entry" }),
			makeRanked({ category: "failed-approach", summary: "Failed entry" }),
			makeRanked({ category: "gotcha", summary: "Gotcha entry" }),
			makeRanked({ category: "active-work", summary: "Work entry" }),
			makeRanked({ category: "architecture", summary: "Arch entry" }),
			makeRanked({ category: "constraint", summary: "Constraint entry" }),
			makeRanked({ category: "user-preference", summary: "Pref entry" }),
		];
		const result = composeSessionStart(entries, TIMESTAMP);

		const order = [
			"### User Preferences",
			"### Constraints",
			"### Architecture",
			"### Active Work",
			"### Gotchas",
			"### Failed Approaches",
			"### Patterns",
			"### Dependencies",
			"### File Map",
		];

		let prevIndex = -1;
		for (const heading of order) {
			const idx = result.indexOf(heading);
			expect(idx).toBeGreaterThan(prevIndex);
			prevIndex = idx;
		}
	});

	it("each entry line starts with '- '", () => {
		const entries = [
			makeRanked({ category: "architecture", summary: "Module boundaries", reasoning: "Clean isolation" }),
		];
		const result = composeSessionStart(entries, TIMESTAMP);

		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Module boundaries"));
		expect(entryLine).toBeDefined();
		expect(entryLine!.startsWith("- ")).toBe(true);
	});

	it("entry line combines summary and reasoning: 'summary. reasoning'", () => {
		const entries = [
			makeRanked({
				category: "architecture",
				summary: "Use dependency injection",
				reasoning: "Decouples construction from use",
			}),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		expect(result).toContain("Use dependency injection. Decouples construction from use");
	});

	it("global entries (crossProject: true) get '(global)' prefix", () => {
		const entries = [
			makeRanked({
				category: "pattern",
				summary: "Retry with backoff",
				reasoning: "Handles transient failures",
				crossProject: true,
			}),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Retry with backoff"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toContain("(global)");
	});

	it("low-confidence entries (confidence < 0.7) get '(unverified)' prefix", () => {
		const entries = [
			makeRanked({
				category: "gotcha",
				summary: "Off-by-one in loop",
				reasoning: "Observed once",
				confidence: 0.5,
			}),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Off-by-one in loop"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toContain("(unverified)");
	});

	it("stale entries (isStale: true) get '[stale]' suffix", () => {
		const entries = [
			makeRanked(
				{ category: "architecture", summary: "Monorepo layout", reasoning: "Shared packages" },
				{ isStale: true },
			),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Monorepo layout"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toContain("[stale]");
	});

	it("global + low-confidence entry has both prefixes", () => {
		const entries = [
			makeRanked({
				category: "constraint",
				summary: "No dynamic requires",
				reasoning: "Breaks bundler",
				crossProject: true,
				confidence: 0.4,
			}),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("No dynamic requires"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toContain("(global)");
		expect(entryLine!).toContain("(unverified)");
	});

	it("entry exactly at confidence threshold (0.7) does NOT get (unverified)", () => {
		const entries = [
			makeRanked({
				category: "architecture",
				summary: "Exact threshold",
				reasoning: "Right on the line",
				confidence: 0.7,
			}),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Exact threshold"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).not.toContain("(unverified)");
	});

	it("multiple entries in same section render as separate bullet lines", () => {
		const entries = [
			makeRanked({ category: "pattern", summary: "Factory pattern", reasoning: "Decouples creation" }),
			makeRanked({ category: "pattern", summary: "Observer pattern", reasoning: "Event-driven flow" }),
			makeRanked({ category: "pattern", summary: "Strategy pattern", reasoning: "Algorithm swapping" }),
		];
		const result = composeSessionStart(entries, TIMESTAMP);

		expect(result).toContain("Factory pattern");
		expect(result).toContain("Observer pattern");
		expect(result).toContain("Strategy pattern");

		const lines = result.split("\n");
		const bulletLines = lines.filter((l) => l.startsWith("- "));
		expect(bulletLines).toHaveLength(3);
	});

	it("entries from different sections appear under correct headings", () => {
		const entries = [
			makeRanked({ category: "architecture", summary: "Arch entry", reasoning: "Why arch" }),
			makeRanked({ category: "gotcha", summary: "Gotcha entry", reasoning: "Why gotcha" }),
		];
		const result = composeSessionStart(entries, TIMESTAMP);

		const archIdx = result.indexOf("### Architecture");
		const gotchaIdx = result.indexOf("### Gotchas");
		const archEntryIdx = result.indexOf("Arch entry");
		const gotchaEntryIdx = result.indexOf("Gotcha entry");

		// Architecture section comes before Gotchas in SECTION_ORDER.
		expect(archIdx).toBeLessThan(gotchaIdx);

		// Each entry appears after its section heading.
		expect(archEntryIdx).toBeGreaterThan(archIdx);
		expect(gotchaEntryIdx).toBeGreaterThan(gotchaIdx);

		// Arch entry appears before gotcha entry (sections maintain order).
		expect(archEntryIdx).toBeLessThan(gotchaEntryIdx);
	});

	it("empty entries list produces output with markers but no section blocks", () => {
		const result = composeSessionStart([], TIMESTAMP);
		expect(result).toContain("<!-- BEGIN:pi-brain");
		expect(result).toContain("<!-- END:pi-brain -->");
		expect(result).not.toContain("###");
	});

	it("non-stale entries do NOT get [stale] suffix", () => {
		const entries = [
			makeRanked({ category: "dependency", summary: "Uses React", reasoning: "UI framework" }, { isStale: false }),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		// The disclaimer prose contains '[stale]' in it, so check only the entry line.
		const entryLine = result.split('\n').find((l) => l.includes('Uses React'));
		expect(entryLine).toBeDefined();
		expect(entryLine!).not.toContain("[stale]");
	});

	it("non-global entries do NOT get (global) prefix", () => {
		const entries = [
			makeRanked({ category: "dependency", summary: "Local only dep", reasoning: "Project-scoped" }),
		];
		const result = composeSessionStart(entries, TIMESTAMP);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Local only dep"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).not.toContain("(global)");
	});
});

// ---------------------------------------------------------------------------
// composeDriftContext
// ---------------------------------------------------------------------------

describe("composeDriftContext", () => {
	it("output starts with '[Project Intelligence -- topic shift detected]'", () => {
		const result = composeDriftContext([]);
		expect(result.startsWith("[Project Intelligence -- topic shift detected]")).toBe(true);
	});

	it("contains 'Relevant context' line", () => {
		const result = composeDriftContext([]);
		expect(result).toContain("Relevant context");
	});

	it("contains 'Verify these' footer", () => {
		const result = composeDriftContext([]);
		expect(result).toContain("Verify these");
	});

	it("each entry is a '- ' prefixed line", () => {
		const entries = [
			makeRanked({ category: "architecture", summary: "Caching strategy", reasoning: "Perf improvement" }),
			makeRanked({ category: "gotcha", summary: "Null check required", reasoning: "Defensive coding" }),
		];
		const result = composeDriftContext(entries);
		const lines = result.split("\n");
		const bulletLines = lines.filter((l) => l.startsWith("- "));
		expect(bulletLines).toHaveLength(2);
	});

	it("global entries get '(global) ' prefix", () => {
		const entries = [
			makeRanked({
				category: "pattern",
				summary: "Circuit breaker",
				reasoning: "Fault tolerance",
				crossProject: true,
			}),
		];
		const result = composeDriftContext(entries);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Circuit breaker"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toBe("- (global) Circuit breaker");
	});

	it("low-confidence entries get '(unverified) ' prefix", () => {
		const entries = [
			makeRanked({
				category: "gotcha",
				summary: "Race condition in init",
				reasoning: "Unclear",
				confidence: 0.3,
			}),
		];
		const result = composeDriftContext(entries);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Race condition in init"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toBe("- (unverified) Race condition in init");
	});

	it("stale entries get ' [stale]' suffix", () => {
		const entries = [
			makeRanked(
				{ category: "architecture", summary: "Old db schema", reasoning: "Changed" },
				{ isStale: true },
			),
		];
		const result = composeDriftContext(entries);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Old db schema"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toBe("- Old db schema [stale]");
	});

	it("global + stale entry combines both tags correctly", () => {
		const entries = [
			makeRanked(
				{
					category: "constraint",
					summary: "No fs writes",
					reasoning: "Serverless env",
					crossProject: true,
				},
				{ isStale: true },
			),
		];
		const result = composeDriftContext(entries);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("No fs writes"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toBe("- (global) No fs writes [stale]");
	});

	it("global + low-confidence entry combines both prefixes", () => {
		const entries = [
			makeRanked({
				category: "pattern",
				summary: "Lazy loading",
				reasoning: "Perf win",
				crossProject: true,
				confidence: 0.5,
			}),
		];
		const result = composeDriftContext(entries);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Lazy loading"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toBe("- (global) (unverified) Lazy loading");
	});

	it("no section grouping — flat list, no ### headings", () => {
		const entries = [
			makeRanked({ category: "architecture", summary: "Arch note", reasoning: "Why" }),
			makeRanked({ category: "gotcha", summary: "Gotcha note", reasoning: "Why" }),
			makeRanked({ category: "pattern", summary: "Pattern note", reasoning: "Why" }),
		];
		const result = composeDriftContext(entries);
		expect(result).not.toContain("###");
	});

	it("drift format uses only summary, not reasoning", () => {
		const entries = [
			makeRanked({
				category: "architecture",
				summary: "The summary text",
				reasoning: "The reasoning text should not appear",
			}),
		];
		const result = composeDriftContext(entries);
		expect(result).toContain("The summary text");
		expect(result).not.toContain("The reasoning text should not appear");
	});

	it("entry at confidence exactly 0.7 does NOT get (unverified)", () => {
		const entries = [
			makeRanked({
				category: "constraint",
				summary: "Threshold entry",
				reasoning: "Right at boundary",
				confidence: 0.7,
			}),
		];
		const result = composeDriftContext(entries);
		const lines = result.split("\n");
		const entryLine = lines.find((l) => l.includes("Threshold entry"));
		expect(entryLine).toBeDefined();
		expect(entryLine!).toBe("- Threshold entry");
	});

	it("empty entries list produces only header, Relevant context line, and Verify footer", () => {
		const result = composeDriftContext([]);
		const lines = result.split("\n");
		const bulletLines = lines.filter((l) => l.startsWith("- "));
		expect(bulletLines).toHaveLength(0);
		expect(lines[0]).toBe("[Project Intelligence -- topic shift detected]");
		expect(lines[lines.length - 1]).toBe("Verify these against current code before acting on them.");
	});

	it("multiple entries render in the order given (no section reordering)", () => {
		const entries = [
			makeRanked({ category: "gotcha", summary: "First entry", reasoning: "R" }),
			makeRanked({ category: "architecture", summary: "Second entry", reasoning: "R" }),
			makeRanked({ category: "pattern", summary: "Third entry", reasoning: "R" }),
		];
		const result = composeDriftContext(entries);
		const firstIdx = result.indexOf("First entry");
		const secondIdx = result.indexOf("Second entry");
		const thirdIdx = result.indexOf("Third entry");
		expect(firstIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(thirdIdx);
	});
});
