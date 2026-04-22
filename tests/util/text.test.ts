import { describe, expect, it } from "vitest";
import { intersectionSize, tokenize, wordOverlap } from "../../src/util/text.js";

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe("tokenize", () => {
	it("splits on spaces and lowercases", () => {
		const result = tokenize("Hello World");
		expect(result).toEqual(new Set(["hello", "world"]));
	});

	it("splits on non-word characters (punctuation, brackets, etc.)", () => {
		const result = tokenize("foo.bar-baz_qux (test) [array]");
		// underscore is a word character in \W+ — baz_qux stays together
		expect(result).toEqual(new Set(["foo", "bar", "baz_qux", "test", "array"]));
	});

	it("deduplicates tokens via Set", () => {
		const result = tokenize("the the the same same word");
		expect(result.size).toBe(3);
		expect(result).toEqual(new Set(["the", "same", "word"]));
	});

	it("drops empty tokens from consecutive delimiters", () => {
		const result = tokenize("a...b   c---d");
		expect(result).toEqual(new Set(["a", "b", "c", "d"]));
	});

	it("returns empty Set for empty string", () => {
		expect(tokenize("").size).toBe(0);
	});

	it("returns empty Set for whitespace-only string", () => {
		expect(tokenize("   \t\n  ").size).toBe(0);
	});

	it("returns empty Set for punctuation-only string", () => {
		expect(tokenize("...---!!!").size).toBe(0);
	});

	it("handles unicode by splitting on non-word boundaries", () => {
		const result = tokenize("café résumé");
		// \W+ splits on non-word chars; accented letters may split depending on locale
		// The key behavior: doesn't crash, returns something reasonable
		expect(result.size).toBeGreaterThan(0);
	});

	it("handles numbers as tokens", () => {
		const result = tokenize("version 3 of api2");
		expect(result).toContain("version");
		expect(result).toContain("3");
		expect(result).toContain("of");
		expect(result).toContain("api2");
	});

	it("handles single-character tokens", () => {
		const result = tokenize("a b c");
		expect(result).toEqual(new Set(["a", "b", "c"]));
	});
});

// ---------------------------------------------------------------------------
// wordOverlap (Jaccard similarity)
// ---------------------------------------------------------------------------

describe("wordOverlap", () => {
	it("returns 1.0 for identical strings", () => {
		expect(wordOverlap("hello world", "hello world")).toBe(1.0);
	});

	it("returns 1.0 for both empty strings", () => {
		expect(wordOverlap("", "")).toBe(1.0);
	});

	it("returns 0 when one string is empty and the other is not", () => {
		expect(wordOverlap("hello", "")).toBe(0);
		expect(wordOverlap("", "hello")).toBe(0);
	});

	it("returns 0 for completely disjoint strings", () => {
		expect(wordOverlap("alpha beta gamma", "delta epsilon zeta")).toBe(0);
	});

	it("computes correct Jaccard for partial overlap", () => {
		// "the cat sat" = {the, cat, sat}
		// "the dog sat" = {the, dog, sat}
		// intersection = {the, sat} = 2
		// union = {the, cat, sat, dog} = 4
		// Jaccard = 2/4 = 0.5
		expect(wordOverlap("the cat sat", "the dog sat")).toBe(0.5);
	});

	it("is case-insensitive", () => {
		expect(wordOverlap("Hello World", "hello world")).toBe(1.0);
	});

	it("ignores punctuation differences", () => {
		expect(wordOverlap("hello, world!", "hello world")).toBe(1.0);
	});

	it("is symmetric (a,b === b,a)", () => {
		const a = "the quick brown fox";
		const b = "the lazy brown dog";
		expect(wordOverlap(a, b)).toBe(wordOverlap(b, a));
	});

	it("handles single-word strings", () => {
		expect(wordOverlap("hello", "hello")).toBe(1.0);
		expect(wordOverlap("hello", "world")).toBe(0);
	});

	it("handles duplicate words correctly (Set deduplication)", () => {
		// "a a a" tokenizes to {a}, "a b" tokenizes to {a, b}
		// intersection = 1, union = 2, Jaccard = 0.5
		expect(wordOverlap("a a a", "a b")).toBe(0.5);
	});

	it("returns value between 0 and 1 inclusive", () => {
		const result = wordOverlap("some random text here", "other random words there");
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThanOrEqual(1);
	});

	it("correctly handles near-duplicate summaries", () => {
		const a = "The ORM silently drops fields not in the active migration";
		const b = "The ORM silently drops fields not in the current migration";
		// Very high overlap — one word different
		expect(wordOverlap(a, b)).toBeGreaterThanOrEqual(0.8);
	});

	it("correctly handles completely different summaries", () => {
		const a = "Never import from internal packages across boundaries";
		const b = "The React frontend uses compound component pattern with Context";
		expect(wordOverlap(a, b)).toBeLessThan(0.2);
	});
});

// ---------------------------------------------------------------------------
// intersectionSize
// ---------------------------------------------------------------------------

describe("intersectionSize", () => {
	it("returns 0 for empty items array", () => {
		expect(intersectionSize([], new Set(["a", "b"]))).toBe(0);
	});

	it("returns 0 for empty querySet", () => {
		expect(intersectionSize(["a", "b"], new Set())).toBe(0);
	});

	it("returns 0 when no items match", () => {
		expect(intersectionSize(["x", "y"], new Set(["a", "b"]))).toBe(0);
	});

	it("counts all matches when all items are in querySet", () => {
		expect(intersectionSize(["a", "b", "c"], new Set(["a", "b", "c", "d"]))).toBe(3);
	});

	it("counts partial matches correctly", () => {
		expect(intersectionSize(["a", "b", "c"], new Set(["b", "d"]))).toBe(1);
	});

	it("counts duplicates in items array separately", () => {
		// "a" appears twice in items, and "a" is in the set → counts as 2
		expect(intersectionSize(["a", "a", "b"], new Set(["a"]))).toBe(2);
	});

	it("handles large arrays efficiently", () => {
		const items = Array.from({ length: 1000 }, (_, i) => `item-${i}`);
		const querySet = new Set(items.slice(0, 500));
		expect(intersectionSize(items, querySet)).toBe(500);
	});
});
