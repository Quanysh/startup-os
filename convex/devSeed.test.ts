import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { SEEDED_TABLES } from "./devSeed";
import { LOCAL_OWNER_EMAIL, NOT_LOCAL, localEmail, type LocalRole } from "./lib/devLocal";
import {
  SEED_NOTIFICATIONS,
  SEED_PEOPLE,
  SEED_TASKS,
  emailOf,
  seedPayMonth,
} from "./lib/devSeedData";
import { METRICS } from "./lib/metricRegistry";
import schema from "./schema";
import { modules, signInAs, type TestBackend } from "./test.setup";

// The local seed and the local sign-in: that they run only on a local
// backend, that the seed lands on the same state every time, that what it
// writes is what the pages read, and that the session it makes is let in as
// the person it is for. Every name, figure and address is made up.

const NOW = Date.parse("2026-10-13T12:00:00Z");

const local = () => {
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("CONVEX_SITE_URL", "http://127.0.0.1:3211");
  vi.stubEnv("OWNER_EMAILS", LOCAL_OWNER_EMAIL);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  local();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const start = () => convexTest(schema, modules);
const seed = (t: TestBackend) => t.mutation(internal.devSeed.run, {});

/** Every seeded table's rows, without what differs from one run to the next: ids and insert times. */
async function contents(t: TestBackend) {
  const dump = await t.run(async (ctx) => {
    const tables: Record<string, unknown[]> = {};
    for (const table of SEEDED_TABLES) {
      tables[table] = (await ctx.db.query(table).collect()).map(
        ({ _id, _creationTime, ...row }) => row,
      );
    }
    return tables;
  });
  // An id is "<number>;<table>" in the test backend. Which number a row got
  // is not part of the state; which table a reference points at is.
  return JSON.parse(JSON.stringify(dump).replace(/"\d+;(\w+)"/g, '"<id of $1>"')) as typeof dump;
}

describe("where the seed may run", () => {
  test.each([
    ["a cloud deployment", () => {
      vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-animal-123.convex.cloud");
      vi.stubEnv("CONVEX_SITE_URL", "https://happy-animal-123.convex.site");
    }],
    ["a cloud deployment that had the made-up owner", () => {
      vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-animal-123.convex.cloud");
    }],
    ["a backend with a real owner", () => vi.stubEnv("OWNER_EMAILS", "someone@example.com")],
    ["a backend with a second owner", () =>
      vi.stubEnv("OWNER_EMAILS", `${LOCAL_OWNER_EMAIL} someone@example.com`)],
    ["a backend with no owner", () => vi.stubEnv("OWNER_EMAILS", "")],
    ["a backend that does not say where it is", () => vi.stubEnv("CONVEX_CLOUD_URL", "")],
  ])("not on %s: it throws, and neither deletes nor writes a row", async (_name, change) => {
    const t = start();
    // What a real deployment would stand to lose.
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", { title: "Real work", kind: "task", column: "doing", order: 0 });
      await ctx.db.insert("metricTargets", { key: "mrr", scope: "us", target: 1 });
    });
    change();
    await expect(seed(t)).rejects.toThrow(NOT_LOCAL);
    await expect(
      t.mutation(internal.devSession.create, { role: "owner", companies: "both" }),
    ).rejects.toThrow(NOT_LOCAL);
    const left = await t.run(async (ctx) => ({
      tasks: (await ctx.db.query("tasks").collect()).map((task) => task.title),
      targets: (await ctx.db.query("metricTargets").collect()).length,
      users: (await ctx.db.query("users").collect()).length,
      sessions: (await ctx.db.query("authSessions").collect()).length,
      snapshots: (await ctx.db.query("metricSnapshots").collect()).length,
    }));
    expect(left).toEqual({ tasks: ["Real work"], targets: 1, users: 0, sessions: 0, snapshots: 0 });
  });

  test("neither function is one a browser can call", () => {
    expect(api).not.toHaveProperty("devSeed.run");
    const names = Object.keys(modules).filter((path) => /\/dev(Seed|Session)\.ts$/.test(path));
    expect(names).toHaveLength(2);
  });
});

