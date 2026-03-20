import { describe, it, expect } from "vitest";
import { generateTyposquatVariants, levenshtein } from "../src/typosquat/generator.js";

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("lodash", "lodash")).toBe(0);
  });

  it("returns correct distance for single edit", () => {
    expect(levenshtein("lodash", "lodahs")).toBe(2); // transposition = 2 ops
    expect(levenshtein("lodash", "lodsh")).toBe(1);  // deletion
    expect(levenshtein("lodash", "loddash")).toBe(1); // insertion
  });

  it("handles empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
  });
});

describe("generateTyposquatVariants", () => {
  it("generates variants for a simple package name", () => {
    const variants = generateTyposquatVariants("lodash");
    expect(variants.length).toBeGreaterThan(0);

    // Should have transposition variants
    const transpositions = variants.filter((v) => v.technique === "transposition");
    expect(transpositions.length).toBeGreaterThan(0);

    // Should have omission variants
    const omissions = variants.filter((v) => v.technique === "omission");
    expect(omissions.length).toBeGreaterThan(0);
  });

  it("generates scope confusion variants for scoped packages", () => {
    const variants = generateTyposquatVariants("@myorg/utils");
    const scopeVariants = variants.filter((v) => v.technique === "scope-confusion");
    expect(scopeVariants.length).toBeGreaterThan(0);
  });

  it("generates separator variants for hyphenated names", () => {
    const variants = generateTyposquatVariants("my-package");
    const separatorVariants = variants.filter((v) =>
      v.technique === "separator-removal" || v.technique === "separator-swap",
    );
    // separator-swap should produce my_package and my.package
    expect(separatorVariants.some((v) => v.variant === "my_package" || v.variant === "my.package")).toBe(true);
    // "mypackage" may be deduped as "omission" (removing the "-" char), but should exist in overall set
    expect(variants.some((v) => v.variant === "mypackage")).toBe(true);
  });

  it("respects maxVariants limit", () => {
    const variants = generateTyposquatVariants("lodash", 5);
    expect(variants.length).toBeLessThanOrEqual(5);
  });

  it("sorts by edit distance (closest first)", () => {
    const variants = generateTyposquatVariants("lodash", 20);
    for (let i = 1; i < variants.length; i++) {
      expect(variants[i].editDistance).toBeGreaterThanOrEqual(variants[i - 1].editDistance);
    }
  });

  it("does not include the original name", () => {
    const variants = generateTyposquatVariants("lodash");
    expect(variants.every((v) => v.variant !== "lodash")).toBe(true);
  });
});
