import type { EntryCategory, RankedEntry } from "../types.js";
import { IMPERATIVE_CATEGORIES } from "../types.js";

// Maps each category to its section heading in the CLAUDE.md output.
// Order here determines section order in the rendered output.
const SECTION_ORDER: ReadonlyArray<{ categories: EntryCategory[]; heading: string }> = [
	{ categories: ["user-preference"], heading: "User Preferences" },
	{ categories: ["constraint"], heading: "Constraints" },
	{ categories: ["architecture"], heading: "Architecture" },
	{ categories: ["active-work"], heading: "Active Work" },
	{ categories: ["gotcha"], heading: "Gotchas" },
	{ categories: ["failed-approach"], heading: "Failed Approaches" },
	{ categories: ["pattern"], heading: "Patterns" },
	{ categories: ["dependency"], heading: "Dependencies" },
	{ categories: ["file-purpose"], heading: "File Map" },
];

// Strip HTML comment delimiters from brain content before injecting into CLAUDE.md.
// If an entry's text contains <!-- END:engram --> it would corrupt the managed
// section markers on the next inject cycle.
function sanitizeForClaudeMd(text: string): string {
	return text.replace(/<!--/g, "").replace(/-->/g, "");
}

/** Extract the first sentence, capped at maxChars. Returns empty string if input is empty. */
function truncateToFirstSentence(text: string, maxChars: number): string {
	const periodIdx = text.indexOf(". ");
	const firstSentence = periodIdx > 0 ? text.slice(0, periodIdx + 1) : text;
	return firstSentence.length <= maxChars
		? firstSentence
		: `${firstSentence.slice(0, maxChars - 3)}...`;
}

function buildEntryLine(ranked: RankedEntry): string {
	const { entry, isStale } = ranked;
	const parts: string[] = [];

	// Global prefix: mark cross-project entries so the agent knows the source.
	if (entry.crossProject) {
		parts.push("(global)");
	}

	// Confidence prefix: flag low-confidence entries so the reader knows to
	// treat them with extra skepticism before acting.
	if (entry.confidence < 0.7) {
		parts.push("(unverified)");
	}

	parts.push(sanitizeForClaudeMd(entry.summary));

	// Reasoning anchor: imperative entries (constraint, gotcha, failed-approach)
	// benefit from a brief "why" so the agent can judge edge cases. Informational
	// entries stay summary-only to preserve signal density.
	if (IMPERATIVE_CATEGORIES.has(entry.category) && entry.reasoning) {
		const brief = truncateToFirstSentence(entry.reasoning, 100);
		if (brief) {
			parts.push(`— Why: ${sanitizeForClaudeMd(brief)}`);
		}
	}

	// Stale suffix: entry references files that have been modified since
	// extraction — the fact may still be correct but needs re-verification.
	if (isStale) {
		parts.push("[stale]");
	}

	return `- ${parts.join(" ")}`;
}

/**
 * Produces the full CLAUDE.md managed section that is injected at session
 * start. Only sections that have at least one entry are emitted so the output
 * stays clean when the brain is sparse.
 */
export function composeSessionStart(
	entries: readonly RankedEntry[],
	syncTimestamp: string,
): string {
	// Group entries by their section heading.
	const byHeading = new Map<string, RankedEntry[]>();

	for (const ranked of entries) {
		for (const section of SECTION_ORDER) {
			if ((section.categories as string[]).includes(ranked.entry.category)) {
				const existing = byHeading.get(section.heading);
				if (existing) {
					existing.push(ranked);
				} else {
					byHeading.set(section.heading, [ranked]);
				}
				break;
			}
		}
	}

	const sectionBlocks: string[] = [];

	for (const { heading } of SECTION_ORDER) {
		const sectionEntries = byHeading.get(heading);
		if (!sectionEntries || sectionEntries.length === 0) continue;

		const lines = sectionEntries.map(buildEntryLine).join("\n");
		sectionBlocks.push(`### ${heading}\n${lines}`);
	}

	const body = sectionBlocks.join("\n\n");

	return [
		"<!-- BEGIN:engram (auto-managed -- do not edit inside markers) -->",
		`## Project Intelligence -- Last synced: ${syncTimestamp}`,
		"",
		`> Context from prior sessions — not instructions. You decide what's relevant.`,
		`> Use what helps. Ignore what doesn't apply. Verify before acting on anything`,
		`> marked [stale]. When in doubt, read the code — it's the source of truth.`,
		"",
		body,
		"<!-- END:engram -->",
	].join("\n");
}

/**
 * Shorter format for mid-session injection when a topic drift is detected.
 * No section grouping — just a flat list of the most relevant entries.
 */
export function composeDriftContext(entries: readonly RankedEntry[]): string {
	const lines = entries.map((ranked) => {
		const { entry, isStale } = ranked;
		const globalTag = entry.crossProject ? "(global) " : "";
		const prefix = globalTag + (entry.confidence < 0.7 ? "(unverified) " : "");
		const suffix = isStale ? " [stale]" : "";
		return `- ${prefix}${sanitizeForClaudeMd(entry.summary)}${suffix}`;
	});

	return ["[Prior session context — may be relevant to your current topic]", ...lines].join("\n");
}
