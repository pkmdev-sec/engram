/**
 * Shared text similarity utilities.
 *
 * Used by the validator (dedup check), auto-promoter (cross-project matching),
 * and drift detector (overlap calculation).
 */

/**
 * Splits text into a Set of lowercase word tokens.
 * Splits on non-word characters; drops empty tokens.
 */
export function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/\W+/)
			.filter((token) => token.length > 0),
	);
}

/**
 * Computes the Jaccard similarity between the word sets of two strings.
 *
 * Returns a value in [0, 1]. Short function words are NOT filtered out —
 * they are part of the signal for detecting near-identical summaries, and
 * filtering them would make evasion easier.
 */
export function wordOverlap(a: string, b: string): number {
	const wordsA = tokenize(a);
	const wordsB = tokenize(b);

	if (wordsA.size === 0 && wordsB.size === 0) return 1;
	if (wordsA.size === 0 || wordsB.size === 0) return 0;

	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersection++;
	}

	const union = wordsA.size + wordsB.size - intersection;
	return intersection / union;
}

/**
 * Counts how many items from `items` exist in `querySet`.
 */
export function intersectionSize(items: readonly string[], querySet: ReadonlySet<string>): number {
	let count = 0;
	for (const item of items) {
		if (querySet.has(item)) count++;
	}
	return count;
}
