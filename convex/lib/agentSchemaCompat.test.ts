import { describe, expect, test } from "vitest";
import { deepEqual, schemaProblems, stableStringify, utf8Bytes } from "./agentSchemaCompat";

// The output schema a draft may publish, held to the one the project's code
// parses (made-up schemas). Allowed: add an optional property, widen an enum,
// change a description, drop an optional property; a required one stays
// with its type. Anything else the rules name is refused, at its path.

const CODE = {
  type: "object",
  description: "Codes for a made-up note.",
  required: ["codes", "confidence"],
  properties: {
    codes: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "kind"],
        properties: {
          code: { type: "string", description: "A made-up code." },
          kind: { type: "string", enum: ["cpt", "icd"] },
          note: { type: "string" },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

type Node = { [key: string]: unknown };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** The schema node at a path of keys, to change in place. */
const at = (node: Node, ...keys: string[]): Node => keys.reduce((n, key) => n[key] as Node, node);
const paths = (next: unknown) => schemaProblems(CODE, next).map((issue) => issue.path);

describe("the output schema's compatibility", () => {
  test("the code's own schema passes", () => {
    expect(schemaProblems(CODE, clone(CODE))).toEqual([]);
  });

  test("descriptions, titles and examples may change", () => {
    const next = clone(CODE) as Node;
    next.description = "Another description.";
    next.title = "Made-up output";
    at(next, "properties", "codes", "items", "properties", "code").description = "Changed.";
    at(next, "properties", "codes", "items", "properties", "code").examples = ["99213"];
    expect(schemaProblems(CODE, next)).toEqual([]);
  });

  test("an optional property may be added, at any depth", () => {
    const next = clone(CODE) as Node;
    at(next, "properties").reasoning = { type: "string" };
    at(next, "properties", "codes", "items", "properties").modifier = { type: "string" };
    expect(schemaProblems(CODE, next)).toEqual([]);
  });

  test("an enum may be widened (or dropped, the widest), never narrowed or added: the package's rule", () => {
    const wide = clone(CODE) as Node;
    at(wide, "properties", "codes", "items", "properties", "kind").enum = ["cpt", "icd", "hcpcs"];
    expect(schemaProblems(CODE, wide)).toEqual([]);

    const narrow = clone(CODE) as Node;
    at(narrow, "properties", "codes", "items", "properties", "kind").enum = ["cpt"];
    expect(paths(narrow)).toEqual(["$.codes[].kind"]);

    const dropped = clone(CODE) as Node;
    delete at(dropped, "properties", "codes", "items", "properties", "kind").enum;
    expect(schemaProblems(CODE, dropped)).toEqual([]);

    const added = clone(CODE) as Node;
    at(added, "properties", "codes", "items", "properties", "code").enum = ["99213"];
    expect(paths(added)).toEqual(["$.codes[].code"]);
  });

  test("a required property must stay required, with its type, recursively", () => {
    const optional = clone(CODE) as Node;
    at(optional, "properties", "codes", "items").required = ["code"];
    expect(schemaProblems(CODE, optional)).toEqual([
      { path: "$.codes[].kind", message: "is required by the code and must stay required." },
    ]);

    const retyped = clone(CODE) as Node;
    at(retyped, "properties", "codes", "items", "properties", "code").type = "number";
    expect(schemaProblems(CODE, retyped)).toEqual([
      { path: "$.codes[].code", message: "type must stay string." },
    ]);

    const gone = clone(CODE) as Node;
    delete at(gone, "properties").confidence;
    gone.required = ["codes"];
    expect(schemaProblems(CODE, gone)).toEqual([
      { path: "$.confidence", message: "is required by the code and must stay." },
    ]);
  });

  test("an array's items stay of the same kind", () => {
    const next = clone(CODE) as Node;
    at(next, "properties", "codes").items = { type: "string" };
    expect(paths(next)).toContain("$.codes[]");
  });

  test("an optional property may be dropped; one kept keeps its type", () => {
    const dropped = clone(CODE) as Node;
    delete at(dropped, "properties", "codes", "items", "properties").note;
    expect(schemaProblems(CODE, dropped)).toEqual([]);
    const retyped = clone(CODE) as Node;
    at(retyped, "properties", "codes", "items", "properties", "note").type = "number";
    expect(schemaProblems(CODE, retyped)).toEqual([{ path: "$.codes[].note", message: "type must stay string." }]);
  });

  test("a new property must be optional", () => {
    const next = clone(CODE) as Node;
    at(next, "properties").reasoning = { type: "string" };
    next.required = ["codes", "confidence", "reasoning"];
    expect(schemaProblems(CODE, next)).toEqual([
      { path: "$.reasoning", message: "is new: a new property must be optional." },
    ]);
    const nested = clone(CODE) as Node;
    at(nested, "properties", "codes", "items", "properties").modifier = { type: "string" };
    at(nested, "properties", "codes", "items").required = ["code", "kind", "modifier"];
    expect(paths(nested)).toEqual(["$.codes[].modifier"]);
  });

  test("other keywords, constraints included, are not compared (the package's rules)", () => {
    const changed = clone(CODE) as Node;
    at(changed, "properties", "confidence").maximum = 100;
    at(changed, "properties", "codes", "items", "properties", "code").maxLength = 5;
    changed.additionalProperties = false;
    expect(schemaProblems(CODE, changed)).toEqual([]);
  });

  test("a type list is the same set in any order, and a single type equals a list of one", () => {
    expect(schemaProblems({ type: ["string", "null"] }, { type: ["null", "string"] })).toEqual([]);
    expect(schemaProblems({ type: "string" }, { type: ["string"] })).toEqual([]);
    expect(schemaProblems({ type: "string" }, { type: ["string", "null"] })).toEqual([
      { path: "$", message: "type must stay string." },
    ]);
  });

  test("odd property names are written as quoted keys", () => {
    const code = { type: "object", required: ["a b"], properties: { "a b": { type: "string" } } };
    expect(schemaProblems(code, { type: "object", properties: { "a b": { type: "string" } } })).toEqual([
      { path: '$["a b"]', message: "is required by the code and must stay required." },
    ]);
  });

  test("a schema nested past the depth limit is refused, not walked", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i += 1) deep = { type: "object", properties: { x: deep } };
    const problems = schemaProblems(deep, clone(deep));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toBe("is nested too deeply to check.");
  });

  test("a schema that is not an object is refused where the code's is one", () => {
    expect(schemaProblems(CODE, [])).toEqual([{ path: "$", message: "must stay an object schema, as the code has it." }]);
  });
});

describe("the JSON helpers", () => {
  test("deepEqual ignores key order and nothing else", () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: null }, { a: 0 })).toBe(false);
  });

  test("stableStringify sorts keys at every depth", () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: [2, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[2,{"e":0,"f":1}],"d":1},"b":1}');
  });

  test("utf8Bytes counts bytes, not characters", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
  });
});
