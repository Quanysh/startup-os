// An agent's harness: its prompt templates, model parameters, tools and
// output schema (Agents Protocol v1.1 and v1.2, docs/agents-protocol.md).
// v1.2 adds prompt variants chosen at call time, sections in templates
// (convex/lib/agentTemplate.ts), agents that send their own conversation
// (`input: "messages"`), and tools built into the provider. The code of
// each project declares its defaults in its usage report (`agentsKnown[].harness`);
// the OS keeps versions of what may replace them (draft, published,
// archived), tests a draft through the project (convex/lib/agentJobs.ts),
// and sends the published one in GET /agents/v1/config.
//
// The agents still run inside each project, and patient data never reaches
// the OS: a prompt here is a template with `{{variables}}`, filled in by the
// project; a test case is made-up data.
//
// A version holds only the parts that differ from the code's defaults (a
// part the same as the code's is left out, so a later change to the code's
// default is not pinned by an old copy). What is sent is those parts: any
// part left out is the code's own.
//
// Pure: the UI imports it, and publishing asks the same rules.

import { z } from "zod";
import { PROMPT_VERSION_PATTERN, PROVIDER_INFO, isKnownProvider } from "./agentControl";
import { AGENT_NAME_PATTERN } from "./agentProjects";
import { deepEqual, schemaProblems, stableStringify, utf8Bytes } from "./agentSchemaCompat";
import { TEMPLATE_WORDS, VARIABLE_NAME_PATTERN, parseTemplate } from "./agentTemplate";

export { VARIABLE_NAME_PATTERN };

/** A broken rule: where (a path; for a template, its line and column too) and fixed words. */
export type Issue = { path: string; message: string; at?: { line: number; column: number } };

// ── Bounds ───────────────────────────────────────────────────────────────────

/** A system or user template, in UTF-8 bytes (v1.2; 32 KB in v1.1). */
export const MAX_TEMPLATE_BYTES = 128 * 1024;
/** A whole harness as JSON, in UTF-8 bytes: the code's defaults, or a version as it would run (v1.2). */
export const MAX_HARNESS_BYTES = 512 * 1024;
export const MAX_VARIABLES = 30;
/** A prompt variant's name (v1.2): `default`, `denial`, `retry_rubric`. */
export const VARIANT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_VARIANTS = 12;
/** The variant every prompt has: a v1.1 prompt is this one alone. */
export const DEFAULT_VARIANT = "default";
/** What an agent sends the model besides its system prompt: one user turn from its template, or its own conversation. */
export const PROMPT_INPUTS = ["text", "messages"] as const;
export type PromptInput = (typeof PROMPT_INPUTS)[number];
/** A tool the code runs (`function`), or one built into the provider (`provider`: skipped in test runs). */
export const TOOL_KINDS = ["function", "provider"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export const MAX_TOOLS = 40;
/** A tool's id: `web_search`, `ncci.ptp`. */
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
export const MAX_TOOL_DESCRIPTION = 500;
/** An output schema, as JSON, in UTF-8 bytes. */
export const MAX_SCHEMA_BYTES = 64 * 1024;
/** The code's own name for its output schema's version: "1", "2026-10.a". */
export const SCHEMA_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/;
/** A version's note: why it was made. */
export const MAX_NOTE_LENGTH = 280;
/** The most versions kept a page shows for one agent. */
export const VERSIONS_SHOWN = 100;

export const PARAM_KEYS = ["temperature", "maxOutputTokens", "thinkingBudget", "timeoutMs", "retries"] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];
export type Params = Partial<Record<ParamKey, number>>;

