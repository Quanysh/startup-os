import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { LINKEDIN_WORDS } from "./lib/linkedin";
import { MEMORY_WORDS } from "./lib/memory";
import schema from "./schema";
import { OWNER, modules, signInAsEngineer, signInAsOwner, signInAsSales } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const PLANNED = Date.UTC(2026, 9, 21, 9);
const WENT_OUT = Date.UTC(2026, 9, 14, 9);

/** What the form sends: every field. */
const form = (over: Record<string, unknown> = {}) => ({
  company: "us" as const,
  account: "page" as const,
  person: null,
  status: "idea" as const,
  title: "Why denials start at the front desk",
  body: null,
  pillar: null,
  owner: null,
  plannedAt: null,
  publishedAt: null,
  link: null,
  ...over,
});

describe("linkedin posts", () => {
  test("one is saved, cleaned, and listed for its company", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(
      api.linkedin.save,
      form({
        title: "  Why​ denials   start ",
        body: "Line one\n\n\n\nLine <b>two</b>",
        pillar: "Denials",
        status: "scheduled",
        plannedAt: PLANNED,
        owner: OWNER,
      }),
    );
    const { posts } = await owner.query(api.linkedin.list, { company: "us" });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      title: "Why denials start",
      body: "Line one\n\nLine <b>two</b>",
      pillar: "Denials",
      status: "scheduled",
      plannedAt: PLANNED,
      owner: { email: OWNER },
      byClient: null,
      snapshots: [],
    });
    expect((await owner.query(api.linkedin.list, { company: "kz" })).posts).toEqual([]);
  });

  test("a person's profile names the person, and the company page names nobody", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.linkedin.save, form({ account: "person" }))).rejects.toThrow(
      LINKEDIN_WORDS.needsPerson,
    );
    await expect(
      owner.mutation(api.linkedin.save, form({ account: "person", person: "ada@example.test" })),
    ).rejects.toThrow(LINKEDIN_WORDS.nameOnly);
    await expect(owner.mutation(api.linkedin.save, form({ person: "Ada Example" }))).rejects.toThrow(
      LINKEDIN_WORDS.pageHasNoPerson,
    );
    await owner.mutation(api.linkedin.save, form({ account: "person", person: " Ada  Example " }));
    const { posts } = await owner.query(api.linkedin.list, {});
    expect(posts[0]).toMatchObject({ account: "person", person: "Ada Example" });
  });

  test("a hook is needed and bounded, and a draft is bounded", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.linkedin.save, form({ title: "  " }))).rejects.toThrow(LINKEDIN_WORDS.needsTitle);
    await expect(owner.mutation(api.linkedin.save, form({ title: "x".repeat(201) }))).rejects.toThrow("too long");
    await expect(owner.mutation(api.linkedin.save, form({ body: "x".repeat(3_001) }))).rejects.toThrow("too long");
  });

  test("scheduled needs a time, published needs a time it went out, and only a published post has a link", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.linkedin.save, form({ status: "scheduled" }))).rejects.toThrow(
      LINKEDIN_WORDS.needsPlanned,
    );
    await expect(owner.mutation(api.linkedin.save, form({ status: "published" }))).rejects.toThrow(
      LINKEDIN_WORDS.needsPublished,
    );
    await expect(
      owner.mutation(api.linkedin.save, form({ status: "draft", link: "https://www.linkedin.com/posts/made-up" })),
    ).rejects.toThrow(LINKEDIN_WORDS.publishedOnly);
    await expect(
      owner.mutation(api.linkedin.save, form({ status: "published", publishedAt: WENT_OUT, link: "https://evil.test/x" })),
    ).rejects.toThrow(LINKEDIN_WORDS.badLink);
    await expect(
      owner.mutation(api.linkedin.save, form({ status: "scheduled", plannedAt: Number.NaN })),
    ).rejects.toThrow();
    await owner.mutation(
      api.linkedin.save,
      form({ status: "published", publishedAt: WENT_OUT, link: "https://www.linkedin.com/posts/made-up#c" }),
    );
    const { posts } = await owner.query(api.linkedin.list, {});
    expect(posts[0]).toMatchObject({ link: "https://www.linkedin.com/posts/made-up", publishedAt: WENT_OUT });
  });

  test("its owner must be someone a task of that company could be given to", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await expect(owner.mutation(api.linkedin.save, form({ owner: "stranger@example.test" }))).rejects.toThrow(
      MEMORY_WORDS.cannotOwn,
    );
  });

  test("a change keeps who made it, and leaving published drops the time and the link", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(
      api.linkedin.save,
      form({ status: "published", publishedAt: WENT_OUT, link: "https://lnkd.in/made-up" }),
    );
    await owner.mutation(api.linkedin.save, { id, ...form({ status: "dropped" }) });
    const row = (await owner.query(api.linkedin.list, {})).posts[0]!;
    expect(row).toMatchObject({ status: "dropped", publishedAt: null, link: null });
    await expect(
      owner.mutation(api.linkedin.save, { id, ...form({ company: "kz" }) }),
    ).rejects.toThrow(LINKEDIN_WORDS.postElsewhere);
  });

  test("a company's posts are its people's: the other company cannot read, change, list or delete them", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.linkedin.save, form());
    const kzOnly = await signInAsSales(t, ["kz"]);
    expect((await kzOnly.query(api.linkedin.list, {})).posts).toEqual([]);
    await expect(kzOnly.query(api.linkedin.list, { company: "us" })).rejects.toThrow("not_allowed");
    await expect(kzOnly.mutation(api.linkedin.save, { id, ...form({ title: "Mine now" }) })).rejects.toThrow("not_allowed");
    await expect(kzOnly.mutation(api.linkedin.save, form({ company: "us" }))).rejects.toThrow("not_allowed");
    await expect(kzOnly.mutation(api.linkedin.remove, { id })).rejects.toThrow("not_allowed");
    expect((await owner.query(api.linkedin.list, {})).posts).toHaveLength(1);
  });

  test("a page without the go-to-market area cannot read or write", async () => {
    const t = convexTest(schema, modules);
    const engineer = await signInAsEngineer(t);
    await expect(engineer.query(api.linkedin.list, {})).rejects.toThrow("not_allowed");
    await expect(engineer.mutation(api.linkedin.save, form())).rejects.toThrow("not_allowed");
  });

  test("a post is deleted with its figures, and twice is no error", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const id = await owner.mutation(api.linkedin.save, form({ status: "published", publishedAt: WENT_OUT }));
    await owner.mutation(api.linkedin.addSnapshot, { postId: id, day: "2026-10-15", impressions: 10 });
    await owner.mutation(api.linkedin.remove, { id });
    await owner.mutation(api.linkedin.remove, { id });
    expect((await owner.query(api.linkedin.list, {})).posts).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("linkedinStats").collect())).toEqual([]);
  });
});

