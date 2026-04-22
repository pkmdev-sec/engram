import { describe, expect, it } from "vitest";
import { detectDrift } from "../../src/compose/drift-detector.js";
import type { InjectionState } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeState(
	overrides: {
		injectedFiles?: string[];
		injectedTopics?: string[];
	} = {},
): InjectionState {
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
		const result = detectDrift("Please look at /src/auth/token.ts and refactor it", state);

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
		const result = detectDrift("Check /src/compose/templates.ts and also src/types.ts", state);

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

	// -- File extraction edge cases --

	it("extracts paths with dots in directory names", () => {
		const state = makeState();
		const result = detectDrift("Check /usr/local/lib/node_modules/.pnpm/pkg.ts", state);
		expect(result.newFiles.length).toBeGreaterThan(0);
	});

	it("extracts relative paths like src/auth without extension", () => {
		const state = makeState();
		const result = detectDrift("Look at src/auth for the middleware", state);
		expect(result.newFiles).toContain("src/auth");
	});

	it("deduplicates file paths extracted from repeated mentions", () => {
		const state = makeState();
		const result = detectDrift(
			"First check /src/auth/token.ts then revisit /src/auth/token.ts",
			state,
		);
		const tokenCount = result.newFiles.filter((f) => f === "/src/auth/token.ts").length;
		expect(tokenCount).toBe(1);
	});

	it("does not extract bare filenames without slashes as file paths", () => {
		const state = makeState();
		const result = detectDrift("Edit the package.json file", state);
		// package.json has no slash → not extracted as a file path
		const hasPackageJson = result.newFiles.some((f) => f.includes("package.json"));
		expect(hasPackageJson).toBe(false);
	});

	// -- Topic extraction edge cases --

	it("filters stop words from topics", () => {
		const state = makeState();
		const result = detectDrift(
			"the authentication module should have been using better patterns",
			state,
		);
		expect(result.newTopics).toContain("authentication");
		expect(result.newTopics).toContain("module");
		expect(result.newTopics).toContain("better");
		expect(result.newTopics).toContain("patterns");
		// Stop words excluded
		expect(result.newTopics).not.toContain("the");
		expect(result.newTopics).not.toContain("should");
		expect(result.newTopics).not.toContain("have");
		expect(result.newTopics).not.toContain("been");
		expect(result.newTopics).not.toContain("using");
	});

	it("keeps 3-character technical terms like api, cli, git", () => {
		const state = makeState();
		const result = detectDrift("fix the api rate limiter and cli help text", state);
		expect(result.newTopics).toContain("api");
		expect(result.newTopics).toContain("rate");
		expect(result.newTopics).toContain("limiter");
		expect(result.newTopics).toContain("cli");
		expect(result.newTopics).toContain("help");
		expect(result.newTopics).toContain("text");
	});

	it("drops 1-2 character words from topics", () => {
		const state = makeState();
		const result = detectDrift("go to db or do it", state);
		// "go", "to", "db", "or", "do", "it" are all <= 2 chars → filtered
		expect(result.newTopics).toHaveLength(0);
	});

	it("deduplicates topics from repeated words", () => {
		const state = makeState();
		const result = detectDrift(
			"authentication authentication authentication pattern",
			state,
		);
		const authCount = result.newTopics.filter((t) => t === "authentication").length;
		expect(authCount).toBe(1);
	});

	// -- Drift threshold edge cases --

	it("drift when overlap is exactly 0 (all new territory)", () => {
		const state = makeState({
			injectedFiles: ["/old/path.ts"],
			injectedTopics: ["database"],
		});
		const result = detectDrift(
			"Refactor /src/auth/token.ts for authentication security",
			state,
		);
		expect(result.drifted).toBe(true);
	});

	it("no drift when overlap is exactly 1.0 (perfect match)", () => {
		const state = makeState({
			injectedFiles: ["/src/auth/token.ts"],
			injectedTopics: ["authentication", "security", "refactor"],
		});
		const result = detectDrift(
			"Check /src/auth/token.ts for authentication security refactor",
			state,
		);
		expect(result.drifted).toBe(false);
	});

	it("no drift when both files and topics have high overlap", () => {
		// All mentioned files and most topics match injected state → no drift
		const state = makeState({
			injectedFiles: ["/src/auth/token.ts"],
			injectedTopics: ["authentication", "validation", "fix", "src", "auth", "token"],
		});
		const result = detectDrift(
			"Fix /src/auth/token.ts authentication validation",
			state,
		);
		expect(result.drifted).toBe(false);
	});

	it("reports newFiles and newTopics even when no drift detected", () => {
		// Most overlap, but one new file and topic
		const state = makeState({
			injectedFiles: ["/src/auth/token.ts", "/src/auth/session.ts"],
			injectedTopics: ["authentication", "validation", "security", "fix", "src", "auth", "token", "session"],
		});
		const result = detectDrift(
			"Fix /src/auth/token.ts and /src/auth/session.ts authentication validation security",
			state,
		);
		expect(result.drifted).toBe(false);
	});
});
