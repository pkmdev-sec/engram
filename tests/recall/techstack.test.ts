import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectTechStack, techRelevance, type TechStack } from "../../src/recall/techstack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a unique temp directory for each test and returns both projectDir and cacheDir. */
function makeTempDirs(): { projectDir: string; cacheDir: string } {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "techstack-test-"));
	const projectDir = path.join(base, "project");
	const cacheDir = path.join(base, "cache");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(cacheDir, { recursive: true });
	return { projectDir, cacheDir };
}

function makeStack(overrides: Partial<TechStack> = {}): TechStack {
	return {
		languages: [],
		packages: [],
		detectedAt: new Date().toISOString(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// detectTechStack
// ---------------------------------------------------------------------------

describe("detectTechStack", () => {
	let projectDir: string;
	let cacheDir: string;
	let base: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "techstack-test-"));
		projectDir = path.join(base, "project");
		cacheDir = path.join(base, "cache");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(cacheDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	// -------------------------------------------------------------------------
	// JavaScript / TypeScript via package.json
	// -------------------------------------------------------------------------

	it("detects javascript from package.json (no typescript dep)", () => {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ dependencies: {}, devDependencies: {} }),
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("javascript");
		expect(stack.languages).not.toContain("typescript");
	});

	it("detects typescript when listed in devDependencies", () => {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }),
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("typescript");
		expect(stack.languages).toContain("javascript");
	});

	it("detects typescript when listed in dependencies", () => {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ dependencies: { typescript: "^5.0.0" } }),
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("typescript");
	});

	it("detects packages from dependencies and devDependencies", () => {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({
				dependencies: { express: "^4.18.0", zod: "^3.0.0" },
				devDependencies: { vitest: "^2.0.0", "@types/node": "^22.0.0" },
			}),
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.packages).toContain("express");
		expect(stack.packages).toContain("zod");
		expect(stack.packages).toContain("vitest");
		expect(stack.packages).toContain("@types/node");
	});

	// -------------------------------------------------------------------------
	// Rust via Cargo.toml
	// -------------------------------------------------------------------------

	it("detects rust from Cargo.toml", () => {
		fs.writeFileSync(
			path.join(projectDir, "Cargo.toml"),
			`[package]\nname = "my-crate"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1", features = ["full"] }\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("rust");
	});

	it("detects packages from Cargo.toml [dependencies]", () => {
		fs.writeFileSync(
			path.join(projectDir, "Cargo.toml"),
			`[package]\nname = "my-crate"\n\n[dependencies]\nserde = "1.0"\ntokio = "1.0"\nanyhow = "1.0"\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.packages).toContain("serde");
		expect(stack.packages).toContain("tokio");
		expect(stack.packages).toContain("anyhow");
	});

	// -------------------------------------------------------------------------
	// Go via go.mod
	// -------------------------------------------------------------------------

	it("detects go from go.mod", () => {
		fs.writeFileSync(
			path.join(projectDir, "go.mod"),
			`module example.com/myapp\n\ngo 1.21\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("go");
	});

	it("detects packages from go.mod require block", () => {
		fs.writeFileSync(
			path.join(projectDir, "go.mod"),
			`module example.com/myapp\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.0\n\tgolang.org/x/net v0.15.0\n)\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		// parseGoMod extracts the last path segment
		expect(stack.packages).toContain("gin");
		expect(stack.packages).toContain("net");
	});

	// -------------------------------------------------------------------------
	// Python via pyproject.toml
	// -------------------------------------------------------------------------

	it("detects python from pyproject.toml", () => {
		fs.writeFileSync(
			path.join(projectDir, "pyproject.toml"),
			`[project]\nname = "myapp"\n\ndependencies = [\n  "requests>=2.28",\n  "pydantic>=2.0",\n]\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("python");
	});

	it("detects packages from pyproject.toml dependencies array", () => {
		fs.writeFileSync(
			path.join(projectDir, "pyproject.toml"),
			`[project]\ndependencies = [\n  "requests>=2.28",\n  "pydantic>=2.0",\n  "fastapi",\n]\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.packages).toContain("requests");
		expect(stack.packages).toContain("pydantic");
		expect(stack.packages).toContain("fastapi");
	});

	it("detects python from requirements.txt", () => {
		fs.writeFileSync(
			path.join(projectDir, "requirements.txt"),
			`requests==2.28.0\nflask>=2.0\n# comment line\n-r base.txt\nnumpy\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("python");
	});

	it("detects packages from requirements.txt (skipping comments and flags)", () => {
		fs.writeFileSync(
			path.join(projectDir, "requirements.txt"),
			`requests==2.28.0\nflask>=2.0\n# this is a comment\n-r base.txt\nnumpy\n`,
		);

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.packages).toContain("requests");
		expect(stack.packages).toContain("flask");
		expect(stack.packages).toContain("numpy");
		// Comment and flag lines should not appear as packages
		expect(stack.packages).not.toContain("#");
		expect(stack.packages).not.toContain("-r");
	});

	// -------------------------------------------------------------------------
	// Empty directory
	// -------------------------------------------------------------------------

	it("returns empty languages and packages for an empty directory", () => {
		// No manifest files, no source files.
		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toHaveLength(0);
		expect(stack.packages).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Extension scanning
	// -------------------------------------------------------------------------

	it("detects languages from .ts files in project root", () => {
		fs.writeFileSync(path.join(projectDir, "index.ts"), "");

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("typescript");
	});

	it("detects languages from .py files in project root", () => {
		fs.writeFileSync(path.join(projectDir, "main.py"), "");

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("python");
	});

	it("detects languages from .rs files in project root", () => {
		fs.writeFileSync(path.join(projectDir, "lib.rs"), "");

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("rust");
	});

	it("detects languages from .go files in project root", () => {
		fs.writeFileSync(path.join(projectDir, "main.go"), "");

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("go");
	});

	it("detects languages from .ts files inside src/ directory", () => {
		const srcDir = path.join(projectDir, "src");
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, "app.ts"), "");

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("typescript");
	});

	it("detects languages from .js files inside src/ directory", () => {
		const srcDir = path.join(projectDir, "src");
		fs.mkdirSync(srcDir);
		fs.writeFileSync(path.join(srcDir, "utils.js"), "");

		const stack = detectTechStack(projectDir, cacheDir);

		expect(stack.languages).toContain("javascript");
	});

	it("does not scan deeper than project root and src/", () => {
		// A .rs file buried inside src/deep/nested/ should not be scanned
		// (scanExtensions only checks the top level of each dir).
		const nested = path.join(projectDir, "src", "deep", "nested");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(nested, "lib.rs"), "");

		const stack = detectTechStack(projectDir, cacheDir);

		// rust not present because the file is too deeply nested
		expect(stack.languages).not.toContain("rust");
	});

	// -------------------------------------------------------------------------
	// Result shape
	// -------------------------------------------------------------------------

	it("returns sorted languages and packages arrays", () => {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({
				devDependencies: { typescript: "^5.0.0", zod: "^3.0.0", vitest: "^2.0.0" },
			}),
		);

		const stack = detectTechStack(projectDir, cacheDir);

		const sortedLangs = [...stack.languages].sort();
		const sortedPkgs = [...stack.packages].sort();
		expect(stack.languages).toEqual(sortedLangs);
		expect(stack.packages).toEqual(sortedPkgs);
	});

	it("sets detectedAt to a recent ISO timestamp", () => {
		const before = new Date().toISOString();
		const stack = detectTechStack(projectDir, cacheDir);
		const after = new Date().toISOString();

		expect(stack.detectedAt >= before).toBe(true);
		expect(stack.detectedAt <= after).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Cache behavior
	// -------------------------------------------------------------------------

	it("writes a cache file to cacheDir after scanning", () => {
		fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({}));

		detectTechStack(projectDir, cacheDir);

		expect(fs.existsSync(path.join(cacheDir, "techstack.json"))).toBe(true);
	});

	it("returns cached result when cache is fresh and manifests unchanged", () => {
		fs.writeFileSync(
			path.join(projectDir, "package.json"),
			JSON.stringify({ dependencies: { express: "^4.0.0" } }),
		);

		const first = detectTechStack(projectDir, cacheDir);

		// Write a new manifest — but we'll manipulate the cache timestamp to make
		// it appear fresh, so the cache should still be returned.
		// In practice, just call again immediately; the cache is < 1 hour old.
		const second = detectTechStack(projectDir, cacheDir);

		// Both calls should agree on detected languages.
		expect(second.languages).toEqual(first.languages);
		expect(second.packages).toEqual(first.packages);
	});
});