describe("linkedin figures", () => {
  const published = async (t: ReturnType<typeof convexTest>, owner: Awaited<ReturnType<typeof signInAsOwner>>) =>
    owner.mutation(api.linkedin.save, form({ status: "published", publishedAt: WENT_OUT }));

  test("are kept by day, oldest first, with a missing figure unknown rather than zero", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const postId = await published(t, owner);
    await owner.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-16", impressions: 900, reactions: 30 });
    await owner.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-15", impressions: 400 });
    const snapshots = (await owner.query(api.linkedin.list, {})).posts[0]!.snapshots;
    expect(snapshots.map((s) => s.day)).toEqual(["2026-10-15", "2026-10-16"]);
    expect(snapshots[1]).toMatchObject({ impressions: 900, reactions: 30, comments: null, clicks: null });
  });

  test("a second set for the same day fills in what it gives and keeps the rest", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const postId = await published(t, owner);
    await owner.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-15", impressions: 400, clicks: 5 });
    await owner.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-15", impressions: 450, comments: 2 });
    const snapshots = (await owner.query(api.linkedin.list, {})).posts[0]!.snapshots;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ impressions: 450, clicks: 5, comments: 2 });
  });

  test("are refused for a post not out, a wrong day, no figure or a figure out of range", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const idea = await owner.mutation(api.linkedin.save, form());
    await expect(owner.mutation(api.linkedin.addSnapshot, { postId: idea, day: "2026-10-15", impressions: 1 })).rejects.toThrow(
      LINKEDIN_WORDS.statsForPublished,
    );
    const postId = await published(t, owner);
    const at = (over: Record<string, unknown>) =>
      owner.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-15", impressions: 1, ...over });
    await expect(at({ day: "15 Oct" })).rejects.toThrow(LINKEDIN_WORDS.notADate);
    await expect(at({ day: "2026-10-01" })).rejects.toThrow(LINKEDIN_WORDS.statsBeforePublished);
    await expect(at({ day: "2999-01-01" })).rejects.toThrow(LINKEDIN_WORDS.statsInFuture);
    await expect(at({ impressions: -1 })).rejects.toThrow(LINKEDIN_WORDS.figureRange);
    await expect(at({ impressions: 1.5 })).rejects.toThrow(LINKEDIN_WORDS.figureRange);
    await expect(at({ impressions: 2e9 })).rejects.toThrow(LINKEDIN_WORDS.figureRange);
    await expect(
      owner.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-15" }),
    ).rejects.toThrow(LINKEDIN_WORDS.noFigures);
  });

  test("the other company cannot add or remove them", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    const postId = await published(t, owner);
    await owner.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-15", impressions: 5 });
    const snapshotId = (await owner.query(api.linkedin.list, {})).posts[0]!.snapshots[0]!.id;
    const kzOnly = await signInAsSales(t, ["kz"]);
    await expect(
      kzOnly.mutation(api.linkedin.addSnapshot, { postId, day: "2026-10-15", impressions: 9 }),
    ).rejects.toThrow("not_allowed");
    await expect(kzOnly.mutation(api.linkedin.removeSnapshot, { id: snapshotId })).rejects.toThrow("not_allowed");
    await owner.mutation(api.linkedin.removeSnapshot, { id: snapshotId });
    await owner.mutation(api.linkedin.removeSnapshot, { id: snapshotId });
    expect((await owner.query(api.linkedin.list, {})).posts[0]!.snapshots).toEqual([]);
  });
});

