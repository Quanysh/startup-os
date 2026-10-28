import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { LINKEDIN_WORDS } from "./lib/linkedin";
import { AGENT_TEXT_CUT } from "./lib/memory";
import { MAC_CLIENT, NOW, call, calls, ownerWithToken, seed } from "./mcp.kit";
import schema from "./schema";
import { OWNER, modules } from "./test.setup";

// The LinkedIn calendar as the owner's agent sees and writes it: `linkedin_posts`
// is the page's own list, and `linkedin_post_upsert` and `linkedin_stats_add`
// run the functions the page's forms run, as the client that called.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type Row = { [key: string]: unknown; body: string; history: { day: string; comments: number | null }[] };

const WENT_OUT = Date.UTC(2026, 9, 12, 9);

async function world() {
  const t = convexTest(schema, modules);
  await seed(t);
  const { owner, token } = await ownerWithToken(t, "act");
  const id = await owner.mutation(api.linkedin.save, {
    company: "us",
    account: "page",
    person: null,
    status: "published",
    title: "Example hook",
    body: "b".repeat(AGENT_TEXT_CUT + 100),
    pillar: "denials",
    owner: OWNER,
    plannedAt: null,
    publishedAt: WENT_OUT,
    link: "https://www.linkedin.com/posts/made-up",
  });
  await owner.mutation(api.linkedin.addSnapshot, { postId: id, day: "2026-10-12", impressions: 400, reactions: 10 });
  await owner.mutation(api.linkedin.addSnapshot, { postId: id, day: "2026-10-13", impressions: 900, reactions: 30, comments: 4, reposts: 2 });
  await owner.mutation(api.linkedin.save, {
    company: "kz",
    account: "person",
    person: "Ada Example",
    status: "idea",
    title: "Example kz idea",
    body: null,
    pillar: null,
    owner: null,
    plannedAt: null,
    publishedAt: null,
    link: null,
  });
  return { t, owner, token, id };
}

describe("linkedin_posts", () => {
  test("is the page's list: fields, the latest figures and the history, the draft cut", async () => {
    const { t, token, id } = await world();
    const reply = await call(t, token, "linkedin_posts", { company: "us" });
    expect(reply.isError).toBe(false);
    expect(reply.output.truncated).toBe(false);
    const rows = reply.output.rows as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      company: "us",
      account: "page",
      person: null,
      status: "published",
      title: "Example hook",
      pillar: "denials",
      owner: OWNER,
      plannedAt: null,
      publishedAt: new Date(WENT_OUT).toISOString(),
      link: "https://www.linkedin.com/posts/made-up",
      addedBy: null,
      figures: { day: "2026-10-13", impressions: 900, reactions: 30, comments: 4, reposts: 2, clicks: null, followersGained: null },
    });
    expect(rows[0]!.body.length).toBe(AGENT_TEXT_CUT);
    expect(rows[0]!.history.map((h: { day: string }) => h.day)).toEqual(["2026-10-12", "2026-10-13"]);
    expect(rows[0]!.history[0]!.comments).toBeNull();
  });

  test("filters by company, status and day, and leaves undated ideas out of a since", async () => {
    const { t, token } = await world();
    const all = (await call(t, token, "linkedin_posts", {})).output.rows as Row[];
    expect(all.map((row) => row.title).sort()).toEqual(["Example hook", "Example kz idea"]);
    const kz = (await call(t, token, "linkedin_posts", { company: "kz" })).output.rows as unknown[];
    expect(kz).toHaveLength(1);
    expect(((await call(t, token, "linkedin_posts", { status: "idea" })).output.rows as unknown[])).toHaveLength(1);
    expect(((await call(t, token, "linkedin_posts", { since: "2026-10-12" })).output.rows as unknown[])).toHaveLength(1);
    expect(((await call(t, token, "linkedin_posts", { since: "2026-10-13" })).output.rows as unknown[])).toHaveLength(0);
    expect((await call(t, token, "linkedin_posts", { company: "everyone" })).isError).toBe(true);
  });
});

