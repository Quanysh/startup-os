// The model clients for the agents Startup OS runs itself (the project
// `startup-os`; convex/lib/agentRuntime.ts runs them). The owner decided on
// 2026-10-17 that Startup OS may call a model on the server for its built
// agents. **This is the one module that reads a provider's variables and the
// one that calls a provider**: a test fails if another does. The chat on
// /assistant is not this: it stays on Claude on the owner's Mac.
//
//   ai_studio   Gemini, POST {GEMINI_ENDPOINT}/{model}:generateContent,
//               the key in `x-goog-api-key` (GOOGLE_GENAI_API_KEY)
//   astana_gpu  an OpenAI-compatible server, POST {base}/v1/chat/completions,
//               `Authorization: Bearer` (OPEN_MODELS_BASE_URL, OPEN_MODELS_API_KEY)
//
// One interface for both: the system prompt, the turns and the tools in;
// text, tool calls, tokens and why it stopped out. A failure is a
// `ModelError` of a closed class (auth, quota, timeout, bad_request, server,
// network) with fixed words: never a response body, a header or a key. A
// body is read only to tell a bad key from a bad request, and dropped.
//
// Every request has a deadline and `redirect: "manual"`. Nothing here logs.

import { MODEL_PATTERN } from "./agentControl";
import { providersConfigured } from "./agentStartupOs";

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
/** A Gemini model id, as it goes into the address: no `/` or `:`, so it can name no other path. */
const GEMINI_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const MODEL_ERROR_CLASSES = ["auth", "quota", "timeout", "bad_request", "server", "network"] as const;
export type ModelErrorClass = (typeof MODEL_ERROR_CLASSES)[number];

/** What a failed call is said to be: fixed words, nothing the provider sent. */
export const MODEL_ERROR_WORDS: Record<ModelErrorClass, string> = {
  auth: "The provider refused the key.",
  quota: "The provider's quota or rate limit was reached.",
  timeout: "The model did not answer in time.",
  bad_request: "The provider refused the request as built.",
  server: "The provider failed to answer.",
  network: "The provider could not be reached.",
};

export class ModelError extends Error {
  constructor(readonly errorClass: ModelErrorClass) {
    super(MODEL_ERROR_WORDS[errorClass]);
    this.name = "ModelError";
  }
}

export type ToolCallRequest = { id: string; name: string; args: Record<string, unknown> };

/** A provider's own record of a turn, sent back as it came (Gemini's thought signatures). */
export type RawTurn = { provider: "ai_studio"; parts: unknown[] };

export type ModelMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCallRequest[]; raw?: RawTurn }
  | { role: "tool"; results: { id: string; name: string; output: unknown }[] };

export type ToolDeclaration = { name: string; description: string; parameters: Record<string, unknown> };

export type ModelRequest = {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolDeclaration[];
  params: { temperature?: number; maxOutputTokens?: number; thinkingBudget?: number };
  /** A JSON Schema the answer must fit: the model is asked for JSON. */
  outputSchema?: unknown;
  /** How long the call may take, in milliseconds. */
  timeoutMs: number;
};

export type ModelFinish = "stop" | "tool_calls" | "length" | "refused";

export type ModelReply = {
  text: string;
  toolCalls: ToolCallRequest[];
  finish: ModelFinish;
  usage: { inputTokens: number; outputTokens: number };
  raw?: RawTurn;
};

export interface ModelClient {
  readonly provider: string;
  generate(request: ModelRequest): Promise<ModelReply>;
}

type Fetch = typeof globalThis.fetch;
type Env = Readonly<Record<string, string | undefined>>;

// ── Shared ───────────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/** A JSON Schema as a provider takes it: without `$schema`, which some refuse. */
function bareSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dropped, ...rest } = schema;
  return rest;
}

/** The class of a status that is not 2xx; `body` is read only for Gemini's bad key, never kept. */
function classOfStatus(status: number, body: unknown): ModelErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 408 || status === 504) return "timeout";
  if (status === 400 && isObject(body) && isObject(body.error)) {
    const details = Array.isArray(body.error.details) ? body.error.details : [];
    if (details.some((detail) => isObject(detail) && detail.reason === "API_KEY_INVALID")) return "auth";
  }
  if (status >= 400 && status < 500) return "bad_request";
  return "server";
}

