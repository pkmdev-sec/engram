import { describe, it, expect } from "vitest";
import { buildDistillationPrompt } from "../../src/distill/prompt.js";
import type { SessionTranscript } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
		// Message bodies must be present in output.
		expect(user).toContain("What is the config strategy?");
		expect(user).toContain("Config is loaded once at startup.");
	});
});
