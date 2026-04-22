/**
 * Auto-promotion: detects when the same knowledge appears in 3+ independent
 * projects and quarantines it for eventual promotion to the global brain.
 *
 * Security constraints (from challenged plan):
 *   - 3+ independent projects required (different git remotes)
 *   - 7-day quarantine in pending.jsonl before entering active global brain
 *   - Auto-promoted entries get confidence capped at 0.7
 *   - user-preference entries are NEVER auto-promoted
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { KnowledgeEntry } from "../types.js";
import { wordOverlap } from "../util/text.js";
import { isValidEntry } from "./brain-store.js";

const PENDING_FILE = "pending.jsonl";
const PROMOTION_LOG = "promotion-log.jsonl";
const OVERLAP_THRESHOLD = 0.7;
const MIN_INDEPENDENT_PROJECTS = 3;
const QUARANTINE_DAYS = 7;

export interface PendingEntry {
	readonly entry: KnowledgeEntry;
	readonly matchingProjects: readonly string[];
	readonly quarantinedAt: string;
}

/**
 * Scan all project brains for entries similar to the newly distilled ones.
 * If an entry matches knowledge in 3+ independent projects, quarantine it
 * for eventual promotion to the global brain.
 *
 * @param newEntries - Entries just distilled from the current session
 * @param currentProjectId - The project that produced these entries
 * @param currentProjectDir - The project directory (for git remote check)
 */
export function scanForCrossProjectKnowledge(
	newEntries: readonly KnowledgeEntry[],
	currentProjectId: string,
	currentProjectDir: string,
): { quarantined: number } {
	if (newEntries.length === 0) return { quarantined: 0 };

	const projectsDir = join(homedir(), ".engram", "projects");
	if (!existsSync(projectsDir)) return { quarantined: 0 };

	// Load all OTHER project brains
	const otherBrains = loadOtherProjectBrains(projectsDir, currentProjectId);
	if (otherBrains.length === 0) return { quarantined: 0 };

	const currentRemote = getGitRemote(currentProjectDir);
	const globalDir = join(homedir(), ".engram", "global");
	let quarantined = 0;

	for (const entry of newEntries) {
		// Never auto-promote user-preference entries
		if (entry.category === "user-preference") continue;

		// Find matching entries across other projects
		const matchingProjectIds: string[] = [];

		for (const { projectId, entries: brainEntries, remote } of otherBrains) {
			// Independence check: null remotes mean non-git dirs, which are not independent
			if (!currentRemote || !remote || currentRemote === remote) continue;

			const hasMatch = brainEntries.some(
				(other) => wordOverlap(entry.summary, other.summary) > OVERLAP_THRESHOLD,
			);
			if (hasMatch) {
				matchingProjectIds.push(projectId);
			}
		}

		// Need 3+ projects total (current + 2 others = 3, so need >= 2 other matches)
		// Actually: 3+ independent projects means current project counts as 1
		if (matchingProjectIds.length + 1 >= MIN_INDEPENDENT_PROJECTS) {
			const allProjects = [currentProjectId, ...matchingProjectIds];

			// Dedup: skip if already pending with similar summary
			const existingPending = loadPendingEntries(globalDir);
			const alreadyPending = existingPending.some(
				(p) => wordOverlap(entry.summary, p.entry.summary) > OVERLAP_THRESHOLD,
			);
			if (alreadyPending) continue;

			quarantineEntry(entry, allProjects, globalDir);
			quarantined++;
		}
	}

	return { quarantined };
}

/**
 * Check pending entries and promote those that have completed the 7-day quarantine.
 * Returns the number of entries promoted.
 */
