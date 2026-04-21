import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrainStore } from "../../src/store/brain-store.js";
import type { BrainIndex, KnowledgeEntry } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueProjectId(): string {
	return `test-${crypto.randomBytes(8).toString("hex")}`;
}

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
	return {
		id: `entry-${crypto.randomBytes(4).toString("hex")}`,
		timestamp: new Date().toISOString(),
		projectId: "test-project",
		category: "pattern",
		summary: "Default test summary",
		reasoning: "Default test reasoning",
		confidence: 0.9,
		files: ["src/index.ts"],
		topics: ["testing"],
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

function makeBrainIndex(projectId: string, overrides: Partial<BrainIndex> = {}): BrainIndex {
	return {
		projectId,
		lastUpdated: new Date().toISOString(),
		entryCount: 0,
		byTopic: {},
		byFile: {},
		byCategory: {},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("BrainStore", () => {
	let projectId: string;
	let storageDir: string;
	let store: BrainStore;

	beforeEach(() => {
		projectId = uniqueProjectId();
		store = new BrainStore(projectId);
		storageDir = path.join(os.homedir(), ".pi-brain", "projects", projectId);
	});

	afterEach(() => {
		fs.rmSync(storageDir, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------

	it("loadEntries returns empty array for new store", () => {
		const entries = store.loadEntries();
		expect(entries).toEqual([]);
	});

	it("appendEntries + loadEntries round-trips entries", () => {
		const a = makeEntry({ id: "id-a", summary: "entry A" });
		const b = makeEntry({ id: "id-b", summary: "entry B" });

		store.appendEntries([a, b]);

		const loaded = store.loadEntries();
		expect(loaded).toHaveLength(2);
		expect(loaded[0]).toEqual(a);
		expect(loaded[1]).toEqual(b);
	});

	it("replaceEntries overwrites all entries", () => {
		const original = makeEntry({ id: "id-original" });
		store.appendEntries([original]);

		const replacement = makeEntry({ id: "id-replacement", summary: "replacement" });
		store.replaceEntries([replacement]);

		const loaded = store.loadEntries();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toEqual(replacement);
	});

	it("replaceEntries with empty array clears the store", () => {
		store.appendEntries([makeEntry()]);
		store.replaceEntries([]);

		const loaded = store.loadEntries();
		expect(loaded).toEqual([]);
	});

	it("updateFeedback changes score for matching entry", () => {
		const entry = makeEntry({ id: "id-target", feedbackScore: 0 });
		store.appendEntries([entry]);

		store.updateFeedback("id-target", 0.25);

		const loaded = store.loadEntries();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]!.feedbackScore).toBe(0.25);
	});

	it("updateFeedback leaves other entries unaffected", () => {
		const a = makeEntry({ id: "id-a", feedbackScore: 0 });
		const b = makeEntry({ id: "id-b", feedbackScore: 0.1 });
		store.appendEntries([a, b]);

		store.updateFeedback("id-a", -0.1);

		const loaded = store.loadEntries();
		const byId = Object.fromEntries(loaded.map((e) => [e.id, e]));
		expect(byId["id-a"]!.feedbackScore).toBe(-0.1);
		expect(byId["id-b"]!.feedbackScore).toBe(0.1);
	});

	it("updateFeedback is no-op for unknown ID", () => {
		const entry = makeEntry({ id: "id-real", feedbackScore: 0.05 });
		store.appendEntries([entry]);

		// Should not throw and should not modify the file.
		store.updateFeedback("id-does-not-exist", 0.99);

		const loaded = store.loadEntries();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]!.feedbackScore).toBe(0.05);
	});

	it("entryCount returns correct count", () => {
		expect(store.entryCount()).toBe(0);

		store.appendEntries([makeEntry(), makeEntry()]);
		expect(store.entryCount()).toBe(2);

		store.appendEntries([makeEntry()]);
		expect(store.entryCount()).toBe(3);

		store.replaceEntries([makeEntry()]);
		expect(store.entryCount()).toBe(1);
	});

	it("loadIndex returns null when no index exists", () => {
		const index = store.loadIndex();
		expect(index).toBeNull();
	});

	it("saveIndex + loadIndex round-trips", () => {
		const index = makeBrainIndex(projectId, {
			entryCount: 3,
			byTopic: { typescript: ["id-1", "id-2"] },
			byFile: { "src/foo.ts": ["id-1"] },
			byCategory: { pattern: ["id-2"] },
		});

		store.saveIndex(index);
		const loaded = store.loadIndex();

		expect(loaded).not.toBeNull();
		expect(loaded!.projectId).toBe(projectId);
		expect(loaded!.entryCount).toBe(3);
		expect(loaded!.byTopic["typescript"]).toEqual(["id-1", "id-2"]);
		expect(loaded!.byFile["src/foo.ts"]).toEqual(["id-1"]);
		expect(loaded!.byCategory["pattern"]).toEqual(["id-2"]);
	});
});
