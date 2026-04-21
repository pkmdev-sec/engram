#!/usr/bin/env node
/**
 * pi-brain-agent CLI entry point.
 *
 * Commands:
 *   distill   — Distill a session into knowledge entries
 *   inject    — Inject brain context into a project
 *   show      — Display brain contents for the current project
 *   stats     — Show brain statistics
 *   compact   — Run compaction on the current project's brain
 *   clear     — Clear the brain for the current project
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import type {
	AgentConfig,
	InjectionState,
	KnowledgeEntry,
	SessionMessage,
	SessionTranscript,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

import { distill } from "./distill/distiller.js";
import { BrainStore } from "./store/brain-store.js";
import { buildIndex, queryIndex } from "./store/indexer.js";
import { compact } from "./store/compactor.js";
import { verifyEntries } from "./recall/verifier.js";
import { rankEntries } from "./recall/ranker.js";
import { compose } from "./compose/composer.js";
import { detectDrift } from "./compose/drift-detector.js";
import { injectSessionStart, injectDriftContext } from "./inject/claude-code.js";
import { trackFeedback } from "./feedback/tracker.js";

/** Compute a stable project ID from the working directory path. */
function projectIdFromPath(projectDir: string): string {
	const normalized = path.resolve(projectDir);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Load config — for now, uses defaults. Future: read ~/.pi-brain/config.json */
function loadConfig(): AgentConfig {
	return DEFAULT_CONFIG;
}

/** Parse a Claude Code session JSONL into a SessionTranscript. */
function parseClaudeSession(filePath: string): SessionTranscript {
	const content = readFileSync(filePath, "utf-8");
	const messages: SessionMessage[] = [];
	let sessionId: string | undefined;
	let projectPath: string | undefined;

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (entry.cwd && !projectPath) projectPath = entry.cwd as string;
		if (entry.sessionId && !sessionId) sessionId = entry.sessionId as string;

		const type = entry.type as string | undefined;
		if (type === "user") {
			const msg = entry.message as Record<string, unknown> | undefined;
			const messageContent = typeof msg?.content === "string" ? msg.content : "";
			if (messageContent) {
				messages.push({
					role: "user",
					content: messageContent,
					timestamp: entry.timestamp as string | undefined,
				});
			}
		} else if (type === "assistant") {
			const msg = entry.message as Record<string, unknown> | undefined;
			const contentArr = msg?.content;
			const textParts: string[] = [];
			if (Array.isArray(contentArr)) {
				for (const block of contentArr) {
					if (
						typeof block === "object" &&
						block !== null &&
						(block as Record<string, unknown>).type === "text"
					) {
						const text = (block as Record<string, unknown>).text;
						if (typeof text === "string") textParts.push(text);
					}
				}
			} else if (typeof contentArr === "string") {
				textParts.push(contentArr);
			}
			const joined = textParts.join("\n");
			if (joined) {
				messages.push({
					role: "assistant",
					content: joined,
					timestamp: entry.timestamp as string | undefined,
					model: (msg?.model as string) ?? undefined,
				});
			}
		}
	}

	const idFromPath = path.basename(filePath, ".jsonl");
	return {
		id: sessionId ?? idFromPath,
		source: "claude",
		messages,
		projectPath,
	};
}

// -- Command Handlers --