describe("linkedin_post_upsert", () => {
  test("adds a post as the page would, and says which client wrote it", async () => {
    const { t, owner, token } = await world();
    const reply = await call(t, token, "linkedin_post_upsert", {
      company: "us",
      title: " Example   scheduled hook ",
      body: "Draft line.\n\nSecond.",
      status: "scheduled",
      plannedAt: "2026-10-21T09:00:00Z",
      pillar: "billing",
      ownerEmail: OWNER,
    });
    expect(reply.isError).toBe(false);
    expect(reply.output).toMatchObject({ created: true });
    const listed = (await owner.query(api.linkedin.list, { company: "us" })).posts;
    expect(listed.find((post) => post.id === reply.output.id)).toMatchObject({
      title: "Example scheduled hook",
      status: "scheduled",
      plannedAt: Date.UTC(2026, 9, 21, 9),
      account: "page",
      pillar: "billing",
      byClient: MAC_CLIENT,
    });
    const read = (await call(t, token, "linkedin_posts", { status: "scheduled" })).output.rows as Row[];
    expect(read[0]).toMatchObject({ addedBy: MAC_CLIENT, plannedAt: "2026-10-21T09:00:00.000Z" });
  });

  test("changes only what it is given, keeps who wrote it, and null clears", async () => {
    const { t, owner, token, id } = await world();
    const reply = await call(t, token, "linkedin_post_upsert", { id, pillar: null, title: "Example renamed" });
    expect(reply.output).toMatchObject({ created: false, id });
    const row = (await owner.query(api.linkedin.list, { company: "us" })).posts[0]!;
    expect(row).toMatchObject({
      title: "Example renamed",
      pillar: null,
      status: "published",
      link: "https://www.linkedin.com/posts/made-up",
      byClient: null,
    });
  });

  test("moves an idea through to published with a link", async () => {
    const { t, token } = await world();
    const made = await call(t, token, "linkedin_post_upsert", { company: "kz", title: "Example flow" });
    const id = made.output.id as string;
    expect((await call(t, token, "linkedin_post_upsert", { id, status: "published" })).said).toBe(LINKEDIN_WORDS.needsPublished);
    const done = await call(t, token, "linkedin_post_upsert", {
      id,
      status: "published",
      publishedAt: "2026-10-13T10:00:00+05:00",
      link: "https://lnkd.in/made-up",
    });
    expect(done.isError).toBe(false);
    const row = (await call(t, token, "linkedin_posts", { company: "kz", status: "published" })).output.rows[0];
    expect(row).toMatchObject({ publishedAt: "2026-10-13T05:00:00.000Z", link: "https://lnkd.in/made-up" });
  });

  test("is held to the page's rules and rejects stray fields", async () => {
    const { t, token } = await world();
    const ok = { company: "us", title: "Example" };
    const said = async (over: Record<string, unknown>) => (await call(t, token, "linkedin_post_upsert", { ...ok, ...over })).said;
    expect(await said({ status: "scheduled" })).toBe(LINKEDIN_WORDS.needsPlanned);
    expect(await said({ account: "person" })).toBe(LINKEDIN_WORDS.needsPerson);
    expect(await said({ status: "published", publishedAt: "2026-10-13T10:00:00Z", link: "https://evil.test/x" })).toBe(
      LINKEDIN_WORDS.badLink,
    );
    expect(await said({ status: "draft", link: "https://lnkd.in/x" })).toBe(LINKEDIN_WORDS.publishedOnly);
    expect(await said({ ownerEmail: "nobody@example.test" })).toBeTruthy();
    expect(await said({ title: "x".repeat(201) })).toMatch(/too long/);
    expect(await said({ body: "x".repeat(3_001) })).toMatch(/too long/);
    expect(await said({ plannedAt: "next week" })).toMatch(/not valid/);
    expect(await said({ status: "posted" })).toMatch(/not valid/);
    expect(await said({ views: 3 })).toMatch(/does not take/);
    expect((await call(t, token, "linkedin_post_upsert", { title: "No company" })).isError).toBe(true);
    expect((await call(t, token, "linkedin_post_upsert", { company: "us" })).said).toBe(LINKEDIN_WORDS.needsTitle);
    expect((await call(t, token, "linkedin_post_upsert", { id: "not-an-id", title: "x" })).said).toBe(LINKEDIN_WORDS.postGone);
  });
});

