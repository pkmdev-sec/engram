import { describe, expect, it } from "vitest";

import { extractToolActivity, parseClaudeSessionContent } from "../../src/ingest/session-parser.js";

// -- Helpers --

/** Build a single JSONL line from an object. */
function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

/** Join multiple JSONL lines into a content string. */
function jsonl(...lines: string[]): string {
	return lines.join("\n");
}

/** Minimal user message JSONL entry. */
function userLine(content: string, extras: Record<string, unknown> = {}): string {
	return line({
		type: "user",
		message: { content },
		...extras,
	});
}

/** Minimal assistant message with text content blocks. */
function assistantTextLine(text: string, extras: Record<string, unknown> = {}): string {
	return line({
		type: "assistant",
		message: {
			content: [{ type: "text", text }],
			...extras,
		},
		...extras,
	});
}

/** Assistant message with tool_use content blocks. */
function assistantToolLine(
	tools: Array<{ name: string; input: Record<string, unknown> }>,
	textBefore?: string,
): string {
	const blocks: Record<string, unknown>[] = [];
	if (textBefore) blocks.push({ type: "text", text: textBefore });
	for (const t of tools) {
		blocks.push({ type: "tool_use", name: t.name, input: t.input });
	}
	return line({
		type: "assistant",
		message: { content: blocks },
	});
}

// -- Tests --

