import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	loadPendingEntries,
	promoteQuarantinedEntries,
	scanForCrossProjectKnowledge,
	type PendingEntry,
} from "../../src/store/auto-promoter.js";
import type { KnowledgeEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock node:child_process so git remote checks don't hit the filesystem
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

const mockExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
	return {
		timestamp: new Date().toISOString(),
		projectId: "test",
		category: "pattern",
		summary: `Entry about ${overrides.id}`,
		reasoning: "test reasoning",
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

/** Write entries to a brain.jsonl file inside projectsDir/<projectId>/ */
function writeBrain(projectsDir: string, projectId: string, entries: KnowledgeEntry[]): void {
	const dir = path.join(projectsDir, projectId);
	fs.mkdirSync(dir, { recursive: true });
	const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	fs.writeFileSync(path.join(dir, "brain.jsonl"), content, "utf-8");
}

/** Write meta.json for a project, pointing to a fake src dir, and configure its git remote. */
function writeMeta(projectsDir: string, projectId: string, remote: string): void {
	const projDir = path.join(projectsDir, projectId);
	const fakeProjectDir = path.join(projectsDir, projectId + "-src");
	fs.mkdirSync(fakeProjectDir, { recursive: true });
	fs.writeFileSync(
		path.join(projDir, "meta.json"),
		JSON.stringify({ projectDir: fakeProjectDir }),
	);
}

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Setup: create isolated ~/.pi-brain mock using TMPDIR override via homedir mock
// ---------------------------------------------------------------------------
// 
// scanForCrossProjectKnowledge internally calls homedir() to resolve
// ~/.pi-brain/projects and ~/.pi-brain/global. We intercept by mocking
// node:os in the auto-promoter module. Since vi.mock is hoisted, we set
// the actual return value per-test via the shared tmpDir variable.

let tmpDir: string;
let piBrainDir: string;
let projectsDir: string;
let globalDir: string;

// The auto-promoter uses homedir() from "node:os". We mock it at the module
// level so every call inside auto-promoter.ts returns our tmpDir.
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return {
		...original,
		homedir: vi.fn(),
	};
});

import { homedir } from "node:os";
const mockHomedir = vi.mocked(homedir);

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-promoter-test-"));
	piBrainDir = path.join(tmpDir, ".pi-brain");
	projectsDir = path.join(piBrainDir, "projects");
	globalDir = path.join(piBrainDir, "global");
	fs.mkdirSync(projectsDir, { recursive: true });
	fs.mkdirSync(globalDir, { recursive: true });

	// Point the auto-promoter's homedir() at our temp dir
	mockHomedir.mockReturnValue(tmpDir);
	// Default: git remote returns null (no remote configured)
	mockExecFileSync.mockImplementation(() => {
		throw new Error("not a git repo");
	});
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// scanForCrossProjectKnowledge
// ---------------------------------------------------------------------------

describe("scanForCrossProjectKnowledge — basic cases", () => {
	it("returns quarantined: 0 when newEntries is empty", () => {
		const result = scanForCrossProjectKnowledge([], "current", tmpDir);
		expect(result.quarantined).toBe(0);
	});

	it("returns quarantined: 0 when projects directory does not exist", () => {
		// Remove the projects dir
		fs.rmSync(projectsDir, { recursive: true });

		const entry = makeEntry({ id: "e1" });
		const result = scanForCrossProjectKnowledge([entry], "current", tmpDir);

		expect(result.quarantined).toBe(0);
	});

	it("returns quarantined: 0 when no other project brains exist", () => {
		// projectsDir exists but is empty
		const entry = makeEntry({ id: "e1" });
		const result = scanForCrossProjectKnowledge([entry], "current", tmpDir);

		expect(result.quarantined).toBe(0);
	});

	it("never auto-promotes user-preference entries", () => {
		const summary = "always use tabs not spaces when editing config files";
		const pref = makeEntry({ id: "pref", category: "user-preference", summary });

		// Create 3 other projects with matching knowledge
		for (let i = 0; i < 3; i++) {
			writeBrain(projectsDir, `other-${i}`, [
				makeEntry({ id: `match-${i}`, summary }),
			]);
		}

		const result = scanForCrossProjectKnowledge([pref], "current", tmpDir);

		expect(result.quarantined).toBe(0);
		// pending.jsonl should not be written
		expect(fs.existsSync(path.join(globalDir, "pending.jsonl"))).toBe(false);
	});
});

