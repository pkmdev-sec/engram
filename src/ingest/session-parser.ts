/**
 * Parses Claude Code session JSONL files into structured SessionTranscript objects.
 *
 * Handles multiple content block formats (string, array of text/tool_result),
 * extracts tool activity from tool_use blocks, validates CWD paths against
 * traversal attacks, and gracefully skips malformed JSON lines.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import type { SessionMessage, SessionTranscript } from "../types.js";

/** Parse a Claude Code session JSONL file into a SessionTranscript. */
export function parseClaudeSession(filePath: string): SessionTranscript {
	const content = readFileSync(filePath, "utf-8");
	return parseClaudeSessionContent(content, filePath);
}

/**
 * Parse JSONL content string into a SessionTranscript.
 *
 * Separated from file I/O so it can be tested without touching the filesystem.
 */
export function parseClaudeSessionContent(
	content: string,
	filePathOrId: string,
): SessionTranscript {
	const messages: SessionMessage[] = [];
	let sessionId: string | undefined;
	let projectPath: string | undefined;

	const filesRead = new Set<string>();
	const filesEdited = new Set<string>();
	const filesCreated = new Set<string>();
	const searchPatterns = new Set<string>();
	const shellCommands: string[] = [];

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (entry.cwd && !projectPath) {
			const cwd = entry.cwd as string;
			// Reject suspicious cwd values — must be a deep absolute path, not root or traversal
			if (cwd.startsWith("/") && cwd.split("/").length > 2 && !cwd.includes("..")) {
				projectPath = cwd;
			}
		}
		if (entry.sessionId && !sessionId) sessionId = entry.sessionId as string;

		const type = entry.type as string | undefined;
		if (type === "user") {
			const msg = entry.message as Record<string, unknown> | undefined;
			const rawContent = msg?.content;
			let messageContent = "";
			if (typeof rawContent === "string") {
				messageContent = rawContent;
			} else if (Array.isArray(rawContent)) {
				// Extract text from array content blocks (tool_result, text, etc.)
				const parts: string[] = [];
				for (const block of rawContent) {
					if (typeof block !== "object" || block === null) continue;
					const b = block as Record<string, unknown>;
					if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
					if (b.type === "tool_result" && typeof b.content === "string") parts.push(b.content);
				}
				messageContent = parts.join("\n");
			}
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
					if (typeof block !== "object" || block === null) continue;
					const b = block as Record<string, unknown>;
					if (b.type === "text") {
						const text = b.text;
						if (typeof text === "string") textParts.push(text);
					} else if (b.type === "tool_use") {
						extractToolActivity(
							b,
							projectPath ?? "",
							filesRead,
							filesEdited,
							filesCreated,
							searchPatterns,
							shellCommands,
						);
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

	const idFromPath = path.basename(filePathOrId, ".jsonl");
	return {
		id: sessionId ?? idFromPath,
		source: "claude",
		messages,
		projectPath,
		toolActivity: {
			filesRead: [...filesRead],
			filesEdited: [...filesEdited],
			filesCreated: [...filesCreated],
			searchPatterns: [...searchPatterns],
			shellCommands,
		},
	};
}

/** Extract file paths and patterns from a tool_use content block. */
export function extractToolActivity(
	block: Record<string, unknown>,
	projectDir: string,
	filesRead: Set<string>,
	filesEdited: Set<string>,
	filesCreated: Set<string>,
	searchPatterns: Set<string>,
	shellCommands: string[],
): void {
	const name = block.name as string | undefined;
	const input = block.input as Record<string, unknown> | undefined;
	if (!name || !input) return;

	const strip = (abs: string): string => {
		if (projectDir && abs.startsWith(projectDir)) {
			const rel = abs.slice(projectDir.length).replace(/^\//, "");
			return rel || abs;
		}
		return abs;
	};

	switch (name) {
		case "Read": {
			const fp = input.file_path;
			if (typeof fp === "string") filesRead.add(strip(fp));
			break;
		}
		case "Edit": {
			const fp = input.file_path;
			if (typeof fp === "string") filesEdited.add(strip(fp));
			break;
		}
		case "Write": {
			const fp = input.file_path;
			if (typeof fp === "string") filesCreated.add(strip(fp));
			break;
		}
		case "Glob": {
			const pat = input.pattern;
			if (typeof pat === "string") searchPatterns.add(pat);
			break;
		}
		case "Grep": {
			const pat = input.pattern;
			if (typeof pat === "string") searchPatterns.add(pat);
			break;
		}
		case "Bash": {
			const desc = input.description;
			if (typeof desc === "string" && desc.length > 0 && shellCommands.length < 50) {
				shellCommands.push(desc);
			}
			break;
		}
	}
}
