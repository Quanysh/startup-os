import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internalMutation } from "./_generated/server";
import { MAX_INGEST_BYTES } from "./lib/ingestSchema";
import { PLAN_KEYS, PLAN_SCENARIOS } from "./lib/planShape";
import schema from "./schema";
import { modules, type TestBackend } from "./test.setup";

// Long enough to count as a real secret (see MIN_INGEST_TOKEN_LENGTH).
const TOKEN = "test-ingest-token-0123456789-abcdefghij";

afterEach(() => {
  vi.unstubAllEnvs();
});

const row = {
  key: "clinics_using",
  scope: "kz_product",
  period: "month",
  periodStart: "2026-10-01",
  value: 12,
};

const envelope = {
  version: 1,
  source: "cfo_workbook",
  batchId: "retention-2026-10-11",
  observedAt: "2026-10-11T09:30:00Z",
  snapshots: [row],
};

function post(
  t: TestBackend,
  body: unknown,
  token: string | null = TOKEN,
) {
  return t.fetch("/ingest/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const stored = (t: TestBackend) =>
  t.run((ctx) => ctx.db.query("metricSnapshots").collect());

describe("POST /ingest/v1", () => {
  test("503 when no ingest token is configured, even with a bearer token", async () => {
    const t = convexTest(schema, modules);
    const response = await post(t, envelope);
    expect(response.status).toBe(503);
    expect(await stored(t)).toEqual([]);
  });

  test("401 without an Authorization header", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    expect((await post(t, envelope, null)).status).toBe(401);
  });

  test("401 with the wrong token", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    expect((await post(t, envelope, "not-the-token")).status).toBe(401);
    expect(await stored(t)).toEqual([]);
  });

  test("401 with an empty bearer token", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    expect((await post(t, envelope, "")).status).toBe(401);
  });

  test("413 when the body is over the size cap", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    const oversized = JSON.stringify({ ...envelope, batchId: "x".repeat(MAX_INGEST_BYTES) });
    expect((await post(t, oversized)).status).toBe(413);
  });

  test("400 when the body is not JSON", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    expect((await post(t, "{not json")).status).toBe(400);
  });

  test("422 with the offending path when the envelope is malformed", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, {
      ...envelope,
      snapshots: [{ ...row, value: "12" }],
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain("snapshots.0.value");
    expect(await stored(t)).toEqual([]);
  });

  test("422 when an extra field is smuggled onto a row", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, {
      ...envelope,
      snapshots: [{ ...row, clientName: "Clinic A" }],
    });
    expect(response.status).toBe(422);
    expect(await stored(t)).toEqual([]);
  });

  test("403 when the envelope names a source the token does not belong to", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, { ...envelope, source: "mercury" });
    expect(response.status).toBe(403);
    expect(await stored(t)).toEqual([]);
  });

  test("422 when the source does not own the metric", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, {
      ...envelope,
      // US MRR is a manual metric; the workbook token must not overwrite it.
      snapshots: [{ key: "mrr", scope: "us", period: "month", periodStart: "2026-10-01", value: 1, currency: "USD" }],
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { issues: { path: string }[] };
    expect(body.issues[0]?.path).toBe("snapshots.0.source");
    expect(await stored(t)).toEqual([]);
  });

  test("a rejected push is logged against the source so it shows in the OS", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, { ...envelope, snapshots: [{ ...row, periodStart: "2026-10-15" }] });
    const status = await t.run((ctx) =>
      ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", "cfo_workbook"))
        .unique(),
    );
    expect(status?.state).toBe("error");
    expect(status?.message).toContain("2026-10-15");
  });

  const status = (t: TestBackend) =>
    t.run((ctx) =>
      ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", "cfo_workbook"))
        .unique(),
    );

  test("an oversized authenticated push is logged against the source", async () => {
    // A truncated or runaway push must not leave the source showing "Working".
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, JSON.stringify({ ...envelope, batchId: "x".repeat(MAX_INGEST_BYTES) }));
    expect(await status(t)).toMatchObject({ state: "error" });
    expect((await status(t))?.message).toContain("payload_too_large");
  });

  test("an authenticated push that is not JSON is logged against the source", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, "{not json");
    expect((await status(t))?.message).toContain("invalid_json");
  });

  test("a failure message is cut down before it is stored", async () => {
    // Validation errors echo the offending key name, which the sender chooses.
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, { ...envelope, snapshots: [{ ...row, ["k".repeat(5_000)]: 1 }] });
    const stored = await status(t);
    expect(stored?.state).toBe("error");
    expect(stored?.message?.length).toBeLessThanOrEqual(300);
  });

  test("a rejected batch keeps its name in the run log", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, { ...envelope, snapshots: [{ ...row, periodStart: "2026-10-15" }] });
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs[0]).toMatchObject({ status: "error", batchId: envelope.batchId });
  });

  test("the run log records when the source observed the data", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, envelope);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs[0]).toMatchObject({ status: "ok", observedAt: envelope.observedAt });
  });

  test("a token too short to be a secret is treated as not configured", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", "short");
    const t = convexTest(schema, modules);
    expect((await post(t, envelope, "short")).status).toBe(503);
    expect(await stored(t)).toEqual([]);
  });

  test("an unauthenticated request leaves no trace in the run log", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, envelope, "not-the-token");
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs).toEqual([]);
  });

  test("200 stores the rows and reports the counts", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    const response = await post(t, envelope);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inserted: 1, updated: 0, unchanged: 0 });
    const rows = await stored(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...row, source: "cfo_workbook" });
  });

  test("replaying the same request changes nothing", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    const t = convexTest(schema, modules);
    await post(t, envelope);
    const replay = await post(t, envelope);
    expect(await replay.json()).toEqual({ ok: true, inserted: 0, updated: 0, unchanged: 1 });
    expect(await stored(t)).toHaveLength(1);
  });
});

