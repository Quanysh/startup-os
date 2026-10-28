import { describe, expect, test } from "vitest";
import {
  HARNESS_WORDS,
  MAX_TOOLS,
  configHarnessOf,
  defaultsFromWire,
  defaultsKey,
  defaultsProblems,
  draftVersionName,
  effectiveOf,
  harnessDefaultsWire,
  harnessProblems,
  isCodeDefault,
  jobHarnessOf,
  paramsProblems,
  partsAgainst,
  patientDataOnly,
  placeholdersOf,
  promptProblems,
  toolProblems,
  versionName,
  codeVariantsOf,
  inputOf,
  providerToolsOf,
  variantNames,
  type HarnessDefaults,
} from "./agentHarness";
import { TEMPLATE_WORDS } from "./agentTemplate";

// An agent's harness: the code's defaults as a project reports them, what a
// version may change, the rules publishing is held to, and what is sent.
// Every prompt, tool and schema is made up.

const SCHEMA = {
  type: "object",
  required: ["codes"],
  properties: { codes: { type: "array", items: { type: "string" } } },
};

const WIRE = {
  prompt: {
    version: "v1+2e092415",
    system: "You code made-up notes.",
    user: "Note: {{note}}\nPayer: {{payer}}",
    variables: [
      { name: "note", required: true },
      { name: "payer", required: false },
    ],
  },
  params: { temperature: 0.2, maxOutputTokens: 2048, thinkingBudget: 1024, timeoutMs: 60000, retries: 1 },
  tools: [
    { id: "web_search", name: "Web search", description: "Searches the web.", phi: false },
    { id: "chart_lookup", name: "Chart lookup", description: "Reads the chart.", phi: true },
  ],
  defaultTools: ["web_search"],
  output: { schemaVersion: "1", schema: SCHEMA },
};

const DEFAULTS: HarnessDefaults = defaultsFromWire(harnessDefaultsWire.parse(WIRE));

describe("the code's defaults on the wire", () => {
  test("the example from the protocol parses, and is stored with its schema as JSON text", () => {
    expect(DEFAULTS.output).toEqual({ schemaVersion: "1", schema: JSON.stringify(SCHEMA) });
    expect(DEFAULTS.prompt?.variables).toHaveLength(2);
    expect(DEFAULTS.params).toEqual(WIRE.params);
  });

  test("every part is optional; within a part, every field is required", () => {
    expect(harnessDefaultsWire.safeParse({}).success).toBe(true);
    expect(harnessDefaultsWire.safeParse({ params: {} }).success).toBe(true);
    expect(harnessDefaultsWire.safeParse({ prompt: { version: "v1", system: "", user: "" } }).success).toBe(false);
    expect(harnessDefaultsWire.safeParse({ output: { schema: SCHEMA } }).success).toBe(false);
  });

  test("bounds: templates, variables, tools, schema and params", () => {
    const fails = (over: Record<string, unknown>) => !harnessDefaultsWire.safeParse({ ...WIRE, ...over }).success;
    expect(fails({ prompt: { ...WIRE.prompt, system: "x".repeat(128 * 1024) } })).toBe(false);
    expect(fails({ prompt: { ...WIRE.prompt, system: "x".repeat(128 * 1024 + 1) } })).toBe(true);
    expect(fails({ prompt: { ...WIRE.prompt, user: "é".repeat(64 * 1024 + 1) } })).toBe(true);
    const vars = Array.from({ length: 31 }, (_, i) => ({ name: `v${i}`, required: false }));
    expect(fails({ prompt: { ...WIRE.prompt, variables: vars } })).toBe(true);
    expect(fails({ prompt: { ...WIRE.prompt, variables: [{ name: "Note", required: true }] } })).toBe(true);
    expect(fails({ prompt: { ...WIRE.prompt, variables: [{ name: "a".repeat(41), required: true }] } })).toBe(true);
    const tools = Array.from({ length: MAX_TOOLS + 1 }, (_, i) => ({ id: `t${i}`, name: "T", description: "", phi: false }));
    expect(fails({ tools })).toBe(true);
    expect(fails({ output: { schemaVersion: "1", schema: { description: "x".repeat(64 * 1024) } } })).toBe(true);
    expect(fails({ output: { schemaVersion: "1", schema: [] } })).toBe(true);
    expect(fails({ params: { temperature: 2.1 } })).toBe(true);
    expect(fails({ params: { maxOutputTokens: 1.5 } })).toBe(true);
    expect(fails({ params: { retries: 4 } })).toBe(true);
    expect(fails({ params: { topK: 4 } })).toBe(true);
    expect(fails({ extra: true })).toBe(true);
  });

  test("no variable or tool twice, and the default tools are declared ones", () => {
    const wire = harnessDefaultsWire.parse({
      ...WIRE,
      prompt: { ...WIRE.prompt, variables: [WIRE.prompt.variables[0], WIRE.prompt.variables[0]] },
      tools: [WIRE.tools[0], WIRE.tools[0]],
      defaultTools: ["web_search", "nope"],
    });
    expect(defaultsProblems(wire, "h").map((issue) => issue.path)).toEqual([
      "h.prompt.variables.1",
      "h.tools.1",
      "h.defaultTools.1",
    ]);
  });

  test("the same defaults give the same key whatever the order of their keys", () => {
    const reordered = defaultsFromWire(
      harnessDefaultsWire.parse({ output: WIRE.output, defaultTools: WIRE.defaultTools, tools: WIRE.tools, params: WIRE.params, prompt: WIRE.prompt }),
    );
    expect(defaultsKey(reordered)).toBe(defaultsKey(DEFAULTS));
  });
});

