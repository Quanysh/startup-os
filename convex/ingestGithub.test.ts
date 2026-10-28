import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { NOT_A_PERSONAL_TOOL_WORDS, RECORDS_ONLY_WORDS } from "./lib/personalRules";
import type { SharedRecord } from "./lib/sharedRecords";
import schema from "./schema";
import {
  OWNER,
  modules,
  signInAs,
  signInAsMember,
  signInAsOwner,
  signInWithAreas,
  type TestBackend,
} from "./test.setup";

// GitHub's token: its numbers (`snapshots`) and its one shared list
// (`records` of kind `repo`), and nothing else. Every organisation and
// repository name is made up; the first company's carry "uniform", the second's "kilo", so
// an assertion can look for the other company's. A value that must never be
// echoed or logged carries SECRET.

// Obviously not real secrets.
const GITHUB = "fake-github-push-token-0123456789-abcdefg";
const APOLLO = "fake-apollo-push-token-0123456789-abcdefg";
const GMAIL = "fake-gmail-push-token-0123456789-abcdefgh";
const WORKBOOK = "fake-workbook-token-0123456789-abcdefghij";
const ENTROPY = "fake-browser-entropy-0123456789-abcdefghijklmn";
// A Wednesday. The week in progress began on Monday 2026-10-12.
const NOW = Date.UTC(2026, 9, 14, 6);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
  vi.stubEnv("INGEST_TOKEN_GITHUB", GITHUB);
  vi.stubEnv("INGEST_TOKEN_APOLLO", APOLLO);
  vi.stubEnv("INGEST_TOKEN_GMAIL", GMAIL);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const repo = (name: string, company: "us" | "kz", over: Record<string, unknown> = {}) => ({
  repoId: `Made-Up-Org/${name}`,
  org: "Made-Up-Org",
  name,
  company,
  mergedLastWeek: 4,
  open: 3,
  stuck: 1,
  main: "passing",
  pushedAt: "2026-10-13",
  ...over,
});
const sequence = (sequenceId: string) => ({
  sequenceId,
  name: "Made-up outreach",
  active: true,
  archived: false,
  steps: 7,
  createdAt: "2026-03-13",
  delivered: 24,
  opened: 1,
  replied: 0,
  bounced: 1,
  unsubscribed: 1,
});
const mail = (threadId: string) => ({
  threadId,
  fromName: "SECRET Sender",
  fromAddress: "secret.sender@example.test",
  subject: "SECRET subject",
  lastMessageAt: "2026-10-13T15:04:05Z",
});
const week = (key: string, scope: string, periodStart: string, value: number) => ({
  key,
  scope,
  period: "week",
  periodStart,
  value,
});
const header = (source: string) => ({
  version: 1,
  source,
  batchId: `${source}-batch-SECRET`,
  observedAt: "2026-10-14T06:00:00Z",
});
const list = (records: unknown[], extra: Record<string, unknown> = {}) => ({
  ...header("github"),
  kind: "repo",
  records,
  ...extra,
});

const REPO_OF = { us: "uniform-app", kz: "kilo-app" } as const;
/** A made-up pull request. Its title and its people carry SECRET and their company. */
const pr = (number: number, company: "us" | "kz", over: Record<string, unknown> = {}) => ({
  repoId: `Made-Up-Org/${REPO_OF[company]}`,
  number,
  company,
  title: `SECRET ${company} title ${number}`,
  url: `https://github.com/Made-Up-Org/${REPO_OF[company]}/pull/${number}`,
  authorLogin: `SECRET-${company}-ada`,
  authorName: `SECRET ${company} Ada`,
  draft: false,
  state: "open",
  createdAt: "2026-10-10T08:00:00Z",
  updatedAt: "2026-10-13T09:00:00Z",
  reviewDecision: "review_required",
  reviewersRequested: 1,
  reviewers: [`SECRET-${company}-ben`],
  checks: "passing",
  ...over,
});
const pulls = (records: unknown[], extra: Record<string, unknown> = {}) => ({
  ...header("github"),
  kind: "pull_request",
  records,
  ...extra,
});

type Reply = { status: number; text: string; json: () => unknown };
async function post(t: TestBackend, body: unknown, token: string): Promise<Reply> {
  const response = await t.fetch("/ingest/v1", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) as unknown };
}

const docs = (t: TestBackend) => t.run((ctx) => ctx.db.query("mirrorRecords").collect());
const ids = async (t: TestBackend) => (await docs(t)).map((doc) => doc.externalId).sort();
const runs = (t: TestBackend) => t.run((ctx) => ctx.db.query("syncRuns").collect());
const statuses = (t: TestBackend) => t.run((ctx) => ctx.db.query("sourceStatus").collect());
const snapshots = (t: TestBackend) =>
  t.run(async (ctx) =>
    (await ctx.db.query("metricSnapshots").collect())
      .map((r) => `${r.key} ${r.scope} ${r.periodStart} ${r.value} ${r.source}`)
      .sort(),
  );

