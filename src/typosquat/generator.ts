/**
 * Algorithmic typosquat variant generation.
 *
 * Generates plausible misspellings of package names using common attack techniques:
 * - Character transposition (lodash → ldoash)
 * - Character omission (lodash → lodsh)
 * - Character insertion (lodash → loddash)
 * - Character substitution (lodash → 1odash, lodash → lodach)
 * - Homoglyph replacement (lodash → ℓodash)
 * - Scope confusion (@org/pkg → @0rg/pkg)
 */

const CHAR_SUBSTITUTIONS: Record<string, string[]> = {
  a: ["4", "@", "e"],
  b: ["d", "6"],
  c: ["k", "s"],
  d: ["b"],
  e: ["3", "a"],
  g: ["q", "9"],
  i: ["1", "l", "!"],
  l: ["1", "i", "|"],
  o: ["0", "q"],
  s: ["5", "z", "$"],
  t: ["7"],
  u: ["v"],
  z: ["s", "2"],
};

const COMMON_SEPARATORS = ["-", "_", "."];

export interface TyposquatVariant {
  original: string;
  variant: string;
  technique: string;
  editDistance: number;
}

/**
 * Generate all typosquat variants for a package name.
 */
export function generateTyposquatVariants(packageName: string, maxVariants = 50): TyposquatVariant[] {
  const variants = new Map<string, TyposquatVariant>();

  const addVariant = (variant: string, technique: string) => {
    if (variant === packageName || variants.has(variant)) return;
    if (!isValidPackageName(variant)) return;
    variants.set(variant, {
      original: packageName,
      variant,
      technique,
      editDistance: levenshtein(packageName, variant),
    });
  };

  // Extract the local name (after scope)
  const hasScope = packageName.startsWith("@");
  const [scope, localName] = hasScope
    ? [packageName.split("/")[0], packageName.split("/").slice(1).join("/")]
    : ["", packageName];

  const prefix = hasScope ? `${scope}/` : "";

  // 1. Character transposition
  for (let i = 0; i < localName.length - 1; i++) {
    const chars = [...localName];
    [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
    addVariant(prefix + chars.join(""), "transposition");
  }

  // 2. Character omission
  for (let i = 0; i < localName.length; i++) {
    const variant = localName.slice(0, i) + localName.slice(i + 1);
    if (variant.length > 0) {
      addVariant(prefix + variant, "omission");
    }
  }

  // 3. Character insertion (duplicate adjacent chars)
  for (let i = 0; i < localName.length; i++) {
    const variant = localName.slice(0, i) + localName[i] + localName.slice(i);
    addVariant(prefix + variant, "insertion");
  }

  // 4. Character substitution
  for (let i = 0; i < localName.length; i++) {
    const char = localName[i].toLowerCase();
    const subs = CHAR_SUBSTITUTIONS[char];
    if (!subs) continue;
    for (const sub of subs) {
      const variant = localName.slice(0, i) + sub + localName.slice(i + 1);
      addVariant(prefix + variant, "substitution");
    }
  }

  // 5. Separator manipulation
  for (const sep of COMMON_SEPARATORS) {
    if (localName.includes(sep)) {
      // Remove separator
      addVariant(prefix + localName.replaceAll(sep, ""), "separator-removal");
      // Replace with other separators
      for (const altSep of COMMON_SEPARATORS) {
        if (altSep !== sep) {
          addVariant(prefix + localName.replaceAll(sep, altSep), "separator-swap");
        }
      }
    }
  }

  // 6. Scope confusion (if scoped)
  if (hasScope && scope) {
    const scopeChars = scope.slice(1); // Remove @
    for (let i = 0; i < scopeChars.length; i++) {
      const char = scopeChars[i].toLowerCase();
      const subs = CHAR_SUBSTITUTIONS[char];
      if (!subs) continue;
      for (const sub of subs) {
        const variant = `@${scopeChars.slice(0, i)}${sub}${scopeChars.slice(i + 1)}/${localName}`;
        addVariant(variant, "scope-confusion");
      }
    }
  }

  // Sort by edit distance (most similar first) and limit
  return [...variants.values()]
    .sort((a, b) => a.editDistance - b.editDistance)
    .slice(0, maxVariants);
}

function isValidPackageName(name: string): boolean {
  // Basic npm name validation
  if (name.length === 0 || name.length > 214) return false;
  if (name.startsWith(".") || name.startsWith("_")) return false;
  if (/\s/.test(name)) return false;
  return true;
}

/**
 * Levenshtein edit distance.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}