describe("parseClaudeSessionContent", () => {
	describe("basic message extraction", () => {
		it("extracts user messages with string content", () => {
			const content = jsonl(userLine("hello world"), userLine("second message"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(2);
			expect(result.messages[0]).toMatchObject({ role: "user", content: "hello world" });
			expect(result.messages[1]).toMatchObject({ role: "user", content: "second message" });
		});

		it("extracts assistant messages with text blocks", () => {
			const content = jsonl(assistantTextLine("I'll help you"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]).toMatchObject({ role: "assistant", content: "I'll help you" });
		});

		it("extracts assistant messages with string content (non-array)", () => {
			const content = jsonl(
				line({
					type: "assistant",
					message: { content: "plain string response" },
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]).toMatchObject({
				role: "assistant",
				content: "plain string response",
			});
		});

		it("concatenates multiple text blocks in a single assistant message", () => {
			const content = jsonl(
				line({
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: "first part" },
							{ type: "text", text: "second part" },
						],
					},
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("first part\nsecond part");
		});

		it("preserves timestamps on messages", () => {
			const content = jsonl(userLine("hello", { timestamp: "2025-01-15T10:00:00Z" }));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages[0]?.timestamp).toBe("2025-01-15T10:00:00Z");
		});

		it("preserves model info on assistant messages", () => {
			const content = jsonl(
				line({
					type: "assistant",
					message: {
						content: [{ type: "text", text: "hi" }],
						model: "claude-opus-4-6",
					},
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages[0]?.model).toBe("claude-opus-4-6");
		});
	});

	describe("user messages with array content", () => {
		it("extracts text from array content blocks", () => {
			const content = jsonl(
				line({
					type: "user",
					message: {
						content: [{ type: "text", text: "please fix this" }],
					},
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("please fix this");
		});

		it("extracts text from tool_result blocks", () => {
			const content = jsonl(
				line({
					type: "user",
					message: {
						content: [{ type: "tool_result", content: "file contents here" }],
					},
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("file contents here");
		});

		it("joins text and tool_result blocks", () => {
			const content = jsonl(
				line({
					type: "user",
					message: {
						content: [
							{ type: "text", text: "part one" },
							{ type: "tool_result", content: "part two" },
						],
					},
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages[0]?.content).toBe("part one\npart two");
		});

		it("skips non-object blocks in content arrays", () => {
			const content = jsonl(
				line({
					type: "user",
					message: {
						content: [null, 42, "bare string", { type: "text", text: "real text" }],
					},
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("real text");
		});
	});

	describe("session metadata", () => {
		it("extracts sessionId from the first entry that has it", () => {
			const content = jsonl(line({ sessionId: "sess-abc123", type: "system" }), userLine("hello"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.id).toBe("sess-abc123");
		});

		it("falls back to filename-based ID when no sessionId is present", () => {
			const content = jsonl(userLine("hello"));
			const result = parseClaudeSessionContent(content, "/path/to/my-session.jsonl");

			expect(result.id).toBe("my-session");
		});

		it("uses first sessionId and ignores subsequent ones", () => {
			const content = jsonl(
				line({ sessionId: "first-id", type: "system" }),
				line({ sessionId: "second-id", type: "system" }),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.id).toBe("first-id");
		});

		it("always sets source to 'claude'", () => {
			const content = jsonl(userLine("hello"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.source).toBe("claude");
		});
	});

	describe("CWD / projectPath validation", () => {
		it("accepts a deep absolute path as projectPath", () => {
			const content = jsonl(line({ cwd: "/Users/dev/project", type: "system" }), userLine("hello"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.projectPath).toBe("/Users/dev/project");
		});

		it("rejects root-level paths (too shallow)", () => {
			// "/Users" has only 2 segments ["", "Users"], need > 2
			const content = jsonl(line({ cwd: "/Users", type: "system" }), userLine("hello"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.projectPath).toBeUndefined();
		});

		it("rejects paths with directory traversal", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/../../../etc/passwd", type: "system" }),
				userLine("hello"),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.projectPath).toBeUndefined();
		});

		it("rejects relative paths (no leading /)", () => {
			const content = jsonl(line({ cwd: "relative/path/here", type: "system" }), userLine("hello"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.projectPath).toBeUndefined();
		});

		it("rejects bare root '/'", () => {
			const content = jsonl(line({ cwd: "/", type: "system" }), userLine("hello"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.projectPath).toBeUndefined();
		});

		it("uses first valid cwd and ignores subsequent ones", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/project-a", type: "system" }),
				line({ cwd: "/Users/dev/project-b", type: "system" }),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.projectPath).toBe("/Users/dev/project-a");
		});
	});

	describe("malformed input handling", () => {
		it("skips non-JSON lines gracefully", () => {
			const content = jsonl("this is not json", userLine("valid message"), "{ broken: json }");
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("valid message");
		});

		it("skips empty lines", () => {
			const content = `\n\n${userLine("hello")}\n\n`;
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
		});

		it("returns empty messages for completely empty content", () => {
			const result = parseClaudeSessionContent("", "test.jsonl");

			expect(result.messages).toHaveLength(0);
			expect(result.projectPath).toBeUndefined();
		});

		it("skips user entries with no message content", () => {
			const content = jsonl(
				line({ type: "user", message: {} }),
				line({ type: "user", message: { content: "" } }),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(0);
		});

		it("skips assistant entries with no text content", () => {
			const content = jsonl(
				line({ type: "assistant", message: { content: [] } }),
				line({ type: "assistant", message: { content: "" } }),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(0);
		});

		it("handles entries with no type field", () => {
			const content = jsonl(line({ message: { content: "no type" } }), userLine("valid"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("valid");
		});

		it("handles entries with no message field", () => {
			const content = jsonl(line({ type: "user" }), userLine("valid"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			// First entry has type user but no message — messageContent stays ""
			// so it's skipped. Only the second entry makes it through.
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("valid");
		});
	});

	describe("tool activity extraction", () => {
		it("extracts Read tool file paths", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/project", type: "system" }),
				assistantToolLine([
					{ name: "Read", input: { file_path: "/Users/dev/project/src/index.ts" } },
				]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesRead).toContain("src/index.ts");
		});

		it("extracts Edit tool file paths", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/project", type: "system" }),
				assistantToolLine([
					{ name: "Edit", input: { file_path: "/Users/dev/project/src/app.ts" } },
				]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesEdited).toContain("src/app.ts");
		});

		it("extracts Write tool file paths", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/project", type: "system" }),
				assistantToolLine([
					{ name: "Write", input: { file_path: "/Users/dev/project/src/new-file.ts" } },
				]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesCreated).toContain("src/new-file.ts");
		});

		it("extracts Glob search patterns", () => {
			const content = jsonl(assistantToolLine([{ name: "Glob", input: { pattern: "**/*.ts" } }]));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.searchPatterns).toContain("**/*.ts");
		});

		it("extracts Grep search patterns", () => {
			const content = jsonl(
				assistantToolLine([{ name: "Grep", input: { pattern: "function\\s+\\w+" } }]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.searchPatterns).toContain("function\\s+\\w+");
		});

		it("extracts Bash command descriptions", () => {
			const content = jsonl(
				assistantToolLine([{ name: "Bash", input: { description: "Run unit tests" } }]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.shellCommands).toContain("Run unit tests");
		});

		it("relativizes paths within the project CWD", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/my-project", type: "system" }),
				assistantToolLine([
					{ name: "Read", input: { file_path: "/Users/dev/my-project/src/foo.ts" } },
				]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesRead).toContain("src/foo.ts");
		});

		it("keeps absolute paths outside the project CWD", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/my-project", type: "system" }),
				assistantToolLine([
					{ name: "Read", input: { file_path: "/Users/dev/.claude/hooks/hook.sh" } },
				]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesRead).toContain("/Users/dev/.claude/hooks/hook.sh");
		});

		it("deduplicates file paths across multiple tool_use blocks", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/project", type: "system" }),
				assistantToolLine([
					{ name: "Read", input: { file_path: "/Users/dev/project/src/index.ts" } },
				]),
				assistantToolLine([
					{ name: "Read", input: { file_path: "/Users/dev/project/src/index.ts" } },
				]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesRead).toEqual(["src/index.ts"]);
		});

		it("caps shell commands at 50", () => {
			const lines: string[] = [];
			for (let i = 0; i < 55; i++) {
				lines.push(assistantToolLine([{ name: "Bash", input: { description: `command ${i}` } }]));
			}
			const content = jsonl(...lines);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.shellCommands).toHaveLength(50);
		});

		it("skips Bash entries with empty description", () => {
			const content = jsonl(assistantToolLine([{ name: "Bash", input: { description: "" } }]));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.shellCommands).toHaveLength(0);
		});

		it("skips tool_use blocks with no name or input", () => {
			const content = jsonl(
				line({
					type: "assistant",
					message: {
						content: [
							{ type: "tool_use" },
							{ type: "tool_use", name: "Read" },
							{ type: "tool_use", input: { file_path: "/f" } },
						],
					},
				}),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesRead).toHaveLength(0);
		});

		it("handles mixed text and tool_use blocks in one assistant message", () => {
			const content = jsonl(
				line({ cwd: "/Users/dev/project", type: "system" }),
				assistantToolLine(
					[{ name: "Read", input: { file_path: "/Users/dev/project/src/main.ts" } }],
					"Let me read the file",
				),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]?.content).toBe("Let me read the file");
			expect(result.toolActivity?.filesRead).toContain("src/main.ts");
		});

		it("ignores unknown tool names", () => {
			const content = jsonl(
				assistantToolLine([{ name: "UnknownTool", input: { file_path: "/some/file" } }]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity?.filesRead).toHaveLength(0);
			expect(result.toolActivity?.filesEdited).toHaveLength(0);
			expect(result.toolActivity?.filesCreated).toHaveLength(0);
			expect(result.toolActivity?.searchPatterns).toHaveLength(0);
			expect(result.toolActivity?.shellCommands).toHaveLength(0);
		});
	});

	describe("toolActivity always present", () => {
		it("returns empty toolActivity even when no tool_use blocks exist", () => {
			const content = jsonl(userLine("hello"));
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.toolActivity).toEqual({
				filesRead: [],
				filesEdited: [],
				filesCreated: [],
				searchPatterns: [],
				shellCommands: [],
			});
		});
	});

	describe("full session integration", () => {
		it("parses a realistic multi-turn session", () => {
			const content = jsonl(
				line({
					sessionId: "sess-42",
					cwd: "/Users/dev/app",
					type: "system",
					timestamp: "2025-01-15T10:00:00Z",
				}),
				userLine("Fix the auth bug in src/auth/login.ts", { timestamp: "2025-01-15T10:01:00Z" }),
				assistantToolLine(
					[{ name: "Read", input: { file_path: "/Users/dev/app/src/auth/login.ts" } }],
					"Let me read the file first.",
				),
				line({
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: "I found the bug. The token validation is missing." },
							{
								type: "tool_use",
								name: "Edit",
								input: { file_path: "/Users/dev/app/src/auth/login.ts" },
							},
						],
					},
					timestamp: "2025-01-15T10:02:00Z",
				}),
				userLine("Looks good, now run the tests", { timestamp: "2025-01-15T10:03:00Z" }),
				assistantToolLine([{ name: "Bash", input: { description: "Run auth test suite" } }]),
			);
			const result = parseClaudeSessionContent(content, "test.jsonl");

			expect(result.id).toBe("sess-42");
			expect(result.source).toBe("claude");
			expect(result.projectPath).toBe("/Users/dev/app");

			// 4 messages: user, assistant, assistant, user
			// (last assistant is tool_use-only with no text → no message emitted)
			expect(result.messages).toHaveLength(4);
			expect(result.messages[0]).toMatchObject({
				role: "user",
				content: "Fix the auth bug in src/auth/login.ts",
			});
			expect(result.messages[1]).toMatchObject({
				role: "assistant",
				content: "Let me read the file first.",
			});
			expect(result.messages[2]).toMatchObject({
				role: "assistant",
				content: "I found the bug. The token validation is missing.",
			});
			expect(result.messages[3]).toMatchObject({
				role: "user",
				content: "Looks good, now run the tests",
			});

			// Tool activity — aggregated across all assistant messages
			expect(result.toolActivity?.filesRead).toContain("src/auth/login.ts");
			expect(result.toolActivity?.filesEdited).toContain("src/auth/login.ts");
			expect(result.toolActivity?.shellCommands).toContain("Run auth test suite");
		});
	});
});

describe("extractToolActivity", () => {
	function callExtract(
		blocks: Array<{ name?: string; input?: Record<string, unknown> }>,
		projectDir = "/project",
	) {
		const filesRead = new Set<string>();
		const filesEdited = new Set<string>();
		const filesCreated = new Set<string>();
		const searchPatterns = new Set<string>();
		const shellCommands: string[] = [];

		for (const block of blocks) {
			extractToolActivity(
				block as Record<string, unknown>,
				projectDir,
				filesRead,
				filesEdited,
				filesCreated,
				searchPatterns,
				shellCommands,
			);
		}

		return {
			filesRead: [...filesRead],
			filesEdited: [...filesEdited],
			filesCreated: [...filesCreated],
			searchPatterns: [...searchPatterns],
			shellCommands,
		};
	}

	it("handles all 6 tool types", () => {
		const result = callExtract([
			{ name: "Read", input: { file_path: "/project/a.ts" } },
			{ name: "Edit", input: { file_path: "/project/b.ts" } },
			{ name: "Write", input: { file_path: "/project/c.ts" } },
			{ name: "Glob", input: { pattern: "*.ts" } },
			{ name: "Grep", input: { pattern: "TODO" } },
			{ name: "Bash", input: { description: "npm test" } },
		]);

		expect(result.filesRead).toEqual(["a.ts"]);
		expect(result.filesEdited).toEqual(["b.ts"]);
		expect(result.filesCreated).toEqual(["c.ts"]);
		expect(result.searchPatterns).toEqual(expect.arrayContaining(["*.ts", "TODO"]));
		expect(result.shellCommands).toEqual(["npm test"]);
	});

	it("returns original path when projectDir is empty", () => {
		const result = callExtract([{ name: "Read", input: { file_path: "/some/abs/path.ts" } }], "");

		expect(result.filesRead).toEqual(["/some/abs/path.ts"]);
	});

	it("strips non-string file_path values", () => {
		const result = callExtract([
			{ name: "Read", input: { file_path: 42 } },
			{ name: "Read", input: { file_path: null } },
			{ name: "Read", input: { file_path: undefined } },
		]);

		expect(result.filesRead).toHaveLength(0);
	});

	it("strips non-string pattern values", () => {
		const result = callExtract([
			{ name: "Glob", input: { pattern: 42 } },
			{ name: "Grep", input: { pattern: null } },
		]);

		expect(result.searchPatterns).toHaveLength(0);
	});
});