describe("a version's parts", () => {
  test("a part the same as the code's is left out; a version of nothing but defaults is the code's", () => {
    const parts = partsAgainst(effectiveOf({}, DEFAULTS), DEFAULTS);
    expect(parts).toEqual({});
    expect(isCodeDefault(parts)).toBe(true);
  });

  test("only what changed is kept, and what runs is the version's part, else the code's", () => {
    const next = { ...effectiveOf({}, DEFAULTS), params: { ...DEFAULTS.params, temperature: 0.7 } };
    const parts = partsAgainst(next, DEFAULTS);
    expect(parts).toEqual({ params: { ...WIRE.params, temperature: 0.7 } });
    expect(effectiveOf(parts, DEFAULTS).prompt).toEqual({
      variants: { default: { system: WIRE.prompt.system, user: WIRE.prompt.user } },
    });
  });

  test("tools in another order, or a schema with keys reordered, are the code's", () => {
    const next = {
      ...effectiveOf({}, DEFAULTS),
      tools: ["web_search"],
      outputSchema: JSON.stringify({ properties: SCHEMA.properties, required: ["codes"], type: "object" }, null, 2),
    };
    expect(partsAgainst(next, DEFAULTS)).toEqual({});
  });

  test("with no defaults at all, whatever is set is the version's", () => {
    expect(effectiveOf({}, null)).toEqual({ prompt: null, params: null, tools: null, outputSchema: null });
    const prompt = { variants: { default: { system: "a", user: "b" } } };
    expect(partsAgainst({ prompt, params: null, tools: null, outputSchema: null }, null)).toEqual({ prompt });
  });
});

describe("variables", () => {
  test("placeholders are what sits between double braces", () => {
    expect(placeholdersOf("{{note}} and {{ payer }} and {{}} and {single}")).toEqual(["note", " payer ", ""]);
  });

  const one = (system: string, user: string) => ({ variants: { default: { system, user } } });

  test("templates use declared variables only, and every required one", () => {
    const check = (system: string, user: string) => promptProblems(one(system, user), DEFAULTS);
    expect(check("", "{{note}}")).toEqual([]);
    expect(check("{{note}}", "")).toEqual([]);
    expect(check("", "{{payer}}")).toEqual([{ path: "prompt", message: "must use the required variable {{note}}." }]);
    expect(check("{{patientName}}", "{{note}}\n {{patientName}}")).toEqual([
      { path: "prompt.default.system", message: "uses {{patientName}}, which is not a declared variable.", at: { line: 1, column: 1 } },
      { path: "prompt.default.user", message: "uses {{patientName}}, which is not a declared variable.", at: { line: 2, column: 2 } },
    ]);
    expect(check("", "{{note}} {{ note }}")).toEqual([
      { path: "prompt.default.user", message: HARNESS_WORDS.badPlaceholder, at: { line: 1, column: 10 } },
    ]);
  });

  test("a template over 128 KB is refused; 128 KB is not", () => {
    expect(promptProblems(one("x".repeat(128 * 1024), "{{note}}"), DEFAULTS)).toEqual([]);
    expect(promptProblems(one("x".repeat(128 * 1024 + 1), "{{note}}"), DEFAULTS)).toEqual([
      { path: "prompt.default.system", message: HARNESS_WORDS.templateSize },
    ]);
  });
});

