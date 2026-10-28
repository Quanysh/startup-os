import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { PUSH_FAILURE_WORDS } from "./lib/agentControl";
import schema from "./schema";
import { pushConfig, signatureOf } from "./agentPush";
import {
  OWNER,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";
import { finishScheduled } from "./test.timers";

// Vertical Startup's agents, from the ingest door to the steering push. Every
// agent, model, figure, address and secret here is made up, and no test
// reaches a real endpoint: the push is handed a fetch of its own.

const TOKEN = "test-agents-token-0123456789-abcdefghij";
const SECRET = "made-up-steering-secret-0123456789abcdef";
const VERTICAL = "https://vertical.example.com";
const NOW = Date.parse("2026-10-16T12:00:00Z");
const TODAY = "2026-10-16";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const usage = (over: Record<string, unknown> = {}) => ({
  product: "vertical_startup",
  agentId: "note-coding.select",
  promptVersion: "3",
  provider: "ai_studio",
  model: "gemini-2.5-pro",
  day: TODAY,
  calls: 12,
  errors: 1,
  schemaFailures: 0,
  fallbacks: 0,
  refusals: 0,
  inputTokens: 34000,
  outputTokens: 5200,
  costUsd: 0.12,
  p50Ms: 4100,
  p95Ms: 9800,
  ...over,
});
const provider = (over: Record<string, unknown> = {}) => ({
  provider: "vertex",
  model: "gemini-2.5-pro",
  state: "up",
  checkedAt: "2026-10-16T11:00:00Z",
  lastErrorClass: null,
  ...over,
});
const envelope = (over: Record<string, unknown> = {}) => ({
  version: 1,
  source: "vertical_agents",
  batchId: "vertical-agents-2026-10-16",
  observedAt: "2026-10-16T12:00:00Z",
  ...over,
});

function post(t: TestBackend, body: unknown, token = TOKEN) {
  return t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const tables = (t: TestBackend) =>
  t.run(async (ctx) => ({
    usage: await ctx.db.query("agentUsage").collect(),
    providers: await ctx.db.query("agentProviders").collect(),
    config: await ctx.db.query("agentConfig").first(),
    changes: await ctx.db.query("agentControlChanges").collect(),
    controls: await ctx.db.query("agentControls").collect(),
    status: await ctx.db
      .query("sourceStatus")
      .withIndex("by_source", (q) => q.eq("source", "vertical_agents"))
      .unique(),
    runs: await ctx.db.query("syncRuns").collect(),
  }));

/** A backend with the agents token set and one push of usage and providers in it. */
async function pushed() {
  vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", TOKEN);
  const t = convexTest(schema, modules);
  const response = await post(
    t,
    envelope({
      agentUsage: [usage(), usage({ agentId: "note-coding.extract", provider: "vertex", calls: 5, errors: 0 })],
      providers: [
        provider(),
        provider({ provider: "ai_studio" }),
        provider({ provider: "astana_gpu", model: "made-up-open-72b", state: "down", lastErrorClass: "timeout" }),
      ],
    }),
  );
  expect(response.status).toBe(200);
  return t;
}

describe("the ingest door", () => {
  test("the contract's push is stored, counted, logged and marks the source fresh", async () => {
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      envelope({
        agentUsage: [usage()],
        providers: [provider({ provider: "astana_gpu", model: "made-up-open-72b" })],
        agentConfigApplied: { version: 7, appliedAt: "2026-10-16T11:00:00Z" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inserted: 2, updated: 1, unchanged: 0 });
    const stored = await tables(t);
    expect(stored.usage).toHaveLength(1);
    expect(stored.usage[0]).toMatchObject({ agentId: "note-coding.select", calls: 12, costUsd: 0.12, p95Ms: 9800 });
    expect(stored.providers[0]).toMatchObject({
      provider: "astana_gpu",
      state: "up",
      checkedAt: Date.parse("2026-10-16T11:00:00Z"),
    });
    expect(stored.providers[0]!.lastErrorClass).toBeUndefined();
    expect(stored.config).toMatchObject({ appliedVersion: 7, appliedAt: Date.parse("2026-10-16T11:00:00Z") });
    expect(stored.status).toMatchObject({ state: "ok", lastOkAt: NOW });
    expect(stored.runs).toEqual([expect.objectContaining({ source: "vertical_agents", status: "ok", inserted: 2 })]);
  });

  test("the same push twice changes nothing the second time; a new figure overwrites its row", async () => {
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", TOKEN);
    const t = convexTest(schema, modules);
    const body = envelope({ agentUsage: [usage()] });
    await post(t, body);
    expect(await (await post(t, body)).json()).toEqual({ ok: true, inserted: 0, updated: 0, unchanged: 1 });
    expect(
      await (await post(t, envelope({ agentUsage: [usage({ calls: 20, costUsd: null })] }))).json(),
    ).toEqual({ ok: true, inserted: 0, updated: 1, unchanged: 0 });
    const { usage: rows } = await tables(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.calls).toBe(20);
    // Not priced now: absent, never a stale price and never zero.
    expect(rows[0]!.costUsd).toBeUndefined();
    // Another prompt version is a row of its own.
    await post(t, envelope({ agentUsage: [usage({ promptVersion: "4" })] }));
    expect((await tables(t)).usage).toHaveLength(2);
  });

  test("a provider's older check does not replace a newer one; an older applied version does not go back", async () => {
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", TOKEN);
    const t = convexTest(schema, modules);
    await post(
      t,
      envelope({
        providers: [provider({ state: "down", checkedAt: "2026-10-16T11:30:00Z" })],
        agentConfigApplied: { version: 9, appliedAt: "2026-10-16T11:00:00Z" },
      }),
    );
    await post(
      t,
      envelope({
        providers: [provider({ state: "up", checkedAt: "2026-10-16T10:00:00Z" })],
        agentConfigApplied: { version: 8, appliedAt: "2026-10-16T11:30:00Z" },
      }),
    );
    const stored = await tables(t);
    expect(stored.providers[0]!.state).toBe("down");
    expect(stored.config!.appliedVersion).toBe(9);
  });

  test("another source's token cannot send agent usage, and the agents token sends nothing else", async () => {
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", TOKEN);
    vi.stubEnv("INGEST_TOKEN_GITHUB", "test-github-token-0123456789-abcdefghij");
    const t = convexTest(schema, modules);
    const other = await post(
      t,
      envelope({ source: "github", agentUsage: [usage()] }),
      "test-github-token-0123456789-abcdefghij",
    );
    expect(other.status).toBe(422);
    expect((await other.json()).error).toBe("agents_not_accepted");

    const snapshots = await post(
      t,
      envelope({
        snapshots: [{ key: "searches", scope: "startup_insights", period: "week", periodStart: "2026-10-05", value: 1 }],
      }),
    );
    expect(snapshots.status).toBe(422);
    expect((await snapshots.json()).error).toBe("agents_only");
    expect((await tables(t)).usage).toEqual([]);
  });

  test("a refused push is logged in paths and fixed words, never quoting what was sent", async () => {
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, envelope({ agentUsage: [{ ...usage(), patientName: "Made-up Person" }] }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("patientName");
    expect(JSON.stringify(body)).not.toContain("Made-up Person");
    const { status, usage: rows } = await tables(t);
    expect(rows).toEqual([]);
    expect(status!.state).toBe("error");
    expect(status!.message).not.toContain("patientName");
  });

  test("a day ahead of every time zone is refused with its path", async () => {
    vi.stubEnv("INGEST_TOKEN_VERTICAL_AGENTS", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, envelope({ agentUsage: [usage({ day: "2026-10-18" })] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_agent_usage",
      issues: [{ path: "agentUsage.0.day", message: "is in the future." }],
    });
  });
});

describe("what the page reads", () => {
  test("the overview: one row per agent, worked out for the day asked", async () => {
    const t = await pushed();
    const engineer = await signInAsEngineer(t);
    const result = await engineer.query(api.agentControl.overview, { today: TODAY });
    expect(result.agents.map((row) => row.agentId)).toEqual(["note-coding.extract", "note-coding.select"]);
    expect(result.agents[1]).toMatchObject({
      steered: false,
      enabled: null,
      primary: { provider: "ai_studio", model: "gemini-2.5-pro" },
      calls7d: 12,
      p95Ms7d: 9800,
      costToday: { usd: 0.12, why: null },
    });
    expect(result.agents[1]!.errorRate7d).toBeCloseTo(1 / 12);
    expect(result.pushed).toBe(true);
    expect(result.steering).toEqual({
      connected: false,
      missing: ["VERTICAL_STARTUP_URL", "VERTICAL_AGENT_CONFIG_SECRET"],
    });
  });

  test("before any push: nothing, and said so", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const result = await owner.query(api.agentControl.overview, { today: TODAY });
    expect(result.agents).toEqual([]);
    expect(result.pushed).toBe(false);
    expect(await owner.query(api.agentControl.providers, {})).toEqual([]);
  });

  test("an agent's thirty days, its models and what it may be moved to", async () => {
    const t = await pushed();
    const engineer = await signInAsEngineer(t);
    const detail = await engineer.query(api.agentControl.agent, { agentId: "note-coding.select", today: TODAY });
    expect(detail!.series).toHaveLength(30);
    expect(detail!.series.at(-1)).toMatchObject({ day: TODAY, calls: 12 });
    expect(detail!.models).toEqual([expect.objectContaining({ provider: "ai_studio", model: "gemini-2.5-pro", calls: 12 })]);
    // Up, on a provider the OS knows, and for patient data: Vertical Startup holds it,
    // so AI Studio (up) is not offered and the Kazakhstan GPU (down) is not either.
    expect(detail!.choices).toEqual([{ provider: "vertex", model: "gemini-2.5-pro" }]);
    expect(detail).toMatchObject({ project: "vertical-startup", holdsPatientData: true, allowedProviders: ["vertex"] });
    expect(await engineer.query(api.agentControl.agent, { agentId: "made-up.unknown", today: TODAY })).toBeNull();
  });

  test("a day that is not a date is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.query(api.agentControl.overview, { today: "2026-02-30" })).rejects.toThrow(
      "today is not a date",
    );
  });
});

describe("steering", () => {
  const connect = () => {
    vi.stubEnv("VERTICAL_STARTUP_URL", VERTICAL);
    vi.stubEnv("VERTICAL_AGENT_CONFIG_SECRET", SECRET);
  };

  test("a change is recorded, sent signed, and pending until Vertical Startup applies it", async () => {
    connect();
    const t = await pushed();
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        // Received, not yet applied.
        return new Response(JSON.stringify({ appliedVersion: 0 }), { status: 200 });
      }),
    );
    const engineer = await signInAsEngineer(t);
    const result = await engineer.mutation(api.agentControl.change, {
      agentId: "note-coding.select",
      provider: "vertex",
      model: "gemini-2.5-pro",
      monthlyBudgetUsd: 40,
    });
    expect(result).toEqual({ changed: true, version: 1 });
    expect((await engineer.query(api.agentControl.changes, {}))[0]).toMatchObject({
      status: "pending",
      push: "queued",
    });

    await finishScheduled(t);
    expect(sent).toHaveLength(1);
    const { url, init } = sent[0]!;
    expect(url).toBe(`${VERTICAL}/api/admin/agent-config`);
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({
      version: 1,
      agents: [
        {
          agentId: "note-coding.select",
          enabled: true,
          provider: "vertex",
          model: "gemini-2.5-pro",
          monthlyBudgetUsd: 40,
        },
      ],
    });
    const headers = init.headers as Record<string, string>;
    const timestamp = headers["x-startup-timestamp"]!;
    expect(timestamp).toBe(String(Math.floor(NOW / 1000)));
    expect(headers["x-startup-signature"]).toBe(signatureOf(SECRET, timestamp, body));

    const [change] = await engineer.query(api.agentControl.changes, {});
    expect(change).toMatchObject({
      version: 1,
      agentId: "note-coding.select",
      by: "You",
      before: null,
      after: { enabled: true, provider: "vertex", model: "gemini-2.5-pro", monthlyBudgetUsd: 40 },
      push: "sent",
      status: "pending",
    });

    // Vertical Startup's next push says it applied version 1.
    await post(t, envelope({ agentConfigApplied: { version: 1, appliedAt: "2026-10-16T12:00:00Z" } }));
    expect((await engineer.query(api.agentControl.changes, {}))[0]!.status).toBe("applied");
    const overview = await engineer.query(api.agentControl.overview, { today: TODAY });
    expect(overview.agents[1]).toMatchObject({
      steered: true,
      enabled: true,
      primary: { provider: "vertex", model: "gemini-2.5-pro" },
      budgetUsd: 40,
    });
  });

  test("the push's own answer can apply it", async () => {
    connect();
    const t = await pushed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ appliedVersion: 1 }), { status: 200 })));
    const owner = await signInAsOwner(t);
    await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false });
    await finishScheduled(t);
    expect((await owner.query(api.agentControl.changes, {}))[0]).toMatchObject({ status: "applied", by: "You" });
    expect((await tables(t)).config).toMatchObject({ latestVersion: 1, appliedVersion: 1 });
  });

  test("not connected: the change is kept and said to have failed, and nothing is fetched", async () => {
    const t = await pushed();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false });
    await finishScheduled(t);
    expect(fetch).not.toHaveBeenCalled();
    expect((await owner.query(api.agentControl.changes, {}))[0]).toMatchObject({
      status: "failed",
      push: "not_connected",
      failure: "not_connected",
    });
  });

  test("a refused push fails in fixed words; sending again goes once it is connected", async () => {
    connect();
    const t = await pushed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret detail from Vertical", { status: 401 })));
    const owner = await signInAsOwner(t);
    await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false });
    await finishScheduled(t);
    const [failed] = await owner.query(api.agentControl.changes, {});
    expect(failed).toMatchObject({ status: "failed", failure: "unauthorized" });
    expect(JSON.stringify(failed)).not.toContain("secret detail");
    expect(PUSH_FAILURE_WORDS.unauthorized).toBe(
      "Vertical Startup did not accept the signature or its time. Check that both sides have the same secret.",
    );

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ appliedVersion: 1 }), { status: 200 })));
    expect(await owner.mutation(api.agentControl.resend, {})).toEqual({ queued: true });
    await finishScheduled(t);
    expect((await owner.query(api.agentControl.changes, {}))[0]!.status).toBe("applied");
    // Nothing left to send.
    expect(await owner.mutation(api.agentControl.resend, {})).toEqual({ queued: false });
  });

  test("Vertical Startup holding a newer version: failed as stale, and sent again above it", async () => {
    connect();
    const t = await pushed();
    // It holds version 9, which this OS never heard of.
    const answers = [
      new Response(JSON.stringify({ appliedVersion: 9, stale: true }), { status: 200 }),
      new Response(JSON.stringify({ appliedVersion: 10 }), { status: 200 }),
    ];
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(init.body as string);
        return answers.shift()!;
      }),
    );
    const owner = await signInAsOwner(t);
    await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false });
    await finishScheduled(t);
    expect((await owner.query(api.agentControl.changes, {}))[0]).toMatchObject({
      version: 1,
      status: "failed",
      failure: "stale",
    });
    // Its own push saying it applied 9 does not make ours applied.
    await post(t, envelope({ agentConfigApplied: { version: 9, appliedAt: "2026-10-16T11:00:00Z" } }));
    expect((await owner.query(api.agentControl.changes, {}))[0]!.status).toBe("failed");

    expect(await owner.mutation(api.agentControl.resend, {})).toEqual({ queued: true });
    await finishScheduled(t);
    expect(JSON.parse(sent[1]!).version).toBe(10);
    expect((await owner.query(api.agentControl.changes, {}))[0]).toMatchObject({ version: 10, status: "applied" });
  });

  test("each refusal Vertical Startup can give is said in its own words", async () => {
    connect();
    for (const [status, failure] of [
      [400, "rejected"],
      [413, "too_large"],
      [502, "storage_failed"],
      [503, "not_set_up_there"],
    ] as const) {
      const t = await pushed();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
      const owner = await signInAsOwner(t);
      await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false });
      await finishScheduled(t);
      expect((await owner.query(api.agentControl.changes, {}))[0]).toMatchObject({ status: "failed", failure });
    }
  });

  test("versions follow on from what Vertical Startup last applied, and each change keeps before and after", async () => {
    const t = await pushed();
    await post(t, envelope({ agentConfigApplied: { version: 7, appliedAt: "2026-10-16T11:00:00Z" } }));
    const owner = await signInAsOwner(t);
    expect(await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false })).toEqual({
      changed: true,
      version: 8,
    });
    expect(await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: true })).toEqual({
      changed: true,
      version: 9,
    });
    // The same state again is no change, and no version.
    expect(await owner.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: true })).toEqual({
      changed: false,
    });
    const changes = await owner.query(api.agentControl.changes, { agentId: "note-coding.select" });
    expect(changes.map((c) => c.version)).toEqual([9, 8]);
    expect(changes[0]!.before).toMatchObject({ enabled: false });
    expect(changes[0]!.after).toMatchObject({ enabled: true });
  });

  test("a model must be one seen up, on a provider the OS knows; a fallback must differ", async () => {
    const t = await pushed();
    const owner = await signInAsOwner(t);
    await expect(
      owner.mutation(api.agentControl.change, {
        agentId: "note-coding.select",
        provider: "astana_gpu",
        model: "made-up-open-72b",
      }),
    ).rejects.toThrow("Choose a model that is up.");
    await expect(
      owner.mutation(api.agentControl.change, {
        agentId: "note-coding.select",
        provider: "vertex",
        model: "gemini-2.5-pro",
        fallback: { provider: "vertex", model: "gemini-2.5-pro" },
      }),
    ).rejects.toThrow("The fallback must differ from the model.");
    // Vertical Startup holds patient data: AI Studio is up, and not for it, as a model or a fallback.
    await expect(
      owner.mutation(api.agentControl.change, {
        agentId: "note-coding.extract",
        provider: "ai_studio",
        model: "gemini-2.5-pro",
      }),
    ).rejects.toThrow("That provider is not one this project may use.");
    await expect(
      owner.mutation(api.agentControl.change, {
        agentId: "note-coding.extract",
        fallback: { provider: "ai_studio", model: "gemini-2.5-pro" },
      }),
    ).rejects.toThrow("That provider is not one this project may use.");
    await expect(
      owner.mutation(api.agentControl.change, { agentId: "note-coding.select", provider: "vertex" }),
    ).rejects.toThrow("Choose a provider and a model together.");
    await expect(
      owner.mutation(api.agentControl.change, { agentId: "note-coding.select", monthlyBudgetUsd: -1 }),
    ).rejects.toThrow("A monthly budget is more than $0 and at most $1,000,000.");
    await expect(
      owner.mutation(api.agentControl.change, { agentId: "made-up.unknown", enabled: false }),
    ).rejects.toThrow("There is no agent by that id.");
    expect((await tables(t)).changes).toEqual([]);
  });

  test("a teammate's change says who made it to someone who shares a company", async () => {
    const t = await pushed();
    const engineer = await signInAsEngineer(t);
    await engineer.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false });
    await t.run(async (ctx) => {
      const user = (await ctx.db.query("users").collect()).find((u) => u.email?.startsWith("engineer"))!;
      await ctx.db.patch(user._id, { name: "Made-up Engineer" });
    });
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.agentControl.changes, {}))[0]!.by).toBe("Made-up Engineer");
  });
});

