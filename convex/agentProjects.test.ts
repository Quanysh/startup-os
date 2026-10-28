import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  API_WORDS,
  LAUNCH_WORDS,
  MAX_PROJECT_CALLS_PER_WINDOW,
  MAX_USAGE_BYTES,
  PROJECT_WORDS,
} from "./lib/agentProjects";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAsCofounder,
  signInAsEngineer,
  signInAsOwner,
  signInAsSales,
  type TestBackend,
} from "./test.setup";
import { finishScheduled } from "./test.timers";

// Projects and Protocol v1: connecting a project, its token, what it fetches
// and what it reports. Every project, agent, model and figure is made up, and
// no test reaches a real endpoint: the legacy push is handed a fetch of its own.

const NOW = Date.parse("2026-10-16T12:00:00Z");
const TODAY = "2026-10-16";
const ENTROPY = "a".repeat(43);

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

type Client = Awaited<ReturnType<typeof signInAsOwner>>;

const SAMPLE = {
  name: "Sample Clinic App",
  slug: "sample-clinic",
  region: "US" as const,
  holdsPatientData: true,
  allowedProviders: ["vertex"],
};
const PLAIN = {
  name: "Sample Search",
  slug: "sample-search",
  region: "US" as const,
  holdsPatientData: false,
  allowedProviders: ["ai_studio", "vertex"],
};

const connect = (client: Client, project: typeof SAMPLE | typeof PLAIN = SAMPLE) =>
  client.mutation(api.agentProjects.connect, { ...project, entropy: ENTROPY });

const usageRow = (over: Record<string, unknown> = {}) => ({
  agentId: "sample.extract",
  promptVersion: "v1+made0up1",
  provider: "vertex",
  model: "made-up-pro",
  day: TODAY,
  calls: 10,
  errors: 1,
  schemaFailures: 0,
  fallbacks: 0,
  refusals: 0,
  inputTokens: 2000,
  outputTokens: 300,
  costUsd: 0.05,
  p50Ms: 900,
  p95Ms: 2100,
  ...over,
});
const providerRow = (over: Record<string, unknown> = {}) => ({
  provider: "vertex",
  model: "made-up-pro",
  state: "up",
  checkedAt: "2026-10-16T11:00:00Z",
  lastErrorClass: null,
  ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  batchId: "sample-2026-10-16",
  observedAt: "2026-10-16T12:00:00Z",
  agentUsage: [usageRow()],
  providers: [providerRow(), providerRow({ provider: "ai_studio", model: "made-up-flash" })],
  agentsKnown: [{ agentId: "sample.extract", name: "Sample extract", phi: true, kind: "code" }],
  configApplied: { version: 0, appliedAt: null },
  ...over,
});

const report = (t: TestBackend, token: string, payload: unknown = body()) =>
  t.fetch("/agents/v1/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const config = (t: TestBackend, token: string, etag?: string) =>
  t.fetch("/agents/v1/config", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, ...(etag === undefined ? {} : { "If-None-Match": etag }) },
  });

async function connected(project: typeof SAMPLE | typeof PLAIN = SAMPLE) {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  const { token } = await connect(owner, project);
  return { t, owner, token };
}