describe("GitHub's token: the two envelopes of a daily read", () => {
  test("numbers: finished weeks' counts and this week's levels, for each company", async () => {
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      {
        ...header("github"),
        snapshots: [
          week("prs_merged", "us", "2026-10-05", 12),
          week("prs_opened", "us", "2026-10-05", 14),
          week("prs_merged", "kz", "2026-09-28", 0),
          week("prs_open", "us", "2026-10-12", 5),
          week("prs_stuck", "us", "2026-10-12", 1),
          week("repos_failing", "kz", "2026-10-12", 0),
          week("repos_tracked", "kz", "2026-10-12", 6),
        ],
      },
      GITHUB,
    );
    expect(response.status).toBe(200);
    expect(await snapshots(t)).toEqual([
      "prs_merged kz 2026-09-28 0 github",
      "prs_merged us 2026-10-05 12 github",
      "prs_open us 2026-10-12 5 github",
      "prs_opened us 2026-10-05 14 github",
      "prs_stuck us 2026-10-12 1 github",
      "repos_failing kz 2026-10-12 0 github",
      "repos_tracked kz 2026-10-12 6 github",
    ]);
    expect(await docs(t)).toEqual([]);
  });

  test("numbers: a part-week count, a level under another week and a metric of another source are refused whole", async () => {
    const t = convexTest(schema, modules);
    const refused = async (rows: unknown[]) => {
      const response = await post(t, { ...header("github"), snapshots: rows }, GITHUB);
      expect([response.status, (response.json() as { error: string }).error]).toEqual([
        422,
        "invalid_snapshots",
      ]);
    };
    const good = week("prs_merged", "us", "2026-10-05", 12);
    await refused([good, week("prs_merged", "us", "2026-10-12", 3)]);
    await refused([good, week("prs_open", "us", "2026-10-05", 3)]);
    await refused([good, week("apollo_contacts", "us", "2026-10-12", 3)]);
    await refused([good, week("searches", "startup_insights", "2026-10-05", 3)]);
    await refused([good, week("prs_stuck", "us", "2026-10-12", 1.5)]);
    expect(await snapshots(t)).toEqual([]);
  });

  test("the repositories: stored as the team's list, with no owner, under github", async () => {
    const t = convexTest(schema, modules);
    const response = await post(
      t,
      list([repo("uniform-app", "us"), repo("kilo-app", "kz", { main: "failing" })]),
      GITHUB,
    );
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, inserted: 2, updated: 0, unchanged: 0 });
    const stored = await docs(t);
    expect(stored.map((doc) => [doc.source, doc.owner, doc.userId, doc.externalId]).sort()).toEqual([
      ["github", undefined, undefined, "repo:made-up-org/kilo-app"],
      ["github", undefined, undefined, "repo:made-up-org/uniform-app"],
    ]);
    expect(stored.find((doc) => doc.externalId.endsWith("kilo-app"))!.record).toEqual({
      kind: "repo",
      ...repo("kilo-app", "kz", { main: "failing" }),
    });
  });

  test("the run log holds counts and the source: no repository's name, and not the sender's batch id", async () => {
    const t = convexTest(schema, modules);
    await post(t, list([repo("SECRET-uniform-app", "us")]), GITHUB);
    const log = JSON.stringify([await runs(t), await statuses(t)]);
    expect(log).not.toContain("SECRET");
    expect(await runs(t)).toMatchObject([{ source: "github", status: "ok", inserted: 1 }]);
    expect(await statuses(t)).toMatchObject([{ source: "github", state: "ok", lastOkAt: NOW }]);
  });
});