const REGISTER_TOKEN = "test-register-token-0123456789-abcdefgh";

// Made-up clinics. Every name contains "SECRET".
const clinic = (letter: string, patch: Record<string, unknown> = {}) => ({
  name: `SECRET CLINIC ${letter}`,
  market: "kz",
  status: "active",
  ...patch,
});

const register = (customers: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  source: "client_register",
  batchId: "register-2026-10-12",
  observedAt: "2026-10-12T09:30:00Z",
  customers,
  ...extra,
});

const clinics = (t: TestBackend) => t.run((ctx) => ctx.db.query("customers").collect());

describe("POST /ingest/v1: the client register", () => {
  const both = () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    vi.stubEnv("INGEST_TOKEN_CLIENT_REGISTER", REGISTER_TOKEN);
    return convexTest(schema, modules);
  };

  test("200 stores the clinics and reports the counts", async () => {
    const t = both();
    const response = await post(t, register([clinic("ALPHA"), clinic("BETA")]), REGISTER_TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      inserted: 2,
      updated: 0,
      unchanged: 0,
      archived: 0,
    });
    expect(await clinics(t)).toHaveLength(2);
  });

  test("the workbook's token cannot write as the register", async () => {
    const t = both();
    const response = await post(t, register([clinic("ALPHA")]), TOKEN);
    expect(response.status).toBe(403);
    expect(await clinics(t)).toEqual([]);
  });

  test("the workbook cannot send clinics under its own name either", async () => {
    const t = both();
    const response = await post(t, register([clinic("ALPHA")], { source: "cfo_workbook" }), TOKEN);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "customers_not_accepted" });
    expect(await clinics(t)).toEqual([]);
  });

  test("the register's token cannot write a metric", async () => {
    const t = both();
    const response = await post(t, { ...envelope, source: "client_register" }, REGISTER_TOKEN);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "invalid_snapshots" });
    expect(await stored(t)).toEqual([]);
  });

  test("one token set for both sources authenticates neither", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    vi.stubEnv("INGEST_TOKEN_CLIENT_REGISTER", TOKEN);
    const t = convexTest(schema, modules);
    expect((await post(t, register([clinic("ALPHA")]), TOKEN)).status).toBe(401);
    expect((await post(t, envelope, TOKEN)).status).toBe(401);
  });

  test("the same clinic twice is refused, by row", async () => {
    const t = both();
    const response = await post(
      t,
      register([clinic("ALPHA"), clinic("ALPHA", { name: "secret clinic alpha" })]),
      REGISTER_TOKEN,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_customers",
      issues: [{ path: "customers.1.name", message: "is the same clinic as row 0" }],
    });
    expect(await clinics(t)).toEqual([]);
  });

  test("a push that would empty most of the list is refused, with counts", async () => {
    const t = both();
    await post(t, register(["ALPHA", "BETA", "GAMMA", "DELTA"].map((l) => clinic(l))), REGISTER_TOKEN);
    const response = await post(t, register([clinic("ALPHA")]), REGISTER_TOKEN);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "register_shrank",
      issues: [
        {
          path: "customers",
          message:
            "This push would archive 3 of 4 clinics. Send it with allowShrink if that is right.",
        },
      ],
    });
    expect((await clinics(t)).filter((c) => c.archivedAt !== undefined)).toEqual([]);

    const allowed = await post(t, register([clinic("ALPHA")], { allowShrink: true }), REGISTER_TOKEN);
    expect(await allowed.json()).toMatchObject({ ok: true, archived: 3 });
  });

  test("no clinic name reaches the run log, a source's status, a snapshot or a reply", async () => {
    const t = both();
    const replies: string[] = [];
    const send = async (body: unknown) => {
      const response = await post(t, body, REGISTER_TOKEN);
      replies.push(await response.text());
      return response.status;
    };
    // Every way a register push can fail after authentication, then one that works.
    expect(await send(register([clinic("ALPHA"), clinic("ALPHA")]))).toBe(422);
    expect(await send(register([clinic("ALPHA", { lastPaymentDate: "2099-01-01" })]))).toBe(422);
    expect(await send(register([clinic("ALPHA", { "SECRET CLINIC OMEGA": 1 })]))).toBe(422);
    expect(await send(register([clinic("ALPHA", { market: "SECRET MARKET" })]))).toBe(422);
    expect(await send(register([clinic("ALPHA", { name: "S".repeat(250) + "SECRET" })]))).toBe(422);
    // A stray field beside the list, named after a clinic.
    expect(await send(register([clinic("ALPHA")], { "SECRET CLINIC SIGMA": 1 }))).toBe(422);
    // A batch name that is a clinic's name is the sender's mistake to make, so
    // it is not tested here: batchId is the one field echoed in the log.
    expect(await send(register(["ALPHA", "BETA", "GAMMA", "DELTA"].map((l) => clinic(l))))).toBe(200);
    expect(await send(register([clinic("ALPHA")]))).toBe(422);

    const kept = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
      snapshots: await ctx.db.query("metricSnapshots").collect(),
    }));
    expect(kept.runs).toHaveLength(8);
    expect(JSON.stringify(kept)).not.toContain("SECRET");
    expect(replies.join("\n")).not.toContain("SECRET");
  });

  test("a write that throws leaves fixed words in the log, never the error's own", async () => {
    vi.stubEnv("INGEST_TOKEN_CLIENT_REGISTER", REGISTER_TOKEN);
    // The register's write, replaced by one that fails naming a clinic: what
    // a database or validator error could do with a row in hand.
    const real = (await modules["./customers.ts"]!()) as Record<string, unknown>;
    const t = convexTest(schema, {
      ...modules,
      "./customers.ts": async () => ({
        ...real,
        applyRegister: internalMutation({
          handler: async () => {
            throw new Error("Could not store SECRET CLINIC ALPHA: SECRET detail");
          },
        }),
      }),
    });
    const response = await post(t, register([clinic("ALPHA")]), REGISTER_TOKEN);
    expect(response.status).toBe(500);
    const reply = await response.text();
    expect(JSON.parse(reply)).toEqual({ ok: false, error: "write_failed", issues: [] });
    const kept = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));
    expect(kept.runs).toMatchObject([{ source: "client_register", status: "error", message: "write_failed" }]);
    expect(kept.status).toMatchObject([{ source: "client_register", state: "error", message: "write_failed" }]);
    expect(JSON.stringify(kept)).not.toContain("SECRET");
    expect(reply).not.toContain("SECRET");
    expect(await clinics(t)).toEqual([]);
  });

  test("the register's token gets fixed words whatever the body holds, customers or not", async () => {
    const t = both();
    // No `customers` key at all: a body cut short, or built wrongly, with a
    // clinic's name where a field name should be.
    const { customers: _none, ...head } = register([]);
    const bodies = [
      { ...head, "SECRET CLINIC ALPHA": 1 },
      { ...head, "SECRET CLINIC ALPHA": [clinic("BETA")], version: "SECRET" },
      { ...head, snapshots: [{ ...row, "SECRET CLINIC GAMMA": 1 }] },
      { ...head, snapshots: [{ ...row, key: "SECRET CLINIC DELTA" }] },
    ];
    const replies: string[] = [];
    for (const body of bodies) {
      const response = await post(t, body, REGISTER_TOKEN);
      expect(response.status).toBe(422);
      replies.push(await response.text());
    }
    expect(JSON.parse(replies[0]!)).toEqual({
      ok: false,
      error: "invalid_envelope",
      issues: [
        { path: "envelope", message: "has a field the OS does not accept" },
        { path: "envelope", message: "Send snapshots, deals, investors, customers, records, contacts, a plan or agent usage." },
      ],
    });
    const kept = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));
    expect(kept.runs).toHaveLength(bodies.length);
    expect(JSON.stringify(kept)).not.toContain("SECRET");
    expect(replies.join("\n")).not.toContain("SECRET");
  });

  test("a refused register is logged against its source", async () => {
    const t = both();
    await post(t, register([clinic("ALPHA"), clinic("ALPHA")]), REGISTER_TOKEN);
    const status = await t.run((ctx) =>
      ctx.db
        .query("sourceStatus")
        .withIndex("by_source", (q) => q.eq("source", "client_register"))
        .unique(),
    );
    expect(status).toMatchObject({
      state: "error",
      message: "invalid_customers: customers.1.name — is the same clinic as row 0",
    });
  });
});