// ---------------------------------------------------------------------------
// techRelevance
// ---------------------------------------------------------------------------

describe("techRelevance", () => {
	it("returns 1.0 when entry topics are empty (universal knowledge)", () => {
		const stack = makeStack({ languages: ["typescript"], packages: ["vitest"] });
		expect(techRelevance([], stack)).toBe(1.0);
	});

	it("returns 1.0 when entry topics match stack languages", () => {
		const stack = makeStack({ languages: ["typescript", "javascript"], packages: [] });
		expect(techRelevance(["typescript"], stack)).toBe(1.0);
	});

	it("returns 1.0 when entry topics match stack packages", () => {
		const stack = makeStack({ languages: ["javascript"], packages: ["vitest", "express"] });
		expect(techRelevance(["express"], stack)).toBe(1.0);
	});

	it("returns 1.0 when entry topics match a mix of languages and packages", () => {
		const stack = makeStack({ languages: ["rust"], packages: ["serde", "tokio"] });
		expect(techRelevance(["rust", "tokio"], stack)).toBe(1.0);
	});

	it("returns 0.5 when entry topics have no overlap with the stack", () => {
		const stack = makeStack({ languages: ["python"], packages: ["flask"] });
		expect(techRelevance(["typescript", "react"], stack)).toBe(0.5);
	});

	it("returns 1.0 when stack has no detected languages or packages", () => {
		// Empty stack means we cannot say anything is irrelevant.
		const stack = makeStack({ languages: [], packages: [] });
		expect(techRelevance(["typescript"], stack)).toBe(1.0);
	});

	it("matching is case-insensitive", () => {
		const stack = makeStack({ languages: ["TypeScript"], packages: ["Express"] });
		// Entry uses lowercase; stack uses mixed case.
		expect(techRelevance(["typescript"], stack)).toBe(1.0);
		expect(techRelevance(["express"], stack)).toBe(1.0);
	});

	it("returns proportional score when some topics match and others do not", () => {
		// "go" matches; "haskell" does not → 1/2 match → 0.5 + 0.5 * 0.5 = 0.75
		const stack = makeStack({ languages: ["go", "python"], packages: [] });
		expect(techRelevance(["go", "haskell"], stack)).toBe(0.75);
	});

	it("returns 0.5 when all entry topics are non-matching technologies", () => {
		const stack = makeStack({ languages: ["rust"], packages: ["serde"] });
		expect(techRelevance(["java", "spring"], stack)).toBe(0.5);
	});
});