describe("the repository list: a push is the whole list", () => {
  test("a repository missing from the next push is removed; one that changed is updated", async () => {
    const t = convexTest(schema, modules);
    await post(t, list([repo("uniform-app", "us"), repo("uniform-old", "us"), repo("kilo-app", "kz")]), GITHUB);
    const response = await post(
      t,
      list([repo("uniform-app", "us", { open: 9 }), repo("kilo-app", "kz")]),
      GITHUB,
    );
    expect(response.json()).toEqual({ ok: true, inserted: 0, updated: 1, unchanged: 1 });
    expect(await ids(t)).toEqual(["repo:made-up-org/kilo-app", "repo:made-up-org/uniform-app"]);
  });

  test("it leaves Apollo's lists alone, and Apollo's leave it alone", async () => {
    const t = convexTest(schema, modules);
    await post(t, { ...header("apollo"), kind: "sequence", records: [sequence("s1")] }, APOLLO);
    await post(t, list([repo("uniform-app", "us")]), GITHUB);
    await post(t, list([repo("uniform-next", "us")]), GITHUB);
    expect(await ids(t)).toEqual(["repo:made-up-org/uniform-next", "sequence:s1"]);
    await post(t, { ...header("apollo"), kind: "sequence", records: [sequence("s2")] }, APOLLO);
    expect(await ids(t)).toEqual(["repo:made-up-org/uniform-next", "sequence:s2"]);
  });

  test("every row carries the time of the latest push, changed or not", async () => {
    const t = convexTest(schema, modules);
    await post(t, list([repo("uniform-app", "us")]), GITHUB);
    vi.setSystemTime(NOW + 5000);
    await post(t, list([repo("uniform-app", "us")]), GITHUB);
    expect((await docs(t)).map((doc) => doc.syncedAt)).toEqual([NOW + 5000]);
  });

  test("a refused push leaves what is stored untouched, and is logged in paths and fixed words", async () => {
    const t = convexTest(schema, modules);
    await post(t, list([repo("uniform-app", "us")]), GITHUB);
    const response = await post(
      t,
      list([repo("uniform-app", "us"), repo("uniform-two", "us", { title: "SECRET pull request" })]),
      GITHUB,
    );
    expect(response.status).toBe(422);
    expect(response.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.1", message: "has a field the OS does not accept" }],
    });
    expect(await ids(t)).toEqual(["repo:made-up-org/uniform-app"]);
    const failure = (await runs(t)).find((run) => run.status === "error")!;
    expect(failure.message).toBe("invalid_records: records.1 — has a field the OS does not accept");
    expect(failure.batchId).toBeUndefined();
    expect(JSON.stringify([response.text, await runs(t), await statuses(t)])).not.toContain("SECRET");
  });

  test("an empty list is refused, with `empty` or without", async () => {
    const t = convexTest(schema, modules);
    await post(t, list([repo("uniform-app", "us")]), GITHUB);
    expect((await post(t, list([]), GITHUB)).status).toBe(422);
    const flagged = await post(t, list([], { empty: true }), GITHUB);
    expect([flagged.status, (flagged.json() as { error: string }).error]).toEqual([422, "invalid_records"]);
    expect(await ids(t)).toEqual(["repo:made-up-org/uniform-app"]);
  });
});