describe("connecting a project", () => {
  test("gives a rap_ token once; the project's card never holds it or its hash", async () => {
    const { t, owner, token } = await connected();
    expect(token).toMatch(/^rap_[A-Za-z0-9_-]{43}$/);
    const cards = await owner.query(api.agentProjects.list, { today: TODAY });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      slug: "sample-clinic",
      name: "Sample Clinic App",
      connected: true,
      failMode: "closed",
      lastSeenAt: null,
      callsToday: null,
      errorsToday: null,
      costToday: { usd: null, why: "nothing_reported" },
    });
    const said = JSON.stringify(cards);
    const stored = await t.run(async (ctx) => (await ctx.db.query("agentProjects").first())!);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(said).not.toContain(token);
    expect(said).not.toContain(stored.tokenHash!);
  });

  test("refuses a taken or reserved id, a bad name, and non-patient providers for a patient-data project", async () => {
    const { owner } = await connected();
    await expect(connect(owner)).rejects.toThrow(PROJECT_WORDS.taken);
    await expect(connect(owner, { ...SAMPLE, slug: "startup-os" })).rejects.toThrow(PROJECT_WORDS.reserved);
    await expect(connect(owner, { ...SAMPLE, slug: "Bad Slug" })).rejects.toThrow(PROJECT_WORDS.slug);
    await expect(connect(owner, { ...SAMPLE, slug: "other", name: "<b>" })).rejects.toThrow(PROJECT_WORDS.name);
    await expect(
      connect(owner, { ...SAMPLE, slug: "other", allowedProviders: ["vertex", "ai_studio"] }),
    ).rejects.toThrow(PROJECT_WORDS.patientProviders);
    await expect(
      owner.mutation(api.agentProjects.connect, { ...PLAIN, entropy: "short" }),
    ).rejects.toThrow(PROJECT_WORDS.tokenNotMade);
  });
});

describe("the token", () => {
  test("a good token is let in; none, another kind, an unknown one and a malformed header are one 401", async () => {
    const { t, token } = await connected();
    expect((await config(t, token)).status).toBe(200);
    for (const bad of ["", "sosa_made-up", "sos_made-up", "made-up-ingest-token", `rap_${"x".repeat(43)}`]) {
      const response = await config(t, bad);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ ok: false, error: "unauthorized", message: API_WORDS.unauthorized });
      expect((await report(t, bad)).status).toBe(401);
    }
    const noBearer = await t.fetch("/agents/v1/config", { method: "GET", headers: { Authorization: token } });
    expect(noBearer.status).toBe(401);
  });

  test("a disconnected project's token is refused; a rotated token replaces the old one at once", async () => {
    const { t, owner, token } = await connected();
    await owner.mutation(api.agentProjects.disconnect, { slug: "sample-clinic" });
    expect((await config(t, token)).status).toBe(401);
    expect((await owner.query(api.agentProjects.list, { today: TODAY }))[0]).toMatchObject({
      connected: false,
      status: "disconnected",
    });
    const { token: second } = await owner.mutation(api.agentProjects.rotateToken, {
      slug: "sample-clinic",
      entropy: ENTROPY,
    });
    expect(second).not.toBe(token);
    expect((await config(t, second)).status).toBe(200);
    const { token: third } = await owner.mutation(api.agentProjects.rotateToken, {
      slug: "sample-clinic",
      entropy: ENTROPY,
    });
    expect((await config(t, second)).status).toBe(401);
    expect((await config(t, third)).status).toBe(200);
  });

  test("calls are limited per project, like the owner's agent endpoint", async () => {
    const { t, token } = await connected();
    for (let i = 0; i < MAX_PROJECT_CALLS_PER_WINDOW; i++) expect((await config(t, token)).status).toBe(200);
    const limited = await config(t, token);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe("too_many_requests");
    vi.setSystemTime(NOW + 11 * 60_000);
    expect((await config(t, token)).status).toBe(200);
  });

  test("a call stamps the project as seen", async () => {
    const { t, owner, token } = await connected();
    await config(t, token);
    expect((await owner.query(api.agentProjects.list, { today: TODAY }))[0]!.lastSeenAt).toBe(NOW);
  });
});

