// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { THEME_COLORS } from "@/lib/theme";
import { COLOUR_LITERAL, readTokens, resolve } from "@/test-support/tokens";

// Keeps the two themes from rotting. A colour is written out in one place,
// the token blocks of globals.css, where it has a light value and a dark one.
// Anywhere else it is a token's name (`bg-panel`, `var(--chart-1)`), which is
// right in both themes. A new hex, `text-white` or `bg-slate-100` in a
// component fails here: give the colour a token (and its dark value) instead.

const SRC = fileURLToPath(new URL("..", import.meta.url));
const tokens = readTokens();

/**
 * The colours that may be written outside the tokens, each with its reason.
 * Keep it this short: a new entry needs a reason a token cannot meet.
 */
const ALLOWED: Record<string, { why: string; colours: string[] }> = {
  "lib/theme.ts": {
    why: "the browser's bar (<meta name=theme-color>) cannot read a CSS variable; checked against --color-page below",
    colours: [THEME_COLORS.light, THEME_COLORS.dark],
  },
  "components/startup-mark.tsx": {
    why: "the logo mark's own gradient, the same artwork on either ground",
    colours: ["white", "#e2e8f0", "#475569"],
  },
  "components/globex-mark.tsx": {
    why: "Globex's logo mark from globex.example.com, its two violets, the same artwork on either ground",
    colours: ["#574AE2", "#654597"],
  },
  "app/signin/page.tsx": {
    why: "Google's 'G', whose four colours its sign-in guidelines fix",
    colours: ["#4285F4", "#34A853", "#FBBC05", "#EA4335"],
  },
};

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PAINTS = "bg|text|border|ring|ring-offset|outline|fill|stroke|from|via|to|shadow|divide|decoration|accent|caret|placeholder";

/** Every way a colour gets written into a component. Each is `g`, for matchAll. */
const WRITTEN: { what: string; pattern: RegExp }[] = [
  { what: "a hex colour", pattern: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b|(?<=["'`])#[0-9a-fA-F]{3,4}(?=["'`])/g },
  { what: "a colour function", pattern: /\b(?:rgba?|hsla?|oklch|oklab|hwb)\(/g },
  { what: "a white or black utility", pattern: new RegExp(`(?<![\\w-])(?:${PAINTS})-(?:white|black)(?![\\w-])`, "g") },
  { what: "a Tailwind palette colour", pattern: new RegExp(`(?<![\\w-])(?:${PAINTS})-(?:${PALETTE})-\\d{2,3}(?![\\w-])`, "g") },
  { what: "an arbitrary colour value", pattern: new RegExp(`(?<![\\w-])(?:${PAINTS})-\\[(?:#|rgb|hsl|oklch)`, "g") },
  {
    what: "a named colour in a paint attribute or style",
    pattern:
      /\b(?:fill|stroke|stopColor|floodColor|color|backgroundColor|borderColor)\s*[=:]\s*\{?\s*["'`](?:white|black|red|green|blue|gr[ae]y|silver|orange|yellow|purple|pink)["'`]/g,
  },
];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    // Tests may name colours (this one does); only what ships is held to it.
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !path.includes("test-support")
      ? [path]
      : [];
  });
}

/** Code with its comments blanked: a colour may be talked about. */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, (line, lead: string) => lead + " ".repeat(line.length - lead.length));

function written(file: string): string[] {
  const text = code(readFileSync(file, "utf8"));
  const allowed = ALLOWED[relative(SRC, file)]?.colours ?? [];
  return WRITTEN.flatMap(({ what, pattern }) =>
    [...text.matchAll(pattern)]
      .filter((match) => !allowed.some((colour) => match[0].endsWith(colour) || match[0].includes(`"${colour}"`)))
      .map((match) => `${relative(SRC, file)}:${text.slice(0, match.index).split("\n").length} ${what}: ${match[0]}`),
  );
}

describe("colours live in the tokens", () => {
  test("no component, page or library file writes a colour out", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(written)).toEqual([]);
  });

  test("the scan catches what it is for", () => {
    const caught = (line: string) => WRITTEN.some(({ pattern }) => new RegExp(pattern.source, "g").test(line));
    for (const bad of [
      'className="bg-white p-2"',
      'className="hover:text-black/60"',
      'className="border-slate-200"',
      'className="bg-[#fafafa]"',
      'style={{ color: "#333" }}',
      'style={{ backgroundColor: "rgba(0,0,0,0.5)" }}',
      '<path fill="#475569" />',
      '<stop stopColor="white" />',
      'const c = "#475569";',
    ]) {
      expect(caught(bad), bad).toBe(true);
    }
    for (const good of [
      'className="bg-panel text-ink shadow-soft"',
      'className="bg-kind-teal-soft text-kind-slate-ink"',
      'className="bg-brand/10 text-on-brand to-market"',
      'style={{ backgroundColor: "var(--chart-1)" }}',
      '<path fill="currentColor" stroke="none" />',
      "see pull request #157 and issue #1234",
      'href="#top"',
    ]) {
      expect(caught(good), good).toBe(false);
    }
  });

  test("every allowed file still exists and still holds the colours it is allowed", () => {
    for (const [file, { colours }] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(SRC, file), "utf8");
      for (const colour of colours) expect(text, `${file} no longer has ${colour}`).toContain(colour);
    }
    expect(Object.keys(ALLOWED)).toHaveLength(4);
  });

  test("the stylesheet writes colours only in its token blocks", () => {
    const stray = tokens.rest
      .split("\n")
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      // `transparent` and `currentColor` are not colours of ours.
      .filter(({ text }) => COLOUR_LITERAL.test(text));
    expect(stray).toEqual([]);
  });
});

describe("every colour has both themes", () => {
  const colourTokens = [...tokens.light].filter(([, value]) => COLOUR_LITERAL.test(value)).map(([name]) => name);

  test("each light token that holds a colour has a dark value", () => {
    expect(colourTokens.length).toBeGreaterThan(80);
    expect(colourTokens.filter((name) => !tokens.darkOnly.has(name))).toEqual([]);
  });

  test("the dark block adds no token the light theme does not have", () => {
    expect([...tokens.darkOnly.keys()].filter((name) => !tokens.light.has(name))).toEqual([]);
  });

  test("every reference in the dark block leads to a colour", () => {
    for (const name of tokens.darkOnly.keys()) expect(() => resolve(tokens.dark, name)).not.toThrow();
  });

  test("both themes declare their color-scheme, so native controls and scrollbars follow", () => {
    const css = readFileSync(join(SRC, "styles/globals.css"), "utf8");
    expect(css).toMatch(/:root \{[^}]*color-scheme: light;/);
    expect(css).toMatch(/\.dark \{\s*color-scheme: dark;/);
  });

  test("the browser's bar is the page colour of each theme", () => {
    expect(THEME_COLORS.light).toBe(resolve(tokens.light, "--color-page"));
    expect(THEME_COLORS.dark).toBe(resolve(tokens.dark, "--color-page"));
  });
});