describe("linkedin targets", () => {
  test("are set per company, listed with the posts, and cleared by 0", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    await owner.mutation(api.linkedin.setTarget, { company: "us", postsPerWeek: 3 });
    await owner.mutation(api.linkedin.setTarget, { company: "us", postsPerWeek: 2 });
    expect((await owner.query(api.linkedin.list, {})).targets).toMatchObject([{ company: "us", postsPerWeek: 2 }]);
    expect((await owner.query(api.linkedin.list, { company: "kz" })).targets).toEqual([]);
    await owner.mutation(api.linkedin.setTarget, { company: "us", postsPerWeek: 0 });
    expect((await owner.query(api.linkedin.list, {})).targets).toEqual([]);
  });

  test("are whole numbers a week, within reason, and only for a company the caller is on", async () => {
    const t = convexTest(schema, modules);
    const owner = await signInAsOwner(t);
    for (const bad of [-1, 1.5, 22]) {
      await expect(owner.mutation(api.linkedin.setTarget, { company: "us", postsPerWeek: bad })).rejects.toThrow(
        LINKEDIN_WORDS.badTarget,
      );
    }
    const kzOnly = await signInAsSales(t, ["kz"]);
    await expect(kzOnly.mutation(api.linkedin.setTarget, { company: "us", postsPerWeek: 2 })).rejects.toThrow("not_allowed");
  });
});