describe("GET /agents/v1/config", () => {
  test("version 0 and no agents before anything is launched; fail closed for patient data, open otherwise", async () => {
    const { t, owner, token } = await connected();
    const response = await config(t, token);
    expect(response.headers.get("ETag")).toBe('"0"');
    expect(await response.json()).toEqual({ project: "sample-clinic", version: 0, agents: [], failMode: "closed" });
    const { token: plain } = await connect(owner, PLAIN);
    expect(await (await config(t, plain)).json()).toMatchObject({ project: "sample-search", failMode: "open" });
  });

  test("answers 304 to the version it holds, and the new config once it changes", async () => {
    const { t, owner, token } = await connected();
    await report(t, token);
    expect((await config(t, token, '"0"')).status).toBe(304);
    await owner.mutation(api.agentControl.launch, {
      project: "sample-clinic",
      agentId: "sample.extract",
      name: "Extract",
      enabled: true,
      provider: "vertex",
      model: "made-up-pro",
      monthlyBudgetUsd: 25,
      promptVersionPin: "v1+made0up1",
    });
    const stale = await config(t, token, '"0"');
    expect(stale.status).toBe(200);
    expect(stale.headers.get("ETag")).toBe('"1"');
    expect(await stale.json()).toEqual({
      project: "sample-clinic",
      version: 1,
      agents: [
        {
          agentId: "sample.extract",
          name: "Extract",
          enabled: true,
          provider: "vertex",
          model: "made-up-pro",
          monthlyBudgetUsd: 25,
          promptVersionPin: "v1+made0up1",
        },
      ],
      failMode: "closed",
    });
    expect((await config(t, token, '"1"')).status).toBe(304);
    expect((await config(t, token, 'W/"1"')).status).toBe(304);
  });
});

describe("POST /agents/v1/usage", () => {
  test("stores the report as the token's project, counts it, and says the config version", async () => {
    const { t, owner, token } = await connected();
    const response = await report(t, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: { agentUsage: 1, providers: 2, agentsKnown: 1, inserted: 3, updated: 1, unchanged: 0 },
      configVersion: 0,
    });
    const rows = await t.run(async (ctx) => ({
      usage: await ctx.db.query("agentUsage").collect(),
      catalog: await ctx.db.query("agentCatalog").collect(),
    }));
    expect(rows.usage.map((row) => [row.project, row.agentId])).toEqual([["sample-clinic", "sample.extract"]]);
    expect(rows.usage[0]!.product).toBeUndefined();
    expect(rows.catalog).toEqual([
      expect.objectContaining({ project: "sample-clinic", agentId: "sample.extract", name: "Sample extract", phi: true, kind: "code" }),
    ]);
    const card = (await owner.query(api.agentProjects.list, { today: TODAY }))[0]!;
    expect(card).toMatchObject({ agentsCount: 1, knownCount: 1, callsToday: 10, errorsToday: 1, costToday: { usd: 0.05, why: null } });
  });

  test("the same report twice changes nothing the second time", async () => {
    const { t, token } = await connected();
    await report(t, token);
    const again = await (await report(t, token)).json();
    expect(again.accepted).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
  });

  test("a token writes its own project only: a row or body that names a project or product is refused", async () => {
    const { t, owner, token } = await connected();
    const { token: other } = await connect(owner, PLAIN);
    for (const payload of [
      body({ project: "sample-search" }),
      body({ agentUsage: [usageRow({ project: "sample-search" })] }),
      body({ agentUsage: [usageRow({ product: "vertical_startup" })] }),
    ]) {
      const response = await report(t, token, payload);
      expect(response.status).toBe(422);
      const said = await response.json();
      expect(said.error).toBe("invalid_body");
      // Fixed words: nothing sent is quoted back.
      expect(JSON.stringify(said)).not.toContain("sample-search");
      expect(JSON.stringify(said)).not.toContain("vertical_startup");
    }
    await report(t, other, body({ agentUsage: [usageRow({ agentId: "search.rank", provider: "ai_studio", model: "made-up-flash" })] }));
    const overview = await owner.query(api.agentControl.overview, { today: TODAY, project: "sample-clinic" });
    expect(overview.agents).toEqual([]);
    const theirs = await owner.query(api.agentControl.overview, { today: TODAY, project: "sample-search" });
    expect(theirs.agents.map((row) => row.agentId)).toEqual(["search.rank"]);
    const all = await owner.query(api.agentControl.overview, { today: TODAY });
    expect(all.agents.map((row) => [row.project, row.agentId])).toEqual([["sample-search", "search.rank"]]);
  });

  test("is held to the same bounds as the legacy push: by path and fixed words", async () => {
    const { t, token } = await connected();
    const cases: [unknown, string][] = [
      [body({ agentUsage: [usageRow({ errors: 11 })] }), "agentUsage.0.errors"],
      [body({ agentUsage: [usageRow({ day: "2026-10-18" })] }), "agentUsage.0.day"],
      [body({ agentUsage: [usageRow({ promptVersion: "has spaces in it" })] }), "agentUsage.0.promptVersion"],
      [body({ agentUsage: [usageRow({ calls: -1 })] }), "agentUsage.0.calls"],
      [body({ agentUsage: [usageRow(), usageRow()] }), "agentUsage.1"],
      [body({ agentsKnown: [{ agentId: "x", name: "Patient Jane Doe <b>", phi: false, kind: "code" }] }), "agentsKnown.0.name"],
      [body({ configApplied: undefined }), "configApplied"],
    ];
    for (const [payload, path] of cases) {
      const response = await report(t, token, payload);
      expect([path, response.status]).toEqual([path, 422]);
      const said = await response.json();
      expect(said.issues.map((issue: { path: string }) => issue.path)).toContain(path);
      expect(JSON.stringify(said)).not.toContain("Jane");
    }
    expect((await report(t, token, "{not json")).status).toBe(400);
    const huge = await report(t, token, JSON.stringify(body({ pad: "x".repeat(MAX_USAGE_BYTES + 1) })));
    expect(huge.status).toBe(413);
    expect(await t.run(async (ctx) => (await ctx.db.query("agentUsage").collect()).length)).toBe(0);
  });
});