describe("linkedin_stats_add", () => {
  test("keeps a day's figures, dated today by default, and a second call that day fills in", async () => {
    const { t, owner, token, id } = await world();
    const first = await call(t, token, "linkedin_stats_add", { postId: id, impressions: 1200, clicks: 15 });
    expect(first.output).toMatchObject({ replaced: false });
    const second = await call(t, token, "linkedin_stats_add", { postId: id, followersGained: 3 });
    expect(second.output).toMatchObject({ replaced: true });
    const snapshots = (await owner.query(api.linkedin.list, { company: "us" })).posts[0]!.snapshots;
    expect(snapshots.map((s) => s.day)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(snapshots[2]).toMatchObject({ impressions: 1200, clicks: 15, followersGained: 3, reactions: null, byClient: MAC_CLIENT });
    const added = await call(t, token, "linkedin_stats_add", { postId: id, day: "2026-10-15", impressions: 1300 });
    expect(added.isError).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(added.output.id));
    expect(row).toMatchObject({ day: "2026-10-15", origin: { source: "agent", client: MAC_CLIENT } });
  });

  test("is refused for a post not out, a bad day, no figure or a figure out of range, and writes nothing", async () => {
    const { t, owner, token, id } = await world();
    const idea = (await call(t, token, "linkedin_post_upsert", { company: "us", title: "Example idea" })).output.id as string;
    expect((await call(t, token, "linkedin_stats_add", { postId: idea, impressions: 1 })).said).toBe(
      LINKEDIN_WORDS.statsForPublished,
    );
    expect((await call(t, token, "linkedin_stats_add", { postId: id, day: "2026-12-01", impressions: 1 })).said).toBe(
      LINKEDIN_WORDS.statsInFuture,
    );
    expect((await call(t, token, "linkedin_stats_add", { postId: id, day: "2026-10-01", impressions: 1 })).said).toBe(
      LINKEDIN_WORDS.statsBeforePublished,
    );
    expect((await call(t, token, "linkedin_stats_add", { postId: id })).said).toBe(LINKEDIN_WORDS.noFigures);
    for (const bad of [-1, 1.5, 2e9]) {
      expect((await call(t, token, "linkedin_stats_add", { postId: id, impressions: bad })).isError).toBe(true);
    }
    expect((await call(t, token, "linkedin_stats_add", { postId: id, views: 5 })).isError).toBe(true);
    const posts = (await owner.query(api.linkedin.list, { company: "us" })).posts;
    expect(posts.find((post) => post.id === id)!.snapshots).toHaveLength(2);
  });
});

describe("the LinkedIn tools and the token's scope", () => {
  test("a read-only token reads, is refused both writes, and they leave nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const { token } = await ownerWithToken(t, "read");
    expect((await call(t, token, "linkedin_posts", {})).isError).toBe(false);
    expect((await call(t, token, "linkedin_post_upsert", { company: "us", title: "x" })).isError).toBe(true);
    expect((await call(t, token, "linkedin_stats_add", { postId: "x", impressions: 1 })).isError).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("linkedinPosts").collect())).toEqual([]);
  });

  test("the audit holds the tool's name and outcome, never a hook, a draft or a figure", async () => {
    const { t, token } = await world();
    await call(t, token, "linkedin_post_upsert", { company: "us", title: "SECRET-HOOK-TEXT", body: "SECRET-DRAFT-TEXT" });
    const rows = await calls(t);
    expect(rows.some((row) => row.tool === "linkedin_post_upsert" && row.outcome === "ok")).toBe(true);
    const raw = JSON.stringify(await t.run((ctx) => ctx.db.query("agentCalls").collect()));
    expect(raw).not.toMatch(/SECRET-/);
  });
});
