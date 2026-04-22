import type { InjectionState } from "../types.js";

// Common English words that carry no signal about the topic being discussed.
// Keeping this list narrow — overly broad stop-word lists suppress legitimate
// technical terms (e.g. "type", "this" is intentionally kept short).
const STOP_WORDS = new Set([
	"the", "and", "but", "for", "with", "this", "that", "from",
	"have", "will", "been", "are", "was", "were", "they", "them",
	"then", "than", "when", "what", "where", "which", "also", "into",
	"some", "more", "just", "like", "would", "could", "should", "does",
	"your", "their", "there", "here", "each", "such", "only", "over",
	"after", "about", "before", "these", "those", "both", "very",
	"make", "made", "being", "using", "used", "need", "needs",
	"not", "has", "had", "can", "any", "its", "you", "all", "one",
	"new", "now", "way", "may", "got", "get", "let", "put", "set",
	"try", "run", "use", "yet", "how", "why", "who", "our", "own", "too",
]);

/**
 * Extracts file-path-like strings from a message.
 *
 * Two patterns are matched:
 *  1. Absolute/deep relative paths: at least two segments separated by `/`
 *     where each segment contains word chars, dots, or hyphens, and the final
 *     segment has an extension.
 *  2. Single-slash relative paths: `foo/bar` or `foo/bar.ts` — common in
 *     code review and short references.
 *
 * We don't attempt to resolve these to real paths; we only need stable strings
 * for overlap comparison with InjectionState.injectedFiles.
 */
function extractFiles(message: string): string[] {
	const seen = new Set<string>();
	const results: string[] = [];

	// Pattern 1: deep paths with extension — e.g. /src/auth/token.ts
	const deepPathRe = /\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-zA-Z]+/g;
	for (const match of message.matchAll(deepPathRe)) {
		const p = match[0];
		if (!seen.has(p)) {
			seen.add(p);
			results.push(p);
		}
	}

	// Pattern 2: relative single-slash paths — e.g. src/auth or src/auth.ts
	const relPathRe = /[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:\.[a-zA-Z]+)?/g;
	for (const match of message.matchAll(relPathRe)) {
		const p = match[0];
		if (!seen.has(p)) {
			seen.add(p);
			results.push(p);
		}
	}

	return results;
}

/**
 * Extracts topic keywords from a message.
 *
 * Strategy: split on non-alpha boundaries, keep lowercase-alpha words longer
 * than 3 characters, remove stop words. This is deliberately simple — we want
 * stable, comparable tokens, not NLP-quality extraction.
 */
function extractTopics(message: string): string[] {
	const words = message
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter((w) => w.length > 2 && /^[a-z]+$/.test(w) && !STOP_WORDS.has(w));

	// Deduplicate while preserving first-occurrence order.
	const seen = new Set<string>();
	const result: string[] = [];
	for (const w of words) {
		if (!seen.has(w)) {
			seen.add(w);
			result.push(w);
		}
	}
	return result;
}

function intersectionSize(a: string[], b: Set<string>): number {
	let count = 0;
	for (const item of a) {
		if (b.has(item)) count++;
	}
	return count;
}

export interface DriftResult {
	readonly drifted: boolean;
	readonly newFiles: string[];
	readonly newTopics: string[];
}

/**
 * Decides whether the current user message represents a topic drift relative
 * to what was already injected in this session.
 *
 * Drift is defined as: the message mentions files and/or topics, AND the
 * average overlap with what was previously injected is below 30%. This means:
 * - A message that touches already-covered territory → no drift (no re-inject).
 * - A message with no extractable signal (pure prose) → no drift (avoid noise).
 * - A message that clearly moves into new territory → drift (re-inject).
 */
export function detectDrift(
	userMessage: string,
	injectionState: InjectionState,
): DriftResult {
	const extractedFiles = extractFiles(userMessage);
	const extractedTopics = extractTopics(userMessage);

	const hasSignal = extractedFiles.length > 0 || extractedTopics.length > 0;

	let drifted = false;

	if (hasSignal) {
		const fileOverlap =
			intersectionSize(extractedFiles, injectionState.injectedFiles) /
			Math.max(extractedFiles.length, 1);

		const topicOverlap =
			intersectionSize(extractedTopics, injectionState.injectedTopics) /
			Math.max(extractedTopics.length, 1);

		const avgOverlap = (fileOverlap + topicOverlap) / 2;

		drifted = avgOverlap < 0.3;
	}

	const newFiles = extractedFiles.filter((f) => !injectionState.injectedFiles.has(f));
	const newTopics = extractedTopics.filter((t) => !injectionState.injectedTopics.has(t));

	return { drifted, newFiles, newTopics };
}