describe("the signed push", () => {
  test("the signature is HMAC-SHA256 of the timestamp, a dot and the raw body", () => {
    // Worked out independently: printf '%s' '1760616000.{"version":1,"agents":[]}' |
    // openssl dgst -sha256 -hmac 'made-up-steering-secret-0123456789abcdef'
    expect(signatureOf(SECRET, "1760616000", '{"version":1,"agents":[]}')).toBe(
      "sha256=eeb4c6f9d218653a95483a2360b5e54d1dbe195412e194632f1d73dca8a96340",
    );
  });

  test("an answer that is not JSON, or has no version, is a bad answer; a throw is unreachable", async () => {
    const env = { VERTICAL_STARTUP_URL: VERTICAL, VERTICAL_AGENT_CONFIG_SECRET: SECRET };
    const body = { version: 1, agents: [] };
    const answer = (response: Response) => pushConfig({ env, body, now: NOW, fetch: async () => response });
    expect(await answer(new Response("not json", { status: 200 }))).toEqual({ outcome: "failed", failure: "bad_answer" });
    expect(await answer(new Response("{}", { status: 200 }))).toEqual({ outcome: "failed", failure: "bad_answer" });
    expect(await answer(new Response("", { status: 500 }))).toEqual({ outcome: "failed", failure: "refused" });
    expect(
      await pushConfig({
        env,
        body,
        now: NOW,
        fetch: async () => {
          throw new Error("made-up network failure");
        },
      }),
    ).toEqual({ outcome: "failed", failure: "unreachable" });
    expect(await pushConfig({ env: {}, body, now: NOW, fetch: async () => new Response("{}") })).toEqual({
      outcome: "not_connected",
      failure: "not_connected",
    });
    // A redirect is not followed: the signature goes to one address only.
    const seen: RequestInit[] = [];
    await pushConfig({
      env,
      body,
      now: NOW,
      fetch: async (_url, init) => {
        seen.push(init!);
        return new Response(JSON.stringify({ appliedVersion: 1 }));
      },
    });
    expect(seen[0]!.redirect).toBe("manual");
  });
});