// Each of these runs the whole seed two or three times (some 2,000 figures a
// run, with Globex's in detail), which takes longer than vitest's 5 seconds
// on a busy machine.
describe("what the seed writes", { timeout: 20_000 }, () => {
  test("something in every table a page reads, and the counts it reports are what is stored", async () => {
    const t = start();
    const counts = await seed(t);
    const stored = await contents(t);
    for (const table of [
      "members",
      "goals",
      "tasks",
      "notifications",
      "standupItems",
      "metricTargets",
      "deals",
      // A few US deals' sales intelligence, for the deal page and the table's columns.
      "dealIntel",
      "investors",
      "metricSnapshots",
      "sourceStatus",
      "syncRuns",
      "planFigures",
      "customers",
      "obligations",
      "mirrorRecords",
      "personalSourceStatus",
      "workToolSettings",
      "payrollPeople",
      "payrollLines",
      "payrollRuns",
      "costs",
      // What the owner's Claude called, for the Assistant page's table.
      "agentCalls",
      // Globex's Intercom inbox, for the Support page.
      "supportConversations",
      "supportWorkspace",
    ]) {
      expect([table, stored[table]!.length]).toEqual([table, counts[table]]);
      expect([table, counts[table]]).toEqual([table, expect.any(Number)]);
    }
    expect(counts.users).toBe(SEED_PEOPLE.length);
    expect(counts.tasks).toBe(SEED_TASKS.length);
    expect(counts.notifications).toBe(SEED_NOTIFICATIONS.length);
    // Nothing the seed does not mean to fill: no token, no grant, no Telegram, no limit rows.
    for (const table of [
      "personalTokens",
      // No agent token either: one is made on the Assistant page, and shown once.
      "agentTokens",
      "oauthStates",
      "oauthConnections",
      "telegramSettings",
      "telegramSends",
      "suggestionsSent",
    ]) {
      expect([table, stored[table]]).toEqual([table, []]);
    }
  });

  // Three seeds and two reads of every seeded table cross vitest's 5s default
  // on a busy runner, beside the rest of the suite.
  test("running it again lands on the same state, row for row", { timeout: 20_000 }, async () => {
    const t = start();
    await seed(t);
    const first = await contents(t);
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(await seed(t)).toEqual(await seed(t));
    expect(await contents(t)).toEqual(first);
    // The people are the same rows, so a browser signed in as one stays signed in.
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toEqual(users);
  });

  test("it resets whatever was changed locally, and removes what was added", async () => {
    const t = start();
    await seed(t);
    const first = await contents(t);
    await t.run(async (ctx) => {
      const [task] = await ctx.db.query("tasks").collect();
      await ctx.db.patch(task!._id, { title: "Renamed by hand" });
      await ctx.db.insert("goals", { quarter: "2026-Q4", title: "Added by hand", status: "done", order: 9 });
      for (const row of await ctx.db.query("customers").collect()) await ctx.db.delete(row._id);
      const owner = await ctx.db.query("users").first();
      await ctx.db.patch(owner!._id, { name: "Renamed" });
    });
    await seed(t);
    expect(await contents(t)).toEqual(first);
    const owner = await t.run((ctx) => ctx.db.query("users").first());
    expect(owner!.name).toBe("Owner Example");
  });

  test("a session made before a re-seed is still there after it", async () => {
    const t = start();
    await seed(t);
    const session = await t.mutation(internal.devSession.create, { role: "sales", companies: "both" });
    await seed(t);
    const kept = await t.run((ctx) => ctx.db.query("authSessions").collect());
    expect(kept.map((row) => row._id)).toEqual([session.sessionId]);
  });
});

