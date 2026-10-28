import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Reads the colour tokens out of src/styles/globals.css, for the tests that
// hold the two themes to account (src/styles/*.test.ts). Tests only.

export const GLOBALS_CSS = fileURLToPath(new URL("../styles/globals.css", import.meta.url));

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));

/** The text between the braces of the first block that opens with `header`. */
function block(css: string, header: string): { body: string; start: number; end: number } {
  const at = css.search(new RegExp(`(^|\\n)${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`));
  if (at === -1) throw new Error(`globals.css has no "${header} {" block`);
  const start = css.indexOf("{", at) + 1;
  const end = css.indexOf("}", start);
  return { body: css.slice(start, end), start, end };
}

function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(name!, value!.trim().replace(/\s+/g, " "));
  }
  return found;
}

export type Tokens = {
  /** Every custom property of the light theme (`@theme` and `:root`), as written. */
  light: Map<string, string>;
  /** What `.dark` declares, as written. */
  darkOnly: Map<string, string>;
  /** The dark theme in full: the light values with `.dark`'s over them. */
  dark: Map<string, string>;
  /** The stylesheet with those three blocks (and all comments) blanked out. */
  rest: string;
};

export function readTokens(): Tokens {
  const css = withoutComments(readFileSync(GLOBALS_CSS, "utf8"));
  const blocks = ["@theme", ":root", ".dark"].map((header) => block(css, header));
  const [theme, root, dark] = blocks.map((found) => declarations(found.body)) as [
    Map<string, string>,
    Map<string, string>,
    Map<string, string>,
  ];
  const light = new Map([...theme, ...root]);
  let rest = css;
  for (const { start, end } of blocks) {
    rest = rest.slice(0, start) + rest.slice(start, end).replace(/[^\n]/g, " ") + rest.slice(end);
  }
  return { light, darkOnly: dark, dark: new Map([...light, ...dark]), rest };
}

/** A token's value with any `var(--other)` followed to its end. */
export function resolve(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let hops = 0; value !== undefined && hops < 8; hops++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) return value;
    value = tokens.get(ref[1]!);
  }
  throw new Error(`no value for ${name}`);
}

/** Anything that writes a colour out: hex, a colour function, or a bare white/black. */
export const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|(?<![\w-])(?:white|black)(?![\w-])/;

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`not a six-digit hex colour: ${hex}`);
  const n = parseInt(match[1]!, 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2 contrast ratio of two opaque colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