describe("params", () => {
  test("temperature 0–2, tokens 1–65536, thinking 0–32768, timeout 1–600 s, retries 0–3", () => {
    expect(paramsProblems({ temperature: 0, maxOutputTokens: 1, thinkingBudget: 0, timeoutMs: 1000, retries: 0 })).toEqual([]);
    expect(paramsProblems({ temperature: 2, maxOutputTokens: 65536, thinkingBudget: 32768, timeoutMs: 600000, retries: 3 })).toEqual([]);
    expect(
      paramsProblems({ temperature: -0.1, maxOutputTokens: 0, thinkingBudget: 32769, timeoutMs: 999, retries: 1.5 }).map((i) => i.path),
    ).toEqual(["params.temperature", "params.maxOutputTokens", "params.thinkingBudget", "params.timeoutMs", "params.retries"]);
    expect(paramsProblems({ timeoutMs: 600_001 })).toEqual([{ path: "params.timeoutMs", message: "is 1 to 600 seconds, in whole milliseconds." }]);
    expect(paramsProblems({ temperature: Number.NaN })).toHaveLength(1);
    expect(paramsProblems({ topK: 3 } as never)).toEqual([{ path: "params", message: HARNESS_WORDS.paramUnknown }]);
  });
});

describe("tools", () => {
  const declared = DEFAULTS.tools!;
  test("declared ids only, each once", () => {
    expect(toolProblems(["web_search"], declared, false)).toEqual([]);
    expect(toolProblems(["web_search", "web_search"], declared, false)).toEqual([
      { path: "tools", message: HARNESS_WORDS.toolRepeated },
    ]);
    expect(toolProblems(["made_up"], declared, false)).toEqual([{ path: "tools", message: HARNESS_WORDS.toolUndeclared }]);
  });

  test("a tool that handles patient data only on providers for patient data, fallback included", () => {
    expect(toolProblems(["chart_lookup"], declared, false)).toEqual([{ path: "tools", message: HARNESS_WORDS.phiTool }]);
    expect(toolProblems(["chart_lookup"], declared, true)).toEqual([]);
    expect(patientDataOnly("vertex", null)).toBe(true);
    expect(patientDataOnly("vertex", "vertex")).toBe(true);
    expect(patientDataOnly("vertex", "ai_studio")).toBe(false);
    expect(patientDataOnly("ai_studio", null)).toBe(false);
    expect(patientDataOnly("made_up", null)).toBe(false);
  });
});

describe("the rules together", () => {
  test("only the parts a version changes are checked", () => {
    expect(harnessProblems({}, { defaults: DEFAULTS, patientProviders: false })).toEqual([]);
  });

  test("a schema that is not JSON, not an object, or breaks the code's", () => {
    const check = (outputSchema: string) => harnessProblems({ outputSchema }, { defaults: DEFAULTS, patientProviders: false });
    expect(check("{")).toEqual([{ path: "output.schema", message: HARNESS_WORDS.schemaJson }]);
    expect(check("[]")).toEqual([{ path: "output.schema", message: HARNESS_WORDS.schemaObject }]);
    expect(check(JSON.stringify({ ...SCHEMA, required: [] }))).toEqual([
      { path: "output:$.codes", message: "is required by the code and must stay required." },
    ]);
    expect(check(JSON.stringify({ ...SCHEMA, description: "Codes." }))).toEqual([]);
  });

  test("with no schema from the code, any object schema will do", () => {
    expect(harnessProblems({ outputSchema: '{"type":"object"}' }, { defaults: null, patientProviders: false })).toEqual([]);
  });

  test("with no prompt from the code, a template may use no variable, and is the one variant default", () => {
    const prompt = { variants: { default: { system: "", user: "{{note}}" } } };
    expect(harnessProblems({ prompt }, { defaults: null, patientProviders: true })).toEqual([
      { path: "prompt.default.user", message: "uses {{note}}, which is not a declared variable.", at: { line: 1, column: 1 } },
    ]);
  });
});

