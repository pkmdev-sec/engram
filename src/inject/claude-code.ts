import * as fs from "node:fs";
import * as path from "node:path";

const BEGIN_MARKER = "<!-- BEGIN:engram";
const END_MARKER = "<!-- END:engram -->";

/**
 * Writes engram content into CLAUDE.md for the given project directory.
 *
 * Three cases:
 *  1. CLAUDE.md does not exist — create it with the brain content as the
 *     entire file contents.
 *  2. CLAUDE.md exists and contains the engram markers — replace everything
 *     between (and including) the markers with the new brain content.
 *  3. CLAUDE.md exists but has no markers — append the brain content at the
 *     end of the file, preceded by a blank line separator.
 *
 * All operations are synchronous to keep hook integration simple; this runs
 * in a short-lived hook process, not in a server loop.
 */
export function injectSessionStart(projectDir: string, brainContent: string): void {
	const claudeMdPath = path.join(projectDir, "CLAUDE.md");

	if (!fs.existsSync(claudeMdPath)) {
		fs.writeFileSync(claudeMdPath, brainContent, "utf8");
		return;
	}

	const existing = fs.readFileSync(claudeMdPath, "utf8");

	const beginIdx = existing.indexOf(BEGIN_MARKER);
	const endIdx = existing.indexOf(END_MARKER);

	if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
		// Replace from the beginning of the begin-marker to the end of the
		// end-marker (inclusive). This handles any variation in the text that
		// follows BEGIN:engram on the same line (e.g. the auto-managed note).
		const endOfEndMarker = endIdx + END_MARKER.length;
		const updated = existing.slice(0, beginIdx) + brainContent + existing.slice(endOfEndMarker);
		fs.writeFileSync(claudeMdPath, updated, "utf8");
	} else {
		// No markers present — append to the existing file.
		const separator = existing.endsWith("\n") ? "\n" : "\n\n";
		fs.writeFileSync(claudeMdPath, existing + separator + brainContent, "utf8");
	}
}

/**
 * Returns a JSON string suitable for writing to hook stdout when the hook
 * wants to inject additional context into the assistant's context window
 * mid-session. Claude Code reads this from hook stdout and prepends it to
 * the next user message.
 */
export function injectDriftContext(driftContent: string): string {
	return JSON.stringify({ additionalContext: driftContent });
}
