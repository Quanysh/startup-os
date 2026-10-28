import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { MirrorRecord, RecordOf } from "../lib/mirrorRules";
import { ConnectorError } from "./errors";
import { NotConnected, runMirror } from "./mirror";

// runMirror talks to Convex only through ctx.runMutation and ctx.runQuery, so
// a fake ctx that records the calls is the whole backend it needs.

const NOW = Date.UTC(2026, 9, 12, 6);

type Call = { name: string; args: Record<string, unknown> };
type Ref = Parameters<typeof getFunctionName>[0];

const FAILURE = getFunctionName(internal.snapshots.recordFailure);
const APPLY = getFunctionName(internal.mirror.apply);
const NOTE = getFunctionName(internal.mirror.noteNotConfigured);
const IS_OFF = getFunctionName(internal.workTools.isOff);
const GRANT_AT = getFunctionName(internal.google.grantAt);

function harness(
  options: { off?: boolean; failWrite?: unknown; dropped?: boolean; grantAt?: number | null } = {},
) {
  const calls: Call[] = [];
  const runMutation = vi.fn(async (ref: Ref, args: Call["args"]) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (name === APPLY) {
      if (options.failWrite !== undefined) throw options.failWrite;
      return options.dropped ? null : { inserted: 1, updated: 0, unchanged: 0 };
    }
    return null;
  });
  const queries: string[] = [];
  const runQuery = vi.fn(async (ref: Ref) => {
    queries.push(getFunctionName(ref));
    if (getFunctionName(ref) === IS_OFF) return options.off === true;
    if (getFunctionName(ref) === GRANT_AT && options.grantAt !== undefined) return options.grantAt;
    throw new Error("unexpected query");
  });
  const ctx = { runMutation, runQuery } as unknown as ActionCtx;
  return { ctx, calls, queries, named: (name: string) => calls.filter((c) => c.name === name) };
}

const issue = (issueId: string, over: Partial<RecordOf<"issue">> = {}): RecordOf<"issue"> => ({
  kind: "issue",
  issueId,
  identifier: "ENG-1",
  title: "Made-up title",
  url: "https://linear.app/startup/issue/ENG-1/made-up-title",
  stateType: "started",
  stateName: "In Progress",
  teamKey: "ENG",
  teamName: "Engineering",
  assigneeName: "Ada Example",
  mine: true,
  priority: 2,
  updatedAt: NOW - 60_000,
  ...over,
});

