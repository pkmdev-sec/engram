/**
 * Detects a project's technology stack from manifest files and file extensions.
 * Results are cached to avoid re-scanning on every hook invocation.
 *
 * Used to rank global brain entries by technological relevance — entries
 * matching the project's stack get full importance, non-matching entries
 * get a penalty (soft signal, not hard filter).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TechStack {
	readonly languages: readonly string[];
	readonly packages: readonly string[];
	readonly detectedAt: string;
}

const CACHE_FILE = "techstack.json";

/**
 * Detect the tech stack for a project. Uses a cached result if the cache
 * is less than 1 hour old and the manifest files haven't changed.
 */
export function detectTechStack(projectDir: string, cacheDir: string): TechStack {
	const cachePath = join(cacheDir, CACHE_FILE);
	const cached = loadCache(cachePath);
	if (cached && isCacheFresh(cached, projectDir)) return cached;

	const stack = scan(projectDir);
	try {
		writeFileSync(cachePath, JSON.stringify(stack, null, 2), "utf-8");
	} catch {
		// Cache write failure is non-fatal
	}
	return stack;
}

/**
 * Returns a relevance multiplier for a global entry based on tech stack overlap.
 *   1.0 — entry topics are empty (universal) or match the stack
 *   0.5 — entry mentions technologies not in this project
 */
export function techRelevance(
	entryTopics: readonly string[],
	stack: TechStack,
): number {
	if (entryTopics.length === 0) return 1.0;
	const stackTerms = new Set([...stack.languages, ...stack.packages].map((s) => s.toLowerCase()));
	if (stackTerms.size === 0) return 1.0;
	const matches = entryTopics.filter((t) => stackTerms.has(t.toLowerCase())).length;
	return matches > 0 ? 1.0 : 0.5;
}

// -- Internal --

function loadCache(cachePath: string): TechStack | null {
	if (!existsSync(cachePath)) return null;
	try {
		return JSON.parse(readFileSync(cachePath, "utf-8")) as TechStack;
	} catch {
		return null;
	}
}

function isCacheFresh(cached: TechStack, projectDir: string): boolean {
	const cacheAge = Date.now() - Date.parse(cached.detectedAt);
	if (cacheAge > 3_600_000) return false;
	const manifests = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt"];
	const cacheTime = Date.parse(cached.detectedAt);
	for (const manifest of manifests) {
		try {
			if (statSync(join(projectDir, manifest)).mtimeMs > cacheTime) return false;
		} catch {
			/* file doesn't exist */
		}
	}
	return true;
}

function scan(projectDir: string): TechStack {
	const languages = new Set<string>();
	const packages = new Set<string>();

	parsePackageJson(join(projectDir, "package.json"), languages, packages);
	parseCargoToml(join(projectDir, "Cargo.toml"), languages, packages);
	parseGoMod(join(projectDir, "go.mod"), languages, packages);
	parsePyprojectToml(join(projectDir, "pyproject.toml"), languages, packages);
	parseRequirementsTxt(join(projectDir, "requirements.txt"), languages, packages);
	scanExtensions(projectDir, languages);

	return {
		languages: [...languages].sort(),
		packages: [...packages].sort(),
		detectedAt: new Date().toISOString(),
	};
}

function parsePackageJson(p: string, langs: Set<string>, pkgs: Set<string>): void {
	if (!existsSync(p)) return;
	try {
		const pkg = JSON.parse(readFileSync(p, "utf-8"));
		langs.add("javascript");
		if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) langs.add("typescript");
		for (const name of Object.keys(pkg.dependencies ?? {})) pkgs.add(name);
		for (const name of Object.keys(pkg.devDependencies ?? {})) pkgs.add(name);
	} catch { /* malformed */ }
}

function parseCargoToml(p: string, langs: Set<string>, pkgs: Set<string>): void {
	if (!existsSync(p)) return;
	try {
		const content = readFileSync(p, "utf-8");
		langs.add("rust");
		const depSection = content.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
		if (depSection) {
			for (const m of depSection[1].matchAll(/^([a-zA-Z0-9_-]+)\s*=/gm)) pkgs.add(m[1]);
		}
	} catch { /* malformed */ }
}

function parseGoMod(p: string, langs: Set<string>, pkgs: Set<string>): void {
	if (!existsSync(p)) return;
	try {
		const content = readFileSync(p, "utf-8");
		langs.add("go");
		for (const m of content.matchAll(/^\t([^\s]+)\s/gm)) {
			const parts = m[1].split("/");
			pkgs.add(parts[parts.length - 1]);
		}
	} catch { /* malformed */ }
}

function parsePyprojectToml(p: string, langs: Set<string>, pkgs: Set<string>): void {
	if (!existsSync(p)) return;
	try {
		const content = readFileSync(p, "utf-8");
		langs.add("python");
		const deps = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
		if (deps) {
			for (const m of deps[1].matchAll(/"([a-zA-Z0-9_-]+)/g)) pkgs.add(m[1].toLowerCase());
		}
	} catch { /* malformed */ }
}

function parseRequirementsTxt(p: string, langs: Set<string>, pkgs: Set<string>): void {
	if (!existsSync(p)) return;
	try {
		for (const line of readFileSync(p, "utf-8").split("\n")) {
			const t = line.trim();
			if (!t || t.startsWith("#") || t.startsWith("-")) continue;
			const m = t.match(/^([a-zA-Z0-9_-]+)/);
			if (m) pkgs.add(m[1].toLowerCase());
		}
		langs.add("python");
	} catch { /* malformed */ }
}

function scanExtensions(projectDir: string, langs: Set<string>): void {
	const extMap: Record<string, string> = {
		".ts": "typescript", ".tsx": "typescript",
		".js": "javascript", ".jsx": "javascript",
		".py": "python", ".rs": "rust", ".go": "go",
		".swift": "swift", ".java": "java", ".kt": "kotlin",
		".rb": "ruby", ".php": "php",
	};
	const dirs = [projectDir];
	const srcDir = join(projectDir, "src");
	if (existsSync(srcDir)) dirs.push(srcDir);

	for (const dir of dirs) {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const name = String(entry.name);
				const ext = name.slice(name.lastIndexOf("."));
				if (ext in extMap) langs.add(extMap[ext]);
			}
		} catch { /* permission denied */ }
	}
}
