import { describe, it, expect } from "vitest";
import { detectDrift } from "../../src/compose/drift-detector.js";
import type { InjectionState } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeState(overrides: {
	injectedFiles?: string[];
	injectedTopics?: string[];
} = {}): InjectionState {
	return {
		sessionId: "test-session",
		injectedEntryIds: new Set(),
		injectedFiles: new Set(overrides.injectedFiles ?? []),
		injectedTopics: new Set(overrides.injectedTopics ?? []),
		injectionTimestamp: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectDrift", () => {
	it("detects drift when message has new files not in injection state", () => {
		// Message contains /src/auth/token.ts — a deep path with extension.
		// extractedFiles = ["/src/auth/token.ts"], injectedFiles = {} → fileOverlap = 0.
		// extractedTopics may include words like "look", "refactor" → topicOverlap ≈ 0.
		// avgOverlap < 0.3 → drifted = true.
		const state = makeState({ injectedFiles: [] });
		const result = detectDrift(
			"Please look at /src/auth/token.ts and refactor it",
			state,
		);

		expect(result.drifted).toBe(true);
	});

	it("no drift when message files overlap with injected files", () => {
		// Both the file and the topic words are already in the injection state.
		// fileOverlap = 1.0, topicOverlap = 1.0 → avgOverlap = 1.0 ≥ 0.3 → no drift.
		const state = makeState({
			injectedFiles: ["/src/auth/token.ts"],
			injectedTopics: ["refactor", "authentication"],
		});
		const result = detectDrift(
			"Please look at /src/auth/token.ts and refactor authentication",
			state,
		);

		expect(result.drifted).toBe(false);
	});

	it("no drift when message has no extractable signal", () => {
		// Pure prose: no file paths, words are either ≤3 chars or stop words.
		// hasSignal = false → drifted stays false regardless of injection state.
		const state = makeState();
		// "They were here." — every word is a stop word or ≤3 chars → extractTopics = [].
		// No file paths present either → extractFiles = []. hasSignal = false → no drift.
		const result = detectDrift("They were here.", state);

		expect(result.drifted).toBe(false);
		expect(result.newFiles).toHaveLength(0);
		expect(result.newTopics).toHaveLength(0);
	});

	it("extracts file paths from message text", () => {
		// Deep absolute path (/src/compose/templates.ts) and relative single-slash
		// path (src/types.ts) must both be captured by the two regex patterns.
		const state = makeState();
		const result = detectDrift(
			"Check /src/compose/templates.ts and also src/types.ts",
			state,
		);

		expect(result.newFiles).toContain("/src/compose/templates.ts");
		expect(result.newFiles).toContain("src/types.ts");
	});

	it("returns newFiles and newTopics correctly", () => {
		// /src/auth/token.ts is already injected → must NOT appear in newFiles.
		// /src/auth/session.ts is new → must appear in newFiles.
		// "authentication" is already injected → must NOT appear in newTopics.
		// "authorization" is new → must appear in newTopics.
		const state = makeState({
			injectedFiles: ["/src/auth/token.ts"],
			injectedTopics: ["authentication"],
		});
		const result = detectDrift(
			"Now look at /src/auth/token.ts and /src/auth/session.ts for authentication and authorization logic",
			state,
		);

		expect(result.newFiles).not.toContain("/src/auth/token.ts");
		expect(result.newFiles).toContain("/src/auth/session.ts");

		expect(result.newTopics).not.toContain("authentication");
		expect(result.newTopics).toContain("authorization");
	});
});