/** What each model parameter may be, and what the page calls it. */
export const PARAM_BOUNDS: Record<ParamKey, { min: number; max: number; integer: boolean; label: string; words: string }> = {
  temperature: { min: 0, max: 2, integer: false, label: "Temperature", words: "is 0 to 2." },
  maxOutputTokens: { min: 1, max: 65_536, integer: true, label: "Most output tokens", words: "is a whole number, 1 to 65,536." },
  thinkingBudget: { min: 0, max: 32_768, integer: true, label: "Thinking budget, tokens", words: "is a whole number, 0 to 32,768." },
  timeoutMs: { min: 1_000, max: 600_000, integer: true, label: "Timeout, milliseconds", words: "is 1 to 600 seconds, in whole milliseconds." },
  retries: { min: 0, max: 3, integer: true, label: "Retries", words: "is a whole number, 0 to 3." },
};

// ── The code's defaults, as a usage report sends them ───────────────────────

const template = z.string().refine((text) => utf8Bytes(text) <= MAX_TEMPLATE_BYTES, "is more than 128 KB.");

const bounded = (key: ParamKey) => {
  const bound = PARAM_BOUNDS[key];
  const base = z.number().min(bound.min).max(bound.max);
  return (bound.integer ? base.int() : base).optional();
};

export const paramsWire = z.strictObject({
  temperature: bounded("temperature"),
  maxOutputTokens: bounded("maxOutputTokens"),
  thinkingBudget: bounded("thinkingBudget"),
  timeoutMs: bounded("timeoutMs"),
  retries: bounded("retries"),
});

export const variableWire = z.strictObject({
  name: z.string().regex(VARIABLE_NAME_PATTERN),
  required: z.boolean(),
});
export type Variable = z.infer<typeof variableWire>;

export const toolWire = z.strictObject({
  id: z.string().regex(TOOL_ID_PATTERN),
  name: z.string().regex(AGENT_NAME_PATTERN),
  description: z.string().max(MAX_TOOL_DESCRIPTION),
  /** Whether the tool handles patient data. */
  phi: z.boolean(),
  /** v1.2: left out, a function the code runs; `provider`, built into the provider and skipped in test runs. */
  kind: z.enum(TOOL_KINDS).optional(),
});
export type ToolDecl = z.infer<typeof toolWire>;

/** One prompt variant (v1.2): its system template, and its user template unless the agent sends messages. */
export type Variant = { system: string; user?: string };
export type Variants = Record<string, Variant>;

const variantWire = z.strictObject({ system: template, user: template.optional() });

/** The words for a prompt's shape, on the wire and in a draft. */
const PROMPT_WORDS = {
  promptMissing: "is required where there are no variants.",
  legacyWithVariants: "is not sent with variants: each variant has its own templates.",
  messagesLegacy: "is messages only with variants, each with a system template alone.",
  variantCount: `holds 1 to ${MAX_VARIANTS} variants.`,
  variantName: "names a variant that is not a lowercase letter, then up to 31 of a-z, 0-9 and _.",
  variantDefault: `must hold a variant named ${DEFAULT_VARIANT}.`,
  messagesUser:
    "is not a template here: this agent sends its own conversation, so only the system prompt is editable.",
  userRequired: "is required: this agent sends one user turn, from this template.",
} as const;

/**
 * The code's prompt: v1.1's `{ version, system, user, variables }`, or
 * v1.2's `{ version, input?, variables, variants }` (every variant named,
 * `default` among them; a `messages` agent's variants have no user template).
 */