describe("launching an agent", () => {
  test("launch, pending, then applied once the project says it applied that version", async () => {
    const { t, owner, token } = await connected();
    await report(t, token);
    const { version } = await owner.mutation(api.agentControl.launch, {
      project: "sample-clinic",
      agentId: "sample.extract",
      enabled: true,
      provider: "vertex",
      model: "made-up-pro",
    });
    expect(version).toBe(1);
    const before = await owner.query(api.agentControl.overview, { today: TODAY, project: "sample-clinic" });
    expect(before.agents[0]).toMatchObject({ agentId: "sample.extract", name: "Sample extract", steered: true, pending: true, phi: true });
    const [launched] = await owner.query(api.agentControl.changes, { project: "sample-clinic" });
    expect(launched).toMatchObject({ project: "sample-clinic", launched: true, push: "pull", status: "pending", before: null });

    const answer = await (await report(t, token, body({ configApplied: { version: 1, appliedAt: "2026-10-16T11:59:00Z" } }))).json();
    expect(answer.configVersion).toBe(1);
    const after = await owner.query(api.agentControl.overview, { today: TODAY, project: "sample-clinic" });
    expect(after.agents[0]!.pending).toBe(false);
    expect((await owner.query(api.agentControl.changes, { project: "sample-clinic" }))[0]!.status).toBe("applied");
  });

  test("an id the project has not reported yet waits for it; launched twice is refused", async () => {
    const { t, owner, token } = await connected();
    await report(t, token, body({ agentUsage: [], agentsKnown: [] }));
    await owner.mutation(api.agentControl.launch, {
      project: "sample-clinic",
      agentId: "sample.future",
      name: "Coming soon",
      enabled: false,
      provider: "vertex",
      model: "made-up-pro",
    });
    const overview = await owner.query(api.agentControl.overview, { today: TODAY, project: "sample-clinic" });
    expect(overview.agents[0]).toMatchObject({ agentId: "sample.future", name: "Coming soon", waiting: true, enabled: false });
    await expect(
      owner.mutation(api.agentControl.launch, {
        project: "sample-clinic",
        agentId: "sample.future",
        enabled: true,
        provider: "vertex",
        model: "made-up-pro",
      }),
    ).rejects.toThrow(LAUNCH_WORDS.launched);
  });

  test("a patient-data project, or an agent that handles patient data, gets patient-data providers only", async () => {
    const { t, owner, token } = await connected();
    await report(t, token);
    // ai_studio is up in this project and not one it may use.
    await expect(
      owner.mutation(api.agentControl.launch, {
        project: "sample-clinic",
        agentId: "sample.other",
        enabled: true,
        provider: "ai_studio",
        model: "made-up-flash",
      }),
    ).rejects.toThrow(LAUNCH_WORDS.notAllowed);

    const { token: plain } = await connect(owner, PLAIN);
    await report(
      t,
      plain,
      body({
        agentsKnown: [
          { agentId: "search.rank", name: "Rank", phi: false, kind: "declarative" },
          { agentId: "search.notes", name: "Notes", phi: true, kind: "code" },
        ],
      }),
    );
    expect(
      await owner.mutation(api.agentControl.launch, {
        project: "sample-search",
        agentId: "search.rank",
        enabled: true,
        provider: "ai_studio",
        model: "made-up-flash",
        fallback: { provider: "vertex", model: "made-up-pro" },
      }),
    ).toEqual({ version: 1 });
    await expect(
      owner.mutation(api.agentControl.launch, {
        project: "sample-search",
        agentId: "search.notes",
        enabled: true,
        provider: "ai_studio",
        model: "made-up-flash",
      }),
    ).rejects.toThrow(LAUNCH_WORDS.phiAgent);
    // A model nobody reported up is refused whatever the provider.
    await expect(
      owner.mutation(api.agentControl.launch, {
        project: "sample-search",
        agentId: "search.notes",
        enabled: true,
        provider: "vertex",
        model: "made-up-unknown",
      }),
    ).rejects.toThrow("Choose a model that is up.");
    const card = (await owner.query(api.agentProjects.list, { today: TODAY })).find((c) => c.slug === "sample-search")!;
    expect(card.phiMismatch).toBe(true);
    const options = await owner.query(api.agentProjects.launchOptions, { project: "sample-search" });
    expect(options!.pairs).toEqual([
      { provider: "ai_studio", model: "made-up-flash", patientData: false },
      { provider: "vertex", model: "made-up-pro", patientData: true },
    ]);
    expect(options!.catalog.map((entry) => [entry.agentId, entry.launched])).toEqual([
      ["search.notes", false],
      ["search.rank", true],
    ]);
  });

  test("Startup OS's own project and an unknown one cannot be launched into", async () => {
    const { owner } = await connected();
    for (const project of ["startup-os", "made-up-missing"]) {
      await expect(
        owner.mutation(api.agentControl.launch, {
          project,
          agentId: "x",
          enabled: true,
          provider: "vertex",
          model: "made-up-pro",
        }),
      ).rejects.toThrow();
    }
  });
});