describe("who may send what", () => {
  const refusedWith = async (
    t: TestBackend,
    body: unknown,
    token: string,
    status: number,
    error: string,
  ) => {
    const response = await post(t, body, token);
    expect([response.status, (response.json() as { error: string }).error]).toEqual([status, error]);
    expect(response.text).not.toContain("SECRET");
    return response;
  };
  const numbers = (source = "github") => ({
    ...header(source),
    snapshots: [week("prs_open", "us", "2026-10-12", 1)],
  });

  test("GitHub's token: records need a kind, and only `repo`", async () => {
    const t = convexTest(schema, modules);
    const bare = await refusedWith(t, { ...header("github"), records: [repo("a", "us")] }, GITHUB, 422, "invalid_envelope");
    expect(bare.json()).toMatchObject({ issues: [{ path: "kind" }] });
    for (const kind of ["sequence", "stage_count", "mail", "SECRET kind"]) {
      const response = await refusedWith(t, list([repo("a", "us")], { kind }), GITHUB, 422, "invalid_envelope");
      expect(response.json()).toMatchObject({ issues: [{ path: "kind" }] });
    }
    expect(await docs(t)).toEqual([]);
  });

  test("GitHub's token: Apollo's rows or a work tool's rows as repositories are refused by row", async () => {
    const t = convexTest(schema, modules);
    await refusedWith(t, list([sequence("s1")]), GITHUB, 422, "invalid_records");
    await refusedWith(t, list([mail("aa01")]), GITHUB, 422, "invalid_records");
    expect(await docs(t)).toEqual([]);
  });

  test("GitHub's token cannot write as Apollo or as a work tool", async () => {
    const t = convexTest(schema, modules);
    await refusedWith(t, { ...header("apollo"), kind: "sequence", records: [sequence("s1")] }, GITHUB, 403, "source_mismatch");
    await refusedWith(t, { ...header("apollo"), kind: "repo", records: [repo("a", "us")] }, GITHUB, 422, "invalid_envelope");
    await refusedWith(t, numbers("apollo"), GITHUB, 403, "source_mismatch");
    for (const source of ["gmail", "google_calendar", "linear", "fireflies"]) {
      await refusedWith(t, { ...header(source), records: [mail("aa01")] }, GITHUB, 403, "source_mismatch");
      await refusedWith(t, { ...header(source), kind: "repo", records: [repo("a", "us")] }, GITHUB, 422, "invalid_envelope");
    }
    expect(await docs(t)).toEqual([]);
    expect(await snapshots(t)).toEqual([]);
  });

  test("GitHub's token carries no pipeline, register or plan, and one payload per envelope", async () => {
    const t = convexTest(schema, modules);
    await refusedWith(
      t,
      { ...header("github"), deals: [{ externalId: "d1", name: "SECRET Co", stage: "Lead" }] },
      GITHUB,
      422,
      "invalid_rows",
    );
    await refusedWith(
      t,
      { ...header("github"), investors: [{ externalId: "i1", name: "SECRET Fund", stage: "Lead" }] },
      GITHUB,
      422,
      "invalid_rows",
    );
    await refusedWith(
      t,
      { ...header("github"), customers: [{ name: "SECRET clinic", market: "us", status: "active" }] },
      GITHUB,
      422,
      "customers_not_accepted",
    );
    await refusedWith(
      t,
      {
        ...header("github"),
        plan: { modelVersion: "a1b2c3d", rows: [{ scenario: "base", year: 2027, key: "arr", value: 1 }] },
      },
      GITHUB,
      422,
      "plan_not_accepted",
    );
    await refusedWith(
      t,
      { ...list([repo("a", "us")]), snapshots: [week("prs_open", "us", "2026-10-12", 1)] },
      GITHUB,
      422,
      "invalid_envelope",
    );
    expect(await docs(t)).toEqual([]);
    expect(await snapshots(t)).toEqual([]);
  });

  test("no other source's token can write the repositories or GitHub's numbers", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", WORKBOOK);
    const t = convexTest(schema, modules);
    for (const token of [APOLLO, GMAIL, WORKBOOK]) {
      // As GitHub: the token says who is writing.
      await refusedWith(t, list([repo("a", "us")]), token, 403, "source_mismatch");
      await refusedWith(t, numbers(), token, 403, "source_mismatch");
    }
    // As themselves: Apollo has no such list, and the others carry no list at all.
    await refusedWith(t, { ...header("apollo"), kind: "repo", records: [repo("a", "us")] }, APOLLO, 422, "invalid_envelope");
    await refusedWith(t, { ...header("gmail"), kind: "repo", records: [repo("a", "us")] }, GMAIL, 422, "invalid_envelope");
    await refusedWith(t, { ...header("gmail"), records: [repo("a", "us")] }, GMAIL, 422, "invalid_records");
    await refusedWith(t, { ...header("cfo_workbook"), kind: "repo", records: [repo("a", "us")] }, WORKBOOK, 422, "invalid_envelope");
    // And GitHub's metrics belong to GitHub in the registry.
    await refusedWith(t, numbers("apollo"), APOLLO, 422, "invalid_snapshots");
    await refusedWith(t, numbers("cfo_workbook"), WORKBOOK, 422, "invalid_snapshots");
    await refusedWith(t, numbers("gmail"), GMAIL, 422, "records_only");
    expect(await docs(t)).toEqual([]);
    expect(await snapshots(t)).toEqual([]);
  });

  test("a personal token cannot write the repositories or GitHub's numbers", async () => {
    const t = convexTest(schema, modules);
    const ada = await signInAsMember(t, "engineer", ["us"], "ada.teammate@gmail.com", ["today", "product"]);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });

    const named = await refusedWith(t, list([repo("a", "us")]), token, 422, "records_not_accepted");
    expect(named.json()).toMatchObject({
      issues: [{ path: "source", message: NOT_A_PERSONAL_TOOL_WORDS }],
    });
    await refusedWith(t, { ...header("github"), records: [repo("a", "us")] }, token, 422, "invalid_envelope");
    await refusedWith(t, { ...header("linear"), kind: "repo", records: [repo("a", "us")] }, token, 422, "invalid_envelope");
    await refusedWith(t, { ...header("linear"), records: [repo("a", "us")] }, token, 422, "invalid_records");
    const figures = await refusedWith(t, numbers(), token, 422, "records_only");
    expect(figures.json()).toMatchObject({ issues: [{ path: "envelope", message: RECORDS_ONLY_WORDS }] });

    expect(await docs(t)).toEqual([]);
    expect(await snapshots(t)).toEqual([]);
    expect(await runs(t)).toEqual([]);
  });

  test("without its token set, GitHub's token is nobody's", async () => {
    vi.stubEnv("INGEST_TOKEN_GITHUB", "");
    const t = convexTest(schema, modules);
    expect((await post(t, list([repo("a", "us")]), GITHUB)).status).toBe(401);
    expect(await docs(t)).toEqual([]);
  });
});

describe("the write's own guards, whoever calls it", () => {
  const stored = (name: string, over: Record<string, unknown> = {}) =>
    ({ kind: "repo", ...repo(name, "us"), ...over }) as SharedRecord;
  const seq = { kind: "sequence", ...sequence("s1") } as SharedRecord;

  test("a list of another source's kind is refused, both ways round", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.mirror.applyShared, { source: "github", kind: "sequence", startedAt: NOW, rows: [seq] }),
    ).rejects.toThrow("This source has no list of that kind.");
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "apollo",
        kind: "repo",
        startedAt: NOW,
        rows: [stored("uniform-app")],
      }),
    ).rejects.toThrow("This source has no list of that kind.");
    expect(await docs(t)).toEqual([]);
  });

  test("an empty batch and a row that could not be true are refused", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.mirror.applyShared, { source: "github", kind: "repo", startedAt: NOW, rows: [] }),
    ).rejects.toThrow("An empty list is never written for this source.");
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "github",
        kind: "repo",
        startedAt: NOW,
        rows: [stored("uniform-app", { stuck: 99 })],
      }),
    ).rejects.toThrow("1 of 1 records broke the size and shape rules, so nothing was written.");
    expect(await docs(t)).toEqual([]);
  });

  test("the validators: no field for a title or a person, and no door for a work tool", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "github",
        kind: "repo",
        startedAt: NOW,
        // @ts-expect-error a repository has no field for a person
        rows: [{ ...stored("uniform-app"), author: "SECRET person" }],
      }),
    ).rejects.toThrow(/Validator error/);
    await expect(
      t.mutation(internal.mirror.apply, {
        // @ts-expect-error github is not a work tool
        source: "github",
        startedAt: NOW,
        rows: [],
        pushed: true,
      }),
    ).rejects.toThrow(/Validator error/);
    expect(await docs(t)).toEqual([]);
  });
});