const promptWire = z
  .strictObject({
    version: z.string().regex(PROMPT_VERSION_PATTERN),
    input: z.enum(PROMPT_INPUTS).optional(),
    system: template.optional(),
    user: template.optional(),
    variables: z.array(variableWire).max(MAX_VARIABLES),
    // Keys are checked below, so a name that is not one is never quoted back in a path.
    variants: z.record(z.string(), variantWire).optional(),
  })
  .superRefine((prompt, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (prompt.variants === undefined) {
      if (prompt.system === undefined) issue(["system"], PROMPT_WORDS.promptMissing);
      if (prompt.user === undefined) issue(["user"], PROMPT_WORDS.promptMissing);
      if (prompt.input === "messages") issue(["input"], PROMPT_WORDS.messagesLegacy);
      return;
    }
    if (prompt.system !== undefined) issue(["system"], PROMPT_WORDS.legacyWithVariants);
    if (prompt.user !== undefined) issue(["user"], PROMPT_WORDS.legacyWithVariants);
    const names = Object.keys(prompt.variants);
    if (names.some((name) => !VARIANT_NAME_PATTERN.test(name))) {
      issue(["variants"], PROMPT_WORDS.variantName);
      return;
    }
    if (names.length === 0 || names.length > MAX_VARIANTS) issue(["variants"], PROMPT_WORDS.variantCount);
    else if (!names.includes(DEFAULT_VARIANT)) issue(["variants"], PROMPT_WORDS.variantDefault);
    for (const name of names) {
      const user = prompt.variants[name]!.user;
      if (prompt.input === "messages" && user !== undefined) issue(["variants", name, "user"], PROMPT_WORDS.messagesUser);
      if (prompt.input !== "messages" && user === undefined) issue(["variants", name, "user"], PROMPT_WORDS.userRequired);
    }
  });

const jsonSchema = z
  .record(z.string(), z.unknown())
  .refine((schema) => utf8Bytes(JSON.stringify(schema)) <= MAX_SCHEMA_BYTES, "is more than 64 KB.");

/**
 * `agentsKnown[].harness` in POST /agents/v1/usage: the code's defaults.
 * Every part is optional; within a part every field is required.
 */
export const harnessDefaultsWire = z
  .strictObject({
    prompt: promptWire.optional(),
    params: paramsWire.optional(),
    tools: z.array(toolWire).max(MAX_TOOLS).optional(),
    defaultTools: z.array(z.string().regex(TOOL_ID_PATTERN)).max(MAX_TOOLS).optional(),
    output: z
      .strictObject({
        schemaVersion: z.string().regex(SCHEMA_VERSION_PATTERN),
        schema: jsonSchema,
      })
      .optional(),
  })
  .refine((harness) => utf8Bytes(JSON.stringify(harness)) <= MAX_HARNESS_BYTES, "is more than 512 KB as a whole.");
export type HarnessDefaultsWire = z.infer<typeof harnessDefaultsWire>;

const repeats = <T>(list: readonly T[], key: (item: T) => string): number[] => {
  const seen = new Set<string>();
  const at: number[] = [];
  list.forEach((item, i) => {
    if (seen.has(key(item))) at.push(i);
    seen.add(key(item));
  });
  return at;
};

/** What the shape alone cannot say about a code's defaults: no name twice, default tools declared. */
export function defaultsProblems(wire: HarnessDefaultsWire, prefix: string): Issue[] {
  const issues: Issue[] = [];
  for (const i of repeats(wire.prompt?.variables ?? [], (v) => v.name)) {
    issues.push({ path: `${prefix}.prompt.variables.${i}`, message: "repeats an earlier variable's name." });
  }
  for (const i of repeats(wire.tools ?? [], (t) => t.id)) {
    issues.push({ path: `${prefix}.tools.${i}`, message: "repeats an earlier tool's id." });
  }
  const declared = new Set((wire.tools ?? []).map((t) => t.id));
  (wire.defaultTools ?? []).forEach((id, i) => {
    if (!declared.has(id)) issues.push({ path: `${prefix}.defaultTools.${i}`, message: "is not a tool in tools." });
  });
  for (const i of repeats(wire.defaultTools ?? [], (id) => id)) {
    issues.push({ path: `${prefix}.defaultTools.${i}`, message: "repeats an earlier tool id." });
  }
  return issues;
}

// ── As stored ────────────────────────────────────────────────────────────────

/**
 * The code's defaults as the OS keeps them: the output schema as JSON text,
 * since a schema's keys (`$ref`, `$defs`) cannot be field names in Convex.
 */
