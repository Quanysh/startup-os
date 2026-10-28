import { describe, expect, test } from "vitest";
import {
  GEMINI_ENDPOINT,
  MODEL_ERROR_WORDS,
  ModelError,
  configuredProviders,
  geminiClient,
  modelClientFor,
  openModelsClient,
  type ModelRequest,
} from "./modelClients";

// The model clients for the agents Startup OS runs itself: Google AI Studio's
// Gemini REST API and an OpenAI-compatible chat completions API (the Astana
// GPU). Every test answers from a fake fetch: no test reaches a provider, and
// every key here is made up.

const KEY = "made-up-key-0123456789";

type Seen = { url: string; init: RequestInit };

function fakeFetch(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    seen.push(call);
    return await answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "gemini-3.8-flash",
  system: "Sort the made-up request.",
  messages: [{ role: "user", text: "Request: made-up" }],
  tools: [],
  params: {},
  timeoutMs: 5_000,
  ...over,
});

const bodyOf = (seen: Seen) => JSON.parse(String(seen.init.body)) as Record<string, unknown>;

const GEMINI_OK = {
  candidates: [{ content: { role: "model", parts: [{ text: "Sorted." }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, thoughtsTokenCount: 4 },
};

describe("Gemini on Google AI Studio", () => {
  test("posts generateContent for the model, the key in x-goog-api-key and nowhere else", async () => {
    const { fetch, seen } = fakeFetch(() => json(200, GEMINI_OK));
    const reply = await geminiClient({ apiKey: KEY, fetch }).generate(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${GEMINI_ENDPOINT}/gemini-3.8-flash:generateContent`);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("manual");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("x-goog-api-key")).toBe(KEY);
    expect(headers.get("authorization")).toBeNull();
    expect(seen[0]!.url).not.toContain(KEY);
    expect(String(seen[0]!.init.body)).not.toContain(KEY);
    expect(reply).toEqual({
      text: "Sorted.",
      toolCalls: [],
      finish: "stop",
      usage: { inputTokens: 120, outputTokens: 12 },
      raw: { provider: "ai_studio", parts: [{ text: "Sorted." }] },
    });
  });

  test("the system prompt, the turns, the tools and the parameters, in Gemini's shape", async () => {
    const { fetch, seen } = fakeFetch(() => json(200, GEMINI_OK));
    await geminiClient({ apiKey: KEY, fetch }).generate(
      request({
        messages: [
          { role: "user", text: "Request: made-up" },
          {
            role: "assistant",
            text: "",
            toolCalls: [{ id: "c1", name: "tasks", args: { company: "us" } }],
            raw: { provider: "ai_studio", parts: [{ functionCall: { name: "tasks", args: { company: "us" } }, thoughtSignature: "sig" }] },
          },
          { role: "tool", results: [{ id: "c1", name: "tasks", output: ["made-up"] }] },
        ],
        tools: [
          {
            name: "tasks",
            description: "Reads the made-up board.",
            parameters: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {} },
          },
        ],
        params: { temperature: 0.2, maxOutputTokens: 512, thinkingBudget: 128 },
      }),
    );
    const body = bodyOf(seen[0]!);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Sort the made-up request." }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Request: made-up" }] },
      // The model's own parts go back as they came, thought signature and all.
      { role: "model", parts: [{ functionCall: { name: "tasks", args: { company: "us" } }, thoughtSignature: "sig" }] },
      { role: "user", parts: [{ functionResponse: { name: "tasks", response: { result: ["made-up"] } } }] },
    ]);
    expect(body.tools).toEqual([
      { functionDeclarations: [{ name: "tasks", description: "Reads the made-up board.", parametersJsonSchema: { type: "object", properties: {} } }] },
    ]);
    expect(body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 128 } });
  });

  test("an output schema asks for JSON with that schema", async () => {
    const { fetch, seen } = fakeFetch(() => json(200, GEMINI_OK));
    const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
    await geminiClient({ apiKey: KEY, fetch }).generate(request({ outputSchema: schema }));
    expect(bodyOf(seen[0]!).generationConfig).toEqual({ responseMimeType: "application/json", responseJsonSchema: schema });
  });

  test("function calls come back with ids, and the reply says it wants tools", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "deals", args: { company: "kz" } } }, { functionCall: { id: "x9", name: "tasks", args: {} } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
    );
    const reply = await geminiClient({ apiKey: KEY, fetch }).generate(request());
    expect(reply.finish).toBe("tool_calls");
    expect(reply.toolCalls).toEqual([
      { id: "call_0", name: "deals", args: { company: "kz" } },
      { id: "x9", name: "tasks", args: {} },
    ]);
  });

  test("a blocked prompt or a safety stop is a refusal", async () => {
    const blocked = fakeFetch(() => json(200, { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 5 } }));
    expect((await geminiClient({ apiKey: KEY, fetch: blocked.fetch }).generate(request())).finish).toBe("refused");
    const stopped = fakeFetch(() => json(200, { candidates: [{ finishReason: "SAFETY" }] }));
    expect((await geminiClient({ apiKey: KEY, fetch: stopped.fetch }).generate(request())).finish).toBe("refused");
  });

  test.each([
    [401, {}, "auth"],
    [403, {}, "auth"],
    [400, { error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, "auth"],
    [400, { error: { status: "INVALID_ARGUMENT", message: "made-up words about the request" } }, "bad_request"],
    [404, {}, "bad_request"],
    [429, {}, "quota"],
    [500, {}, "server"],
    [503, {}, "server"],
    [504, {}, "timeout"],
    [302, {}, "server"],
  ] as const)("a %s is the class %s, in fixed words with no body and no key", async (status, body, errorClass) => {
    const { fetch } = fakeFetch(() => json(status, { ...body, echo: KEY }));
    const failure = await geminiClient({ apiKey: KEY, fetch })
      .generate(request())
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelError);
    expect((failure as ModelError).errorClass).toBe(errorClass);
    expect((failure as ModelError).message).toBe(MODEL_ERROR_WORDS[errorClass]);
    expect(JSON.stringify(failure)).not.toContain(KEY);
    expect((failure as ModelError).message).not.toContain("made-up words");
  });

  test("a network failure is `network`, and a call past its time is `timeout`", async () => {
    const down = fakeFetch(() => {
      throw new TypeError(`fetch failed for ${KEY}`);
    });
    const failure = (await geminiClient({ apiKey: KEY, fetch: down.fetch }).generate(request()).catch((e: unknown) => e)) as ModelError;
    expect(failure.errorClass).toBe("network");
    expect(failure.message).not.toContain(KEY);

    const slow = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const late = (await geminiClient({ apiKey: KEY, fetch: slow.fetch }).generate(request({ timeoutMs: 5 })).catch((e: unknown) => e)) as ModelError;
    expect(late.errorClass).toBe("timeout");
  });

  test("an answer that is not Gemini's shape is a server error", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>made-up</html>", { status: 200 }));
    const failure = (await geminiClient({ apiKey: KEY, fetch }).generate(request()).catch((e: unknown) => e)) as ModelError;
    expect(failure.errorClass).toBe("server");
  });

  test("a model id that is not one is refused before anything is sent", async () => {
    const { fetch, seen } = fakeFetch(() => json(200, GEMINI_OK));
    const failure = (await geminiClient({ apiKey: KEY, fetch }).generate(request({ model: "../../v1/files?x" })).catch((e: unknown) => e)) as ModelError;
    expect(failure.errorClass).toBe("bad_request");
    expect(seen).toHaveLength(0);
  });
});

const OPEN_OK = {
  choices: [{ message: { role: "assistant", content: "Sorted." }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 6 },
};

describe("an OpenAI-compatible server (the Astana GPU)", () => {
  test("posts /v1/chat/completions with a bearer key, and the turns in its shape", async () => {
    const { fetch, seen } = fakeFetch(() => json(200, OPEN_OK));
    const client = openModelsClient({ baseUrl: "https://models.example.com", apiKey: KEY, fetch });
    const reply = await client.generate(
      request({
        model: "made-up-open-model",
        messages: [
          { role: "user", text: "Request: made-up" },
          { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "tasks", args: { company: "us" } }] },
          { role: "tool", results: [{ id: "c1", name: "tasks", output: { rows: [] } }] },
        ],
        tools: [{ name: "tasks", description: "Reads the made-up board.", parameters: { type: "object", properties: {} } }],
        params: { temperature: 0.1, maxOutputTokens: 300 },
        outputSchema: { type: "object" },
      }),
    );
    expect(seen[0]!.url).toBe("https://models.example.com/v1/chat/completions");
    expect(seen[0]!.init.redirect).toBe("manual");
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(bodyOf(seen[0]!)).toEqual({
      model: "made-up-open-model",
      messages: [
        { role: "system", content: "Sort the made-up request." },
        { role: "user", content: "Request: made-up" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "tasks", arguments: '{"company":"us"}' } }] },
        { role: "tool", tool_call_id: "c1", content: '{"rows":[]}' },
      ],
      tools: [{ type: "function", function: { name: "tasks", description: "Reads the made-up board.", parameters: { type: "object", properties: {} } } }],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: "json_schema", json_schema: { name: "output", schema: { type: "object" } } },
    });
    expect(reply).toEqual({ text: "Sorted.", toolCalls: [], finish: "stop", usage: { inputTokens: 50, outputTokens: 6 } });
  });

  test("a base that already ends in /v1 is not doubled; tool calls come back parsed", async () => {
    const { fetch, seen } = fakeFetch(() =>
      json(200, {
        choices: [
          {
            message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "deals", arguments: '{"company":"kz"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }),
    );
    const reply = await openModelsClient({ baseUrl: "https://models.example.com/v1/", apiKey: KEY, fetch }).generate(request());
    expect(seen[0]!.url).toBe("https://models.example.com/v1/chat/completions");
    expect(reply.toolCalls).toEqual([{ id: "t1", name: "deals", args: { company: "kz" } }]);
    expect(reply.finish).toBe("tool_calls");
  });

  test("a base that is not an https address is refused, never echoed", () => {
    for (const baseUrl of ["http://models.example.com", "models.example.com", "https://user:pw@models.example.com", "https://models.example.com/?q=1"]) {
      expect(() => openModelsClient({ baseUrl, apiKey: KEY, fetch: globalThis.fetch })).toThrow(MODEL_ERROR_WORDS.bad_request);
    }
  });

  test("errors are the same classes", async () => {
    const { fetch } = fakeFetch(() => json(429, { error: { message: KEY } }));
    const failure = (await openModelsClient({ baseUrl: "https://models.example.com", apiKey: KEY, fetch }).generate(request()).catch((e: unknown) => e)) as ModelError;
    expect(failure.errorClass).toBe("quota");
    expect(failure.message).not.toContain(KEY);
  });
});

describe("which providers are configured, and the client for each", () => {
  test("by the variables' names being set, never their values", () => {
    expect(configuredProviders({})).toEqual({ ai_studio: false, astana_gpu: false });
    expect(configuredProviders({ GOOGLE_GENAI_API_KEY: KEY, OPEN_MODELS_BASE_URL: "https://models.example.com" })).toEqual({
      ai_studio: true,
      astana_gpu: false,
    });
    expect(configuredProviders({ GOOGLE_GENAI_API_KEY: "", OPEN_MODELS_BASE_URL: "https://m.example.com", OPEN_MODELS_API_KEY: KEY })).toEqual({
      ai_studio: false,
      astana_gpu: true,
    });
    // A base that is not an https address is not configured, as no client is made for it.
    expect(configuredProviders({ OPEN_MODELS_BASE_URL: "http://m.example.com", OPEN_MODELS_API_KEY: KEY })).toEqual({
      ai_studio: false,
      astana_gpu: false,
    });
  });

  test("a client only for a configured provider Startup OS runs on", () => {
    const fetch = globalThis.fetch;
    expect(modelClientFor("ai_studio", { env: {}, fetch })).toBeNull();
    expect(modelClientFor("ai_studio", { env: { GOOGLE_GENAI_API_KEY: KEY }, fetch })?.provider).toBe("ai_studio");
    expect(modelClientFor("vertex", { env: { GOOGLE_GENAI_API_KEY: KEY }, fetch })).toBeNull();
    expect(
      modelClientFor("astana_gpu", { env: { OPEN_MODELS_BASE_URL: "https://models.example.com", OPEN_MODELS_API_KEY: KEY }, fetch })?.provider,
    ).toBe("astana_gpu");
    // A base that is not an https address: not a client, and not thrown at the caller.
    expect(modelClientFor("astana_gpu", { env: { OPEN_MODELS_BASE_URL: "ftp://x", OPEN_MODELS_API_KEY: KEY }, fetch })).toBeNull();
  });
});
