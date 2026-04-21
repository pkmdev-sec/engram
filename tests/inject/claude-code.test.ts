import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectDriftContext, injectSessionStart } from "../../src/inject/claude-code.js";

const BEGIN_MARKER = "<!-- BEGIN:engram";
const END_MARKER = "<!-- END:engram -->";

function makeMarkerBlock(content: string): string {
	return `${BEGIN_MARKER} -->\n${content}\n${END_MARKER}`;
}

describe("injectSessionStart", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates CLAUDE.md when it does not exist", () => {
		const brainContent = makeMarkerBlock("# My brain content\nsome facts here");
		injectSessionStart(tmpDir, brainContent);

		const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
		expect(fs.existsSync(claudeMdPath)).toBe(true);
		expect(fs.readFileSync(claudeMdPath, "utf8")).toBe(brainContent);
	});

	it("replaces content between markers when markers exist", () => {
		const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
		const originalBlock = makeMarkerBlock("old brain data");
		const initialContent = `# Project Notes\n\n${originalBlock}\n\nsome trailing content`;
		fs.writeFileSync(claudeMdPath, initialContent, "utf8");

		const newBrainContent = makeMarkerBlock("new brain data");
		injectSessionStart(tmpDir, newBrainContent);

		const result = fs.readFileSync(claudeMdPath, "utf8");
		expect(result).toContain("new brain data");
		expect(result).not.toContain("old brain data");
		// surrounding content preserved
		expect(result).toContain("# Project Notes\n\n");
		expect(result).toContain("\n\nsome trailing content");
	});

	it("appends content when CLAUDE.md exists but has no markers", () => {
		const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
		const existingContent = "# Existing content\nsome notes\n";
		fs.writeFileSync(claudeMdPath, existingContent, "utf8");

		const brainContent = makeMarkerBlock("appended brain content");
		injectSessionStart(tmpDir, brainContent);

		const result = fs.readFileSync(claudeMdPath, "utf8");
		// original content is intact at the start
		expect(result.startsWith(existingContent)).toBe(true);
		// brain content appears after the original
		expect(result).toContain(brainContent);
		// brain content comes after the original, not replacing it
		expect(result.indexOf(existingContent)).toBeLessThan(result.indexOf(brainContent));
	});

	it("handles markers with content before and after", () => {
		const claudeMdPath = path.join(tmpDir, "CLAUDE.md");
		const before = "## Section A\ncontent before the markers\n\n";
		const after = "\n\n## Section B\ncontent after the markers";
		const originalBlock = makeMarkerBlock("original injected brain");
		fs.writeFileSync(claudeMdPath, before + originalBlock + after, "utf8");

		const newBrainContent = makeMarkerBlock("replacement brain content");
		injectSessionStart(tmpDir, newBrainContent);

		const result = fs.readFileSync(claudeMdPath, "utf8");
		expect(result).toBe(before + newBrainContent + after);
		expect(result).toContain("replacement brain content");
		expect(result).not.toContain("original injected brain");
		expect(result.startsWith(before)).toBe(true);
		expect(result.endsWith(after)).toBe(true);
	});
});

describe("injectDriftContext", () => {
	it("returns valid JSON with additionalContext key", () => {
		const driftContent = "You have drifted from the project conventions.";
		const output = injectDriftContext(driftContent);

		const parsed: unknown = JSON.parse(output);
		expect(parsed).toEqual({ additionalContext: driftContent });
		expect(typeof (parsed as Record<string, unknown>).additionalContext).toBe("string");
	});

	it("escapes special characters in content", () => {
		const driftContent = 'content with "quotes"\nand newlines\t and tabs\\backslash';
		const output = injectDriftContext(driftContent);

		// must be parseable without throwing
		const parsed = JSON.parse(output) as { additionalContext: string };
		// round-trips correctly — special chars are preserved after parse
		expect(parsed.additionalContext).toBe(driftContent);
		// raw output must not contain unescaped double-quote inside the value
		// (the JSON string boundaries consume the outer quotes, inner ones are escaped)
		const valueSlice = output.slice(output.indexOf(":") + 1).trim();
		expect(valueSlice.startsWith('"')).toBe(true);
	});
});