export type HarnessDefaults = {
  /**
   * v1.1's prompt is kept as it was sent (`system` and `user`), so its key
   * does not move; v1.2's is `variants` (and `input` where it was sent).
   * Read it through `codeVariantsOf` and `inputOf`.
   */
  prompt?: {
    version: string;
    input?: PromptInput;
    system?: string;
    user?: string;
    variables: Variable[];
    variants?: Variants;
  };
  params?: Params;
  tools?: ToolDecl[];
  defaultTools?: string[];
  output?: { schemaVersion: string; schema: string };
};

/** Only the parameters that are set, in a fixed order. */
export function cleanParams(params: Params): Params {
  const out: Params = {};
  for (const key of PARAM_KEYS) if (params[key] !== undefined) out[key] = params[key];
  return out;
}

/** A variant with only what it has: no `user` key where it has no user template. */
const variantOf = (variant: Variant): Variant => ({
  system: variant.system,
  ...(variant.user === undefined ? {} : { user: variant.user }),
});

/** Variants in the order the page lists them: `default` first, then by name. */
export const variantNames = (variants: Variants): string[] =>
  Object.keys(variants).sort((a, b) =>
    a === DEFAULT_VARIANT ? -1 : b === DEFAULT_VARIANT ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );

const variantsOf = (variants: Variants): Variants =>
  Object.fromEntries(variantNames(variants).map((name) => [name, variantOf(variants[name]!)]));

function promptFromWire(prompt: NonNullable<HarnessDefaultsWire["prompt"]>): NonNullable<HarnessDefaults["prompt"]> {
  const variables = prompt.variables.map((v) => ({ name: v.name, required: v.required }));
  if (prompt.variants === undefined) {
    // v1.1, stored exactly as before.
    return { version: prompt.version, system: prompt.system ?? "", user: prompt.user ?? "", variables };
  }
  return {
    version: prompt.version,
    ...(prompt.input === undefined ? {} : { input: prompt.input }),
    variables,
    variants: variantsOf(prompt.variants),
  };
}

export function defaultsFromWire(wire: HarnessDefaultsWire): HarnessDefaults {
  return {
    ...(wire.prompt === undefined ? {} : { prompt: promptFromWire(wire.prompt) }),
    ...(wire.params === undefined ? {} : { params: cleanParams(wire.params) }),
    ...(wire.tools === undefined
      ? {}
      : {
          tools: wire.tools.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            phi: t.phi,
            ...(t.kind === undefined ? {} : { kind: t.kind }),
          })),
        }),
    ...(wire.defaultTools === undefined ? {} : { defaultTools: [...wire.defaultTools] }),
    ...(wire.output === undefined
      ? {}
      : { output: { schemaVersion: wire.output.schemaVersion, schema: JSON.stringify(wire.output.schema) } }),
  };
}

/** The same defaults always print the same: what a report's harness is compared by. */
export const defaultsKey = (defaults: HarnessDefaults): string => stableStringify(defaults);

/** The code's prompt as variants: a v1.1 prompt is the one variant `default`. Null: no prompt declared. */
export function codeVariantsOf(defaults: HarnessDefaults | null): Variants | null {
  const prompt = defaults?.prompt;
  if (prompt === undefined) return null;
  if (prompt.variants !== undefined) return variantsOf(prompt.variants);
  return { [DEFAULT_VARIANT]: { system: prompt.system ?? "", user: prompt.user ?? "" } };
}

/** What the agent sends besides its system prompt: its user template's turn (`text`), or its own `messages`. */
export const inputOf = (defaults: HarnessDefaults | null): PromptInput => defaults?.prompt?.input ?? "text";

/** The tools built into the provider, which test runs skip. */
export const providerToolsOf = (defaults: HarnessDefaults | null): string[] =>
  (defaults?.tools ?? []).filter((tool) => tool.kind === "provider").map((tool) => tool.id);

// ── A version's parts, and what an agent runs on ────────────────────────────

/** A version's prompt: every variant the code declares, as the version has it. */
export type PromptPart = { variants: Variants };