const run = (
  h: ReturnType<typeof harness>,
  read: (now: number) => Promise<MirrorRecord[]>,
  allowEmpty = false,
) => runMirror(h.ctx, "linear", { allowEmpty }, read);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("LINEAR_API_KEY", "fake-linear-key");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("runMirror", () => {
  test("without its key it notes not_configured and never reads", async () => {
    vi.stubEnv("LINEAR_API_KEY", "");
    const h = harness();
    const read = vi.fn(async () => [issue("i1")]);
    expect(await run(h, read)).toBe("not_configured");
    expect(read).not.toHaveBeenCalled();
    expect(h.calls).toEqual([
      {
        name: NOTE,
        args: { source: "linear", message: "Set LINEAR_API_KEY on the Convex deployment." },
      },
    ]);
  });

  test("fed by push instead (a token, no key): the scheduled run does nothing and notes nothing", async () => {
    vi.stubEnv("LINEAR_API_KEY", "");
    vi.stubEnv("INGEST_TOKEN_LINEAR", "fake-ingest-token-0123456789-abcdefghij");
    const h = harness();
    const read = vi.fn(async () => [issue("i1")]);
    expect(await run(h, read)).toBe("not_configured");
    expect(read).not.toHaveBeenCalled();
    // Not even the "is it off?" question: a push's status must not be touched.
    expect(h.calls).toEqual([]);
    expect(h.ctx.runQuery).not.toHaveBeenCalled();
  });

  test("a source that was switched off is never read", async () => {
    const h = harness({ off: true });
    const read = vi.fn(async () => [issue("i1")]);
    expect(await run(h, read)).toBe("not_configured");
    expect(read).not.toHaveBeenCalled();
    expect(h.calls).toEqual([
      {
        name: NOTE,
        args: { source: "linear", message: "Turned off under Settings → Work tools." },
      },
    ]);
  });

  test("a read that needs a connection the owner has not made is a setup step, not a failure", async () => {
    const h = harness();
    const outcome = await run(h, async () => {
      throw new NotConnected("Connect Google under Settings → Work tools.");
    });
    expect(outcome).toBe("not_configured");
    expect(h.calls).toEqual([
      {
        name: NOTE,
        args: { source: "linear", message: "Connect Google under Settings → Work tools." },
      },
    ]);
  });

  test("a ConnectorError's own words are logged, and nothing is written", async () => {
    const h = harness();
    const outcome = await run(h, async () => {
      throw new ConnectorError("Linear answered 401 for issues.");
    });
    expect(outcome).toBe("error");
    expect(h.named(APPLY)).toEqual([]);
    expect(h.calls).toEqual([
      {
        name: FAILURE,
        args: {
          source: "linear",
          startedAt: NOW,
          status: "error",
          message: "Linear answered 401 for issues.",
        },
      },
    ]);
  });

  test("anything else thrown is reduced to its class name", async () => {
    const h = harness();
    const outcome = await run(h, async () => {
      throw new Error('GET https://x.test/?token=abc → body {"subject":"private"}');
    });
    expect(outcome).toBe("error");
    expect(h.named(APPLY)).toEqual([]);
    expect(h.named(FAILURE)[0]?.args).toMatchObject({
      status: "error",
      message: "The run failed unexpectedly (Error).",
    });
    const recorded = JSON.stringify(h.calls);
    for (const leaked of ["x.test", "abc", "private"]) expect(recorded).not.toContain(leaked);
  });

  test("an empty read is logged as empty where empty is not an answer, and nothing is written", async () => {
    const h = harness();
    expect(await run(h, async () => [])).toBe("empty");
    expect(h.calls).toEqual([
      {
        name: FAILURE,
        args: {
          source: "linear",
          startedAt: NOW,
          status: "empty",
          message: "The source returned nothing.",
        },
      },
    ]);
  });

  test("an empty read is applied where empty is a real answer", async () => {
    const h = harness();
    expect(await run(h, async () => [], true)).toBe("ok");
    expect(h.calls).toEqual([
      { name: APPLY, args: { source: "linear", startedAt: NOW, rows: [] } },
    ]);
  });

  test("a batch that breaks the rules is logged by its counts, and nothing is written", async () => {
    const h = harness();
    const rows = [issue("i1"), issue("i2", { title: "REMOTE-TEXT\nwith a line break" })];
    expect(await run(h, async () => rows)).toBe("error");
    expect(h.named(APPLY)).toEqual([]);
    expect(h.named(FAILURE)[0]?.args).toMatchObject({
      status: "error",
      message: "1 of 2 records broke the size and shape rules, so nothing was written.",
    });
    expect(JSON.stringify(h.calls)).not.toContain("REMOTE-TEXT");
  });

  test("a failed write is logged as a fixed sentence, not the thrown message", async () => {
    const h = harness({ failWrite: new Error("write failed: Made-up title") });
    expect(await run(h, async () => [issue("i1")])).toBe("error");
    expect(h.named(APPLY)).toHaveLength(1);
    expect(h.named(FAILURE)).toHaveLength(1);
    expect(h.named(FAILURE)[0]?.args).toMatchObject({
      status: "error",
      message: "The run failed unexpectedly (Error).",
    });
    expect(JSON.stringify(h.named(FAILURE))).not.toContain("Made-up title");
  });

  test("a write dropped because the source was turned off mid-read is not a success", async () => {
    const h = harness({ dropped: true });
    expect(await run(h, async () => [issue("i1")])).toBe("not_configured");
    expect(h.named(FAILURE)).toEqual([]);
  });

  test("a good batch is written once, with the run's start time", async () => {
    const h = harness();
    const rows = [issue("i1"), issue("i2")];
    expect(await run(h, async () => rows)).toBe("ok");
    expect(h.calls).toEqual([{ name: APPLY, args: { source: "linear", startedAt: NOW, rows } }]);
  });

  test("the read is handed the same clock the run is recorded with", async () => {
    const h = harness();
    const read = vi.fn(async (_now: number) => {
      vi.setSystemTime(NOW + 60_000);
      return [issue("i1")];
    });
    expect(await run(h, read)).toBe("ok");
    expect(read).toHaveBeenCalledWith(NOW);
    expect(h.calls[0]?.args).toMatchObject({ startedAt: NOW });
  });
});

// A Google read is stamped with the grant it began under, so the write can
// tell a read that outlived its grant (disconnect, then connect again).
describe("runMirror: the Google sources", () => {
  const mail = (threadId: string): RecordOf<"mail"> => ({
    kind: "mail",
    threadId,
    fromName: "Ada Example",
    fromAddress: "ada@example-fund.test",
    subject: "Made-up subject",
    lastMessageAt: NOW - 60_000,
  });
  const env = () => {
    vi.stubEnv("GOOGLE_WORK_CLIENT_ID", "fake-client-id");
    vi.stubEnv("GOOGLE_WORK_CLIENT_SECRET", "fake-client-secret-not-real");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", btoa("0123456789abcdef0123456789abcdef"));
  };

  test.each(["gmail", "google_calendar"] as const)(
    "a %s write carries when the grant it was read under was made",
    async (source) => {
      env();
      const h = harness({ grantAt: NOW - 5000 });
      const rows = source === "gmail" ? [mail("a1")] : [];
      // The grant is noted before the read, not after: a reconnect during the
      // read must leave the stamp behind.
      const read = vi.fn(async () => {
        expect(h.queries).toContain(GRANT_AT);
        return rows;
      });
      expect(await runMirror(h.ctx, source, { allowEmpty: true }, read)).toBe("ok");
      expect(h.named(APPLY)).toEqual([
        { name: APPLY, args: { source, startedAt: NOW, rows, grantAt: NOW - 5000 } },
      ]);
    },
  );

  test("with no grant the read still runs, to say what is missing, and nothing is stamped", async () => {
    env();
    const h = harness({ grantAt: null });
    const outcome = await runMirror(h.ctx, "gmail", { allowEmpty: true }, async () => {
      throw new NotConnected("Connect Google under Settings → Work tools.");
    });
    expect(outcome).toBe("not_configured");
    expect(h.named(APPLY)).toEqual([]);
  });

  test("the other tools are never asked about a grant", async () => {
    const h = harness();
    expect(await run(h, async () => [issue("i1")])).toBe("ok");
    expect(h.queries).not.toContain(GRANT_AT);
  });
});
