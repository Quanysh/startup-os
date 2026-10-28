import { describe, expect, test } from "vitest";
import { TEMPLATE_WORDS, parseTemplate, positionOf, renderTemplate } from "./agentTemplate";

// Prompt templates, Protocol v1.2: `{{name}}`, sections `{{#name}}…{{/name}}`
// (shown when the variable is non-empty) and inverted `{{^name}}…{{/name}}`
// (shown when it is empty or absent). No nesting, no loops; a problem is
// named at its exact line and column. Every template here is made up.

describe("positions", () => {
  test("line and column are 1-based, counted from each new line", () => {
    const text = "ab\ncd\n\nef";
    expect(positionOf(text, 0)).toEqual({ line: 1, column: 1 });
    expect(positionOf(text, 1)).toEqual({ line: 1, column: 2 });
    expect(positionOf(text, 3)).toEqual({ line: 2, column: 1 });
    expect(positionOf(text, 7)).toEqual({ line: 4, column: 1 });
  });
});

describe("a template without sections", () => {
  test("variables are read with their places; plain text is no tag", () => {
    const parsed = parseTemplate("Query: {{query}}\nPayer: {{payer}} {single}");
    expect(parsed.issues).toEqual([]);
    expect(parsed.sections).toEqual([]);
    expect(parsed.uses).toEqual([
      { name: "query", line: 1, column: 8 },
      { name: "payer", line: 2, column: 8 },
    ]);
  });

  test("a {{…}} that is not a variable name is refused where it is", () => {
    const parsed = parseTemplate("ok {{query}}\n  {{ query }} {{}} {{#}}");
    expect(parsed.issues).toEqual([
      { line: 2, column: 3, message: TEMPLATE_WORDS.badTag },
      { line: 2, column: 15, message: TEMPLATE_WORDS.badTag },
      { line: 2, column: 20, message: TEMPLATE_WORDS.badTag },
    ]);
  });
});

describe("sections", () => {
  test("a section and an inverted one, each with a variable inside", () => {
    const text = "Base.\n{{#denial}}Denied: {{denial}}.{{/denial}}{{^denial}}No denial given.{{/denial}}";
    const parsed = parseTemplate(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.sections).toEqual([
      { name: "denial", inverted: false, start: 6, end: 6 + "{{#denial}}Denied: {{denial}}.{{/denial}}".length },
      {
        name: "denial",
        inverted: true,
        start: 6 + "{{#denial}}Denied: {{denial}}.{{/denial}}".length,
        end: text.length,
      },
    ]);
    // A section's name is a use of its variable, as a {{name}} inside it is.
    expect(parsed.uses.map((use) => use.name)).toEqual(["denial", "denial", "denial"]);
  });

  test("a section may open again after one closes, and may sit on many lines", () => {
    const parsed = parseTemplate("{{#a}}\none\n{{/a}}\n{{#b}}two{{/b}}");
    expect(parsed.issues).toEqual([]);
    expect(parsed.sections.map((s) => s.name)).toEqual(["a", "b"]);
  });

  test("a section opened inside another is refused: no nesting", () => {
    const parsed = parseTemplate("{{#a}}x\n  {{^b}}y{{/b}}{{/a}}");
    expect(parsed.issues).toEqual([{ line: 2, column: 3, message: TEMPLATE_WORDS.nested("#a") }]);
  });

  test("a close with nothing open, and a close of another name, are refused where they are", () => {
    expect(parseTemplate("text {{/a}}").issues).toEqual([{ line: 1, column: 6, message: TEMPLATE_WORDS.strayClose("a") }]);
    expect(parseTemplate("{{^a}}x{{/b}}").issues).toEqual([
      { line: 1, column: 8, message: TEMPLATE_WORDS.mismatch("b", "^a") },
    ]);
  });

  test("a section never closed is refused at where it opens", () => {
    expect(parseTemplate("one\ntwo {{#denial}} three").issues).toEqual([
      { line: 2, column: 5, message: TEMPLATE_WORDS.unclosed("#denial") },
    ]);
  });

  test("the words never quote what is not a variable name", () => {
    for (const words of [TEMPLATE_WORDS.nested("#a"), TEMPLATE_WORDS.strayClose("a"), TEMPLATE_WORDS.mismatch("b", "^a")]) {
      expect(words).toMatch(/\{\{[#^/]?[a-z]\}\}/);
    }
  });
});

describe("rendering, as Startup OS runs its own agents", () => {
  test("a variable is replaced by its value, and an absent one by nothing", () => {
    expect(renderTemplate("Request: {{request}}.{{missing}}", { request: "made-up" })).toBe("Request: made-up.");
  });

  test("a section shows for a non-empty value, an inverted one for an empty or absent one; whitespace counts", () => {
    const text = "{{#note}}Note: {{note}}{{/note}}{{^note}}No note.{{/note}}";
    expect(renderTemplate(text, { note: "made-up" })).toBe("Note: made-up");
    expect(renderTemplate(text, { note: "" })).toBe("No note.");
    expect(renderTemplate(text, {})).toBe("No note.");
    expect(renderTemplate(text, { note: " " })).toBe("Note:  ");
  });

  test("one pass: a value holding a tag is text, never rendered again", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "made-up" })).toBe("{{b}}");
  });

  test("nothing is trimmed and plain braces stay", () => {
    expect(renderTemplate("  {single} {{a}}\n", { a: "x" })).toBe("  {single} x\n");
  });
});