/** A prompt as v1.1 stored and sent it, or as v1.2 does: always read as variants. */
export function promptPartOf(prompt: { system: string; user: string } | PromptPart): PromptPart {
  if ("variants" in prompt) return { variants: variantsOf(prompt.variants) };
  return { variants: { [DEFAULT_VARIANT]: { system: prompt.system, user: prompt.user } } };
}

/** What a version replaces; a part left out is the code's own. */
export type HarnessParts = {
  prompt?: PromptPart;
  params?: Params;
  /** The tools switched on, by id. */
  tools?: string[];
  /** JSON text. */
  outputSchema?: string;
};

/** Every part as it would run: the version's, else the code's, else null (none declared). */
export type Effective = {
  prompt: PromptPart | null;
  params: Params | null;
  tools: string[] | null;
  outputSchema: string | null;
};

export function effectiveOf(parts: HarnessParts, defaults: HarnessDefaults | null): Effective {
  const code = codeVariantsOf(defaults);
  return {
    prompt: parts.prompt ?? (code === null ? null : { variants: code }),
    params: parts.params ?? defaults?.params ?? null,
    tools: parts.tools ?? defaults?.defaultTools ?? null,
    outputSchema: parts.outputSchema ?? defaults?.output?.schema ?? null,
  };
}

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

const sameTools = (a: readonly string[], b: readonly string[]) =>
  deepEqual([...new Set(a)].sort(), [...new Set(b)].sort());

const sameSchema = (a: string, b: string) => {
  const x = parseJson(a);
  const y = parseJson(b);
  return x.ok && y.ok ? deepEqual(x.value, y.value) : a === b;
};

/**
 * What a draft holds, from what the editor shows: each part the same as the
 * code's default is left out, so the version keeps only what it changes.
 */
export function partsAgainst(next: Effective, defaults: HarnessDefaults | null): HarnessParts {
  const code = effectiveOf({}, defaults);
  const parts: HarnessParts = {};
  if (next.prompt !== null) {
    const prompt = promptPartOf(next.prompt);
    if (!(code.prompt !== null && deepEqual(prompt, code.prompt))) parts.prompt = prompt;
  }
  if (next.params !== null) {
    const params = cleanParams(next.params);
    if (!(code.params !== null && deepEqual(params, cleanParams(code.params)))) parts.params = params;
  }
  if (next.tools !== null && !(code.tools !== null && sameTools(next.tools, code.tools))) {
    parts.tools = [...new Set(next.tools)];
  }
  if (next.outputSchema !== null && !(code.outputSchema !== null && sameSchema(next.outputSchema, code.outputSchema))) {
    parts.outputSchema = next.outputSchema;
  }
  return parts;
}

/** Whether a version changes nothing: every part is the code's. */
export const isCodeDefault = (parts: HarnessParts): boolean =>
  parts.prompt === undefined && parts.params === undefined && parts.tools === undefined && parts.outputSchema === undefined;

// ── The rules ────────────────────────────────────────────────────────────────

export const HARNESS_WORDS = {
  templateSize: "is more than 128 KB.",
  harnessSize: "is more than 512 KB as a whole.",
  badPlaceholder: TEMPLATE_WORDS.badTag,
  ...PROMPT_WORDS,
  variantDropped: "is a variant the code declares: every one stays (edit it, but do not drop or rename it).",
  variantAdded: "is not a variant the code declares.",

  paramUnknown: "is not a model parameter.",
  toolsTooMany: `switches on more than ${MAX_TOOLS} tools.`,
  toolRepeated: "names a tool twice.",
  toolUndeclared: "names a tool the project's code does not declare.",
  phiTool:
    "switches on a tool that handles patient data: the agent must run on providers for patient data only (Vertex AI), fallback included.",
  schemaJson: "is not JSON.",
  schemaObject: "must be a JSON Schema object.",
  schemaSize: "is more than 64 KB.",
} as const;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Every `{{…}}` in a template, as written between the braces. */
export const placeholdersOf = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);

