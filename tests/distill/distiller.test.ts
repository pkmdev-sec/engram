import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DistillationConfig, SessionTranscript } from "../../src/types.js";
import { distill } from "../../src/distill/distiller.js";

vi.mock("../../src/api/anthropic.js", () => ({
	callAnthropic: vi.fn(),
}));
vi.mock("../../src/distill/prompt.js", () => ({
	buildDistillationPrompt: vi.fn(),
}));
vi.mock("../../src/distill/validator.js", () => ({
	validateDistillerOutput: vi.fn(),
}));

import { callAnthropic } from "../../src/api/anthropic.js";
import { buildDistillationPrompt } from "../../src/distill/prompt.js";
import { validateDistillerOutput } from "../../src/distill/validator.js";

const mockCallAnthropic = vi.mocked(callAnthropic);
const mockBuildPrompt = vi.mocked(buildDistillationPrompt);
const mockValidate = vi.mocked(validateDistillerOutput);

function makeTranscript(content = "hello"): SessionTranscript {
	return {
		id: "sess-1",
		source: "claude",
		messages: [{ role: "user", content }],
	};
}

function makeConfig(overrides: Partial<DistillationConfig> = {}): DistillationConfig {
	return {
		model: "claude-opus-4-6",
		maxEntriesPerSession: 10,
		minConfidence: 0.7,
		trustLevel: "trusted",
		...overrides,
	};
}

describe("distill", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockBuildPrompt.mockReturnValue({ system: "sys", user: "short user message" });
		mockValidate.mockReturnValue({ valid: [], rejected: [] });
		mockCallAnthropic.mockResolvedValue("[]");
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("does not truncate short transcripts", async () => {
		mockBuildPrompt.mockReturnValue({ system: "sys", user: "short user message" });

		await distill(makeTranscript(), makeConfig(), [], "proj-1");

		expect(mockCallAnthropic).toHaveBeenCalledWith(
			expect.any(String),
			"sys",
			"short user message",
		);
	});

	it("truncates transcripts longer than 400K chars", async () => {
		const longUser = "x".repeat(500_000);
		mockBuildPrompt.mockReturnValue({ system: "sys", user: longUser });

		await distill(makeTranscript(), makeConfig(), [], "proj-1");

		const thirdArg = mockCallAnthropic.mock.calls[0]![2];
		expect(thirdArg.length).toBeLessThanOrEqual(400_000);
		expect(thirdArg).toContain("[... ");
	});

	it("returns empty array for untrusted config without calling API", async () => {
		const result = await distill(
			makeTranscript(),
			makeConfig({ trustLevel: "untrusted" }),
			[],
			"proj-1",
		);

		expect(result).toEqual([]);
		expect(mockCallAnthropic).not.toHaveBeenCalled();
	});
});
