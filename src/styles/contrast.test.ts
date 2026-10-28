// @vitest-environment node
import { describe, expect, test } from "vitest";
import { contrast, readTokens, resolve } from "@/test-support/tokens";

// The contrast the two themes are held to, worked out from the token values
// in globals.css (WCAG 2 ratios). A pair is a foreground token on a ground
// token. If a token changes and a pair drops under its floor, this fails.

const tokens = readTokens();
const THEMES = [
  ["light", tokens.light],
  ["dark", tokens.dark],
] as const;

const c = (name: string) => `--color-${name}`;

// Every ground a line of text can sit on.
const PAGE_GROUNDS = ["page", "surface", "panel"].map(c);
const ROW_GROUNDS = ["panel", "table-stripe", "table-hover", "row-danger", "row-warning"].map(c);
const TABLE_GROUNDS = [...ROW_GROUNDS, c("table-head")];
const ALL_GROUNDS = [...new Set([...PAGE_GROUNDS, ...TABLE_GROUNDS])];

const STATES = ["success", "warning", "danger", "info", "neutral"];
const KINDS = ["teal", "violet", "plum", "sand", "slate"];

describe.each(THEMES)("%s theme", (theme, values) => {
  const ratio = (fg: string, bg: string) => contrast(resolve(values, fg), resolve(values, bg));
  /** Each pair is at least `floor`; the failures name the pair and its ratio. */
  const atLeast = (floor: number, pairs: [fg: string, bg: string][]) => {
    const short = pairs
      .map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: Number(ratio(fg, bg).toFixed(2)) }))
      .filter(({ ratio: r }) => r < floor);
    expect(short).toEqual([]);
  };
  const on = (fgs: string[], bgs: string[]) => fgs.flatMap((fg) => bgs.map((bg): [string, string] => [fg, bg]));

  test("body text is 7:1 or more on every ground", () => {
    atLeast(7, on([c("ink")], ALL_GROUNDS));
  });

  test("secondary text is 4.5:1 or more on every ground", () => {
    atLeast(4.5, on([c("ink-2")], ALL_GROUNDS));
  });

  test("muted labels", () => {
    if (theme === "dark") {
      atLeast(4.5, on([c("ink-3")], ALL_GROUNDS));
    } else {
      // The site's own muted grey, ink at 50%: 3:1 on the white panel, which
      // is under the 4.5:1 of small text. It is as it was before there was a
      // dark theme, and the light values are not this change's to move; the
      // floor here only stops it getting worse.
      atLeast(2.5, on([c("ink-3")], ALL_GROUNDS));
    }
  });

  test("links and brand-coloured words are 4.5:1 or more wherever they are used", () => {
    atLeast(4.5, on([c("brand")], [...PAGE_GROUNDS, c("table-stripe"), c("table-hover")]));
  });

  test("a filled button: its words on it, hovered too, and its shape against the page", () => {
    atLeast(4.5, on([c("on-brand")], [c("brand-fill"), c("brand-deep")]));
    atLeast(3, on([c("brand-fill")], PAGE_GROUNDS));
    // The count on the filled Notifications button.
    atLeast(4.5, [[c("brand-fill"), c("on-brand")]]);
  });

  test("the sparkline's bubble: its words on ink", () => {
    atLeast(7, [[c("on-ink"), c("ink")]]);
  });

  test("large numerals (they wear ink) clear 3:1 with room to spare", () => {
    atLeast(3, on([c("ink")], ALL_GROUNDS));
  });

  test("a chip's words are 4.5:1 or more on its own tint and on every row it can sit in", () => {
    for (const name of [...STATES, ...KINDS.map((kind) => `kind-${kind}`)]) {
      atLeast(4.5, on([c(`${name}-ink`)], [c(`${name}-soft`), ...ROW_GROUNDS]));
    }
  });

  test("a kind's dot is 3:1 or more on its own tint", () => {
    atLeast(3, KINDS.map((kind): [string, string] => [c(`kind-${kind}`), c(`kind-${kind}-soft`)]));
  });

  test("an attention row: its bar shows on its ground, and text keeps its contrast there", () => {
    atLeast(3, [
      [c("danger-mark"), c("row-danger")],
      [c("warning-mark"), c("row-warning")],
    ]);
    atLeast(4.5, on([c("ink"), c("ink-2")], [c("row-danger"), c("row-warning")]));
  });

  test("column names are 7:1 on the header band", () => {
    atLeast(7, [[c("table-head-ink"), c("table-head")]]);
  });

  test("chart marks are 3:1 or more on the panel", () => {
    atLeast(3, on(["--chart-1", "--chart-2", c("brand")], [c("panel")]));
  });

  test("status colours", () => {
    if (theme === "dark") {
      // Icons and the odd word in a status colour: 4.5:1 on a dark panel.
      atLeast(4.5, on(["good", "watch", "weak"].map(c), PAGE_GROUNDS));
    } else {
      // As they were: green and amber are under 3:1 on white, which is why a
      // status always comes with an icon and a label (CLAUDE.md), never alone.
      atLeast(2, on(["good", "watch", "weak"].map(c), [c("panel")]));
    }
    atLeast(theme === "dark" ? 4.5 : 4, [["--destructive", c("panel")]]);
  });

  test("lines are there but quiet", () => {
    for (const ground of PAGE_GROUNDS) {
      const r = ratio(c("line"), ground);
      expect(r, `line on ${ground}`).toBeGreaterThanOrEqual(1.1);
      expect(r, `line on ${ground}`).toBeLessThan(2);
    }
    // The line under a table's header is firmer than a row's.
    expect(ratio(c("table-rule"), c("panel"))).toBeGreaterThan(ratio(c("line"), c("panel")));
  });

  test("the focus ring is 3:1 or more against what it is drawn on", () => {
    atLeast(3, on(["--ring"], PAGE_GROUNDS));
  });

  test("shadcn's pairs: each foreground on its ground", () => {
    atLeast(4.5, [
      ["--foreground", "--background"],
      ["--card-foreground", "--card"],
      ["--popover-foreground", "--popover"],
      ["--primary-foreground", "--primary"],
      ["--secondary-foreground", "--secondary"],
      ["--muted-foreground", "--muted"],
      ["--accent-foreground", "--accent"],
      ["--sidebar-foreground", "--sidebar"],
      ["--sidebar-primary-foreground", "--sidebar-primary"],
      ["--sidebar-accent-foreground", "--sidebar-accent"],
    ]);
  });
});

describe("the dark grounds", () => {
  const lum = (name: string) => contrast(resolve(tokens.dark, c(name)), "#000000");
  test("page darkest, then the sidebar and wells, then panels, then what floats", () => {
    expect(lum("page")).toBeLessThan(lum("surface"));
    expect(lum("surface")).toBeLessThan(lum("panel"));
    expect(lum("panel")).toBeLessThan(contrast(resolve(tokens.dark, "--popover"), "#000000"));
  });

  test("not black: every ground has blue in it", () => {
    for (const name of ["page", "surface", "panel"]) {
      const [, r, , b] = /^#(..)(..)(..)$/.exec(resolve(tokens.dark, c(name)))!.map((part) => parseInt(part, 16));
      expect(b!).toBeGreaterThan(r!);
      expect(resolve(tokens.dark, c(name))).not.toBe("#000000");
    }
  });
});
