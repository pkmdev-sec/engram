import type { FeedbackConfig, KnowledgeEntry } from "../types.js";

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Escape a string for safe use as a literal pattern inside a RegExp.
 * Necessary because topic strings can contain dots, slashes, @-signs, etc.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function entryWasUsed(
	entry: KnowledgeEntry,
	responses: readonly string[],
): boolean {
	const lowerResponses = responses.map((r) => r.toLowerCase());

	// File match: case-insensitive substring — any file in any response.
	for (const file of entry.files) {
		const lowerFile = file.toLowerCase();
		if (lowerResponses.some((r) => r.includes(lowerFile))) {
			return true;
		}
	}

	// Topic match: case-insensitive word-boundary — any topic in any response.
	for (const topic of entry.topics) {
		const pattern = new RegExp(`\\b${escapeRegex(topic)}\\b`, "i");
		if (responses.some((r) => pattern.test(r))) {
			return true;
		}
	}

	return false;
}

/**
 * Compare injected knowledge entries against agent responses and return a map
 * of entryId → newFeedbackScore for every entry whose score changed.
 */
export function trackFeedback(
	injectedEntries: readonly KnowledgeEntry[],
	agentResponses: readonly string[],
	config: FeedbackConfig,
): Map<string, number> {
	const changed = new Map<string, number>();

	for (const entry of injectedEntries) {
		const used = entryWasUsed(entry, agentResponses);

		const newScore = used
			? clamp(
					entry.feedbackScore + config.boostPerUse,
					config.minFeedbackScore,
					config.maxFeedbackScore,
				)
			: clamp(
					entry.feedbackScore - config.penaltyPerIgnore,
					config.minFeedbackScore,
					config.maxFeedbackScore,
				);

		if (newScore !== entry.feedbackScore) {
			changed.set(entry.id, newScore);
		}
	}

	return changed;
}
