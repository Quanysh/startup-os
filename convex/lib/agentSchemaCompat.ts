// Whether a draft's output schema can replace the one an agent's code parses
// (Agents Protocol v1.1, docs/agents-protocol.md). The code declares its
// schema in its usage report; a harness version may publish another only if
// whatever the model returns under the new one is still something the code
// can read. These are the package's own rules (@startup/agents v0.3.0), so a
// version the OS lets through is one the project will use: a project given a
// schema it finds incompatible runs the code's schema instead.
//
// - Every property the code requires stays, required, with the same type,
//   recursively through objects and arrays.
// - A property optional in the code may be dropped; where it is kept, it
//   keeps its type, recursively.
// - A property may be added only as optional: a new required one is refused.
// - An enum may be widened (every value the code allows kept); one may not
//   be added where the code has none, or narrowed. Dropping it is the widest
//   widening and is allowed, as in the package.
// - Descriptions (and every keyword not named here) may change.
// Each refusal names the place in the output it is about, as a path into the
// data: `$.codes[].kind`.
//
// Pure: the page shows the result as the schema is typed, and publishing and
// starting a test run ask the same function.

export type SchemaIssue = { path: string; message: string };

/** Deeper than this is refused rather than walked. */
export const MAX_SCHEMA_DEPTH = 32;
/** The most problems reported for one schema. */
export const MAX_SCHEMA_ISSUES = 50;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The number of bytes a string takes in UTF-8. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** JSON with every object's keys sorted, so equal values print the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Whether two JSON values are the same, whatever the order of their keys. */
export const deepEqual = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const child = (path: string, name: string) =>
  IDENTIFIER.test(name) && name.length <= 60 ? `${path}.${name}` : `${path}[${JSON.stringify(name.slice(0, 60))}]`;

const typeSet = (type: unknown): string[] | null => {
  if (typeof type === "string") return [type];
  if (Array.isArray(type) && type.every((t) => typeof t === "string")) return [...new Set(type as string[])].sort();
  return null;
};

const typeWords = (type: unknown): string => {
  const set = typeSet(type);
  return set === null || set.length === 0 ? "as the code has it" : set.join(" or ");
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const SCHEMA_WORDS = {
  deep: "is nested too deeply to check.",
  notObject: "must stay an object schema, as the code has it.",
  required: "is required by the code and must stay required.",
  missing: "is required by the code and must stay.",
  newRequired: "is new: a new property must be optional.",
  enumAdded: "must not add a list of allowed values (enum) the code does not have.",
  enumNarrowed: "must keep every value the code allows (enum); it may add more.",
} as const;

function walk(code: unknown, next: unknown, path: string, depth: number, issues: SchemaIssue[]) {
  if (issues.length >= MAX_SCHEMA_ISSUES) return;
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push({ path, message: SCHEMA_WORDS.deep });
    return;
  }
  // A boolean schema says nothing to compare.
  if (!isObject(code)) return;
  if (!isObject(next)) {
    issues.push({ path, message: SCHEMA_WORDS.notObject });
    return;
  }

  if ("type" in code) {
    const a = typeSet(code.type);
    const b = typeSet(next.type);
    const same = a !== null && b !== null ? a.join("|") === b.join("|") : deepEqual(code.type, next.type);
    if (!same) issues.push({ path, message: `type must stay ${typeWords(code.type)}.` });
  }

  if (Array.isArray(code.enum)) {
    // No enum at all is the widest widening, as the package rules (@startup/agents isCompatible).
    const theirs = Array.isArray(next.enum) ? next.enum : null;
    if ("enum" in next && (theirs === null || !code.enum.every((value) => theirs.some((other) => deepEqual(value, other))))) {
      issues.push({ path, message: SCHEMA_WORDS.enumNarrowed });
    }
  } else if ("enum" in next) {
    issues.push({ path, message: SCHEMA_WORDS.enumAdded });
  }

  const codeProps = isObject(code.properties) ? code.properties : {};
  const nextProps = isObject(next.properties) ? next.properties : {};
  const codeRequired = new Set(strings(code.required));
  const nextRequired = new Set(strings(next.required));
  for (const name of codeRequired) {
    if (!(name in nextProps) && name in codeProps) {
      issues.push({ path: child(path, name), message: SCHEMA_WORDS.missing });
    } else if (!nextRequired.has(name)) {
      issues.push({ path: child(path, name), message: SCHEMA_WORDS.required });
    }
  }
  for (const name of nextRequired) {
    if (!(name in codeProps) && !codeRequired.has(name)) {
      issues.push({ path: child(path, name), message: SCHEMA_WORDS.newRequired });
    }
  }
  // Every property the code has that the draft keeps keeps its type, recursively.
  for (const name of Object.keys(codeProps)) {
    if (name in nextProps) walk(codeProps[name], nextProps[name], child(path, name), depth + 1, issues);
  }

  if (isObject(code.items)) {
    if (isObject(next.items)) walk(code.items, next.items, `${path}[]`, depth + 1, issues);
    else issues.push({ path: `${path}[]`, message: SCHEMA_WORDS.notObject });
  }
}

/**
 * Why `next` cannot replace the code's own schema, by path into the output;
 * empty where it can.
 */
export function schemaProblems(code: unknown, next: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  walk(code, next, "$", 0, issues);
  return issues.slice(0, MAX_SCHEMA_ISSUES);
}
