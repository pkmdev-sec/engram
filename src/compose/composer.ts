import type { RankedEntry, InjectionConfig } from "../types.js";
import { IMPERATIVE_CATEGORIES } from "../types.js";
import { composeSessionStart, composeDriftContext } from "./templates.js";

export interface ComposeResult {
	readonly text: string;
	readonly includedIds: string[];
	readonly files: Set<string>;
	readonly topics: Set<string>;
}

/**
 * Selects and composes knowledge entries into injection text.
 *
 * Entries are assumed to be pre-sorted by descending score from the ranker.
 * We partition them into imperative (constraint / gotcha / failed-approach) and
 * informational buckets, cap each at its configured limit, then hand off to the
 * appropriate template function.
 *
 * Keeping the two budgets separate ensures critical warnings (imperatives) can
 * never be crowded out by a large body of informational context, and vice versa.
 */
export function compose(
	rankedEntries: readonly RankedEntry[],
	config: InjectionConfig,
	mode: "session-start" | "drift",
): ComposeResult {
	const imperativeEntries: RankedEntry[] = [];
	const informationalEntries: RankedEntry[] = [];

	for (const ranked of rankedEntries) {
		if (IMPERATIVE_CATEGORIES.has(ranked.entry.category)) {
			imperativeEntries.push(ranked);
		} else {
			informationalEntries.push(ranked);
		}
	}

	// Entries are already score-sorted by the ranker; slice preserves that order.
	const selectedImperative = imperativeEntries.slice(0, config.maxImperativeEntries);
	const selectedInformational = informationalEntries.slice(0, config.maxInformationalEntries);

	const selected = [...selectedImperative, ...selectedInformational];

	// Collect the union of all file and topic references covered by the
	// selected entries so the caller can update InjectionState accordingly.
	const files = new Set<string>();
	const topics = new Set<string>();
	const includedIds: string[] = [];

	for (const ranked of selected) {
		includedIds.push(ranked.entry.id);
		for (const f of ranked.entry.files) files.add(f);
		for (const t of ranked.entry.topics) topics.add(t);
	}

	const text =
		mode === "session-start"
			? composeSessionStart(selected, new Date().toISOString())
			: composeDriftContext(selected);

	return { text, includedIds, files, topics };
}
