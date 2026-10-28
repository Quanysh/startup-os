import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { SourceId } from "../lib/metricRegistry";
import type { SnapshotInput } from "../lib/snapshotRules";
import schema from "../schema";
import { modules, type TestBackend } from "../test.setup";
import { ConnectorError } from "./errors";
import { runConnector } from "./run";

// runConnector only talks to Convex through ctx.runMutation, so a fake ctx
// that records the calls is the whole backend it needs.

const NOW = Date.UTC(2026, 9, 12, 6);

type Call = { name: string; args: Record<string, unknown> };

function harness(options: { failWrite?: unknown } = {}) {
  const calls: Call[] = [];
  const runMutation = vi.fn(async (ref: Parameters<typeof getFunctionName>[0], args: Call["args"]) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (name === "snapshots:applySync" && options.failWrite !== undefined) {
      throw options.failWrite;
    }
    return null;
  });
  const ctx = { runMutation } as unknown as ActionCtx;
  return {
    ctx,
    calls,
    named: (name: string) => calls.filter((c) => c.name === name),
  };
}

const FAILURE = getFunctionName(internal.snapshots.recordFailure);
const APPLY = getFunctionName(internal.snapshots.applySync);

/** The four tables a Globex run writes besides numbers, without system fields. */
async function sideTables(t: TestBackend) {
  return t.run(async (ctx) => {
    const plain = <T extends { _id: unknown; _creationTime: unknown }>({ _id, _creationTime, ...row }: T) => row;
    return {
      clinics: (await ctx.db.query("kzAppClinics").collect()).map(plain),
      usage: (await ctx.db.query("customerUsage").collect()).map(plain),
      doctors: (await ctx.db.query("customerDoctors").collect()).map(plain),
      breakdowns: (await ctx.db.query("kzBreakdowns").collect()).map(plain),
    };
  });
}