describe("what is sent", () => {
  test("names: h7 published, draft-h8.3 under test, both prompt versions", () => {
    expect(versionName(7)).toBe("h7");
    expect(draftVersionName(8, 3)).toBe("draft-h8.3");
    expect(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/.test(draftVersionName(999_999, 999_999))).toBe(true);
  });

  test("the config carries only what the published version changes", () => {
    expect(configHarnessOf(7, {})).toEqual({ version: "h7" });
    expect(configHarnessOf(7, { tools: ["web_search"], outputSchema: JSON.stringify(SCHEMA) })).toEqual({
      version: "h7",
      tools: ["web_search"],
      output: { schema: SCHEMA },
    });
  });

  test("a job carries every part as it would run", () => {
    const job = jobHarnessOf(8, 3, { params: { temperature: 1 } }, DEFAULTS);
    expect(job).toEqual({
      version: "draft-h8.3",
      // A v1.1 prompt (one variant, default, with a user template) is sent as v1.1 sends it.
      prompt: { system: WIRE.prompt.system, user: WIRE.prompt.user },
      params: { temperature: 1 },
      tools: ["web_search"],
      output: { schema: SCHEMA },
    });
    expect(jobHarnessOf(1, 1, {}, null)).toEqual({ version: "draft-h1.1" });
  });
});

// ── Protocol v1.2 ────────────────────────────────────────────────────────────

const V12_WIRE = {
  prompt: {
    version: "v2+0a1b2c3d",
    variables: [
      { name: "query", required: true },
      { name: "denial", required: false },
    ],
    variants: {
      default: {
        system: "You answer made-up policy questions.{{#denial}} The claim was denied: {{denial}}.{{/denial}}",
        user: "Query: {{query}}",
      },
      retry: { system: "Retry, more firmly.{{^denial}} No denial given.{{/denial}}", user: "Again: {{query}}" },
    },
  },
  tools: [
    { id: "lookup_codes", name: "Code lookup", description: "Made-up codes.", phi: false },
    { id: "google_search", name: "Google search", description: "The provider's own search.", phi: false, kind: "provider" },
  ],
  defaultTools: ["lookup_codes", "google_search"],
};
const V12 = defaultsFromWire(harnessDefaultsWire.parse(V12_WIRE));

const MESSAGES_WIRE = {
  prompt: {
    version: "v3",
    input: "messages",
    variables: [{ name: "payer", required: true }],
    variants: { default: { system: "Answer about {{payer}}." }, rubric: { system: "Grade by the rubric for {{payer}}." } },
  },
};
const MESSAGES = defaultsFromWire(harnessDefaultsWire.parse(MESSAGES_WIRE));