async function cmdDistill(args: string[]): Promise<void> {
	const sessionPath = args.find((a) => !a.startsWith("--"));
	if (!sessionPath) {
		console.error("Usage: pi-brain-agent distill <session-file.jsonl>");
		process.exit(1);
	}

	const config = loadConfig();
	const transcript = parseClaudeSession(sessionPath);

	if (transcript.messages.length === 0) {
		console.log("No messages in session, nothing to distill.");
		return;
	}

	const projectDir = transcript.projectPath ?? process.cwd();
	const projectId = projectIdFromPath(projectDir);
	const store = new BrainStore(projectId);
	const existingEntries = store.loadEntries();

	console.log(
		`Distilling session ${transcript.id} (${transcript.messages.length} messages)...`,
	);

	const entries = await distill(transcript, config.distillation, existingEntries, projectId);

	if (entries.length === 0) {
		console.log("No extractable knowledge found.");
		return;
	}

	store.appendEntries(entries);
	const allEntries = store.loadEntries();
	const index = buildIndex(allEntries, projectId);
	store.saveIndex(index);

	console.log(`Stored ${entries.length} entries. Total: ${allEntries.length}`);
	for (const entry of entries) {
		console.log(`  [${entry.category}] ${entry.summary}`);
	}

	if (allEntries.length >= config.compaction.triggerThreshold) {
		console.log(
			`Brain has ${allEntries.length} entries (threshold: ${config.compaction.triggerThreshold}). Consider running: pi-brain-agent compact`,
		);
	}
}

async function cmdInject(args: string[]): Promise<void> {
	const event = args.find((a) => a === "start" || a === "message") ?? "start";
	const dryRun = args.includes("--dry-run");
	const projectDir = process.cwd();
	const projectId = projectIdFromPath(projectDir);
	const config = loadConfig();
	const store = new BrainStore(projectId);
	const entries = store.loadEntries();

	if (entries.length === 0) {
		if (event === "start") {
			// Nothing to inject, exit silently for hooks
			return;
		}
		return;
	}

	if (event === "start") {
		const verified = verifyEntries(entries, projectDir);
		const ranked = rankEntries(verified, [], [], config.injection);
		const result = compose(ranked, config.injection, "session-start");

		if (dryRun) {
			console.log(result.text);
			console.log(`\n--- ${result.includedIds.length} entries would be injected ---`);
			return;
		}

		injectSessionStart(projectDir, result.text);

		// Write injection state for drift detection in subsequent messages
		const state: InjectionState = {
			sessionId: `session_${Date.now()}`,
			injectedEntryIds: new Set(result.includedIds),
			injectedFiles: result.files,
			injectedTopics: result.topics,
			injectionTimestamp: new Date().toISOString(),
		};
		writeInjectionState(projectId, state);
	} else if (event === "message") {
		// Read user message from stdin (Claude Code passes it via hook)
		const userMessage = readStdin();
		if (!userMessage) return;

		const state = readInjectionState(projectId);
		if (!state) return; // No session-start injection happened, skip drift

		const drift = detectDrift(userMessage, state);
		if (!drift.drifted) return; // No drift, exit silently

		// Query brain for entries relevant to the new topic
		const index = store.loadIndex();
		if (!index) return;

		const matchedIds = queryIndex(index, drift.newFiles, drift.newTopics);
		if (matchedIds.length === 0) return;

		const matchedEntries = entries.filter((e) => matchedIds.includes(e.id));
		const verified = verifyEntries(matchedEntries, projectDir);
		const ranked = rankEntries(
			verified,
			drift.newFiles,
			drift.newTopics,
			config.injection,
		);
		const result = compose(ranked, config.injection, "drift");

		if (dryRun) {
			console.log(result.text);
			return;
		}

		// Output JSON for Claude Code hook to consume
		console.log(injectDriftContext(result.text));

		// Update injection state with newly covered files/topics
		for (const f of result.files) state.injectedFiles.add(f);
		for (const t of result.topics) state.injectedTopics.add(t);
		for (const id of result.includedIds) state.injectedEntryIds.add(id);
		writeInjectionState(projectId, state);
	}
}