const cash = (value: number, day = "2026-10-12"): SnapshotInput => ({
  key: "cash",
  scope: "us",
  period: "day",
  periodStart: day,
  value,
  currency: "USD",
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("MERCURY_API_TOKEN", "fake-token-123");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Run a fetch that throws `thrown`, and return what was logged. */
async function runThrowing(thrown: unknown) {
  const h = harness();
  const outcome = await runConnector(h.ctx, "mercury", async () => {
    throw thrown;
  });
  return { outcome, failures: h.named(FAILURE), applied: h.named(APPLY) };
}

describe("runConnector", () => {
  test("without its key it logs not_configured and never fetches", async () => {
    vi.stubEnv("MERCURY_API_TOKEN", "");
    const h = harness();
    const fetchRows = vi.fn(async () => [cash(1)]);
    expect(await runConnector(h.ctx, "mercury", fetchRows)).toBe("not_configured");
    expect(fetchRows).not.toHaveBeenCalled();
    expect(h.calls).toEqual([
      {
        name: FAILURE,
        args: {
          source: "mercury",
          startedAt: NOW,
          status: "not_configured",
          message: "Set MERCURY_API_TOKEN on the Convex deployment.",
        },
      },
    ]);
  });

  test("fed by push instead (a token, no key): the scheduled run does nothing and logs nothing", async () => {
    vi.stubEnv("MERCURY_API_TOKEN", "");
    vi.stubEnv("INGEST_TOKEN_MERCURY", "fake-ingest-token-0123456789-abcdefghij");
    const h = harness();
    const fetchRows = vi.fn(async () => [cash(1)]);
    expect(await runConnector(h.ctx, "mercury", fetchRows)).toBe("not_configured");
    expect(fetchRows).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  test("with its key it is pulled, whatever token is also set", async () => {
    vi.stubEnv("INGEST_TOKEN_MERCURY", "fake-ingest-token-0123456789-abcdefghij");
    const h = harness();
    expect(await runConnector(h.ctx, "mercury", async () => [cash(1)])).toBe("ok");
    expect(h.named(APPLY)).toHaveLength(1);
  });

  test("a source that is not in the manifest is an error", async () => {
    const h = harness();
    const fetchRows = vi.fn(async () => [cash(1)]);
    // An id no phase will wire up: every real one may be in the manifest by now.
    const nowhere = "nowhere" as SourceId;
    expect(await runConnector(h.ctx, nowhere, fetchRows)).toBe("error");
    expect(fetchRows).not.toHaveBeenCalled();
    expect(h.calls[0]?.args).toMatchObject({
      status: "error",
      message: '"nowhere" is not in the connector manifest.',
    });
  });

  describe("what a thrown value may put in the log", () => {
    test("a network error's message is replaced; only its class name is kept", async () => {
      const { outcome, failures, applied } = await runThrowing(
        new TypeError(
          'fetch failed: https://api.mercury.com/api/v1/account/acc-1/transactions with "Bearer fake-token-123"',
        ),
      );
      expect(outcome).toBe("error");
      expect(applied).toEqual([]);
      expect(failures).toEqual([
        {
          name: FAILURE,
          args: {
            source: "mercury",
            startedAt: NOW,
            status: "error",
            message: "The run failed unexpectedly (TypeError).",
          },
        },
      ]);
      const recorded = JSON.stringify(failures);
      expect(recorded).not.toContain("acc-1");
      expect(recorded).not.toContain("fake-token-123");
    });

    test("a ConnectorError's own words are logged as written", async () => {
      const { outcome, failures } = await runThrowing(
        new ConnectorError("Mercury answered 500 for accounts."),
      );
      expect(outcome).toBe("error");
      expect(failures[0]?.args).toMatchObject({
        status: "error",
        message: "Mercury answered 500 for accounts.",
      });
    });

    test("a look-alike named ConnectorError is not trusted", async () => {
      const lookAlike = Object.assign(new Error("secret detail"), { name: "ConnectorError" });
      const { failures } = await runThrowing(lookAlike);
      expect(failures[0]?.args).toMatchObject({
        message: "The run failed unexpectedly (ConnectorError).",
      });
    });

    const unknownCases: [string, () => unknown][] = [
      ["a string", () => "https://api.mercury.com?token=fake-token-123"],
      ["undefined", () => undefined],
      ["an error named like a URL", () =>
        Object.assign(new Error("x"), { name: "https://api.mercury.com/a?k=fake-token-123" })],
      ["an error with a 41-character name", () =>
        Object.assign(new Error("x"), { name: "A".repeat(41) })],
      ["an error whose name is not a string", () =>
        Object.assign(new Error("x"), { name: { toString: () => "TypeError" } })],
      ["an error whose name getter throws", () => {
        const error = new Error("x");
        Object.defineProperty(error, "name", {
          get(): string {
            throw new Error("getter detail: fake-token-123");
          },
        });
        return error;
      }],
      ["an object whose name getter throws", () => ({
        get name(): string {
          throw new Error("getter detail: fake-token-123");
        },
      })],
    ];
    test.each(unknownCases)("%s is logged as unknown, and the runner survives it", async (_, make) => {
      const { outcome, failures } = await runThrowing(make());
      expect(outcome).toBe("error");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.args).toMatchObject({
        status: "error",
        message: "The run failed unexpectedly (unknown).",
      });
    });

    test("the name is read once", async () => {
      let reads = 0;
      const counted = {
        get name() {
          reads += 1;
          return reads === 1 ? "TypeError" : "https://example.test/second-read";
        },
      };
      const { failures } = await runThrowing(counted);
      expect(reads).toBe(1);
      expect(failures[0]?.args).toMatchObject({
        message: "The run failed unexpectedly (TypeError).",
      });
    });
  });

  test("an empty result is logged as empty, not as a success", async () => {
    const h = harness();
    expect(await runConnector(h.ctx, "mercury", async () => [])).toBe("empty");
    expect(h.calls).toEqual([
      {
        name: FAILURE,
        args: {
          source: "mercury",
          startedAt: NOW,
          status: "empty",
          message: "The source returned nothing.",
        },
      },
    ]);
  });

  test("a row the registry refuses is logged in the registry's words and nothing is written", async () => {
    const h = harness();
    expect(await runConnector(h.ctx, "mercury", async () => [cash(-1)])).toBe("error");
    expect(h.named(APPLY)).toEqual([]);
    expect(h.calls).toEqual([
      {
        name: FAILURE,
        args: {
          source: "mercury",
          startedAt: NOW,
          status: "error",
          message: "Cash cannot be below 0.",
        },
      },
    ]);
  });

  test("a bucket in the future is refused, so validation is given the clock", async () => {
    const h = harness();
    expect(await runConnector(h.ctx, "mercury", async () => [cash(5, "2026-10-14")])).toBe("error");
    expect(h.named(APPLY)).toEqual([]);
    expect(h.calls[0]?.args).toMatchObject({
      status: "error",
      message: '"2026-10-14" is in the future.',
    });
  });

  test("valid rows are written once, with the run's start time", async () => {
    const h = harness();
    const rows = [cash(400_000.75)];
    expect(await runConnector(h.ctx, "mercury", async () => rows)).toBe("ok");
    expect(h.calls).toEqual([
      { name: APPLY, args: { source: "mercury", startedAt: NOW, rows } },
    ]);
  });

  test("a failed number write leaves clinic links, usage, doctors and breakdowns unchanged", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.customers.applyRegister, {
      source: "client_register",
      startedAt: 1,
      rows: [{ name: "SECRET Alpha", market: "kz", status: "active" }],
    });
    await t.mutation(internal.kzAppSync.linkClinics, {
      syncedAt: 1,
      clinics: [{ org: "org_alpha", name: "SECRET Alpha", weeks: 3, actions: 12, doctors: 2, lastActiveOn: "2026-10-17" }],
    });
    await t.mutation(internal.kzAppSync.applyClinics, {
      syncedAt: 2,
      clinics: [
        {
          org: "org_alpha",
          weeks: [
            {
              weekStart: "2026-10-12",
              checks: 5,
              actions: 5,
              doctors: 1,
              activeDays: 2,
              failures: 0,
              modules: { intake: 5 },
            },
          ],
        },
      ],
      doctors: [
        {
          org: "org_alpha",
          doctorId: "d1",
          name: "SECRET Doctor One",
          weekStart: "2026-10-12",
          week: "usual",
          actions: 4,
          activeDays: 2,
          modules: { intake: 4 },
          history: [{ weekStart: "2026-10-12", actions: 4, days: 2, modules: { intake: 4 } }],
        },
      ],
    });
    await t.mutation(internal.kzAppSync.applyBreakdowns, {
      syncedAt: 1,
      kind: "event",
      weeks: ["2026-10-12"],
      rows: [{ weekStart: "2026-10-12", key: "old_event", values: { count: 1, users: 1 } }],
    });
    const before = await sideTables(t);
    // Two rows for the bucket this run writes: applySync's .unique() throws
    // and the mutation rolls back.
    await t.run(async (ctx) => {
      const row = {
        key: "cash",
        scope: "us",
        period: "day" as const,
        periodStart: "2026-10-12",
        value: 1,
        currency: "USD",
        source: "mercury",
        syncedAt: 1,
      };
      await ctx.db.insert("metricSnapshots", row);
      await ctx.db.insert("metricSnapshots", row);
    });

    let applyAttempts = 0;
    const ctx = {
      runMutation: async (ref: Parameters<ActionCtx["runMutation"]>[0], args: Parameters<ActionCtx["runMutation"]>[1]) => {
        if (getFunctionName(ref) === APPLY) applyAttempts += 1;
        return await t.mutation(ref as never, args as never);
      },
    } as unknown as ActionCtx;

    const outcome = await runConnector(ctx, "mercury", async () => [cash(2)], async () => {
      await ctx.runMutation(internal.kzAppSync.linkClinics, {
        syncedAt: 99,
        clinics: [{ org: "org_changed", name: "SECRET Changed", weeks: 1, actions: 9, doctors: 9 }],
      });
      await ctx.runMutation(internal.kzAppSync.applyBreakdowns, {
        syncedAt: 99,
        kind: "event",
        weeks: ["2026-10-12"],
        rows: [{ weekStart: "2026-10-12", key: "changed_event", values: { count: 9, users: 1 } }],
      });
    });

    expect(outcome).toBe("error");
    expect(applyAttempts).toBe(1);
    expect(await sideTables(t)).toEqual(before);
    expect(await t.run(async (ctx) => (await ctx.db.query("metricSnapshots").collect()).map((s) => s.value))).toEqual([
      1, 1,
    ]);
  });

  test("a failed write is logged as a fixed sentence, not the thrown message", async () => {
    const h = harness({ failWrite: new Error("write failed: secret detail") });
    expect(await runConnector(h.ctx, "mercury", async () => [cash(1)])).toBe("error");
    expect(h.named(APPLY)).toHaveLength(1);
    const failures = h.named(FAILURE);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.args).toMatchObject({
      status: "error",
      message: "The run failed unexpectedly (Error).",
    });
    expect(JSON.stringify(failures)).not.toContain("secret detail");
  });

  test("the fetch is handed the same clock the run is recorded with", async () => {
    const h = harness();
    const fetchRows = vi.fn(async (now: number) => {
      // The clock moving on during the fetch must not change what was recorded.
      vi.setSystemTime(NOW + 60_000);
      return now === NOW ? [cash(1)] : [cash(1, "2026-10-14")];
    });
    expect(await runConnector(h.ctx, "mercury", fetchRows)).toBe("ok");
    expect(fetchRows).toHaveBeenCalledWith(NOW);
    expect(h.calls[0]?.args).toMatchObject({ startedAt: NOW });
  });
});