describe("workTools.engineering: the Engineering page's repositories", () => {
  const seed = async (t: TestBackend) => {
    await post(
      t,
      list([
        repo("uniform-app", "us", { pushedAt: "2026-10-13" }),
        repo("uniform-api", "us", { pushedAt: "2026-10-01", main: "failing" }),
        repo("kilo-app", "kz", { pushedAt: "2026-10-12", main: "none" }),
      ]),
      GITHUB,
    );
  };
  const names = (result: { rows: { name: string }[] }) => result.rows.map((row) => row.name);

  test("before the first push: no rows and no read time, never an error", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.workTools.engineering, {})).toEqual({ readAt: null, rows: [] });
  });

  test("the owner gets every repository, newest push first, and when the list was read", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const result = await owner.query(api.workTools.engineering, {});
    expect(result.readAt).toBe(NOW);
    expect(names(result)).toEqual(["uniform-app", "kilo-app", "uniform-api"]);
    expect(result.rows[2]).toEqual(repo("uniform-api", "us", { pushedAt: "2026-10-01", main: "failing" }));
  });

  test("a teammate on Globex alone is never sent a Startup repository, and the other way round", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const kz = await signInAsMember(t, "engineer", ["kz"], "kz.engineer@gmail.com", ["engineering"]);
    const forKz = await kz.query(api.workTools.engineering, {});
    expect(names(forKz)).toEqual(["kilo-app"]);
    expect(JSON.stringify(forKz)).not.toContain("uniform");
    // The list was read, whoever's rows it holds.
    expect(forKz.readAt).toBe(NOW);

    const us = await signInAsMember(t, "engineer", ["us"], "us.engineer@gmail.com", ["engineering"]);
    const forUs = await us.query(api.workTools.engineering, {});
    expect(names(forUs)).toEqual(["uniform-app", "uniform-api"]);
    expect(JSON.stringify(forUs)).not.toContain("kilo");

    const both = await signInAsMember(t, "engineer", ["us", "kz"], "both.engineer@gmail.com", ["engineering"]);
    expect(names(await both.query(api.workTools.engineering, {}))).toHaveLength(3);
  });

  test("the gate: the engineering area, which the product area does not bring", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const withIt = await signInWithAreas(t, "sales", ["engineering"], ["us"]);
    expect(names(await withIt.query(api.workTools.engineering, {}))).toHaveLength(2);

    const without = await signInAsMember(t, "sales", ["us", "kz"], "no.product@gmail.com", [
      "today",
      "product",
      "gtm",
      "board",
    ]);
    await expect(without.query(api.workTools.engineering, {})).rejects.toThrow("not_allowed");
    const stranger = await signInAs(t, { email: "stranger@example.test", emailVerificationTime: 1 });
    await expect(stranger.query(api.workTools.engineering, {})).rejects.toThrow("not_allowed");
    await expect(t.query(api.workTools.engineering, {})).rejects.toThrow("not_allowed");
  });

  test("it returns repositories only: no sequence, no mail", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await post(t, { ...header("apollo"), kind: "sequence", records: [sequence("s1")] }, APOLLO);
    await post(t, { ...header("gmail"), records: [mail("aa01")] }, GMAIL);
    const owner = await signInAsOwner(t);
    const text = JSON.stringify(await owner.query(api.workTools.engineering, {}));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("Made-up outreach");
    // Nor a pull request, though they are stored under the same source.
    await post(t, pulls([pr(1, "us")]), GITHUB);
    const after = await owner.query(api.workTools.engineering, {});
    expect(JSON.stringify(after)).not.toContain("SECRET");
    expect(after.rows).toHaveLength(3);
    // And the go-to-market read holds no repository.
    expect(JSON.stringify(await owner.query(api.workTools.outbound, {}))).not.toContain("uniform-app");
  });

  test("no row holds a field for a person or a title", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const owner = await signInAsOwner(t);
    const { rows } = await owner.query(api.workTools.engineering, {});
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "company",
        "main",
        "mergedLastWeek",
        "name",
        "open",
        "org",
        "pushedAt",
        "repoId",
        "stuck",
      ]);
    }
  });
});