describe("the seeded backend, as each person sees it", () => {
  const signedIn = async (t: TestBackend, role: LocalRole, companies: "us" | "kz" | "both" = "both") => {
    const made = await t.mutation(internal.devSession.create, { role, companies });
    return t.withIdentity({ subject: `${made.userId}|${made.sessionId}` });
  };

  test("the owner's scorecard has a figure for every metric of the registry", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    const { tiles, sources } = await owner.query(api.metrics.scorecard, {});
    const keys = new Set(tiles.map((tile) => tile.key));
    for (const metric of METRICS.filter((m) => m.home !== undefined)) {
      expect(keys).toContain(metric.key);
    }
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    expect((await owner.query(api.metrics.series, { key: "mrr", scope: "us" })).length).toBe(13);
    // Seeds the whole backend: about a second alone, past the default 5s under a full run.
  }, 20_000);

  test("the bell has something in it: for the owner, and for a teammate on one company", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    expect(await owner.query(api.notifications.unreadCount, {})).toBe(2);
    const { rows } = await owner.query(api.notifications.mine, {});
    expect(rows.map((row) => [row.kind, row.actor, row.read])).toEqual([
      ["mentioned", { type: "user", name: "Ada Example" }, false],
      ["finished", { type: "user", name: "Sam Placeholder" }, false],
      ["moved", { type: "user", name: "Ada Example" }, true],
      ["due", { type: "user", name: "Ada Example" }, true],
    ]);
    // Each leads to a card that is on the board, and the mention is marked there.
    const cards = Object.values(await owner.query(api.tasks.board, {})).flat();
    for (const row of rows) expect(cards.map((card) => card.id)).toContain(row.taskId);
    const mentioned = cards.find((card) => card.id === rows[0]!.taskId)!;
    expect(mentioned.mentions).toEqual(["Owner Example"]);
    expect(mentioned.notes).toContain("@Owner Example");

    const riley = await signedIn(t, "sales", "us");
    expect((await riley.query(api.notifications.mine, {})).rows).toMatchObject([
      { kind: "reassigned", to: "Max Fixture", actor: { type: "user", name: "Owner Example" } },
    ]);
  });

  test("every page's own query answers with rows", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    const board = await owner.query(api.tasks.board, {});
    expect(Object.values(board).map((column) => column.length)).toEqual([7, 3, 3, 3]);
    expect(board.backlog.filter((card) => card.origin?.source === "standup")).toHaveLength(2);
    expect(board.backlog.find((card) => card.origin?.source === "suggestion")?.origin).toEqual({
      source: "suggestion",
      suggestedBy: "Sam Placeholder",
    });
    expect(board.backlog.find((card) => card.assignee)?.assignee).toMatchObject({
      status: "teammate",
      name: "Sam Placeholder",
    });

    expect((await owner.query(api.goals.list, { quarter: "2026-Q4" })).length).toBe(4);
    for (const market of ["us", "kz"] as const) {
      const deals = await owner.query(api.deals.board, { market });
      expect(JSON.stringify(deals)).toContain(market === "us" ? "Maple Street Clinic" : "Demo Clinic Almaty");
    }
    expect(JSON.stringify(await owner.query(api.investors.board, {}))).toContain("Example Ventures");
    // Eight US clinics and eighteen in Kazakhstan, enough to fill every group of
    // Product › Kazakhstan › Clinics; the deals won on the Sales board are clinics
    // the register already carries, so they add none.
    expect((await owner.query(api.customers.list, {})).customers.length).toBe(26);
    expect((await owner.query(api.obligations.list, {})).length).toBe(11);
    expect(await owner.query(api.plan.get, {})).not.toBeNull();
    expect((await owner.query(api.sources.list, {})).length).toBeGreaterThan(10);
    expect((await owner.query(api.team.list, {})).length).toBe(SEED_PEOPLE.length - 1);
    expect((await owner.query(api.workTools.outbound, {})).sequences.rows).toHaveLength(4);
    expect((await owner.query(api.workTools.issues, {})).issues.length).toBeGreaterThan(0);
    // One agent's harness: the code's defaults, a draft whose tests passed, made-up cases and a finished run.
    const where = { project: "sample-research", agentId: "sample-search.rank" };
    const harness = await owner.query(api.agentHarness.harness, where);
    expect(harness.published).toBeNull();
    expect(harness.draft).toMatchObject({ name: "h1", gate: "passed", problems: [] });
    const tests = await owner.query(api.agentHarness.tests, where);
    expect(tests.cases).toHaveLength(2);
    expect(tests.runs[0]).toMatchObject({ status: "done", expected: 2, passed: 2, ofDraftNow: true });
    expect((await owner.query(api.agentHarness.run, { id: tests.runs[0]!.id }))?.results).toHaveLength(2);
  });

  test("company memory: decisions and meetings for each company, one of the owner's due on Today", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    for (const company of ["us", "kz"] as const) {
      expect((await owner.query(api.decisions.list, { company })).length).toBeGreaterThan(1);
      expect((await owner.query(api.meetingNotes.list, { company })).length).toBeGreaterThan(0);
    }
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    expect((await owner.query(api.decisions.mineToRevisit, { today })).length).toBeGreaterThan(0);
    const all = JSON.stringify(await owner.query(api.decisions.list, {}));
    expect(all).toContain("Example");
    expect(all).not.toMatch(/@(?!startup-os\.test|example\.test)[a-z]/);
  });

  test("contacts: made-up people of each company, at example.test, one linked to an investor and one to a deal", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    for (const company of ["us", "kz"] as const) {
      const page = await owner.query(api.contacts.list, { company });
      expect(page.contacts.length).toBeGreaterThan(1);
      for (const contact of page.contacts) {
        expect(contact.company).toBe(company);
        for (const email of contact.emails) expect(email).toMatch(/@[a-z0-9.-]*example\.test$/);
      }
    }
    const all = (await owner.query(api.contacts.list, { limit: 50 })).contacts;
    const links = all.flatMap((contact) => contact.linkedRecords.map((link) => link.type)).sort();
    expect(links).toEqual(expect.arrayContaining(["deal", "investor"]));
    expect(all.some((contact) => contact.introducedByName !== null)).toBe(true);
    expect(all.some((contact) => contact.canIntroTo.length > 0)).toBe(true);
  });

  test("the LinkedIn calendar: posts of both companies, figures over weeks, a target, and a scheduled post with no draft", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    for (const company of ["us", "kz"] as const) {
      const { posts, targets } = await owner.query(api.linkedin.list, { company });
      expect(posts.length).toBeGreaterThan(2);
      expect(targets).toHaveLength(1);
      expect(posts.some((post) => post.status === "published" && post.snapshots.length > 1)).toBe(true);
    }
    const { posts } = await owner.query(api.linkedin.list, {});
    expect(posts.some((post) => post.status === "scheduled" && post.body === null)).toBe(true);
    expect(posts.some((post) => post.account === "person")).toBe(true);
    const all = JSON.stringify(posts);
    expect(all).toContain("Made-up");
    expect(all).not.toMatch(/@(?!startup-os\.test|example\.test)[a-z]/);
  });

  test("two roles the made-up owner named, with different focuses, and people who have them", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    const named = (await owner.query(api.roles.list, {})).filter((role) => !role.builtin);
    expect(named.map((role) => [role.name, role.focus, role.people])).toEqual([
      ["Customer success", "customers", 2],
      ["Marketing", "marketing", 2],
    ]);
    // Signed in as one of them: the role's name and focus, and its usual pages with Today.
    const mina = await (await signedIn(t, "marketing")).query(api.viewer.me, {});
    expect(mina).toMatchObject({
      role: "custom",
      roleName: "Marketing",
      focus: "marketing",
      areas: ["scorecard", "marketing", "gtm", "board", "today"],
    });
    const aru = await (await signedIn(t, "success", "kz")).query(api.viewer.me, {});
    expect(aru).toMatchObject({ roleName: "Customer success", focus: "customers", companies: ["kz"] });
    expect(aru!.areas).toEqual(["customers", "board"]);
  });

  test("an engineer's GitHub username is an author of the made-up pull requests", async () => {
    const t = start();
    await seed(t);
    const max = await signedIn(t, "engineer");
    const { login } = await max.query(api.team.myGithub, {});
    expect(login).toBe("example-ben");
    const pulls = await max.query(api.workTools.pullRequests, {});
    expect(pulls.rows.some((row) => row.authorLogin === login)).toBe(true);
    // The owner has none on record, so the line that asks for one can be seen.
    expect(await (await signedIn(t, "owner")).query(api.team.myGithub, {})).toEqual({ login: null });
  });

  test("the Engineering page: repositories and pull requests for each company, every one invented", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    const repos = await owner.query(api.workTools.engineering, {});
    const pulls = await owner.query(api.workTools.pullRequests, {});
    expect(repos.readAt).not.toBeNull();
    expect(pulls.readAt).not.toBeNull();
    for (const company of ["us", "kz"] as const) {
      expect(repos.rows.filter((row) => row.company === company).length).toBeGreaterThan(0);
      const own = pulls.rows.filter((row) => row.company === company);
      // Something in every stage the flow draws, and something stuck.
      expect(new Set(own.map((row) => row.state))).toEqual(new Set(["open", "merged", "closed"]));
      expect(own.some((row) => row.draft)).toBe(true);
      expect(own.some((row) => row.reviewDecision === "approved")).toBe(true);
      expect(own.some((row) => row.reviewDecision === "changes_requested")).toBe(true);
      expect(own.some((row) => row.checks === "failing")).toBe(true);
    }
    // It reads as invented: titles say "Example", people are the seed's made-up engineers, and
    // the organisation is one nobody could mistake for a real one.
    for (const row of pulls.rows) {
      expect(row.title).toMatch(/^Example: /);
      expect(row.repoId).toMatch(/^example-seed-org\/example-/);
      expect(row.authorLogin).toMatch(/^example-/);
      expect(row.authorName).toMatch(/Example|Sample|Placeholder|Mock/);
    }
    for (const row of repos.rows) expect(row.repoId).toMatch(/^example-seed-org\/example-/);
    // Every pull request's repository is a listed one, for the same company.
    for (const row of pulls.rows) {
      expect(repos.rows.find((repo) => repo.repoId === row.repoId)?.company).toBe(row.company);
    }
  });

  test("the seeded engineer on Globex gets Globex's pull requests and none of Startup's", async () => {
    const t = start();
    await seed(t);
    const engineer = await signedIn(t, "engineer", "kz");
    const pulls = await engineer.query(api.workTools.pullRequests, {});
    expect(pulls.rows.length).toBeGreaterThan(0);
    expect(pulls.rows.every((row) => row.company === "kz")).toBe(true);
  });

  test("costs: a dozen lines for each company, through the page's own check, with a figure for every tile", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    for (const company of ["us", "kz"] as const) {
      const lines = await owner.query(api.costs.list, { company });
      // Globex's agency, paid a one-off a month for the last three, is three more.
      expect(lines).toHaveLength(company === "us" ? 12 : 15);
      const summary = await owner.query(api.costs.summary, { company, month: "2026-10" });
      expect(summary.lines).toBe(10);
      expect(summary.estimates).toBe(2);
      expect(summary.combined.kind).not.toBe("unknown");
      const [own] = summary.currencies;
      expect(own!.runRate).toBeGreaterThan(0);
      // A yearly or quarterly bill, or a one-off, makes cash due differ from the run-rate somewhere.
      expect(own!.cashByMonth.some((value) => value !== own!.runRate)).toBe(true);
    }
  });

  test("budget: a plan for every month in view, Globex's actuals, and two scenarios each that project", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    for (const company of ["us", "kz"] as const) {
      const view = await owner.query(api.budget.view, { company, first: "2026-04", count: 18 });
      expect(new Set(view.cells.map((cell) => cell.month)).size).toBe(18);
      expect(view.cells.some((cell) => cell.category === "payroll")).toBe(true);
      expect(view.actuals.length).toBe(company === "kz" ? 6 : 0);
      const scenarios = await owner.query(api.scenarios.list, { company });
      expect(scenarios.map((s) => s.name.startsWith("Example"))).toEqual([true, true]);
    }
  });

  test("payroll: people, lines with rates, and this month prepared and whole, for each company", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    const month = seedPayMonth(NOW);
    expect(month).toBe("2026-10-01");
    for (const company of ["us", "kz"] as const) {
      expect((await owner.query(api.payroll.listPeople, { company })).length).toBe(4);
      const lines = await owner.query(api.payroll.listLines, { company });
      expect(lines.every((line) => line.rateBp !== null)).toBe(true);
      const run = await owner.query(api.payroll.getRun, { company, month });
      expect(run).toMatchObject({ status: "draft" });
      // Every line of every row has an amount: nothing "rate not set", no gross unknown.
      const stored = await t.run((ctx) =>
        ctx.db
          .query("payrollRuns")
          .withIndex("by_company_and_month", (q) => q.eq("company", company).eq("month", month))
          .unique(),
      );
      expect(stored!.rows).toHaveLength(4);
      for (const row of stored!.rows) {
        expect(row.gross).toBeGreaterThan(0);
        expect(row.cost).toBeGreaterThanOrEqual(row.gross!);
        expect(row.lines.every((line) => line.amount !== undefined && line.skipped === undefined)).toBe(true);
      }
      // The seeded month is what the page's live table shows: saving it again leaves it as it is.
      await owner.mutation(api.payroll.prepareRun, { company, month });
      const again = await t.run((ctx) =>
        ctx.db
          .query("payrollRuns")
          .withIndex("by_company_and_month", (q) => q.eq("company", company).eq("month", month))
          .unique(),
      );
      expect(again!.rows).toEqual(stored!.rows);
    }
  });

  test("the owner's Today has the owner's mail, meetings, notes and issues", async () => {
    const t = start();
    await seed(t);
    const owner = await signedIn(t, "owner");
    const mail = await owner.query(api.workTools.needsReply, {});
    expect(mail.threads).toHaveLength(6);
    expect(new Set(mail.threads.map((thread) => thread.group))).toEqual(
      new Set(["investor", "customer", "other"]),
    );
    const day = Date.parse("2026-10-13T00:00:00Z");
    expect((await owner.query(api.workTools.events, { from: day, to: day + 86_400_000 })).events).toHaveLength(3);
    expect((await owner.query(api.workTools.meetings, {})).meetings).toHaveLength(3);
    expect((await owner.query(api.workTools.myIssues, {})).issues.length).toBeGreaterThan(0);
  });

  test("the teammate with Today is sent their own records and none of the owner's", async () => {
    const t = start();
    await seed(t);
    const ada = await signedIn(t, "cofounder");
    const mail = await ada.query(api.workTools.needsReply, {});
    expect(mail.source.state).toBe("ok");
    expect(mail.threads.map((thread) => thread.threadId)).toEqual([
      "seed-thread-t3",
      "seed-thread-t2",
      "seed-thread-t1",
    ]);
    expect((await ada.query(api.workTools.meetings, {})).meetings).toHaveLength(1);
    expect((await ada.query(api.workTools.myIssues, {})).issues).toHaveLength(3);
    expect(JSON.stringify(await ada.query(api.connect.status, {}))).not.toContain("seed-thread-o");
  });

  test("each seeded role is let in to what its role starts with, on its own companies", async () => {
    const t = start();
    await seed(t);
    const sales = await signedIn(t, "sales", "us");
    expect(await sales.query(api.viewer.me, {})).toMatchObject({
      isMember: true,
      role: "sales",
      companies: ["us"],
      email: localEmail("sales", "us"),
      name: "Riley Mockwell",
    });
    await expect(sales.query(api.payroll.listPeople, { company: "us" })).rejects.toThrow("not_allowed");
    await expect(sales.query(api.deals.board, { market: "kz" })).rejects.toThrow("not_allowed");
    const engineer = await signedIn(t, "engineer", "kz");
    const cards = Object.values(await engineer.query(api.tasks.board, {})).flat();
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((card) => card.company !== "us")).toBe(true);
  });
});