describe("scanForCrossProjectKnowledge — cross-project matching", () => {
	it("quarantines entry that matches knowledge in 2+ other projects (total >= 3)", () => {
		const summary = "always initialize database connections in the module scope for reuse";
		const newEntry = makeEntry({ id: "new", summary });

		// Two other projects with a matching entry — give each a distinct remote so they qualify as independent
		writeBrain(projectsDir, "proj-alpha", [makeEntry({ id: "a", summary })]);
		writeMeta(projectsDir, "proj-alpha", "git@github.com:org/alpha.git");
		writeBrain(projectsDir, "proj-beta", [makeEntry({ id: "b", summary })]);
		writeMeta(projectsDir, "proj-beta", "git@github.com:org/beta.git");

		let remoteCallCount = 0;
		mockExecFileSync.mockImplementation(() => {
			remoteCallCount++;
			return `git@github.com:org/repo-${remoteCallCount}.git` as unknown as Buffer;
		});

		const result = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		expect(result.quarantined).toBe(1);

		// Verify the pending file was written
		const pendingPath = path.join(globalDir, "pending.jsonl");
		expect(fs.existsSync(pendingPath)).toBe(true);
		const lines = fs.readFileSync(pendingPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const pending = JSON.parse(lines[0]!) as PendingEntry;
		expect(pending.entry.id).toBe("new");
		expect(pending.matchingProjects).toContain("current");
	});

	it("does not quarantine entry that only matches 1 other project (total = 2, below threshold)", () => {
		const summary = "use async generators for streaming data pipelines";
		const newEntry = makeEntry({ id: "new", summary });

		// Only one other project with a match — total = 2, need >= 3
		writeBrain(projectsDir, "proj-only", [makeEntry({ id: "o", summary })]);

		const result = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		expect(result.quarantined).toBe(0);
	});

	it("writes to pending.jsonl in the global directory", () => {
		const summary = "use connection pooling to avoid exhausting database connections";
		const newEntry = makeEntry({ id: "conn", summary });

		writeBrain(projectsDir, "proj-1", [makeEntry({ id: "p1", summary })]);
		writeMeta(projectsDir, "proj-1", "git@github.com:org/repo1.git");
		writeBrain(projectsDir, "proj-2", [makeEntry({ id: "p2", summary })]);
		writeMeta(projectsDir, "proj-2", "git@github.com:org/repo2.git");

		let rc2 = 0;
		mockExecFileSync.mockImplementation(() => {
			rc2++;
			return `git@github.com:org/repo-${rc2}.git` as unknown as Buffer;
		});

		scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		expect(fs.existsSync(path.join(globalDir, "pending.jsonl"))).toBe(true);
	});

	it("appends multiple quarantined entries as separate lines in pending.jsonl", () => {
		const summaryA = "always use parameterized queries to prevent SQL injection attacks";
		const summaryB = "validate all user input at the API boundary before processing";

		writeBrain(projectsDir, "proj-1", [
			makeEntry({ id: "p1a", summary: summaryA }),
			makeEntry({ id: "p1b", summary: summaryB }),
		]);
		writeMeta(projectsDir, "proj-1", "git@github.com:org/multi1.git");
		writeBrain(projectsDir, "proj-2", [
			makeEntry({ id: "p2a", summary: summaryA }),
			makeEntry({ id: "p2b", summary: summaryB }),
		]);
		writeMeta(projectsDir, "proj-2", "git@github.com:org/multi2.git");

		let rc3 = 0;
		mockExecFileSync.mockImplementation(() => {
			rc3++;
			return `git@github.com:org/multi-repo-${rc3}.git` as unknown as Buffer;
		});

		const entries = [
			makeEntry({ id: "entryA", summary: summaryA }),
			makeEntry({ id: "entryB", summary: summaryB }),
		];

		const result = scanForCrossProjectKnowledge(entries, "current", tmpDir);

		expect(result.quarantined).toBe(2);
		const lines = fs
			.readFileSync(path.join(globalDir, "pending.jsonl"), "utf-8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(2);
	});
});

describe("scanForCrossProjectKnowledge — independence check", () => {
	it("excludes projects with the same git remote as the current project", () => {
		const sharedRemote = "git@github.com:org/monorepo.git";
		const summary = "never commit secrets to version control";
		const newEntry = makeEntry({ id: "new", summary });

		// Two matching projects — but both share the same git remote as current
		writeBrain(projectsDir, "proj-same-remote-1", [makeEntry({ id: "m1", summary })]);
		writeBrain(projectsDir, "proj-same-remote-2", [makeEntry({ id: "m2", summary })]);

		// Write meta.json pointing to a dir for each other project so getGitRemote is called
		for (const projId of ["proj-same-remote-1", "proj-same-remote-2"]) {
			const projDir = path.join(projectsDir, projId);
			const fakeProjectDir = path.join(tmpDir, projId + "-src");
			fs.mkdirSync(fakeProjectDir, { recursive: true });
			fs.writeFileSync(
				path.join(projDir, "meta.json"),
				JSON.stringify({ projectDir: fakeProjectDir }),
			);
		}

		// All git remote calls return the same remote → not independent
		mockExecFileSync.mockReturnValue(sharedRemote as unknown as Buffer);

		const result = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		// Both other projects are excluded due to same remote, so total independent = 1 (current only)
		expect(result.quarantined).toBe(0);
	});

	it("counts projects with different git remotes as independent", () => {
		const summary = "use exponential backoff when retrying failed API requests";
		const newEntry = makeEntry({ id: "new", summary });

		for (let i = 0; i < 2; i++) {
			const projId = `independent-proj-${i}`;
			const fakeProjectDir = path.join(tmpDir, projId + "-src");
			fs.mkdirSync(fakeProjectDir, { recursive: true });
			writeBrain(projectsDir, projId, [makeEntry({ id: `m${i}`, summary })]);
			fs.writeFileSync(
				path.join(projectsDir, projId, "meta.json"),
				JSON.stringify({ projectDir: fakeProjectDir }),
			);
		}

		// Each project gets a unique remote
		let callCount = 0;
		mockExecFileSync.mockImplementation(() => {
			callCount++;
			return `git@github.com:org/repo-${callCount}.git` as unknown as Buffer;
		});

		const result = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		expect(result.quarantined).toBe(1);
	});
});

describe("scanForCrossProjectKnowledge — word overlap", () => {
	it("quarantines entries with highly similar summaries (Jaccard > 0.7)", () => {
		// Original: "use connection pooling to avoid database connection exhaustion"
		// Match:    "use connection pooling to avoid database connection exhaustion"
		// Jaccard = 1.0 > 0.7 → match
		const summary = "use connection pooling to avoid database connection exhaustion";
		const newEntry = makeEntry({ id: "new", summary });

		writeBrain(projectsDir, "proj-a", [makeEntry({ id: "a", summary })]);
		writeMeta(projectsDir, "proj-a", "git@github.com:org/jacc-a.git");
		writeBrain(projectsDir, "proj-b", [makeEntry({ id: "b", summary })]);
		writeMeta(projectsDir, "proj-b", "git@github.com:org/jacc-b.git");

		let rc4 = 0;
		mockExecFileSync.mockImplementation(() => {
			rc4++;
			return `git@github.com:org/jacc-repo-${rc4}.git` as unknown as Buffer;
		});

		const result = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		expect(result.quarantined).toBe(1);
	});

	it("does not quarantine entries with dissimilar summaries (Jaccard <= 0.7)", () => {
		const newEntry = makeEntry({
			id: "new",
			summary: "always validate environment variables at startup",
		});

		// Other projects have completely different knowledge
		writeBrain(projectsDir, "proj-a", [makeEntry({ id: "a", summary: "use rust for performance critical code" })]);
		writeBrain(projectsDir, "proj-b", [makeEntry({ id: "b", summary: "deploy using kubernetes for orchestration" })]);

		const result = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		expect(result.quarantined).toBe(0);
	});
});


describe("scanForCrossProjectKnowledge — null remote independence", () => {
	it("does not quarantine when all projects have null git remotes (non-git dirs are not independent)", () => {
		const summary = "always use connection pooling for database access efficiency";
		const newEntry = makeEntry({ id: "new", summary });

		// Three other projects with matching entries, but all have null remotes
		for (let i = 0; i < 3; i++) {
			writeBrain(projectsDir, `proj-null-${i}`, [makeEntry({ id: `m${i}`, summary })]);
		}

		// git remote throws for all (no remotes) — mockExecFileSync default is to throw
		mockExecFileSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});

		const result = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);

		// Null remotes are not independent — should NOT quarantine
		expect(result.quarantined).toBe(0);
	});
});