describe("GitHub's token: the pull request list", () => {
  test("stored as the team's list, with no owner, under github, keyed by repository and number", async () => {
    const t = convexTest(schema, modules);
    const response = await post(t, pulls([pr(7, "us"), pr(3, "kz")]), GITHUB);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, inserted: 2, updated: 0, unchanged: 0 });
    const stored = await docs(t);
    expect(stored.map((doc) => [doc.source, doc.owner, doc.userId, doc.externalId]).sort()).toEqual([
      ["github", undefined, undefined, "pr:made-up-org/kilo-app#3"],
      ["github", undefined, undefined, "pr:made-up-org/uniform-app#7"],
    ]);
    expect(stored.find((doc) => doc.externalId.endsWith("#7"))!.record).toMatchObject({
      kind: "pull_request",
      title: "SECRET us title 7",
      authorLogin: "SECRET-us-ada",
      createdAt: Date.UTC(2026, 9, 10, 8),
    });
  });

  test("no title and no person in the reply, the run log or the source's status", async () => {
    const t = convexTest(schema, modules);
    const ok = await post(t, pulls([pr(7, "us")]), GITHUB);
    const bad = await post(
      t,
      pulls([pr(7, "us"), pr(8, "us", { url: "https://example.test/SECRET", body: "SECRET body" })]),
      GITHUB,
    );
    expect(bad.status).toBe(422);
    expect(bad.json()).toEqual({
      ok: false,
      error: "invalid_records",
      issues: [{ path: "records.1", message: "has a field the OS does not accept" }],
    });
    const worse = await post(t, pulls([pr(8, "us", { url: "https://example.test/SECRET" })]), GITHUB);
    expect(worse.json()).toMatchObject({
      issues: [{ path: "records.0.url", message: "is not this pull request's address on GitHub" }],
    });
    expect(JSON.stringify([ok.text, bad.text, worse.text, await runs(t), await statuses(t)])).not.toContain(
      "SECRET",
    );
    // The refused pushes left what was stored alone.
    expect(await ids(t)).toEqual(["pr:made-up-org/uniform-app#7"]);
  });

  test("a push is the whole list: one missing from the next is removed, and the repositories are left alone", async () => {
    const t = convexTest(schema, modules);
    await post(t, list([repo("uniform-app", "us")]), GITHUB);
    await post(t, pulls([pr(1, "us"), pr(2, "us")]), GITHUB);
    const response = await post(t, pulls([pr(2, "us", { draft: true }), pr(3, "us")]), GITHUB);
    expect(response.json()).toEqual({ ok: true, inserted: 1, updated: 1, unchanged: 0 });
    expect(await ids(t)).toEqual([
      "pr:made-up-org/uniform-app#2",
      "pr:made-up-org/uniform-app#3",
      "repo:made-up-org/uniform-app",
    ]);
    // And a push of the repositories leaves the pull requests alone.
    await post(t, list([repo("uniform-next", "us")]), GITHUB);
    expect(await ids(t)).toEqual([
      "pr:made-up-org/uniform-app#2",
      "pr:made-up-org/uniform-app#3",
      "repo:made-up-org/uniform-next",
    ]);
  });

  test("an empty list is refused, with `empty` or without", async () => {
    const t = convexTest(schema, modules);
    await post(t, pulls([pr(1, "us")]), GITHUB);
    expect((await post(t, pulls([]), GITHUB)).status).toBe(422);
    expect((await post(t, pulls([], { empty: true }), GITHUB)).status).toBe(422);
    expect(await ids(t)).toEqual(["pr:made-up-org/uniform-app#1"]);
  });

  test("six hundred are taken and one more is refused", async () => {
    const t = convexTest(schema, modules);
    // Short titles: the endpoint's size limit is the script's to keep to.
    const many = (n: number) => Array.from({ length: n }, (_, i) => pr(i + 1, "us", { title: "t", reviewers: [] , reviewersRequested: 0}));
    expect((await post(t, pulls(many(601)), GITHUB)).json()).toMatchObject({
      error: "invalid_records",
      issues: [{ path: "records", message: "At most 600 records of this kind in one push." }],
    });
    expect((await post(t, pulls(many(600)), GITHUB)).status).toBe(200);
    expect(await docs(t)).toHaveLength(600);
  });
});

