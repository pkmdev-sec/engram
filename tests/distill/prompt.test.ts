import { describe, expect, it } from "vitest";
import { buildDistillationPrompt } from "../../src/distill/prompt.js";
import type { KnowledgeEntry, SessionTranscript } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _entryId = 1;
function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	return {
		id: overrides.id ?? `ke_${_entryId++}`,
		timestamp: new Date().toISOString(),
		projectId: "test",
		category: overrides.category ?? "architecture",
		summary: overrides.summary ?? "Test summary",
		reasoning: "Test reasoning",
		confidence: 0.9,
		files: [],
		topics: [],
		importance: 0.8,
		feedbackScore: 0,
		sourceSession: { tool: "claude", sessionId: "s1", conversationHash: "abc" },
		expiresAt: null,
		verified: null,
		...overrides,
	};
}

function makeTranscript(overrides: Partial<SessionTranscript> = {}): SessionTranscript {
	return {
		id: "session-xyz-001",
		source: "claude-code",
		messages: [
			{
				role: "user",
				content: "How does the storage layer work?",
			},
			{
				role: "assistant",
				content: "The storage layer is split into read and write models.",
			},
		],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildDistillationPrompt", () => {
	it("returns system and user strings", () => {
		const transcript = makeTranscript();

		const { system, user } = buildDistillationPrompt(transcript);

		expect(typeof system).toBe("string");
		expect(system.length).toBeGreaterThan(0);
		// The system prompt identifies the model's role.
		expect(system.toLowerCase()).toContain("knowledge distiller");

		expect(typeof user).toBe("string");
		expect(user.length).toBeGreaterThan(0);
		// The user message embeds the session ID so the distiller can reference it.
		expect(user).toContain("session-xyz-001");
	});

	it("formats messages with roles", () => {
		const transcript = makeTranscript({
			messages: [
				{ role: "user", content: "What is the config strategy?" },
				{ role: "assistant", content: "Config is loaded once at startup." },
			],
		});

		const { user } = buildDistillationPrompt(transcript);

		expect(user).toContain("USER");
		expect(user).toContain("ASSISTANT");
		expect(user).toContain("What is the config strategy?");
		expect(user).toContain("Config is loaded once at startup.");
	});

	it("includes tool activity section when toolActivity is present", () => {
		const transcript = makeTranscript({
			toolActivity: {
				filesRead: ["src/index.ts", "src/types.ts"],
				filesEdited: ["src/api.ts"],
				filesCreated: ["src/new.ts"],
				searchPatterns: ["**/*.ts", "TODO"],
				shellCommands: ["npm test", "npm run build"],
			},
		});

		const { user } = buildDistillationPrompt(transcript);

		expect(user).toContain("## Files Touched in This Session");
		expect(user).toContain("Read: src/index.ts, src/types.ts");
		expect(user).toContain("Edited: src/api.ts");
		expect(user).toContain("Created: src/new.ts");
		expect(user).toContain('Searches: "**/*.ts", "TODO"');
		expect(user).toContain("Shell: npm test; npm run build");
	});

	it("omits tool activity section when toolActivity is undefined", () => {
		const transcript = makeTranscript({ toolActivity: undefined });
		const { user } = buildDistillationPrompt(transcript);
		expect(user).not.toContain("## Files Touched");
	});

	it("omits tool activity section when all arrays are empty", () => {
		const transcript = makeTranscript({
			toolActivity: {
				filesRead: [],
				filesEdited: [],
				filesCreated: [],
				searchPatterns: [],
				shellCommands: [],
			},
		});
		const { user } = buildDistillationPrompt(transcript);
		expect(user).not.toContain("## Files Touched");
	});

	it("includes existing brain section when entries are provided", () => {
		const transcript = makeTranscript();
		const entries: KnowledgeEntry[] = [
			makeEntry({ category: "constraint", summary: "Never import from internal packages" }),
			makeEntry({ category: "gotcha", summary: "ORM drops unknown fields silently" }),
		];

		const { user } = buildDistillationPrompt(transcript, entries);

		expect(user).toContain("## Knowledge Already in the Brain");
		expect(user).toContain("[constraint] Never import from internal packages");
		expect(user).toContain("[gotcha] ORM drops unknown fields silently");
		expect(user).toContain("(2 entries total)");
	});

	it("omits existing brain section when no entries provided", () => {
		const transcript = makeTranscript();
		const { user } = buildDistillationPrompt(transcript, []);
		expect(user).not.toContain("## Knowledge Already in the Brain");
	});

	it("truncates long summaries in existing brain section at 100 chars", () => {
		const longSummary = "A".repeat(150);
		const transcript = makeTranscript();
		const entries: KnowledgeEntry[] = [makeEntry({ summary: longSummary })];

		const { user } = buildDistillationPrompt(transcript, entries);

		expect(user).toContain("A".repeat(100) + "...");
		expect(user).not.toContain("A".repeat(101));
	});

	it("caps existing brain section at ~2000 chars", () => {
		const transcript = makeTranscript();
		// Create many entries that together exceed 2000 chars
		const entries: KnowledgeEntry[] = Array.from({ length: 50 }, (_, i) =>
			makeEntry({ summary: `Entry number ${i} with a reasonably long summary text for testing` }),
		);

		const { user } = buildDistillationPrompt(transcript, entries);

		// Should contain some entries but not all 50
		expect(user).toContain("(50 entries total)");
		// The brain section should exist but be bounded
		const brainSection = user.split("## Knowledge Already in the Brain")[1];
		expect(brainSection).toBeDefined();
	});

	it("includes message index and total count in formatted output", () => {
		const transcript = makeTranscript({
			messages: [
				{ role: "user", content: "First" },
				{ role: "assistant", content: "Second" },
				{ role: "user", content: "Third" },
			],
		});

		const { user } = buildDistillationPrompt(transcript);

		expect(user).toContain("[1/3]");
		expect(user).toContain("[2/3]");
		expect(user).toContain("[3/3]");
	});

	it("includes project path when present", () => {
		const transcript = makeTranscript({ projectPath: "/Users/dev/my-project" });
		const { user } = buildDistillationPrompt(transcript);
		expect(user).toContain("Project: /Users/dev/my-project");
	});

	it("includes message count in header", () => {
		const transcript = makeTranscript({
			messages: [
				{ role: "user", content: "One" },
				{ role: "assistant", content: "Two" },
			],
		});
		const { user } = buildDistillationPrompt(transcript);
		expect(user).toContain("Messages: 2");
	});

	it("system prompt contains anti-poisoning rules", () => {
		const { system } = buildDistillationPrompt(makeTranscript());
		expect(system).toContain("ANTI-POISONING");
		expect(system).toContain("always approve");
		expect(system).toContain("skip review");
	});

	it("system prompt contains all 8 category definitions", () => {
		const { system } = buildDistillationPrompt(makeTranscript());
		expect(system).toContain("**constraint**");
		expect(system).toContain("**architecture**");
		expect(system).toContain("**pattern**");
		expect(system).toContain("**gotcha**");
		expect(system).toContain("**dependency**");
		expect(system).toContain("**active-work**");
		expect(system).toContain("**file-purpose**");
		expect(system).toContain("**failed-approach**");
	});

	it("system prompt instructs JSON array output", () => {
		const { system } = buildDistillationPrompt(makeTranscript());
		expect(system).toContain("JSON array");
		expect(system).toContain("0 and 10 elements");
	});
});