describe("who may", () => {
  const callers = {
    owner: signInAsOwner,
    engineer: (t: TestBackend) => signInAsEngineer(t),
    cofounder: (t: TestBackend) => signInAsCofounder(t),
    "engineer on Globex alone": (t: TestBackend) => signInAsEngineer(t, ["kz"]),
  };
  test.each(Object.entries(callers))("%s reads and steers", async (_who, signIn) => {
    const t = await pushed();
    const client = await signIn(t);
    expect((await client.query(api.agentControl.overview, { today: TODAY })).agents).toHaveLength(2);
    expect(await client.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false })).toMatchObject({
      changed: true,
    });
  });

  test("sales, and an engineer whose pages leave Agents out, are refused", async () => {
    const t = await pushed();
    for (const client of [await signInAsSales(t), await signInWithAreas(t, "engineer", ["product", "engineering"])]) {
      await expect(client.query(api.agentControl.overview, { today: TODAY })).rejects.toThrow("not_allowed");
      await expect(
        client.mutation(api.agentControl.change, { agentId: "note-coding.select", enabled: false }),
      ).rejects.toThrow("not_allowed");
    }
    expect((await tables(t)).changes).toEqual([]);
  });

  test("the push itself reads only what it sends: no internal function is public", async () => {
    const t = await pushed();
    const state = await t.query(internal.agentControl.pushState, {});
    expect(state).toBeNull();
  });
});