describe("Vertical Startup, the legacy project", () => {
  test("rows from before projects read as Vertical Startup's, and are stamped by the adoption", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const { project: _project, ...row } = { ...usageRow({ agentId: "note-coding.select" }), project: undefined };
      await ctx.db.insert("agentUsage", { ...row, product: "vertical_startup", costUsd: 0.05, syncedAt: 1 });
      await ctx.db.insert("agentConfig", { latestVersion: 2, appliedVersion: 2 });
    });
    const owner = await signInAsOwner(t);
    const cards = await owner.query(api.agentProjects.list, { today: TODAY });
    expect(cards.map((card) => [card.slug, card.legacy, card.agentsCount])).toEqual([["vertical-startup", true, 1]]);
    const overview = await owner.query(api.agentControl.overview, { today: TODAY });
    expect(overview.agents.map((row) => [row.project, row.agentId])).toEqual([["vertical-startup", "note-coding.select"]]);
    expect(await t.mutation(internal.agentProjects.adoptLegacyRows, {})).toEqual({ stamped: 2 });
    expect(await t.mutation(internal.agentProjects.adoptLegacyRows, {})).toEqual({ stamped: 0 });
    const stamped = await t.run(async (ctx) => ({
      usage: await ctx.db.query("agentUsage").collect(),
      config: await ctx.db.query("agentConfig").collect(),
    }));
    expect(stamped.usage.map((row) => row.project)).toEqual(["vertical-startup"]);
    expect(stamped.config.map((row) => row.project)).toEqual(["vertical-startup"]);
    expect((await owner.query(api.agentProjects.list, { today: TODAY }))[0]!.latestVersion).toBe(2);
  });

  test("with a token and no legacy steering, a change is fetched, not pushed", async () => {
    const t = convexTest(schema, modules);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const owner = await signInAsOwner(t);
    const { token } = await owner.mutation(api.agentProjects.connect, {
      name: "Vertical Startup",
      slug: "vertical-startup",
      region: "US",
      holdsPatientData: true,
      allowedProviders: ["vertex"],
      entropy: ENTROPY,
    });
    await report(t, token, body({ agentsKnown: [] }));
    await owner.mutation(api.agentControl.change, { agentId: "sample.extract", enabled: false });
    await finishScheduled(t);
    expect(fetch).not.toHaveBeenCalled();
    expect((await owner.query(api.agentControl.changes, {}))[0]).toMatchObject({ push: "pull", status: "pending" });
    expect((await (await config(t, token)).json()).agents[0]).toMatchObject({ agentId: "sample.extract", enabled: false });
  });
});