/** POST a JSON body with a deadline; the parsed answer, or a ModelError. */
async function postJson(fetch: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new ModelError(controller.signal.aborted ? "timeout" : "network");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    parsed = null;
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted) throw new ModelError("timeout");
  if (response.status < 200 || response.status >= 300) throw new ModelError(classOfStatus(response.status, parsed));
  if (!isObject(parsed)) throw new ModelError("server");
  return parsed;
}

// ── Gemini (Google AI Studio) ────────────────────────────────────────────────

/** A tool's answer as Gemini takes it: always an object. */
const responseOf = (output: unknown): Record<string, unknown> => (isObject(output) ? output : { result: output });

function geminiContents(messages: readonly ModelMessage[]) {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", parts: [{ text: message.text }] };
    if (message.role === "tool") {
      return {
        role: "user",
        parts: message.results.map((result) => ({ functionResponse: { name: result.name, response: responseOf(result.output) } })),
      };
    }
    if (message.raw?.provider === "ai_studio") return { role: "model", parts: message.raw.parts };
    return {
      role: "model",
      parts: [
        ...(message.text === "" ? [] : [{ text: message.text }]),
        ...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
      ],
    };
  });
}

function geminiReply(answer: Record<string, unknown>): ModelReply {
  const usage = isObject(answer.usageMetadata) ? answer.usageMetadata : {};
  const tokens = {
    inputTokens: count(usage.promptTokenCount),
    outputTokens: count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount),
  };
  const feedback = isObject(answer.promptFeedback) ? answer.promptFeedback : {};
  const candidate = Array.isArray(answer.candidates) && isObject(answer.candidates[0]) ? answer.candidates[0] : null;
  if (typeof feedback.blockReason === "string" || candidate === null) {
    if (candidate === null && typeof feedback.blockReason !== "string") throw new ModelError("server");
    return { text: "", toolCalls: [], finish: "refused", usage: tokens };
  }
  const reason = typeof candidate.finishReason === "string" ? candidate.finishReason : "STOP";
  const content = isObject(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts.filter(isObject) : [];
  if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(reason)) {
    return { text: "", toolCalls: [], finish: "refused", usage: tokens };
  }
  // Thoughts are the model's own working: never the answer.
  const text = parts
    .filter((part) => typeof part.text === "string" && part.thought !== true)
    .map((part) => part.text as string)
    .join("");
  const toolCalls: ToolCallRequest[] = [];
  for (const part of parts) {
    const call = isObject(part.functionCall) ? part.functionCall : null;
    if (call === null || typeof call.name !== "string") continue;
    toolCalls.push({
      id: typeof call.id === "string" && call.id !== "" ? call.id : `call_${toolCalls.length}`,
      name: call.name,
      args: isObject(call.args) ? call.args : {},
    });
  }
  const finish: ModelFinish = toolCalls.length > 0 ? "tool_calls" : reason === "MAX_TOKENS" ? "length" : "stop";
  return { text, toolCalls, finish, usage: tokens, raw: { provider: "ai_studio", parts } };
}

export function geminiClient(deps: { apiKey: string; fetch: Fetch }): ModelClient {
  return {
    provider: "ai_studio",
    async generate(request) {
      if (!GEMINI_MODEL_PATTERN.test(request.model)) throw new ModelError("bad_request");
      const { temperature, maxOutputTokens, thinkingBudget } = request.params;
      const generationConfig = {
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(thinkingBudget === undefined ? {} : { thinkingConfig: { thinkingBudget } }),
        ...(request.outputSchema === undefined ? {} : { responseMimeType: "application/json", responseJsonSchema: request.outputSchema }),
      };
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: geminiContents(request.messages),
        ...(request.tools.length === 0
          ? {}
          : {
              tools: [
                {
                  functionDeclarations: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: bareSchema(tool.parameters),
                  })),
                },
              ],
            }),
        ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
      };
      const answer = await postJson(
        deps.fetch,
        `${GEMINI_ENDPOINT}/${request.model}:generateContent`,
        { "x-goog-api-key": deps.apiKey },
        body,
        request.timeoutMs,
      );
      return geminiReply(answer as Record<string, unknown>);
    },
  };
}

// ── An OpenAI-compatible server (the Astana GPU) ─────────────────────────────

/** A base address: https, a host, maybe a path; no credentials, query or fragment. */
const BASE_URL_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*\/?$/;