describe("scanForCrossProjectKnowledge — deduplication", () => {
	it("does not create duplicate pending entries when called twice with the same entries", () => {
		const summary = "use exponential backoff when retrying failed network requests";
		const newEntry = makeEntry({ id: "dup-test", summary });

		// Two independent projects with different remotes
		for (let i = 0; i < 2; i++) {
			const projId = `dedup-proj-${i}`;
			const fakeProjectDir = path.join(tmpDir, projId + "-src");
			fs.mkdirSync(fakeProjectDir, { recursive: true });
			writeBrain(projectsDir, projId, [makeEntry({ id: `dm${i}`, summary })]);
			fs.writeFileSync(
				path.join(projectsDir, projId, "meta.json"),
				JSON.stringify({ projectDir: fakeProjectDir }),
			);
		}

		let remoteCounter = 0;
		mockExecFileSync.mockImplementation(() => {
			remoteCounter++;
			return `git@github.com:org/dedup-repo-${remoteCounter}.git` as unknown as Buffer;
		});

		// First call — should quarantine 1 entry
		const first = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);
		expect(first.quarantined).toBe(1);

		// Reset remote counter for second call
		remoteCounter = 0;

		// Second call with same entry — should NOT create a duplicate
		const second = scanForCrossProjectKnowledge([newEntry], "current", tmpDir);
		expect(second.quarantined).toBe(0);

		// Pending file should still have exactly 1 entry
		const pendingPath = path.join(globalDir, "pending.jsonl");
		const lines = fs.readFileSync(pendingPath, "utf-8").trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// promoteQuarantinedEntries
// ---------------------------------------------------------------------------

describe("promoteQuarantinedEntries", () => {
	it("returns 0 when pending.jsonl does not exist", () => {
		const count = promoteQuarantinedEntries(globalDir);
		expect(count).toBe(0);
	});

	it("returns 0 when all pending entries are within the quarantine period", () => {
		const pending: PendingEntry = {
			entry: makeEntry({ id: "fresh", confidence: 0.9 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: new Date().toISOString(), // just now
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		const count = promoteQuarantinedEntries(globalDir);

		expect(count).toBe(0);
		// Entry should still be in pending
		const remaining = fs.readFileSync(path.join(globalDir, "pending.jsonl"), "utf-8").trim();
		expect(remaining.length).toBeGreaterThan(0);
	});

	it("promotes entries after 7-day quarantine period", () => {
		const pending: PendingEntry = {
			entry: makeEntry({ id: "ready", confidence: 0.85 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: daysAgo(8), // 8 days ago — past 7-day threshold
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		const count = promoteQuarantinedEntries(globalDir);

		expect(count).toBe(1);
	});

	it("caps confidence at 0.7 for auto-promoted entries", () => {
		const pending: PendingEntry = {
			entry: makeEntry({ id: "high-conf", confidence: 0.95 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: daysAgo(10),
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		promoteQuarantinedEntries(globalDir);

		const brainPath = path.join(globalDir, "brain.jsonl");
		expect(fs.existsSync(brainPath)).toBe(true);
		const promoted = JSON.parse(fs.readFileSync(brainPath, "utf-8").trim()) as KnowledgeEntry;
		expect(promoted.confidence).toBe(0.7);
	});

	it("does not cap confidence when it is already <= 0.7", () => {
		const pending: PendingEntry = {
			entry: makeEntry({ id: "low-conf", confidence: 0.5 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: daysAgo(8),
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		promoteQuarantinedEntries(globalDir);

		const promoted = JSON.parse(
			fs.readFileSync(path.join(globalDir, "brain.jsonl"), "utf-8").trim(),
		) as KnowledgeEntry;
		expect(promoted.confidence).toBe(0.5);
	});

	it("sets crossProject: true on promoted entries", () => {
		const pending: PendingEntry = {
			entry: makeEntry({ id: "cross", confidence: 0.8 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: daysAgo(8),
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		promoteQuarantinedEntries(globalDir);

		const promoted = JSON.parse(
			fs.readFileSync(path.join(globalDir, "brain.jsonl"), "utf-8").trim(),
		) as KnowledgeEntry;
		expect(promoted.crossProject).toBe(true);
	});

	it("sets promotedFrom to the matching projects array", () => {
		const projects = ["current", "proj-a", "proj-b"];
		const pending: PendingEntry = {
			entry: makeEntry({ id: "pf", confidence: 0.8 }),
			matchingProjects: projects,
			quarantinedAt: daysAgo(8),
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		promoteQuarantinedEntries(globalDir);

		const promoted = JSON.parse(
			fs.readFileSync(path.join(globalDir, "brain.jsonl"), "utf-8").trim(),
		) as KnowledgeEntry;
		expect(promoted.promotedFrom).toEqual(projects);
	});

	it("keeps entries still within quarantine in pending.jsonl after promotion run", () => {
		const readyPending: PendingEntry = {
			entry: makeEntry({ id: "ready", confidence: 0.8 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: daysAgo(8),
		};
		const notReadyPending: PendingEntry = {
			entry: makeEntry({ id: "not-ready", confidence: 0.8 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: new Date().toISOString(), // just now
		};

		const pendingPath = path.join(globalDir, "pending.jsonl");
		fs.writeFileSync(
			pendingPath,
			JSON.stringify(readyPending) + "\n" + JSON.stringify(notReadyPending) + "\n",
			"utf-8",
		);

		const count = promoteQuarantinedEntries(globalDir);

		expect(count).toBe(1);

		// not-ready should still be in pending
		const remainingLines = fs
			.readFileSync(pendingPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(remainingLines).toHaveLength(1);
		const remaining = JSON.parse(remainingLines[0]!) as PendingEntry;
		expect(remaining.entry.id).toBe("not-ready");
	});

	it("empties pending.jsonl when all entries are promoted", () => {
		const pending: PendingEntry = {
			entry: makeEntry({ id: "all-done", confidence: 0.8 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: daysAgo(10),
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		promoteQuarantinedEntries(globalDir);

		const remaining = fs.readFileSync(path.join(globalDir, "pending.jsonl"), "utf-8");
		expect(remaining.trim()).toBe("");
	});

	it("writes a promotion log entry to promotion-log.jsonl", () => {
		const pending: PendingEntry = {
			entry: makeEntry({ id: "logged", confidence: 0.8 }),
			matchingProjects: ["current", "proj-a", "proj-b"],
			quarantinedAt: daysAgo(8),
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pending) + "\n",
			"utf-8",
		);

		promoteQuarantinedEntries(globalDir);

		const logPath = path.join(globalDir, "promotion-log.jsonl");
		expect(fs.existsSync(logPath)).toBe(true);
		const log = JSON.parse(fs.readFileSync(logPath, "utf-8").trim());
		expect(log.method).toBe("auto-promotion");
		expect(log.entryId).toBe("logged");
	});
});

// ---------------------------------------------------------------------------
// loadPendingEntries
// ---------------------------------------------------------------------------

describe("loadPendingEntries", () => {
	it("returns empty array when pending.jsonl does not exist", () => {
		const entries = loadPendingEntries(globalDir);
		expect(entries).toEqual([]);
	});

	it("parses valid pending entries from pending.jsonl", () => {
		const pendingA: PendingEntry = {
			entry: makeEntry({ id: "a", confidence: 0.8 }),
			matchingProjects: ["proj-1", "proj-2", "proj-3"],
			quarantinedAt: daysAgo(3),
		};
		const pendingB: PendingEntry = {
			entry: makeEntry({ id: "b", confidence: 0.7 }),
			matchingProjects: ["proj-1", "proj-4", "proj-5"],
			quarantinedAt: daysAgo(1),
		};

		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			JSON.stringify(pendingA) + "\n" + JSON.stringify(pendingB) + "\n",
			"utf-8",
		);

		const entries = loadPendingEntries(globalDir);

		expect(entries).toHaveLength(2);
		expect(entries[0]!.entry.id).toBe("a");
		expect(entries[1]!.entry.id).toBe("b");
	});

	it("skips malformed lines without throwing", () => {
		fs.writeFileSync(
			path.join(globalDir, "pending.jsonl"),
			'{"valid": true, "entry": {}, "matchingProjects": [], "quarantinedAt": "2026-01-01T00:00:00Z"}\nnot-json-at-all\n',
			"utf-8",
		);

		const entries = loadPendingEntries(globalDir);

		// The valid line has a minimal shape; malformed line silently skipped
		expect(entries).toHaveLength(1);
	});

	it("returns empty array for empty pending.jsonl", () => {
		fs.writeFileSync(path.join(globalDir, "pending.jsonl"), "", "utf-8");

		const entries = loadPendingEntries(globalDir);

		expect(entries).toEqual([]);
	});
});
