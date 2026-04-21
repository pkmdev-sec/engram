/**
 * Orchestrates the distillation pipeline:
 *   load session transcript -> call Opus -> validate -> produce KnowledgeEntries
 */

import { createHash, randomBytes } from "node:crypto";

import type {
	DistillationConfig,
	KnowledgeEntry,
	RawDistillerEntry,
	SessionTranscript,
} from "../types.js";
import { callAnthropic } from "../api/anthropic.js";
import { buildDistillationPrompt } from "./prompt.js";
import { validateDistillerOutput } from "./validator.js";

/**
 * Distill a session transcript into knowledge entries.
 *
 * Calls Claude Opus via the Anthropic API, parses the JSON response,
 * validates it against all safety and quality rules, then converts
 * surviving entries into fully-formed KnowledgeEntry objects.
 *
 * Returns an empty array if the model returns no extractable knowledge
 * or if all entries fail validation. Never throws on model output issues —
 * validation failures are silently dropped (logged to stderr for debugging).
 */
export async function distill(
	transcript: SessionTranscript,
	config: DistillationConfig,
	existingEntries: readonly KnowledgeEntry[],
	projectId: string,
): Promise<KnowledgeEntry[]> {
	const { system, user } = buildDistillationPrompt(transcript);

	const rawResponse = await callAnthropic(config.model, system, user);

	const parsed = parseJsonResponse(rawResponse);
	if (parsed === null) {
		console.error("[pi-brain-agent] Distiller returned non-JSON response, skipping");
		return [];
	}

	const { valid, rejected } = validateDistillerOutput(parsed, existingEntries);

	if (rejected.length > 0) {
		console.error(
			`[pi-brain-agent] Distiller: ${rejected.length} entries rejected:`,
			rejected.map((r) => r.reason),
		);
	}

	const conversationHash = hashTranscript(transcript);

	return valid
		.filter((entry) => entry.confidence >= config.minConfidence)
		.slice(0, config.maxEntriesPerSession)
		.map((raw) => toKnowledgeEntry(raw, projectId, transcript, conversationHash));
}

/**
 * Parse JSON from the model response. The model may wrap output in
 * markdown code fences despite instructions not to. Handle both cases.
 */
function parseJsonResponse(response: string): unknown | null {
	const trimmed = response.trim();

	// Try direct parse first
	try {
		return JSON.parse(trimmed);
	} catch {
		// Fall through to fence stripping
	}

	// Strip markdown code fences: ```json ... ``` or ``` ... ```
	const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
	if (fenceMatch) {
		try {
			return JSON.parse(fenceMatch[1].trim());
		} catch {
			return null;
		}
	}

	return null;
}

/** SHA-256 hash of the concatenated message contents, for provenance tracking. */
function hashTranscript(transcript: SessionTranscript): string {
	const content = transcript.messages.map((m) => m.content).join("\n---\n");
	return createHash("sha256").update(content).digest("hex");
}

/** Convert a validated raw entry into a full KnowledgeEntry. */
function toKnowledgeEntry(
	raw: RawDistillerEntry,
	projectId: string,
	transcript: SessionTranscript,
	conversationHash: string,
): KnowledgeEntry {
	const id = `ke_${randomBytes(6).toString("hex")}`;
	const now = new Date().toISOString();

	// Determine source tool from transcript source field
	const toolMap: Record<string, KnowledgeEntry["sourceSession"]["tool"]> = {
		claude: "claude",
		pi: "pi",
		codex: "codex",
		opencode: "opencode",
		hermes: "hermes",
	};
	const tool = toolMap[transcript.source] ?? "claude";

	return {
		id,
		timestamp: now,
		projectId,
		category: raw.category as KnowledgeEntry["category"],
		summary: raw.summary,
		reasoning: raw.reasoning,
		confidence: raw.confidence,
		files: raw.files,
		topics: raw.topics,
		importance: raw.importance,
		feedbackScore: 0,
		sourceSession: {
			tool,
			sessionId: transcript.id,
			conversationHash,
		},
		expiresAt: raw.expiresAt,
		verified: null,
		mayGeneralize: raw.mayGeneralize ?? false,
	};
}