function cmdShow(): void {
	const projectDir = process.cwd();
	const projectId = projectIdFromPath(projectDir);
	const store = new BrainStore(projectId);
	const entries = store.loadEntries();

	if (entries.length === 0) {
		console.log("Brain is empty for this project.");
		return;
	}

	console.log(`Project brain: ${entries.length} entries\n`);
	for (const entry of entries) {
		const age = Math.floor((Date.now() - Date.parse(entry.timestamp)) / 86_400_000);
		const stale = entry.verified?.filesModified ? " [stale]" : "";
		const conf = entry.confidence < 0.7 ? " (unverified)" : "";
		console.log(
			`  [${entry.category}] (imp:${entry.importance.toFixed(2)} fb:${entry.feedbackScore.toFixed(2)} age:${age}d${stale}${conf})`,
		);
		console.log(`    ${entry.summary}`);
		console.log(`    Why: ${entry.reasoning}`);
		if (entry.files.length > 0) console.log(`    Files: ${entry.files.join(", ")}`);
		if (entry.topics.length > 0) console.log(`    Topics: ${entry.topics.join(", ")}`);
		console.log();
	}
}

function cmdStats(): void {
	const projectDir = process.cwd();
	const projectId = projectIdFromPath(projectDir);
	const store = new BrainStore(projectId);
	const entries = store.loadEntries();

	console.log(`Project: ${projectDir}`);
	console.log(`Project ID: ${projectId}`);
	console.log(`Total entries: ${entries.length}`);

	if (entries.length === 0) return;

	const byCat: Record<string, number> = {};
	let totalImportance = 0;
	let totalConfidence = 0;
	let staleCount = 0;

	for (const entry of entries) {
		byCat[entry.category] = (byCat[entry.category] ?? 0) + 1;
		totalImportance += entry.importance;
		totalConfidence += entry.confidence;
		if (entry.verified?.filesModified) staleCount++;
	}

	console.log(`\nBy category:`);
	for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${cat}: ${count}`);
	}

	console.log(`\nAvg importance: ${(totalImportance / entries.length).toFixed(2)}`);
	console.log(`Avg confidence: ${(totalConfidence / entries.length).toFixed(2)}`);
	console.log(`Stale entries: ${staleCount}`);

	const oldestAge = Math.max(
		...entries.map((e) => (Date.now() - Date.parse(e.timestamp)) / 86_400_000),
	);
	console.log(`Oldest entry: ${Math.floor(oldestAge)} days`);
}

async function cmdCompact(): Promise<void> {
	const projectDir = process.cwd();
	const projectId = projectIdFromPath(projectDir);
	const config = loadConfig();
	const store = new BrainStore(projectId);
	const entries = store.loadEntries();

	if (entries.length === 0) {
		console.log("Brain is empty, nothing to compact.");
		return;
	}

	console.log(`Compacting brain (${entries.length} entries)...`);

	const result = await compact(entries, projectDir, config.compaction, config.injection);

	store.replaceEntries(result.entries);
	const index = buildIndex(result.entries, projectId);
	store.saveIndex(index);

	console.log(`Compaction complete:`);
	console.log(`  Before: ${result.before}`);
	console.log(`  Pruned: ${result.pruned}`);
	console.log(`  Merged: ${result.merged}`);
	console.log(`  After:  ${result.after}`);
}

function cmdFeedback(args: string[]): void {
	const sessionPath = args.find((a) => !a.startsWith("--"));
	if (!sessionPath) {
		console.error("Usage: pi-brain-agent feedback <session-file.jsonl>");
		process.exit(1);
	}

	const projectDir = process.cwd();
	const projectId = projectIdFromPath(projectDir);
	const config = loadConfig();
	const store = new BrainStore(projectId);

	// Load injection state to find which entries were injected
	const state = readInjectionState(projectId);
	if (!state || state.injectedEntryIds.size === 0) {
		console.log("No injection state found — feedback tracking requires a prior inject.");
		return;
	}

	// Load the injected entries
	const allEntries = store.loadEntries();
	const injectedEntries = allEntries.filter((e) => state.injectedEntryIds.has(e.id));

	if (injectedEntries.length === 0) {
		console.log("No injected entries found in brain.");
		return;
	}

	// Extract assistant responses from the session
	const transcript = parseClaudeSession(sessionPath);
	const assistantResponses = transcript.messages
		.filter((m) => m.role === "assistant")
		.map((m) => m.content);

	if (assistantResponses.length === 0) {
		console.log("No assistant responses in session, skipping feedback.");
		return;
	}

	const changes = trackFeedback(injectedEntries, assistantResponses, config.feedback);

	if (changes.size === 0) {
		console.log("No feedback score changes.");
		return;
	}

	for (const [entryId, newScore] of changes) {
		store.updateFeedback(entryId, newScore);
	}

	const boosted = [...changes.values()].filter((_, i) => {
		const entryId = [...changes.keys()][i];
		const entry = injectedEntries.find((e) => e.id === entryId);
		return entry && changes.get(entry.id)! > entry.feedbackScore;
	}).length;

	console.log(`Feedback updated: ${changes.size} entries (${boosted} boosted, ${changes.size - boosted} penalized)`);
}

function cmdClear(): void {
	const projectDir = process.cwd();
	const projectId = projectIdFromPath(projectDir);
	const store = new BrainStore(projectId);
	const count = store.entryCount();
	store.replaceEntries([]);
	store.saveIndex(buildIndex([], projectId));
	console.log(`Cleared ${count} entries from brain.`);
}

// -- Injection State Persistence --
// Stored in a temp file per project so drift detection works across hook invocations.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

function injectionStatePath(projectId: string): string {
	const dir = path.join(tmpdir(), "pi-brain-agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return path.join(dir, `state-${projectId}.json`);
}

function writeInjectionState(projectId: string, state: InjectionState): void {
	const serializable = {
		sessionId: state.sessionId,
		injectedEntryIds: [...state.injectedEntryIds],
		injectedFiles: [...state.injectedFiles],
		injectedTopics: [...state.injectedTopics],
		injectionTimestamp: state.injectionTimestamp,
	};
	writeFileSync(injectionStatePath(projectId), JSON.stringify(serializable), "utf-8");
}

function readInjectionState(projectId: string): InjectionState | null {
	const p = injectionStatePath(projectId);
	if (!existsSync(p)) return null;
	try {
		const raw = JSON.parse(readFileSync(p, "utf-8"));
		return {
			sessionId: raw.sessionId,
			injectedEntryIds: new Set(raw.injectedEntryIds),
			injectedFiles: new Set(raw.injectedFiles),
			injectedTopics: new Set(raw.injectedTopics),
			injectionTimestamp: raw.injectionTimestamp,
		};
	} catch {
		return null;
	}
}

function readStdin(): string {
	try {
		return readFileSync(0, "utf-8").trim();
	} catch {
		return "";
	}
}

// -- Main --

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	switch (command) {
		case "distill":
			await cmdDistill(args.slice(1));
			break;
		case "inject":
			await cmdInject(args.slice(1));
			break;
		case "show":
			cmdShow();
			break;
		case "stats":
			cmdStats();
			break;
		case "compact":
			await cmdCompact();
			break;
		case "feedback":
			cmdFeedback(args.slice(1));
			break;
		case "clear":
			cmdClear();
			break;
		case "help":
		case "--help":
		case "-h":
			console.log(`pi-brain-agent — Agent intelligence layer

Commands:
  distill <session.jsonl>      Distill a session into knowledge entries
  inject start [--dry-run]     Inject brain into CLAUDE.md (session start)
  inject message               Detect drift, inject via hook (stdin = user msg)
  compact                      Run compaction (prune + merge) on the brain
  feedback <session.jsonl>     Track which injected entries the agent used
  show                         Display brain contents
  stats                        Show brain statistics
  clear                        Clear the brain for this project
  help                         Show this help

Environment:
  ANTHROPIC_API_KEY            Required for distillation and compaction
`);
			break;
		default:
			console.error(`Unknown command: ${command ?? "(none)"}. Run: pi-brain-agent help`);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