// What each token may send, once the register, the pipelines and the numbers
// share one endpoint. A request with `customers` is a register push or it is
// refused; a pipeline row's name is never quoted back or logged.
describe("POST /ingest/v1: one endpoint, four sources", () => {
  const VISIBLE_TOKEN = "test-visible-token-0123456789-abcdefghij";
  const CRM_TOKEN = "test-kz-crm-token-0123456789-abcdefghijk";
  const ALONE = "A customers push carries nothing else: no snapshots, deals or investors.";

  const all = () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    vi.stubEnv("INGEST_TOKEN_CLIENT_REGISTER", REGISTER_TOKEN);
    vi.stubEnv("INGEST_TOKEN_VISIBLE", VISIBLE_TOKEN);
    vi.stubEnv("INGEST_TOKEN_KZ_CRM", CRM_TOKEN);
    return convexTest(schema, modules);
  };
  const head = (source: string) => ({
    version: 1,
    source,
    batchId: `${source}-2026-10-12`,
    observedAt: "2026-10-12T09:30:00Z",
  });
  // Made-up rows. Every name contains "SECRET".
  const deal = (id: string, patch: Record<string, unknown> = {}) => ({
    externalId: id,
    name: `SECRET COMPANY ${id}`,
    contact: "SECRET PERSON",
    stage: "Lead",
    ...patch,
  });
  const kept = (t: TestBackend) =>
    t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));
  const pipelines = (t: TestBackend) =>
    t.run(async (ctx) => [
      ...(await ctx.db.query("deals").collect()),
      ...(await ctx.db.query("investors").collect()),
    ]);

  test("a register push that also carries deals is refused, in fixed words", async () => {
    const t = all();
    for (const field of ["deals", "investors", "snapshots"]) {
      const extra = field === "snapshots" ? [row] : [deal("1")];
      const response = await post(t, register([clinic("ALPHA")], { [field]: extra }), REGISTER_TOKEN);
      expect(response.status, field).toBe(422);
      expect(await response.json(), field).toEqual({
        ok: false,
        error: "invalid_envelope",
        issues: [{ path: field, message: ALONE }],
      });
    }
    expect(await clinics(t)).toEqual([]);
    expect(await pipelines(t)).toEqual([]);
    expect(JSON.stringify(await kept(t))).not.toContain("SECRET");
  });

  test("the Visible and CRM tokens cannot send clinics", async () => {
    const t = all();
    const attempts: [string, string][] = [
      ["visible", VISIBLE_TOKEN],
      ["kz_crm", CRM_TOKEN],
    ];
    for (const [source, token] of attempts) {
      const response = await post(t, register([clinic("ALPHA")], { source }), token);
      expect(response.status, source).toBe(422);
      expect(await response.json(), source).toEqual({
        ok: false,
        error: "customers_not_accepted",
        issues: [{ path: "customers", message: `"${source}" does not carry the client register.` }],
      });
      // Nor under the register's own name: the token fixes the source.
      expect((await post(t, register([clinic("ALPHA")]), token)).status, source).toBe(403);
    }
    expect(await clinics(t)).toEqual([]);
    expect(JSON.stringify(await kept(t))).not.toContain("SECRET");
  });

  test("the register's token cannot send deals, investors or snapshots", async () => {
    const t = all();
    const refused = async (body: Record<string, unknown>) => {
      const response = await post(t, { ...head("client_register"), ...body }, REGISTER_TOKEN);
      expect(response.status).toBe(422);
      return (await response.json()) as { error: string; issues: unknown[] };
    };
    expect(await refused({ deals: [deal("1")] })).toMatchObject({
      error: "invalid_rows",
      issues: [{ path: "deals", message: "This source does not own deals." }],
    });
    expect(await refused({ investors: [deal("1")] })).toMatchObject({
      error: "invalid_rows",
      issues: [{ path: "investors", message: "This source does not own investors." }],
    });
    expect(await refused({ snapshots: [row] })).toMatchObject({ error: "invalid_snapshots" });
    // Nor as the source that does own them.
    expect((await post(t, { ...head("kz_crm"), deals: [deal("1")] }, REGISTER_TOKEN)).status).toBe(
      403,
    );
    expect(await pipelines(t)).toEqual([]);
    expect(await stored(t)).toEqual([]);
    expect(JSON.stringify(await kept(t))).not.toContain("SECRET");
  });

  test("a name inside a refused deals row reaches neither the reply nor the run log", async () => {
    const t = all();
    const replies: string[] = [];
    const send = async (body: Record<string, unknown>) => {
      const response = await post(t, { ...head("kz_crm"), ...body }, CRM_TOKEN);
      replies.push(await response.text());
      return response.status;
    };
    // Refused by the envelope: a field named after a company, a value of the
    // wrong kind, a name too long, and a stray field beside the rows.
    expect(await send({ deals: [deal("1", { "SECRET COMPANY X": 1 })] })).toBe(422);
    expect(await send({ deals: [deal("1", { amount: "SECRET AMOUNT" })] })).toBe(422);
    expect(await send({ deals: [deal("1", { name: "SECRET ".repeat(40) })] })).toBe(422);
    expect(await send({ deals: [deal("1")], "SECRET COMPANY Y": 1 })).toBe(422);
    expect(await send({ deals: [deal("1")], mode: "SECRET MODE" })).toBe(422);
    // Refused by the row rules.
    expect(await send({ deals: [deal("1"), deal("1")] })).toBe(422);
    expect(await send({ deals: [deal("1", { stage: "SECRET STAGE", closedAt: "SECRET0000" })] })).toBe(422);
    // Refused for the snapshot riding with them, whose key the sender chose.
    expect(
      await send({ deals: [deal("1")], snapshots: [{ ...row, key: "SECRET COMPANY Z" }] }),
    ).toBe(422);
    expect(replies.at(-1)).toBe(
      JSON.stringify({
        ok: false,
        error: "invalid_snapshots",
        issues: [
          {
            path: "snapshots.0.key",
            message: "Is refused. Send the snapshots on their own to read why.",
          },
        ],
      }),
    );
    // And one that works: the name is stored in the deals table and nowhere else.
    expect(await send({ deals: [deal("1")] })).toBe(200);

    const log = await kept(t);
    expect(log.runs).toHaveLength(9);
    expect(JSON.stringify(log)).not.toContain("SECRET");
    expect(replies.join("\n")).not.toContain("SECRET");
    expect((await pipelines(t)).map((d) => d.name)).toEqual(["SECRET COMPANY 1"]);
  });

  test("a refused row is still named by its path", async () => {
    const t = all();
    const response = await post(
      t,
      { ...head("visible"), investors: [deal("a"), deal("b", { email: "x@example.com" })] },
      VISIBLE_TOKEN,
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_envelope",
      issues: [{ path: "investors.1", message: "has a field the OS does not accept" }],
    });
  });

  test("a push of snapshots alone still quotes the registry's own words", async () => {
    const t = all();
    const response = await post(t, { ...envelope, snapshots: [{ ...row, key: "nope" }] });
    expect(await response.json()).toMatchObject({
      error: "invalid_snapshots",
      issues: [{ path: "snapshots.0.key", message: 'Unknown metric "nope".' }],
    });
  });
});