const undeclared = (name: string) => `uses {{${name}}}, which is not a declared variable.`;

/** One template's problems: its size, its tags and sections, and variables the code does not declare. */
function templateIssues(path: string, text: string, declared: ReadonlySet<string>, used: Set<string>): Issue[] {
  const issues: Issue[] = [];
  if (utf8Bytes(text) > MAX_TEMPLATE_BYTES) issues.push({ path, message: HARNESS_WORDS.templateSize });
  const parsed = parseTemplate(text);
  const placed: Issue[] = parsed.issues.map((issue) => ({
    path,
    message: issue.message,
    at: { line: issue.line, column: issue.column },
  }));
  const said = new Set<string>();
  for (const use of parsed.uses) {
    used.add(use.name);
    if (declared.has(use.name) || said.has(use.name)) continue;
    said.add(use.name);
    placed.push({ path, message: undeclared(use.name), at: { line: use.line, column: use.column } });
  }
  placed.sort((a, b) => a.at!.line - b.at!.line || a.at!.column - b.at!.column);
  return [...issues, ...placed];
}

/**
 * A draft's prompt against the code's: every variant the code declares and
 * no other (edited, never dropped or renamed), so `default` too; a user
 * template in every variant where the agent sends one user turn (`text`),
 * and none where it sends its own conversation (`messages`); each template
 * at most 128 KB, its sections balanced and not nested, with only declared
 * variables; and every
 * required variable used at least once, in any variant. A problem in a
 * template is placed: its variant's path, its line and column.
 */
export function promptProblems(prompt: PromptPart, defaults: HarnessDefaults | null): Issue[] {
  const issues: Issue[] = [];
  const variables = defaults?.prompt?.variables ?? [];
  const declared = new Set(variables.map((v) => v.name));
  const input = inputOf(defaults);
  // With no prompt from the code, a draft's prompt is v1.1's: the variant default, system and user.
  const code = codeVariantsOf(defaults) ?? { [DEFAULT_VARIANT]: { system: "", user: "" } };
  const names = variantNames(prompt.variants);
  if (names.some((name) => !VARIANT_NAME_PATTERN.test(name))) {
    return [{ path: "prompt", message: HARNESS_WORDS.variantName }];
  }
  for (const name of names) if (code[name] === undefined) issues.push({ path: `prompt.${name}`, message: HARNESS_WORDS.variantAdded });
  for (const name of variantNames(code)) {
    if (prompt.variants[name] === undefined) issues.push({ path: `prompt.${name}`, message: HARNESS_WORDS.variantDropped });
  }
  const used = new Set<string>();
  for (const name of names) {
    const variant = prompt.variants[name]!;
    issues.push(...templateIssues(`prompt.${name}.system`, variant.system, declared, used));
    if (input === "messages") {
      if (variant.user !== undefined) issues.push({ path: `prompt.${name}.user`, message: HARNESS_WORDS.messagesUser });
      continue;
    }
    if (variant.user === undefined) {
      issues.push({ path: `prompt.${name}.user`, message: HARNESS_WORDS.userRequired });
      continue;
    }
    issues.push(...templateIssues(`prompt.${name}.user`, variant.user, declared, used));
  }
  for (const variable of variables) {
    if (variable.required && !used.has(variable.name)) {
      issues.push({ path: "prompt", message: `must use the required variable {{${variable.name}}}.` });
    }
  }
  return issues;
}

export function paramsProblems(params: Params): Issue[] {
  const issues: Issue[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!(PARAM_KEYS as readonly string[]).includes(key)) {
      issues.push({ path: "params", message: HARNESS_WORDS.paramUnknown });
      continue;
    }
    if (value === undefined) continue;
    const bound = PARAM_BOUNDS[key as ParamKey];
    const fits =
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= bound.min &&
      value <= bound.max &&
      (!bound.integer || Number.isInteger(value));
    if (!fits) issues.push({ path: `params.${key}`, message: bound.words });
  }
  return issues;
}