describe("Startup OS's own agents", () => {
  test("the owner reads each one's switch and its runs in seven days", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await t.run(async (ctx) => {
      const userId = (await ctx.db.query("users").first())!._id;
      const at = (hours: number) => NOW - hours * 3_600_000;
      for (const [agent, outcome, hours] of [
        ["engineering", "ok", 1],
        ["engineering", "error", 2],
        ["sales", "ok", 30],
        ["sales", "ok", 24 * 9],
      ] as const) {
        await ctx.db.insert("agentCalls", { userId, tool: "tasks", kind: "read", at: at(hours), outcome, durationMs: 5, agent });
      }
      await ctx.db.insert("agentSettings", { off: ["finance"], updatedAt: 1 });
    });
    const own = await owner.query(api.agentProjects.startupOs, { today: TODAY });
    expect(own.today).toEqual({ calls: 2, errors: 1 });
    const by = Object.fromEntries(own.agents.map((agent) => [agent.id, agent]));
    expect(by.engineering).toMatchObject({ on: true, calls7d: 2, outcomes: { ok: 1, refused: 0, invalid: 0, error: 1 }, lastRunAt: NOW - 3_600_000 });
    expect(by.sales).toMatchObject({ calls7d: 1 });
    expect(by.finance).toMatchObject({ on: false, calls7d: 0, lastRunAt: null });
  });
});

describe("who may", () => {
  test("the agents area connects and launches; sales cannot; Startup OS's own card is the owner's", async () => {
    const t = convexTest(schema, modules);
    const engineer = await signInAsEngineer(t);
    for (const client of [engineer, await signInAsCofounder(t)]) {
      expect(Array.isArray(await client.query(api.agentProjects.list, { today: TODAY }))).toBe(true);
      await expect(client.query(api.agentProjects.startupOs, { today: TODAY })).rejects.toThrow("not_owner");
    }
    expect((await connect(engineer)).token).toMatch(/^rap_/);
    const sales = await signInAsSales(t);
    await expect(sales.query(api.agentProjects.list, { today: TODAY })).rejects.toThrow("not_allowed");
    await expect(connect(sales, PLAIN)).rejects.toThrow("not_allowed");
    await expect(
      sales.mutation(api.agentProjects.rotateToken, { slug: "sample-clinic", entropy: ENTROPY }),
    ).rejects.toThrow("not_allowed");
  });
});