const MODEL_TOKEN = "test-model-token-0123456789-abcdefghijkl";
const PLAN_BATCH = "financial_model-2026-10-13";

/** Every scenario, 2026 and 2027, every figure: 42 rows. */
const wholePlan = (value = 1) =>
  PLAN_SCENARIOS.flatMap((scenario) =>
    [2026, 2027].flatMap((year) => PLAN_KEYS.map((key) => ({ scenario, year, key, value }))),
  );

const planPush = (rows: unknown[] = wholePlan(), source = "financial_model") => ({
  version: 1,
  source,
  batchId: PLAN_BATCH,
  observedAt: "2026-10-13T09:30:00Z",
  plan: { modelVersion: "920ac834b5b2", rows },
});

// The plan arrives on the financial model's own token, whole or not at all.
// That token writes nothing else, and no other token writes the plan.
describe("POST /ingest/v1: the plan", () => {
  const INCOMPLETE = "The plan is incomplete: every scenario needs every figure for every year.";

  const both = () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", TOKEN);
    vi.stubEnv("INGEST_TOKEN_FINANCIAL_MODEL", MODEL_TOKEN);
    return convexTest(schema, modules);
  };
  const figures = (t: TestBackend) => t.run((ctx) => ctx.db.query("planFigures").collect());
  const kept = (t: TestBackend) =>
    t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      status: await ctx.db.query("sourceStatus").collect(),
    }));

  test("200 stores the whole plan, reports the counts and logs the run", async () => {
    const t = both();
    const response = await post(t, planPush(), MODEL_TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, inserted: 42, updated: 0, unchanged: 0 });
    expect(await figures(t)).toHaveLength(42);
    const log = await kept(t);
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]).toMatchObject({
      source: "financial_model",
      batchId: PLAN_BATCH,
      status: "ok",
    });
    // The plan is not a metric.
    expect(await stored(t)).toEqual([]);
  });

  test("pushing the same plan again changes nothing", async () => {
    const t = both();
    await post(t, planPush(), MODEL_TOKEN);
    const replay = await post(t, planPush(), MODEL_TOKEN);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, inserted: 0, updated: 0, unchanged: 42 });
    expect(await figures(t)).toHaveLength(42);
  });

  test("a plan with one figure missing is refused whole, and logged against the model", async () => {
    const t = both();
    const rows = wholePlan().filter(
      (r) => !(r.scenario === "bull" && r.year === 2027 && r.key === "headcount"),
    );
    expect(rows).toHaveLength(41);
    const response = await post(t, planPush(rows), MODEL_TOKEN);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_plan",
      issues: [{ path: "plan.rows", message: INCOMPLETE }],
    });
    expect(await figures(t)).toEqual([]);
    const log = await kept(t);
    expect(log.runs).toMatchObject([
      {
        source: "financial_model",
        batchId: PLAN_BATCH,
        status: "error",
        message: `invalid_plan: plan.rows — ${INCOMPLETE}`,
      },
    ]);
    expect(log.status).toMatchObject([
      {
        source: "financial_model",
        state: "error",
        message: `invalid_plan: plan.rows — ${INCOMPLETE}`,
      },
    ]);
  });

  test("a value a figure cannot have is refused by row", async () => {
    const t = both();
    const rows = wholePlan();
    const i = rows.findIndex((r) => r.scenario === "base" && r.year === 2027 && r.key === "arr");
    expect(i).toBeGreaterThanOrEqual(0);
    rows[i] = { ...rows[i]!, value: -1 };
    const response = await post(t, planPush(rows), MODEL_TOKEN);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_plan",
      issues: [{ path: `plan.rows.${i}.value`, message: "is outside what this figure can be" }],
    });
    expect(await figures(t)).toEqual([]);
  });

  test("the workbook's token cannot send the plan under its own name", async () => {
    const t = both();
    const response = await post(t, planPush(wholePlan(), "cfo_workbook"), TOKEN);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      ok: false,
      error: "plan_not_accepted",
      issues: [{ path: "plan", message: '"cfo_workbook" does not carry the plan.' }],
    });
    expect(await figures(t)).toEqual([]);
  });

  test("the model's token cannot write as another source", async () => {
    const t = both();
    const response = await post(t, planPush(wholePlan(), "cfo_workbook"), MODEL_TOKEN);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "source_mismatch",
      issues: [{ path: "source", message: 'This token writes as "financial_model".' }],
    });
    expect(await figures(t)).toEqual([]);
  });

  test("the model's token writes no number and no pipeline", async () => {
    const t = both();
    const { plan: _none, ...head } = planPush();
    for (const payload of [
      { snapshots: [row] },
      { deals: [{ externalId: "1", name: "SECRET COMPANY", stage: "Lead" }] },
    ]) {
      const response = await post(t, { ...head, ...payload }, MODEL_TOKEN);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        ok: false,
        error: "plan_only",
        issues: [{ path: "envelope", message: "This token carries the plan and nothing else." }],
      });
    }
    expect(await stored(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("deals").collect())).toEqual([]);
    expect(JSON.stringify(await kept(t))).not.toContain("SECRET");
  });

  test("clinics, records and the plan are each refused by name on a token that does not carry them", async () => {
    const GMAIL_TOKEN = "test-gmail-token-0123456789-abcdefghijkl";
    vi.stubEnv("INGEST_TOKEN_GMAIL", GMAIL_TOKEN);
    const t = both();
    const { plan: _none, ...head } = planPush();

    const clinicsPush = await post(t, { ...head, customers: [clinic("ALPHA")] }, MODEL_TOKEN);
    expect(clinicsPush.status).toBe(422);
    expect(await clinicsPush.json()).toEqual({
      ok: false,
      error: "customers_not_accepted",
      issues: [
        { path: "customers", message: '"financial_model" does not carry the client register.' },
      ],
    });

    const recordsPush = await post(t, { ...head, records: [{ threadId: "18c2f0a1" }] }, MODEL_TOKEN);
    expect(recordsPush.status).toBe(422);
    expect(await recordsPush.json()).toEqual({
      ok: false,
      error: "records_not_accepted",
      issues: [{ path: "records", message: '"financial_model" does not carry records.' }],
    });

    // And a work tool's token is told the same of a plan, not that it carries records.
    const fromGmail = await post(t, planPush(wholePlan(), "gmail"), GMAIL_TOKEN);
    expect(fromGmail.status).toBe(422);
    expect(await fromGmail.json()).toEqual({
      ok: false,
      error: "plan_not_accepted",
      issues: [{ path: "plan", message: '"gmail" does not carry the plan.' }],
    });

    expect(await clinics(t)).toEqual([]);
    expect(await figures(t)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("mirrorRecords").collect())).toEqual([]);
    expect(JSON.stringify(await kept(t))).not.toContain("SECRET");
  });

  test("a write that throws is a 500 in fixed words, logged against the model", async () => {
    vi.stubEnv("INGEST_TOKEN_FINANCIAL_MODEL", MODEL_TOKEN);
    // The plan's write, replaced by one that fails in words of its own.
    const real = (await modules["./plan.ts"]!()) as Record<string, unknown>;
    const t = convexTest(schema, {
      ...modules,
      "./plan.ts": async () => ({
        ...real,
        apply: internalMutation({
          handler: async () => {
            throw new Error("Could not store the plan: SECRET detail");
          },
        }),
      }),
    });
    const response = await post(t, planPush(), MODEL_TOKEN);
    expect(response.status).toBe(500);
    const reply = await response.text();
    expect(JSON.parse(reply)).toEqual({ ok: false, error: "write_failed", issues: [] });
    const log = await kept(t);
    expect(log.runs).toMatchObject([
      { source: "financial_model", batchId: PLAN_BATCH, status: "error", message: "write_failed" },
    ]);
    expect(log.status).toMatchObject([
      { source: "financial_model", state: "error", message: "write_failed" },
    ]);
    expect(JSON.stringify(log)).not.toContain("SECRET");
    expect(reply).not.toContain("SECRET");
    expect(await figures(t)).toEqual([]);
  });
});