/** Whether a pair, and its fallback, are on providers for patient data only. */
export function patientDataOnly(primary: string, fallback: string | null): boolean {
  const ok = (provider: string) => isKnownProvider(provider) && PROVIDER_INFO[provider].patientData;
  return ok(primary) && (fallback === null || ok(fallback));
}

/** Whether a set of tools switches on one the code says handles patient data. */
export const usesPhiTool = (tools: readonly string[] | null, declared: readonly ToolDecl[]): boolean =>
  tools !== null && declared.some((tool) => tool.phi && tools.includes(tool.id));

/**
 * Tools: at most MAX_TOOLS, each once, each declared by the code; one that
 * handles patient data only where the agent runs on providers for patient
 * data only (the same rule as an agent that does).
 */
export function toolProblems(tools: readonly string[], declared: readonly ToolDecl[], patientProviders: boolean): Issue[] {
  const issues: Issue[] = [];
  if (tools.length > MAX_TOOLS) issues.push({ path: "tools", message: HARNESS_WORDS.toolsTooMany });
  if (new Set(tools).size !== tools.length) issues.push({ path: "tools", message: HARNESS_WORDS.toolRepeated });
  const ids = new Set(declared.map((tool) => tool.id));
  if (tools.some((id) => !ids.has(id))) issues.push({ path: "tools", message: HARNESS_WORDS.toolUndeclared });
  if (usesPhiTool(tools, declared) && !patientProviders) issues.push({ path: "tools", message: HARNESS_WORDS.phiTool });
  return issues;
}

/** The schema is JSON, an object, at most 64 KB, and the code can still read what it allows. */
export function outputProblems(text: string, codeSchema: string | null): Issue[] {
  if (utf8Bytes(text) > MAX_SCHEMA_BYTES) return [{ path: "output.schema", message: HARNESS_WORDS.schemaSize }];
  const parsed = parseJson(text);
  if (!parsed.ok) return [{ path: "output.schema", message: HARNESS_WORDS.schemaJson }];
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ path: "output.schema", message: HARNESS_WORDS.schemaObject }];
  }
  if (codeSchema === null) return [];
  const code = parseJson(codeSchema);
  if (!code.ok) return [];
  return schemaProblems(code.value, value).map((issue) => ({ path: `output:${issue.path}`, message: issue.message }));
}

/**
 * Every rule a version is held to before it is tested or published, on the
 * parts it changes (the code's own parts are the code's business). The
 * agent's providers decide whether a tool for patient data may be on.
 */
export function harnessProblems(
  parts: HarnessParts,
  context: { defaults: HarnessDefaults | null; patientProviders: boolean },
): Issue[] {
  const defaults = context.defaults;
  const issues: Issue[] = [];
  if (parts.prompt !== undefined) issues.push(...promptProblems(parts.prompt, defaults));
  if (parts.params !== undefined) issues.push(...paramsProblems(parts.params));
  if (parts.tools !== undefined) issues.push(...toolProblems(parts.tools, defaults?.tools ?? [], context.patientProviders));
  if (parts.outputSchema !== undefined) issues.push(...outputProblems(parts.outputSchema, defaults?.output?.schema ?? null));
  if (harnessBytes(effectiveOf(parts, defaults)) > MAX_HARNESS_BYTES) {
    issues.push({ path: "harness", message: HARNESS_WORDS.harnessSize });
  }
  return issues;
}

// ── Names and what is sent ───────────────────────────────────────────────────

/** A published version's name, sent as `harness.version` and reported back as `promptVersion`: "h7". */
export const versionName = (number: number): string => `h${number}`;
/** The number in a published version's name: 7 for "h7"; null for anything else. */
export function versionNumberOf(name: string | null | undefined): number | null {
  const match = /^h([1-9][0-9]{0,8})$/.exec(name ?? "");
  return match === null ? null : Number(match[1]);
}