describe("who may send pull requests", () => {
  // Token × payload: only GitHub's own token, as GitHub, with the kind said.
  const refusedWith = async (t: TestBackend, body: unknown, token: string, status: number, error: string) => {
    const response = await post(t, body, token);
    expect([response.status, (response.json() as { error: string }).error]).toEqual([status, error]);
    expect(response.text).not.toContain("SECRET");
  };

  test("GitHub's token: as the repo list, as Apollo's lists or with no kind, pull requests are refused", async () => {
    const t = convexTest(schema, modules);
    await refusedWith(t, list([pr(1, "us")]), GITHUB, 422, "invalid_records");
    await refusedWith(t, { ...header("github"), records: [pr(1, "us")] }, GITHUB, 422, "invalid_envelope");
    await refusedWith(t, pulls([pr(1, "us")], { kind: "sequence" }), GITHUB, 422, "invalid_envelope");
    await refusedWith(t, pulls([repo("uniform-app", "us")]), GITHUB, 422, "invalid_records");
    await refusedWith(t, pulls([sequence("s1")]), GITHUB, 422, "invalid_records");
    await refusedWith(t, pulls([mail("aa01")]), GITHUB, 422, "invalid_records");
    await refusedWith(
      t,
      { ...pulls([pr(1, "us")]), snapshots: [week("prs_open", "us", "2026-10-12", 1)] },
      GITHUB,
      422,
      "invalid_envelope",
    );
    expect(await docs(t)).toEqual([]);
  });

  test("GitHub's token cannot write them as Apollo or as a work tool", async () => {
    const t = convexTest(schema, modules);
    await refusedWith(t, { ...pulls([pr(1, "us")]), source: "apollo" }, GITHUB, 422, "invalid_envelope");
    for (const source of ["gmail", "google_calendar", "linear", "fireflies"]) {
      await refusedWith(t, { ...pulls([pr(1, "us")]), source }, GITHUB, 422, "invalid_envelope");
    }
    expect(await docs(t)).toEqual([]);
  });

  test("no other source's token can write them, as GitHub or as itself", async () => {
    vi.stubEnv("INGEST_TOKEN_CFO_WORKBOOK", WORKBOOK);
    const t = convexTest(schema, modules);
    for (const token of [APOLLO, GMAIL, WORKBOOK]) {
      await refusedWith(t, pulls([pr(1, "us")]), token, 403, "source_mismatch");
    }
    await refusedWith(t, { ...pulls([pr(1, "us")]), source: "apollo" }, APOLLO, 422, "invalid_envelope");
    await refusedWith(t, { ...pulls([pr(1, "us")]), source: "gmail" }, GMAIL, 422, "invalid_envelope");
    await refusedWith(t, { ...header("gmail"), records: [pr(1, "us")] }, GMAIL, 422, "invalid_records");
    await refusedWith(t, { ...pulls([pr(1, "us")]), source: "cfo_workbook" }, WORKBOOK, 422, "invalid_envelope");
    expect(await docs(t)).toEqual([]);
  });

  test("a personal token cannot write them", async () => {
    const t = convexTest(schema, modules);
    const ada = await signInAsMember(t, "engineer", ["us"], "ada.teammate@gmail.com", ["today", "engineering"]);
    const { token } = await ada.mutation(api.connect.createToken, { entropy: ENTROPY });
    await refusedWith(t, pulls([pr(1, "us")]), token, 422, "records_not_accepted");
    await refusedWith(t, { ...pulls([pr(1, "us")]), source: "linear" }, token, 422, "invalid_envelope");
    await refusedWith(t, { ...header("linear"), records: [pr(1, "us")] }, token, 422, "invalid_records");
    expect(await docs(t)).toEqual([]);
    expect(await runs(t)).toEqual([]);
  });

  test("the write's own guards: Apollo cannot be handed the kind, and a row that could not be true is refused", async () => {
    const t = convexTest(schema, modules);
    const row = {
      kind: "pull_request",
      ...pr(1, "us"),
      createdAt: NOW - 1000,
      updatedAt: NOW - 500,
    } as SharedRecord;
    await expect(
      t.mutation(internal.mirror.applyShared, { source: "apollo", kind: "pull_request", startedAt: NOW, rows: [row] }),
    ).rejects.toThrow("This source has no list of that kind.");
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "github",
        kind: "pull_request",
        startedAt: NOW,
        rows: [{ ...row, url: "https://example.test/x" } as SharedRecord],
      }),
    ).rejects.toThrow("1 of 1 records broke the size and shape rules, so nothing was written.");
    await expect(
      t.mutation(internal.mirror.applyShared, {
        source: "github",
        kind: "pull_request",
        startedAt: NOW,
        // @ts-expect-error a pull request has no field for its description
        rows: [{ ...row, body: "SECRET body" }],
      }),
    ).rejects.toThrow(/Validator error/);
    expect(await docs(t)).toEqual([]);
  });
});

