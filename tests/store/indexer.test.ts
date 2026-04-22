import * as crypto from "crypto";
import { describe, expect, it } from "vitest";

import { buildIndex, queryIndex } from "../../src/store/indexer.js";
import type { KnowledgeEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	return {
		id: `entry-${crypto.randomBytes(4).toString("hex")}`,
		timestamp: new Date().toISOString(),
		projectId: "test-project",
		category: "pattern",
		summary: "Default test summary",
		reasoning: "Default test reasoning",
		confidence: 0.9,
		files: [],
		topics: [],
		importance: 0.7,
		feedbackScore: 0,
		sourceSession: {
			tool: "claude",
			sessionId: "session-abc",
			conversationHash: "deadbeef".repeat(8),
		},
		expiresAt: null,
		verified: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

describe("buildIndex", () => {
	it("creates correct topic index", () => {
		const e1 = makeEntry({ id: "e1", topics: ["auth", "jwt"] });
		const e2 = makeEntry({ id: "e2", topics: ["auth", "oauth"] });
		const e3 = makeEntry({ id: "e3", topics: ["database"] });

		const index = buildIndex([e1, e2, e3], "proj");

		expect(index.byTopic["auth"]).toEqual(expect.arrayContaining(["e1", "e2"]));
		expect(index.byTopic["auth"]).toHaveLength(2);
		expect(index.byTopic["jwt"]).toEqual(["e1"]);
		expect(index.byTopic["oauth"]).toEqual(["e2"]);
		expect(index.byTopic["database"]).toEqual(["e3"]);
	});

	it("creates correct file index", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth.ts", "src/index.ts"] });
		const e2 = makeEntry({ id: "e2", files: ["src/auth.ts"] });
		const e3 = makeEntry({ id: "e3", files: ["src/db.ts"] });

		const index = buildIndex([e1, e2, e3], "proj");

		expect(index.byFile["src/auth.ts"]).toEqual(expect.arrayContaining(["e1", "e2"]));
		expect(index.byFile["src/auth.ts"]).toHaveLength(2);
		expect(index.byFile["src/index.ts"]).toEqual(["e1"]);
		expect(index.byFile["src/db.ts"]).toEqual(["e3"]);
	});

	it("creates correct category index", () => {
		const e1 = makeEntry({ id: "e1", category: "constraint" });
		const e2 = makeEntry({ id: "e2", category: "constraint" });
		const e3 = makeEntry({ id: "e3", category: "architecture" });

		const index = buildIndex([e1, e2, e3], "proj");

		expect(index.byCategory["constraint"]).toEqual(expect.arrayContaining(["e1", "e2"]));
		expect(index.byCategory["constraint"]).toHaveLength(2);
		expect(index.byCategory["architecture"]).toEqual(["e3"]);
	});

	it("sets projectId, entryCount, and a non-empty lastUpdated", () => {
		const entries = [makeEntry(), makeEntry(), makeEntry()];
		const index = buildIndex(entries, "my-project");

		expect(index.projectId).toBe("my-project");
		expect(index.entryCount).toBe(3);
		expect(typeof index.lastUpdated).toBe("string");
		expect(index.lastUpdated.length).toBeGreaterThan(0);
	});

	it("produces empty maps for entries with no files or topics", () => {
		const entry = makeEntry({ id: "e1", files: [], topics: [] });
		const index = buildIndex([entry], "proj");

		expect(Object.keys(index.byFile)).toHaveLength(0);
		expect(Object.keys(index.byTopic)).toHaveLength(0);
		expect(index.byCategory[entry.category]).toEqual(["e1"]);
	});

	it("returns empty index for empty entry list", () => {
		const index = buildIndex([], "proj");

		expect(index.entryCount).toBe(0);
		expect(Object.keys(index.byTopic)).toHaveLength(0);
		expect(Object.keys(index.byFile)).toHaveLength(0);
		expect(Object.keys(index.byCategory)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// queryIndex
// ---------------------------------------------------------------------------

describe("queryIndex", () => {
	it("returns matching IDs for files", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth.ts"], topics: [] });
		const e2 = makeEntry({ id: "e2", files: ["src/db.ts"], topics: [] });
		const e3 = makeEntry({ id: "e3", files: ["src/index.ts"], topics: [] });
		const index = buildIndex([e1, e2, e3], "proj");

		const result = queryIndex(index, ["src/auth.ts"], []);

		expect(result).toEqual(["e1"]);
	});

	it("returns matching IDs for topics", () => {
		const e1 = makeEntry({ id: "e1", files: [], topics: ["typescript"] });
		const e2 = makeEntry({ id: "e2", files: [], topics: ["rust"] });
		const index = buildIndex([e1, e2], "proj");

		const result = queryIndex(index, [], ["typescript"]);

		expect(result).toEqual(["e1"]);
	});

	it("deduplicates results when entry matches via both file and topic", () => {
		// e1 appears under byFile["src/auth.ts"] AND byTopic["auth"] — should
		// appear in the result exactly once.
		const e1 = makeEntry({ id: "e1", files: ["src/auth.ts"], topics: ["auth"] });
		const e2 = makeEntry({ id: "e2", files: ["src/db.ts"], topics: ["database"] });
		const index = buildIndex([e1, e2], "proj");

		const result = queryIndex(index, ["src/auth.ts"], ["auth"]);

		expect(result.filter((id) => id === "e1")).toHaveLength(1);
		expect(result).toContain("e1");
	});

	it("deduplicates when the same topic maps to multiple entries", () => {
		const e1 = makeEntry({ id: "e1", files: [], topics: ["auth"] });
		const e2 = makeEntry({ id: "e2", files: [], topics: ["auth"] });
		const index = buildIndex([e1, e2], "proj");

		const result = queryIndex(index, [], ["auth"]);

		// Each ID must appear at most once.
		expect(new Set(result).size).toBe(result.length);
		expect(result).toContain("e1");
		expect(result).toContain("e2");
	});

	it("returns empty for no matches", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth.ts"], topics: ["auth"] });
		const index = buildIndex([e1], "proj");

		const result = queryIndex(index, ["src/unknown.ts"], ["unrelated-topic"]);

		expect(result).toEqual([]);
	});

	it("matches entries in the same directory via prefix", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth/token.ts"], topics: [] });
		const e2 = makeEntry({ id: "e2", files: ["src/db/connection.ts"], topics: [] });
		const index = buildIndex([e1, e2], "proj");

		// Querying for a different file in src/auth/ should match e1
		const result = queryIndex(index, ["src/auth/middleware.ts"], []);

		expect(result).toContain("e1");
		expect(result).not.toContain("e2");
	});

	it("matches entries whose files are in the same directory as the query file", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth/login.ts"], topics: [] });
		const index = buildIndex([e1], "proj");

		// Query file src/auth/logout.ts shares parent dir src/auth/ with e1
		const result = queryIndex(index, ["src/auth/logout.ts"], []);

		expect(result).toContain("e1");
	});

	it("does not match unrelated directories", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth/token.ts"], topics: [] });
		const index = buildIndex([e1], "proj");

		const result = queryIndex(index, ["src/db/connection.ts"], []);

		expect(result).not.toContain("e1");
	});

	it("matches topics case-insensitively", () => {
		const e1 = makeEntry({ id: "e1", files: [], topics: ["Authentication"] });
		const index = buildIndex([e1], "proj");

		const result = queryIndex(index, [], ["authentication"]);

		expect(result).toContain("e1");
	});

	it("matches topics when query is uppercase and index is mixed case", () => {
		const e1 = makeEntry({ id: "e1", files: [], topics: ["Redis"] });
		const index = buildIndex([e1], "proj");

		const result = queryIndex(index, [], ["REDIS"]);

		expect(result).toContain("e1");
	});

	it("returns empty when queried with empty files and topics", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth.ts"], topics: ["auth"] });
		const index = buildIndex([e1], "proj");

		const result = queryIndex(index, [], []);

		expect(result).toEqual([]);
	});

	it("returns union of file and topic matches without duplication", () => {
		const e1 = makeEntry({ id: "e1", files: ["src/auth.ts"], topics: [] });
		const e2 = makeEntry({ id: "e2", files: [], topics: ["database"] });
		const e3 = makeEntry({ id: "e3", files: ["src/utils.ts"], topics: ["unrelated"] });
		const index = buildIndex([e1, e2, e3], "proj");

		const result = queryIndex(index, ["src/auth.ts"], ["database"]);

		expect(result).toHaveLength(2);
		expect(result).toContain("e1");
		expect(result).toContain("e2");
		expect(result).not.toContain("e3");
	});
});
