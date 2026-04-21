import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyEntries } from "../../src/recall/verifier.js";
import type { KnowledgeEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock node:child_process — verifier uses execFileSync for git log calls.
// vi.mock is hoisted to the top of the module by vitest automatically.
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
const mockExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	return {
		id: "test-1",
		timestamp: new Date().toISOString(),
		projectId: "test",
		category: "pattern",
		summary: "Test entry",
		reasoning: "test",
		confidence: 0.9,
		files: [],
		topics: ["testing"],
		importance: 0.7,
		feedbackScore: 0,
		sourceSession: { tool: "claude", sessionId: "s1", conversationHash: "h1" },
		expiresAt: null,
		verified: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("verifyEntries", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-test-"));
		// Default: git log returns empty output — no recent modifications.
		mockExecFileSync.mockReturnValue("" as unknown as Buffer);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	// -------------------------------------------------------------------------
	// File existence filtering
	// -------------------------------------------------------------------------

	it("excludes entries where ALL referenced files are deleted", () => {
		// Neither file exists on disk — the entry is dead knowledge.
		const entry = makeEntry({
			id: "dead",
			files: ["src/gone.ts", "src/also-gone.ts"],
		});

		const result = verifyEntries([entry], tmpDir);

		expect(result).toHaveLength(0);
	});

	it("keeps entries where at least one referenced file exists", () => {
		// Create one of the two referenced files.
		fs.writeFileSync(path.join(tmpDir, "exists.ts"), "// present");

		const entry = makeEntry({
			id: "partial",
			files: ["exists.ts", "gone.ts"],
		});

		const result = verifyEntries([entry], tmpDir);

		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("partial");
	});

	it("keeps entries where all referenced files exist", () => {
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "");

		const entry = makeEntry({
			id: "full",
			files: ["a.ts", "b.ts"],
		});

		const result = verifyEntries([entry], tmpDir);

		expect(result).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// Topic-only entries (files: [])
	// -------------------------------------------------------------------------

	it("always passes through topic-only entries (files: [])", () => {
		const entry = makeEntry({
			id: "topic-only",
			files: [],
			topics: ["architecture", "typescript"],
		});

		const result = verifyEntries([entry], tmpDir);

		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("topic-only");
	});

	it("passes through topic-only entries even when tmpDir is empty", () => {
		const entries = [
			makeEntry({ id: "t1", files: [], topics: ["react"] }),
			makeEntry({ id: "t2", files: [], topics: ["rust"] }),
		];

		const result = verifyEntries(entries, tmpDir);
		expect(result.map((e) => e.id)).toEqual(["t1", "t2"]);
	});

	// -------------------------------------------------------------------------
	// verified.filesExist
	// -------------------------------------------------------------------------

	it("sets filesExist to true when at least one file exists", () => {
		fs.writeFileSync(path.join(tmpDir, "present.ts"), "");

		const entry = makeEntry({ files: ["present.ts", "missing.ts"] });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesExist).toBe(true);
	});

	it("sets filesExist to false when no files exist (entry filtered out)", () => {
		// Entry has files but none exist — filtered OUT because filesExist=false.
		// Verified indirectly: use a topic-only control entry.
		const withFiles = makeEntry({ id: "with-files", files: ["nowhere.ts"] });
		const topicOnly = makeEntry({ id: "topic", files: [] });

		const result = verifyEntries([withFiles, topicOnly], tmpDir);

		expect(result.map((e) => e.id)).toEqual(["topic"]);
	});

	it("sets filesExist to true on topic-only entries (no files to check)", () => {
		const entry = makeEntry({ files: [] });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesExist).toBe(true);
	});

	// -------------------------------------------------------------------------
	// verified.filesModified (via git log mock)
	// -------------------------------------------------------------------------

	it("sets filesModified to true when git log returns non-empty output", () => {
		fs.writeFileSync(path.join(tmpDir, "changed.ts"), "");
		// Simulate git log reporting a recent commit on this file.
		mockExecFileSync.mockReturnValue("abc1234 Update auth logic\n" as unknown as Buffer);

		const entry = makeEntry({ files: ["changed.ts"] });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesModified).toBe(true);
	});

	it("sets filesModified to false when git log returns empty output", () => {
		fs.writeFileSync(path.join(tmpDir, "stable.ts"), "");
		mockExecFileSync.mockReturnValue("" as unknown as Buffer);

		const entry = makeEntry({ files: ["stable.ts"] });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesModified).toBe(false);
	});

	it("sets filesModified to false when git log returns only whitespace", () => {
		fs.writeFileSync(path.join(tmpDir, "whitespace.ts"), "");
		mockExecFileSync.mockReturnValue("   \n  " as unknown as Buffer);

		const entry = makeEntry({ files: ["whitespace.ts"] });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesModified).toBe(false);
	});

	it("sets filesModified to false when execFileSync throws (git unavailable)", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "");
		mockExecFileSync.mockImplementation(() => {
			throw new Error("git: command not found");
		});

		const entry = makeEntry({ files: ["file.ts"] });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesModified).toBe(false);
	});

	it("sets filesModified to true if ANY file has recent commits", () => {
		fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
		fs.writeFileSync(path.join(tmpDir, "b.ts"), "");

		// First call (a.ts): no commits. Second call (b.ts): has commits.
		mockExecFileSync
			.mockReturnValueOnce("" as unknown as Buffer)
			.mockReturnValueOnce("deadbeef Fix bug\n" as unknown as Buffer);

		const entry = makeEntry({ files: ["a.ts", "b.ts"] });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesModified).toBe(true);
	});

	it("passes the entry timestamp as --since to git log", () => {
		const timestamp = "2024-01-15T10:00:00.000Z";
		fs.writeFileSync(path.join(tmpDir, "src.ts"), "");

		const entry = makeEntry({ timestamp, files: ["src.ts"] });
		verifyEntries([entry], tmpDir);

		expect(mockExecFileSync).toHaveBeenCalledWith(
			"git",
			expect.arrayContaining([`--since=${timestamp}`]),
			expect.objectContaining({ cwd: tmpDir }),
		);
	});

	it("passes projectDir as cwd to git log", () => {
		fs.writeFileSync(path.join(tmpDir, "src.ts"), "");

		const entry = makeEntry({ files: ["src.ts"] });
		verifyEntries([entry], tmpDir);

		expect(mockExecFileSync).toHaveBeenCalledWith(
			"git",
			expect.any(Array),
			expect.objectContaining({ cwd: tmpDir }),
		);
	});

	it("topic-only entries carry forward prior filesModified from verified state", () => {
		// A topic-only entry previously verified as modified retains that signal.
		const entry = makeEntry({
			files: [],
			verified: {
				lastChecked: "2024-01-01T00:00:00.000Z",
				filesExist: true,
				filesModified: true,
			},
		});

		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesModified).toBe(true);
	});

	it("topic-only entries default filesModified to false when no prior verified state", () => {
		const entry = makeEntry({ files: [], verified: null });
		const [result] = verifyEntries([entry], tmpDir);

		expect(result!.verified!.filesModified).toBe(false);
	});

	// -------------------------------------------------------------------------
	// verified.lastChecked
	// -------------------------------------------------------------------------

	it("sets lastChecked to a current ISO timestamp", () => {
		const before = new Date().toISOString();
		const entry = makeEntry({ files: [] });
		const [result] = verifyEntries([entry], tmpDir);
		const after = new Date().toISOString();

		expect(result!.verified!.lastChecked).toBeDefined();
		expect(result!.verified!.lastChecked >= before).toBe(true);
		expect(result!.verified!.lastChecked <= after).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Bulk and mixed scenarios
	// -------------------------------------------------------------------------

	it("processes multiple entries independently", () => {
		fs.writeFileSync(path.join(tmpDir, "live.ts"), "");
		// "dead.ts" does not exist.

		const live = makeEntry({ id: "live", files: ["live.ts"] });
		const dead = makeEntry({ id: "dead", files: ["dead.ts"] });
		const topic = makeEntry({ id: "topic", files: [] });

		const result = verifyEntries([live, dead, topic], tmpDir);
		const ids = result.map((e) => e.id);

		expect(ids).toContain("live");
		expect(ids).not.toContain("dead");
		expect(ids).toContain("topic");
	});

	it("returns empty array for empty input", () => {
		expect(verifyEntries([], tmpDir)).toEqual([]);
	});

	it("does not mutate the original entry objects", () => {
		fs.writeFileSync(path.join(tmpDir, "file.ts"), "");
		const entry = makeEntry({ files: ["file.ts"], verified: null });
		const originalVerified = entry.verified;

		verifyEntries([entry], tmpDir);

		// verifyEntries spreads into new objects — original is untouched.
		expect(entry.verified).toBe(originalVerified);
	});
});