describe("workTools.pullRequests: the Engineering page's read", () => {
  const seedPulls = async (t: TestBackend) => {
    await post(t, list([repo("uniform-app", "us"), repo("kilo-app", "kz")]), GITHUB);
    await post(
      t,
      pulls([
        pr(1, "us", { updatedAt: "2026-10-13T09:00:00Z" }),
        pr(2, "us", { updatedAt: "2026-10-11T09:00:00Z", draft: true }),
        pr(3, "kz", { updatedAt: "2026-10-12T09:00:00Z" }),
      ]),
      GITHUB,
    );
  };
  const numbers = (result: { rows: { number: number }[] }) => result.rows.map((row) => row.number);

  test("before the first push: no rows and no read time, never an error", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    expect(await owner.query(api.workTools.pullRequests, {})).toEqual({ readAt: null, rows: [] });
    // The repositories alone do not make the pull request list "read".
    await post(t, list([repo("uniform-app", "us")]), GITHUB);
    expect(await owner.query(api.workTools.pullRequests, {})).toEqual({ readAt: null, rows: [] });
  });

  test("the owner gets every pull request, newest activity first, and when the list was read", async () => {
    const t = convexTest(schema, modules);
    await seedPulls(t);
    const owner = await signInAsOwner(t);
    const result = await owner.query(api.workTools.pullRequests, {});
    expect(result.readAt).toBe(NOW);
    expect(numbers(result)).toEqual([1, 3, 2]);
    expect(result.rows[0]).toEqual({
      ...pr(1, "us"),
      createdAt: Date.UTC(2026, 9, 10, 8),
      updatedAt: Date.UTC(2026, 9, 13, 9),
    });
  });

  test("a teammate on Globex alone is never sent a Startup pull request, and the other way round", async () => {
    const t = convexTest(schema, modules);
    await seedPulls(t);
    const kz = await signInAsMember(t, "engineer", ["kz"], "kz.engineer@gmail.com", ["engineering"]);
    const forKz = await kz.query(api.workTools.pullRequests, {});
    expect(numbers(forKz)).toEqual([3]);
    // Not a title, an author, a reviewer, a repository or a link of Startup's.
    expect(JSON.stringify(forKz)).not.toMatch(/uniform|SECRET us|SECRET-us/i);
    expect(forKz.readAt).toBe(NOW);

    const us = await signInAsMember(t, "engineer", ["us"], "us.engineer@gmail.com", ["engineering"]);
    const forUs = await us.query(api.workTools.pullRequests, {});
    expect(numbers(forUs)).toEqual([1, 2]);
    expect(JSON.stringify(forUs)).not.toMatch(/kilo|SECRET kz|SECRET-kz/i);

    const both = await signInAsMember(t, "engineer", ["us", "kz"], "both.engineer@gmail.com", ["engineering"]);
    expect(numbers(await both.query(api.workTools.pullRequests, {}))).toHaveLength(3);
  });

  test("the gate: the engineering area, which neither the product area nor a company brings", async () => {
    const t = convexTest(schema, modules);
    await seedPulls(t);
    const withIt = await signInWithAreas(t, "sales", ["engineering"], ["us"]);
    expect(numbers(await withIt.query(api.workTools.pullRequests, {}))).toHaveLength(2);

    const without = await signInAsMember(t, "sales", ["us", "kz"], "no.engineering@gmail.com", [
      "scorecard",
      "product",
      "today",
      "board",
    ]);
    await expect(without.query(api.workTools.pullRequests, {})).rejects.toThrow("not_allowed");
    const stranger = await signInAs(t, { email: "stranger@example.test", emailVerificationTime: 1 });
    await expect(stranger.query(api.workTools.pullRequests, {})).rejects.toThrow("not_allowed");
    await expect(t.query(api.workTools.pullRequests, {})).rejects.toThrow("not_allowed");
  });

  test("it returns pull requests only: no repository, no sequence, no mail", async () => {
    const t = convexTest(schema, modules);
    await seedPulls(t);
    await post(t, { ...header("apollo"), kind: "sequence", records: [sequence("s1")] }, APOLLO);
    await post(t, { ...header("gmail"), records: [mail("aa01")] }, GMAIL);
    const owner = await signInAsOwner(t);
    const result = await owner.query(api.workTools.pullRequests, {});
    expect(result.rows).toHaveLength(3);
    const text = JSON.stringify(result);
    expect(text).not.toContain("Made-up outreach");
    expect(text).not.toContain("SECRET Sender");
    expect(text).not.toContain("mergedLastWeek");
    // Nobody else's read holds a title or a person of GitHub's.
    for (const other of [api.workTools.engineering, api.workTools.outbound, api.workTools.issues] as const) {
      expect(JSON.stringify(await owner.query(other, {}))).not.toMatch(/SECRET (us|kz) title|SECRET-(us|kz)-/);
    }
  });

  test("a full list beside a full repository list is all returned", async () => {
    const t = convexTest(schema, modules);
    await post(t, list(Array.from({ length: 300 }, (_, i) => repo(`uniform-${i}`, "us"))), GITHUB);
    const many = Array.from({ length: 600 }, (_, i) => pr(i + 1, "us", { title: "t", reviewers: [], reviewersRequested: 0 }));
    await post(t, pulls(many), GITHUB);
    const owner = await signInAsOwner(t);
    expect((await owner.query(api.workTools.pullRequests, {})).rows).toHaveLength(600);
    expect((await owner.query(api.workTools.engineering, {})).rows).toHaveLength(300);
  });

  test("the fields of a row, by name: a new one is added here on purpose", async () => {
    const t = convexTest(schema, modules);
    await seedPulls(t);
    const owner = await signInAsOwner(t);
    const { rows } = await owner.query(api.workTools.pullRequests, {});
    expect(Object.keys(rows[0]!).sort()).toEqual([
      "authorLogin",
      "authorName",
      "checks",
      "company",
      "createdAt",
      "draft",
      "number",
      "repoId",
      "reviewDecision",
      "reviewers",
      "reviewersRequested",
      "state",
      "title",
      "updatedAt",
      "url",
    ]);
  });
});