function openMessages(system: string, messages: readonly ModelMessage[]) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") out.push({ role: "user", content: message.text });
    else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text === "" ? null : message.text,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            }),
      });
    } else {
      for (const result of message.results) {
        out.push({ role: "tool", tool_call_id: result.id, content: JSON.stringify(result.output) });
      }
    }
  }
  return out;
}

function openReply(answer: Record<string, unknown>): ModelReply {
  const usage = isObject(answer.usage) ? answer.usage : {};
  const tokens = { inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens) };
  const choice = Array.isArray(answer.choices) && isObject(answer.choices[0]) ? answer.choices[0] : null;
  if (choice === null || !isObject(choice.message)) throw new ModelError("server");
  const message = choice.message;
  const toolCalls: ToolCallRequest[] = [];
  for (const [i, call] of (Array.isArray(message.tool_calls) ? message.tool_calls : []).entries()) {
    const fn = isObject(call) && isObject(call.function) ? call.function : null;
    if (fn === null || typeof fn.name !== "string") continue;
    let args: unknown = {};
    try {
      args = typeof fn.arguments === "string" && fn.arguments !== "" ? JSON.parse(fn.arguments) : {};
    } catch {
      args = {};
    }
    toolCalls.push({ id: isObject(call) && typeof call.id === "string" ? call.id : `call_${i}`, name: fn.name, args: isObject(args) ? args : {} });
  }
  const reason = choice.finish_reason;
  const finish: ModelFinish =
    toolCalls.length > 0 ? "tool_calls" : reason === "content_filter" ? "refused" : reason === "length" ? "length" : "stop";
  return { text: typeof message.content === "string" ? message.content : "", toolCalls, finish, usage: tokens };
}

export function openModelsClient(deps: { baseUrl: string; apiKey: string; fetch: Fetch }): ModelClient {
  if (!BASE_URL_PATTERN.test(deps.baseUrl)) throw new ModelError("bad_request");
  const base = deps.baseUrl.replace(/\/+$/, "");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  return {
    provider: "astana_gpu",
    async generate(request) {
      if (!MODEL_PATTERN.test(request.model)) throw new ModelError("bad_request");
      const { temperature, maxOutputTokens } = request.params;
      const body = {
        model: request.model,
        messages: openMessages(request.system, request.messages),
        ...(request.tools.length === 0
          ? {}
          : {
              tools: request.tools.map((tool) => ({
                type: "function",
                function: { name: tool.name, description: tool.description, parameters: bareSchema(tool.parameters) },
              })),
            }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
        ...(request.outputSchema === undefined
          ? {}
          : { response_format: { type: "json_schema", json_schema: { name: "output", schema: request.outputSchema } } }),
      };
      const answer = await postJson(deps.fetch, url, { Authorization: `Bearer ${deps.apiKey}` }, body, request.timeoutMs);
      return openReply(answer as Record<string, unknown>);
    },
  };
}

// ── Which providers, from the environment ───────────────────────────────────

const set = (env: Env, name: string) => (env[name] ?? "") !== "";

/** Whether each of Startup OS's providers has its variables set: by their names, never their values. */
export function configuredProviders(env: Env = process.env): Record<string, boolean> {
  const configured = providersConfigured((name) => set(env, name));
  // The Astana GPU's base is held to the address rule a client is made with: one that is not https is not configured.
  if (configured.astana_gpu === true && !BASE_URL_PATTERN.test(env.OPEN_MODELS_BASE_URL ?? "")) configured.astana_gpu = false;
  return configured;
}

/** The client for one of Startup OS's providers, or null where it is not one or not configured. */
export function modelClientFor(
  provider: string,
  deps: { env?: Env; fetch?: Fetch } = {},
): ModelClient | null {
  const env = deps.env ?? process.env;
  const fetch = deps.fetch ?? globalThis.fetch;
  if (configuredProviders(env)[provider] !== true) return null;
  if (provider === "ai_studio") return geminiClient({ apiKey: env.GOOGLE_GENAI_API_KEY!, fetch });
  if (provider === "astana_gpu") {
    try {
      return openModelsClient({ baseUrl: env.OPEN_MODELS_BASE_URL!, apiKey: env.OPEN_MODELS_API_KEY!, fetch });
    } catch {
      return null;
    }
  }
  return null;
}