export function promoteQuarantinedEntries(globalDir: string): number {
	const pendingPath = join(globalDir, PENDING_FILE);
	if (!existsSync(pendingPath)) return 0;

	let content: string;
	try {
		content = readFileSync(pendingPath, "utf-8");
	} catch {
		return 0;
	}

	const pending: PendingEntry[] = [];
	const promoted: PendingEntry[] = [];
	const now = Date.now();

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as PendingEntry;
			const quarantineAge = (now - Date.parse(entry.quarantinedAt)) / 86_400_000;
			if (quarantineAge >= QUARANTINE_DAYS) {
				promoted.push(entry);
			} else {
				pending.push(entry);
			}
		} catch {
			// Malformed line — skip
		}
	}

	if (promoted.length === 0) return 0;

	// Write promoted entries to the active global brain
	const brainPath = join(globalDir, "brain.jsonl");
	const logPath = join(globalDir, PROMOTION_LOG);

	for (const p of promoted) {
		// Cap confidence at 0.7 for auto-promoted entries
		const promotedEntry: KnowledgeEntry = {
			...p.entry,
			confidence: Math.min(p.entry.confidence, 0.7),
			crossProject: true,
			promotedFrom: p.matchingProjects,
		};
		appendFileSync(brainPath, `${JSON.stringify(promotedEntry)}\n`, "utf-8");

		// Log the promotion
		const logEntry = {
			timestamp: new Date().toISOString(),
			entryId: promotedEntry.id,
			category: promotedEntry.category,
			summary: promotedEntry.summary,
			method: "auto-promotion",
			matchingProjects: p.matchingProjects,
			quarantineDays: Math.floor((now - Date.parse(p.quarantinedAt)) / 86_400_000),
		};
		appendFileSync(logPath, `${JSON.stringify(logEntry)}\n`, "utf-8");
	}

	// Rewrite pending file with remaining entries
	const remainingPayload =
		pending.length > 0 ? `${pending.map((p) => JSON.stringify(p)).join("\n")}\n` : "";
	writeFileSync(pendingPath, remainingPayload, "utf-8");

	return promoted.length;
}

/**
 * Load pending entries for display.
 */
export function loadPendingEntries(globalDir: string): PendingEntry[] {
	const pendingPath = join(globalDir, PENDING_FILE);
	if (!existsSync(pendingPath)) return [];

	const entries: PendingEntry[] = [];
	try {
		for (const line of readFileSync(pendingPath, "utf-8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				entries.push(JSON.parse(trimmed) as PendingEntry);
			} catch {
				// Skip malformed
			}
		}
	} catch {
		return [];
	}
	return entries;
}

// -- Internal --

interface ProjectBrain {
	projectId: string;
	entries: KnowledgeEntry[];
	remote: string | null;
}

function loadOtherProjectBrains(projectsDir: string, currentProjectId: string): ProjectBrain[] {
	const brains: ProjectBrain[] = [];

	try {
		for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
			const name = String(entry.name);
			if (!entry.isDirectory() || name === currentProjectId) continue;

			const brainPath = join(projectsDir, name, "brain.jsonl");
			if (!existsSync(brainPath)) continue;

			try {
				const content = readFileSync(brainPath, "utf-8");
				const entries: KnowledgeEntry[] = [];
				for (const line of content.split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const parsed = JSON.parse(trimmed);
						if (isValidEntry(parsed)) {
							entries.push(parsed);
						}
					} catch {
						// Skip
					}
				}
				if (entries.length > 0) {
					// Try to find the project dir from the first entry's metadata
					const projectDir = findProjectDir(join(projectsDir, name));
					brains.push({
						projectId: name,
						entries,
						remote: projectDir ? getGitRemote(projectDir) : null,
					});
				}
			} catch {
				// Skip unreadable brains
			}
		}
	} catch {
		// Can't read projects dir
	}

	return brains;
}

/** Extract project directory from brain metadata file if available. */
function findProjectDir(projectDir: string): string | null {
	const metaPath = join(projectDir, "meta.json");
	if (!existsSync(metaPath)) return null;
	try {
		const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
		return typeof meta.projectDir === "string" ? meta.projectDir : null;
	} catch {
		return null;
	}
}

function getGitRemote(projectDir: string): string | null {
	try {
		const output = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: projectDir,
			encoding: "utf-8",
		});
		return output.trim() || null;
	} catch {
		return null;
	}
}

function quarantineEntry(
	entry: KnowledgeEntry,
	matchingProjects: string[],
	globalDir: string,
): void {
	const pendingPath = join(globalDir, PENDING_FILE);
	const pending: PendingEntry = {
		entry,
		matchingProjects,
		quarantinedAt: new Date().toISOString(),
	};
	appendFileSync(pendingPath, `${JSON.stringify(pending)}\n`, "utf-8");
}