/** A draft's name in a test job, one a revision: "draft-h8.3". */
export const draftVersionName = (number: number, revision: number): string => `draft-h${number}.${revision}`;

/** `harness` on an agent in GET /agents/v1/config: the published version's parts. */
export type ConfigHarness = {
  version: string;
  /** v1.1's `{ system, user }` for one `default` variant with a user template; otherwise v1.2's `{ variants }`. */
  prompt?: { system: string; user: string } | PromptPart;
  params?: Params;
  tools?: string[];
  output?: { schema: unknown };
};

const schemaValue = (text: string): unknown => {
  const parsed = parseJson(text);
  return parsed.ok ? parsed.value : {};
};

/** Whether the code's defaults came in v1.2's shape (`variants`): its package reads `{ variants }`. */
export const speaksVariants = (defaults: HarnessDefaults | null): boolean => defaults?.prompt?.variants !== undefined;

/**
 * A prompt as it goes out, in the shape the project's package speaks: v1.2's
 * `{ variants }` where its code sent variants; otherwise (a v1.1 package, or
 * no prompt reported) the one variant `default` with a user template as v1.1
 * sent it, `{ system, user }`, so a v0.3.0 package reads it, and anything
 * else as `{ variants }`.
 */
function promptOut(prompt: PromptPart, variants: boolean): { system: string; user: string } | PromptPart {
  const names = variantNames(prompt.variants);
  const only = prompt.variants[DEFAULT_VARIANT];
  if (!variants && names.length === 1 && only !== undefined && only.user !== undefined) {
    return { system: only.system, user: only.user };
  }
  return { variants: variantsOf(prompt.variants) };
}

function payloadOf(version: string, parts: HarnessParts, variants = false): ConfigHarness {
  return {
    version,
    ...(parts.prompt === undefined ? {} : { prompt: promptOut(parts.prompt, variants) }),
    ...(parts.params === undefined ? {} : { params: cleanParams(parts.params) }),
    ...(parts.tools === undefined ? {} : { tools: [...parts.tools] }),
    ...(parts.outputSchema === undefined ? {} : { output: { schema: schemaValue(parts.outputSchema) } }),
  };
}

/** A harness as it would run, as JSON, in UTF-8 bytes: what MAX_HARNESS_BYTES bounds. */
export function harnessBytes(effective: Effective): number {
  return utf8Bytes(
    JSON.stringify(
      payloadOf("draft-h0.0", {
        ...(effective.prompt === null ? {} : { prompt: effective.prompt }),
        ...(effective.params === null ? {} : { params: effective.params }),
        ...(effective.tools === null ? {} : { tools: effective.tools }),
        ...(effective.outputSchema === null ? {} : { outputSchema: effective.outputSchema }),
      }),
    ),
  );
}

/**
 * What GET /agents/v1/config carries for a published version: only what it
 * changes, its prompt in the shape the code's defaults were sent in.
 */
export const configHarnessOf = (number: number, parts: HarnessParts, defaults: HarnessDefaults | null = null): ConfigHarness =>
  payloadOf(versionName(number), parts, speaksVariants(defaults));

/**
 * What a test job carries for a draft: every part as it would run, the
 * draft's or the code's, so the project tests exactly that. A part neither
 * has is left out.
 */
export function jobHarnessOf(
  number: number,
  revision: number,
  parts: HarnessParts,
  defaults: HarnessDefaults | null,
): ConfigHarness {
  const effective = effectiveOf(parts, defaults);
  return payloadOf(
    draftVersionName(number, revision),
    {
      ...(effective.prompt === null ? {} : { prompt: effective.prompt }),
      ...(effective.params === null ? {} : { params: effective.params }),
      ...(effective.tools === null ? {} : { tools: effective.tools }),
      ...(effective.outputSchema === null ? {} : { outputSchema: effective.outputSchema }),
    },
    speaksVariants(defaults),
  );
}