describe("v1.2 defaults on the wire", () => {
  test("variants, the messages input and provider tools parse and are stored as sent", () => {
    expect(V12.prompt?.variants).toEqual(V12_WIRE.prompt.variants);
    expect(V12.prompt?.input).toBeUndefined();
    expect(V12.tools?.[1]).toEqual(V12_WIRE.tools[1]);
    expect(MESSAGES.prompt?.input).toBe("messages");
    expect(codeVariantsOf(MESSAGES)).toEqual(MESSAGES_WIRE.prompt.variants);
  });

  test("a v1.1 prompt is the one variant default, and stays stored as v1.1 sent it", () => {
    expect(DEFAULTS.prompt).toEqual(WIRE.prompt);
    expect(codeVariantsOf(DEFAULTS)).toEqual({ default: { system: WIRE.prompt.system, user: WIRE.prompt.user } });
    expect(codeVariantsOf(null)).toBeNull();
    expect(inputOf(DEFAULTS)).toBe("text");
    expect(inputOf(MESSAGES)).toBe("messages");
  });

  test("variants: names a-z, 0-9 and _, at most 12, default required, never beside system and user", () => {
    const issues = (prompt: Record<string, unknown>) => {
      const parsed = harnessDefaultsWire.safeParse({ prompt: { ...V12_WIRE.prompt, ...prompt } });
      return parsed.success ? [] : parsed.error.issues.map((issue) => [issue.path.join("."), issue.message]);
    };
    const v = V12_WIRE.prompt.variants;
    expect(issues({})).toEqual([]);
    expect(issues({ variants: { retry: v.retry } })).toEqual([["prompt.variants", HARNESS_WORDS.variantDefault]]);
    expect(issues({ variants: { ...v, "Bad-Name": v.retry } })).toEqual([["prompt.variants", HARNESS_WORDS.variantName]]);
    const thirteen = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i === 0 ? "default" : `v${i}`, v.retry]));
    expect(issues({ variants: thirteen })).toEqual([["prompt.variants", HARNESS_WORDS.variantCount]]);
    expect(issues({ system: "x" })).toEqual([["prompt.system", HARNESS_WORDS.legacyWithVariants]]);
    expect(issues({ variants: undefined })).toEqual([
      ["prompt.system", HARNESS_WORDS.promptMissing],
      ["prompt.user", HARNESS_WORDS.promptMissing],
    ]);
  });

  test("a messages agent's variants have a system template only", () => {
    const parsed = harnessDefaultsWire.safeParse({
      prompt: { ...MESSAGES_WIRE.prompt, variants: { default: { system: "x", user: "{{payer}}" } } },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["prompt.variants.default.user", HARNESS_WORDS.messagesUser],
    ]);
    expect(
      harnessDefaultsWire.safeParse({ prompt: { ...WIRE.prompt, input: "messages" } }).error?.issues.map((i) => i.message),
    ).toEqual([HARNESS_WORDS.messagesLegacy]);
  });

  test("a text agent's variants each have a user template, whether input is said or left out", () => {
    for (const input of [undefined, "text"]) {
      const parsed = harnessDefaultsWire.safeParse({
        prompt: { ...V12_WIRE.prompt, input, variants: { ...V12_WIRE.prompt.variants, retry: { system: "x" } } },
      });
      expect(parsed.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
        ["prompt.variants.retry.user", HARNESS_WORDS.userRequired],
      ]);
    }
  });

  test("v0.4.0 sends a v1.1-declared agent as one variant with input and every tool's kind: read the same", () => {
    const sent = defaultsFromWire(
      harnessDefaultsWire.parse({
        prompt: {
          version: WIRE.prompt.version,
          input: "text",
          variables: WIRE.prompt.variables,
          variants: { default: { system: WIRE.prompt.system, user: WIRE.prompt.user } },
        },
        tools: WIRE.tools.map((tool) => ({ ...tool, kind: "function" })),
      }),
    );
    expect(codeVariantsOf(sent)).toEqual(codeVariantsOf(DEFAULTS));
    expect(inputOf(sent)).toBe("text");
    expect(providerToolsOf(sent)).toEqual([]);
  });

  test("a tool's kind is function or provider; left out, it is a function", () => {
    expect(harnessDefaultsWire.safeParse({ tools: [{ ...V12_WIRE.tools[0], kind: "builtin" }] }).success).toBe(false);
    expect(harnessDefaultsWire.safeParse({ tools: [{ ...V12_WIRE.tools[0], kind: "function" }] }).success).toBe(true);
    expect(providerToolsOf(V12)).toEqual(["google_search"]);
    expect(providerToolsOf(DEFAULTS)).toEqual([]);
  });

  test("the whole harness is at most 512 KB", () => {
    const big = "x".repeat(100 * 1024);
    const variants = Object.fromEntries(["default", "a", "b", "c", "d", "e"].map((name) => [name, { system: big, user: "" }]));
    const parsed = harnessDefaultsWire.safeParse({ prompt: { version: "v1", variables: [], variants } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([HARNESS_WORDS.harnessSize]);
  });

  test("a v1.1 report is stored exactly as before, so its key does not move", () => {
    expect(Object.keys(DEFAULTS.prompt!)).toEqual(["version", "system", "user", "variables"]);
    expect(Object.keys(DEFAULTS.tools![0]!)).toEqual(["id", "name", "description", "phi"]);
  });
});

