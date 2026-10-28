// A prompt template (Agents Protocol v1.2, docs/agents-protocol.md): the
// text a project fills in before it calls a model. Four tags, nothing else:
//
//   {{name}}               the variable's value
//   {{#name}}…{{/name}}    the body, shown when the variable is non-empty
//   {{^name}}…{{/name}}    the body, shown when it is empty or absent
//
// A section's body may hold `{{name}}` tags; sections do not nest and there
// are no loops. A project's package renders its own agents; Startup OS renders
// only the agents it runs itself (`renderTemplate`, with the package's
// semantics: a non-empty string shows a section, whitespace counts, nothing
// is trimmed, one pass). The OS checks every template and says where a
// problem is (line and column, both from 1), so a 40 KB prompt can be fixed.
//
// Pure: the page highlights sections from the same parse.

/** A variable's name: `note`, `payerName`, `visit_type`. */
export const VARIABLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9_]{0,39}$/;

/** Every `{{…}}` in a template, with nothing but braces excluded inside. */
const TAG = /\{\{([^{}]*)\}\}/g;

export type TemplateIssue = { line: number; column: number; message: string };
export type TemplateUse = { name: string; line: number; column: number };
/** A section from the start of its opening tag to the end of its closing one. */
export type TemplateSection = { name: string; inverted: boolean; start: number; end: number };
export type ParsedTemplate = {
  /** Each variable named, in order: `{{name}}`, and a section's own name. */
  uses: TemplateUse[];
  sections: TemplateSection[];
  issues: TemplateIssue[];
};

/** Words for a template's problems. Only a variable name is ever quoted, never what was typed. */
export const TEMPLATE_WORDS = {
  badTag: "uses a {{…}} that is not a variable name.",
  /** `open` is the open section's marker and name: "#denial", "^retry". */
  nested: (open: string) => `opens a section inside {{${open}}}: sections do not nest.`,
  strayClose: (name: string) => `closes {{/${name}}}, but no section is open.`,
  mismatch: (name: string, open: string) => `closes {{/${name}}}, but the open section is {{${open}}}.`,
  unclosed: (open: string) => `opens {{${open}}} and never closes it.`,
} as const;

/** The line and column (both from 1) of a place in a text. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line += 1;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * A template's variables, sections and problems. Every problem says where it
 * is: a tag that is not a variable name, a section opened inside another, a
 * close with nothing open or of another name, a section never closed.
 */
export function parseTemplate(text: string): ParsedTemplate {
  const uses: TemplateUse[] = [];
  const sections: TemplateSection[] = [];
  const issues: TemplateIssue[] = [];
  const at = (offset: number) => positionOf(text, offset);
  let open: { name: string; inverted: boolean; start: number } | null = null;
  // Sections opened inside another are refused once; their closes are not refused again.
  const refusedOpens: string[] = [];
  const marker = (section: { name: string; inverted: boolean }) => `${section.inverted ? "^" : "#"}${section.name}`;

  for (const match of text.matchAll(TAG)) {
    const inner = match[1]!;
    const start = match.index;
    const end = start + match[0].length;
    const sign = inner[0] === "#" || inner[0] === "^" || inner[0] === "/" ? inner[0] : "";
    const name = inner.slice(sign.length);
    if (!VARIABLE_NAME_PATTERN.test(name)) {
      issues.push({ ...at(start), message: TEMPLATE_WORDS.badTag });
      continue;
    }
    if (sign === "") {
      uses.push({ name, ...at(start) });
      continue;
    }
    if (sign === "/") {
      const refused = refusedOpens.lastIndexOf(name);
      if (refused !== -1 && open?.name !== name) refusedOpens.splice(refused, 1);
      else if (open === null) issues.push({ ...at(start), message: TEMPLATE_WORDS.strayClose(name) });
      else if (open.name !== name) {
        // Taken as the open section's close, misnamed: said once, not again as never closed.
        issues.push({ ...at(start), message: TEMPLATE_WORDS.mismatch(name, marker(open)) });
        open = null;
      } else {
        sections.push({ name, inverted: open.inverted, start: open.start, end });
        open = null;
      }
      continue;
    }
    uses.push({ name, ...at(start) });
    if (open !== null) {
      issues.push({ ...at(start), message: TEMPLATE_WORDS.nested(marker(open)) });
      refusedOpens.push(name);
      continue;
    }
    open = { name, inverted: sign === "^", start };
  }
  if (open !== null) issues.push({ ...at(open.start), message: TEMPLATE_WORDS.unclosed(marker(open)) });
  issues.sort((a, b) => a.line - b.line || a.column - b.column);
  return { uses, sections, issues };
}

/** Each `{{name}}` in a stretch of text, replaced by its value (nothing when absent); anything else is left as it is. */
const fill = (text: string, values: Readonly<Record<string, string>>): string =>
  text.replace(TAG, (tag, inner: string) => (VARIABLE_NAME_PATTERN.test(inner) ? (values[inner] ?? "") : tag));

/**
 * A template with its values in (for the agents Startup OS runs itself): a
 * section's body where its value is a non-empty string, an inverted one's
 * where it is empty or absent, each `{{name}}` its value. One pass: a value
 * is text, never read for tags. Only a template the rules let through is
 * rendered, so its sections are well formed.
 */
export function renderTemplate(text: string, values: Readonly<Record<string, string>>): string {
  const { sections } = parseTemplate(text);
  let out = "";
  let from = 0;
  for (const section of [...sections].sort((a, b) => a.start - b.start)) {
    out += fill(text.slice(from, section.start), values);
    const tag = section.name.length + 5;
    const shown = (values[section.name] ?? "") !== "";
    if (shown !== section.inverted) out += fill(text.slice(section.start + tag, section.end - tag), values);
    from = section.end;
  }
  return out + fill(text.slice(from), values);
}