describe("the local sign-in", () => {
  const create = (t: TestBackend, role: LocalRole, companies: "us" | "kz" | "both") =>
    t.mutation(internal.devSession.create, { role, companies });

  test("on an empty local backend it makes the person, their place on the team and a session", async () => {
    const t = start();
    const made = await create(t, "engineer", "kz");
    expect(made).toMatchObject({
      email: "engineer.kz@startup-os.test",
      issuer: "http://127.0.0.1:3211",
    });
    const client = t.withIdentity({ subject: `${made.userId}|${made.sessionId}` });
    expect(await client.query(api.viewer.me, {})).toMatchObject({
      isMember: true,
      isOwner: false,
      role: "engineer",
      companies: ["kz"],
      areas: ["product", "engineering", "board", "agents"],
    });
    const refresh = await t.run((ctx) => ctx.db.query("authRefreshTokens").collect());
    expect(refresh.map((row) => [row._id, row.sessionId])).toEqual([[made.refreshTokenId, made.sessionId]]);
  });

  test("the owner is the owner, on both companies whatever was asked, with no row on the team", async () => {
    const t = start();
    const made = await create(t, "owner", "kz");
    expect(made.email).toBe(LOCAL_OWNER_EMAIL);
    const client = t.withIdentity({ subject: `${made.userId}|${made.sessionId}` });
    expect(await client.query(api.viewer.me, {})).toMatchObject({
      isOwner: true,
      companies: ["us", "kz"],
    });
    expect(await t.run((ctx) => ctx.db.query("members").collect())).toEqual([]);
  });

  test("signing in again as the same person adds a session and no second person", async () => {
    const t = start();
    const first = await create(t, "sales", "both");
    const second = await create(t, "sales", "both");
    expect(second.userId).toBe(first.userId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await t.run((ctx) => ctx.db.query("members").collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(2); // and the owner who "added" them
  });

  test("pages ticked for a local teammate by hand are kept by the next sign-in", async () => {
    const t = start();
    await create(t, "sales", "both");
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("members").collect();
      await ctx.db.patch(row!._id, { areas: ["finance"] });
    });
    const made = await create(t, "sales", "both");
    const client = t.withIdentity({ subject: `${made.userId}|${made.sessionId}` });
    expect((await client.query(api.viewer.me, {}))!.areas).toEqual(["finance"]);
  });

  test("it takes a role and a company and nothing else: there is no way to name an address", async () => {
    const t = start();
    await expect(
      t.mutation(internal.devSession.create, {
        role: "owner",
        companies: "both",
        email: "someone@example.com",
      } as never),
    ).rejects.toThrow(/Validator error|extra field/i);
    await expect(
      t.mutation(internal.devSession.create, { role: "admin", companies: "both" } as never),
    ).rejects.toThrow(/Validator error|does not match/i);
  });

  test("a named local role signs in before any seed: its role is made, once", async () => {
    const t = start();
    await create(t, "marketing", "us");
    await create(t, "marketing", "both");
    const roles = await t.run((ctx) => ctx.db.query("roles").collect());
    expect(roles.map((role) => role.name).sort()).toEqual(["Customer success", "Marketing"]);
    const members = await t.run((ctx) => ctx.db.query("members").collect());
    const marketing = roles.find((role) => role.name === "Marketing")!._id;
    expect(members.map((member) => member.role)).toEqual([marketing, marketing]);
  });

  test("a real person on the same backend gains nothing from it", async () => {
    const t = start();
    await create(t, "owner", "both");
    const stranger = await signInAs(t, { email: "someone@example.com", emailVerificationTime: 1 });
    expect(await stranger.query(api.viewer.me, {})).toEqual({ isOwner: false, isMember: false });
  });

  test("every seeded person can be signed in as, by role and company", async () => {
    const t = start();
    await seed(t);
    for (const person of SEED_PEOPLE) {
      const made = await create(t, person.role, person.companies);
      expect(made.email).toBe(emailOf(person));
    }
    // Nobody new was made: the sign-in found each of them.
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(SEED_PEOPLE.length);
    expect(await t.run((ctx) => ctx.db.query("members").collect())).toHaveLength(SEED_PEOPLE.length - 1);
  });
});

describe("the seeded chat", () => {
  test("is one made-up conversation: a finished answer with its steps and one proposal under it, and no Mac checked in", async () => {
    const t = start();
    await seed(t);
    const { threads, messages, proposals, runner } = await t.run(async (ctx) => ({
      threads: await ctx.db.query("chatThreads").collect(),
      messages: await ctx.db.query("chatMessages").collect(),
      proposals: await ctx.db.query("proposals").collect(),
      runner: await ctx.db.query("chatRunner").collect(),
    }));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.title).toMatch(/^Made-up question: /);
    expect(messages.map(({ role, status }) => `${role}:${status}`)).toEqual(["user:done", "assistant:done"]);
    const answer = messages[1]!;
    expect(answer.text).toMatch(/^Made-up answer: /);
    expect(answer.text).toMatch(/not read yet/);
    expect(answer.steps).toEqual(["overview", "deals", "tasks", "propose"]);
    expect(answer.proposalIds).toHaveLength(1);
    const linked = proposals.find((proposal) => proposal._id === answer.proposalIds[0])!;
    expect([linked.status, linked.agent, linked.kind]).toEqual(["open", "chief_of_staff", "task_create"]);
    expect(runner).toEqual([]);
  });
});