describe("v1.2 rules: variants", () => {
  const variants = V12_WIRE.prompt.variants;
  const check = (next: Record<string, { system: string; user?: string }>, defaults: HarnessDefaults | null = V12) =>
    promptProblems({ variants: next }, defaults);

  test("every variant the code declares, edited or not, is the draft's; none dropped, none added", () => {
    expect(check({ ...variants, retry: { ...variants.retry, system: "Retry, made-up." } })).toEqual([]);
    expect(check({ default: variants.default })).toEqual([{ path: "prompt.retry", message: HARNESS_WORDS.variantDropped }]);
    expect(check({ default: variants.default, retry2: variants.retry })).toEqual([
      { path: "prompt.retry2", message: HARNESS_WORDS.variantAdded },
      { path: "prompt.retry", message: HARNESS_WORDS.variantDropped },
    ]);
    expect(check({ ...variants, "Bad name": variants.retry })).toEqual([{ path: "prompt", message: HARNESS_WORDS.variantName }]);
  });

  test("a text agent's every variant has a user template", () => {
    expect(check({ ...variants, retry: { system: "x" } })).toEqual([
      { path: "prompt.retry.user", message: HARNESS_WORDS.userRequired },
    ]);
  });

  test("a messages agent's draft has system templates only", () => {
    expect(promptProblems({ variants: MESSAGES_WIRE.prompt.variants }, MESSAGES)).toEqual([]);
    expect(
      promptProblems({ variants: { ...MESSAGES_WIRE.prompt.variants, default: { system: "{{payer}}", user: "x" } } }, MESSAGES),
    ).toEqual([{ path: "prompt.default.user", message: HARNESS_WORDS.messagesUser }]);
  });

  test("a required variable appears once anywhere, in any variant", () => {
    const onlyRetry = {
      default: { system: "None here.", user: "Nothing." },
      retry: { system: "x", user: "{{query}}" },
    };
    expect(check(onlyRetry)).toEqual([]);
    expect(check({ default: { system: "", user: "" }, retry: { system: "", user: "" } })).toEqual([
      { path: "prompt", message: "must use the required variable {{query}}." },
    ]);
  });

  test("sections: balanced, not nested, declared variables only, each problem with its variant and place", () => {
    expect(
      check({
        ...variants,
        retry: { system: "Line one.\n{{#denial}} {{#query}}x{{/query}}{{/denial}}", user: "{{query}} {{^payer}}y{{/payer}}" },
      }),
    ).toEqual([
      { path: "prompt.retry.system", message: TEMPLATE_WORDS.nested("#denial"), at: { line: 2, column: 13 } },
      { path: "prompt.retry.user", message: "uses {{payer}}, which is not a declared variable.", at: { line: 1, column: 11 } },
    ]);
    expect(check({ ...variants, default: { system: "{{#denial}}open", user: "{{query}}" } })).toEqual([
      { path: "prompt.default.system", message: TEMPLATE_WORDS.unclosed("#denial"), at: { line: 1, column: 1 } },
    ]);
  });

  test("the draft as it would run is at most 512 KB as a whole", () => {
    const big = "x".repeat(128 * 1024 - 16);
    const prompt = { variants: { default: { system: big, user: `${big}{{query}}` }, retry: { system: big, user: big } } };
    expect(harnessProblems({ prompt }, { defaults: V12, patientProviders: false })).toEqual([
      { path: "harness", message: HARNESS_WORDS.harnessSize },
    ]);
  });
});

describe("v1.2: what is sent", () => {
  test("to a v1.1 package, one default variant with a user template goes as v1.1's system and user", () => {
    const variants = V12_WIRE.prompt.variants;
    expect(configHarnessOf(2, { prompt: { variants } })).toEqual({ version: "h2", prompt: { variants } });
    expect(configHarnessOf(2, { prompt: { variants: { default: variants.default } } })).toEqual({
      version: "h2",
      prompt: variants.default,
    });
    const messages = { default: { system: "Only a system prompt." } };
    expect(configHarnessOf(2, { prompt: { variants: messages } })).toEqual({ version: "h2", prompt: { variants: messages } });
  });

  test("to a v1.2 package (its code sent variants), a prompt always goes as variants", () => {
    const one = { default: V12_WIRE.prompt.variants.default };
    expect(configHarnessOf(2, { prompt: { variants: one } }, V12)).toEqual({ version: "h2", prompt: { variants: one } });
    expect(jobHarnessOf(2, 1, { prompt: { variants: V12_WIRE.prompt.variants } }, V12).prompt).toEqual({
      variants: V12_WIRE.prompt.variants,
    });
  });

  test("a job carries every variant as it would run", () => {
    expect(jobHarnessOf(3, 1, {}, MESSAGES).prompt).toEqual({ variants: MESSAGES_WIRE.prompt.variants });
  });

  test("variants are listed default first, then by name", () => {
    expect(variantNames({ zeta: { system: "" }, default: { system: "" }, alpha: { system: "" } })).toEqual([
      "default",
      "alpha",
      "zeta",
    ]);
  });
});
