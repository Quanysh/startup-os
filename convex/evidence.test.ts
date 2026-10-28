import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { OWNER, modules, signInAsOwner, signInWithAreas } from "./test.setup";

beforeEach(() => {
  vi.stubEnv("OWNER_EMAILS", OWNER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const start = async () => {
  const t = convexTest(schema, modules);
  const owner = await signInAsOwner(t);
  return { t, owner };
};
type Owner = Awaited<ReturnType<typeof start>>["owner"];

describe("questionnaires", () => {
  const add = (owner: Owner, extra: Record<string, unknown> = {}) =>
    owner.mutation(api.evidence.questionnaireUpsert, {
      requester: "Initech Health",
      company: "us",
      ...extra,
    } as never);
  const list = (owner: Owner) => owner.query(api.evidence.questionnaires, {});

  test("a new one is to do, cleaned, and says who wrote it", async () => {
    const { owner } = await start();
    await add(owner, { requester: "  Initech Health ", dueOn: "2026-11-01", link: "https://docs.example.com/q" });
    expect((await list(owner))[0]).toMatchObject({
      requester: "Initech Health",
      company: "us",
      status: "todo",
      dueOn: "2026-11-01",
      link: "https://docs.example.com/q",
      receivedOn: null,
      owner: null,
      changedBy: OWNER,
    });
  });

  test("a change keeps what is not sent; null clears", async () => {
    const { owner } = await start();
    const id = await add(owner, { notes: "first", owner: "Sam", dueOn: "2026-11-01" });
    await owner.mutation(api.evidence.questionnaireUpsert, { id, status: "sent", notes: null });
    expect((await list(owner))[0]).toMatchObject({ status: "sent", notes: null, owner: "Sam", dueOn: "2026-11-01" });
  });

  test.each([
    ["a document link that is not https", { link: "http://x.example.com" }, "A document link must be a full https:// address."],
    ["a javascript link", { link: "javascript:alert(1)" }, "A document link must be a full https:// address."],
    ["a date that is not one", { dueOn: "2026-13-45" }, "The due date is not a date."],
    ["no requester", { requester: "  " }, "A questionnaire needs a title."],
  ])("refuses %s", async (_name, extra, words) => {
    const { owner } = await start();
    await expect(add(owner, extra)).rejects.toThrow(words);
    expect(await list(owner)).toEqual([]);
  });

  test("a new one needs a requester and a company", async () => {
    const { owner } = await start();
    await expect(owner.mutation(api.evidence.questionnaireUpsert, { requester: "X" } as never)).rejects.toThrow(
      "A new record needs a requester and a company.",
    );
  });

  test("sorted by due date, undated last; removing twice is fine", async () => {
    const { owner } = await start();
    await add(owner, { requester: "Undated" });
    const late = await add(owner, { requester: "Late", dueOn: "2026-12-01" });
    await add(owner, { requester: "Soon", dueOn: "2026-11-01" });
    expect((await list(owner)).map((q) => q.requester)).toEqual(["Soon", "Late", "Undated"]);
    await owner.mutation(api.evidence.questionnaireRemove, { id: late });
    await owner.mutation(api.evidence.questionnaireRemove, { id: late });
    expect(await list(owner)).toHaveLength(2);
  });
});

describe("the answer bank", () => {
  const add = (owner: Owner, extra: Record<string, unknown> = {}) =>
    owner.mutation(api.evidence.answerUpsert, {
      question: "Do you encrypt data at rest?",
      answer: "Yes, AES-256.",
      ...extra,
    } as never);

  test("tags are lower-cased, deduplicated and bounded", async () => {
    const { owner } = await start();
    await add(owner, { tags: [" Encryption ", "encryption", "", "SOC2"], lastReviewedOn: "2026-10-01" });
    expect((await owner.query(api.evidence.answers, {}))[0]).toMatchObject({
      tags: ["encryption", "soc2"],
      lastReviewedOn: "2026-10-01",
      company: null,
    });
    await expect(add(owner, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).rejects.toThrow(
      "at most 10 tags",
    );
  });

  test("an empty answer is refused", async () => {
    const { owner } = await start();
    await expect(add(owner, { answer: "  " })).rejects.toThrow("An answer cannot be empty.");
  });

  test("an answer for one company is not sent to someone on the other", async () => {
    const { t, owner } = await start();
    await add(owner, { question: "Both", company: undefined });
    await add(owner, { question: "Startup only", company: "us" });
    const kz = await signInWithAreas(t, "cofounder", ["compliance"], ["kz"]);
    expect((await kz.query(api.evidence.answers, {})).map((a) => a.question)).toEqual(["Both"]);
    await expect(
      kz.mutation(api.evidence.answerUpsert, { question: "Q", answer: "A", company: "us" }),
    ).rejects.toThrow("not_allowed");
  });
});

describe("vendor agreements", () => {
  const add = (owner: Owner, extra: Record<string, unknown> = {}) =>
    owner.mutation(api.evidence.agreementUpsert, {
      vendor: "Initech Cloud",
      type: "baa",
      company: "us",
      ...extra,
    } as never);
  const list = (owner: Owner) => owner.query(api.evidence.agreements, {});

  test("a new one is a draft; expiry sorts soonest first", async () => {
    const { owner } = await start();
    await add(owner, { vendor: "B", expiresOn: "2027-03-01" });
    await add(owner, { vendor: "A", expiresOn: "2026-12-01", signedOn: "2025-12-01", status: "active" });
    const rows = await list(owner);
    expect(rows.map((r) => r.vendor)).toEqual(["A", "B"]);
    expect(rows[1]).toMatchObject({ status: "draft", type: "baa", link: null });
  });

  test("it cannot expire before it was signed, even by a later edit", async () => {
    const { owner } = await start();
    await expect(add(owner, { signedOn: "2026-05-01", expiresOn: "2026-04-01" })).rejects.toThrow(
      "cannot expire before it was signed",
    );
    const id = await add(owner, { signedOn: "2026-05-01" });
    await expect(
      owner.mutation(api.evidence.agreementUpsert, { id, expiresOn: "2026-01-01" }),
    ).rejects.toThrow("cannot expire before it was signed");
  });

  test("a company the caller is not on is refused, and not listed", async () => {
    const { t, owner } = await start();
    await add(owner, { company: "kz", vendor: "KZ vendor" });
    const us = await signInWithAreas(t, "cofounder", ["compliance"], ["us"]);
    expect(await us.query(api.evidence.agreements, {})).toEqual([]);
    await expect(
      us.mutation(api.evidence.agreementUpsert, { vendor: "X", type: "nda", company: "kz" }),
    ).rejects.toThrow("not_allowed");
  });
});

describe("controls and evidence", () => {
  const control = (owner: Owner, extra: Record<string, unknown> = {}) =>
    owner.mutation(api.evidence.controlUpsert, {
      framework: "soc2",
      controlId: "CC6.1",
      title: "Logical access",
      ...extra,
    } as never);

  test("a control is one per framework and id", async () => {
    const { owner } = await start();
    await control(owner);
    await expect(control(owner)).rejects.toThrow("already listed");
    await control(owner, { framework: "hipaa" });
    expect((await owner.query(api.evidence.controls, {})).map((c) => [c.framework, c.controlId])).toEqual([
      ["hipaa", "CC6.1"],
      ["soc2", "CC6.1"],
    ]);
  });

  test("controls sort by id with numbers as numbers (CC6.2 before CC6.10, CC6.9 before CC6.10)", async () => {
    const { owner } = await start();
    await control(owner, { controlId: "CC6.10" });
    await control(owner, { controlId: "CC6.2" });
    await control(owner, { controlId: "CC6.9" });
    expect((await owner.query(api.evidence.controls, {})).map((c) => c.controlId)).toEqual(["CC6.2", "CC6.9", "CC6.10"]);
  });

  test("an item: collected with a link, missing without; dates and links are checked", async () => {
    const { owner } = await start();
    const controlId = await control(owner);
    await owner.mutation(api.evidence.evidenceItemUpsert, {
      controlId,
      title: "Access review",
      link: "https://drive.example.com/x",
      collectedOn: "2026-09-01",
      validUntil: "2027-09-01",
    });
    await owner.mutation(api.evidence.evidenceItemUpsert, { controlId, title: "Policy" });
    const [row] = await owner.query(api.evidence.controls, {});
    expect(row!.items.map((i) => [i.title, i.status])).toEqual([
      ["Access review", "collected"],
      ["Policy", "missing"],
    ]);
    await expect(
      owner.mutation(api.evidence.evidenceItemUpsert, { controlId, title: "x", validUntil: "2026-01-01", collectedOn: "2026-02-01" }),
    ).rejects.toThrow("before it was collected");
    await expect(
      owner.mutation(api.evidence.evidenceItemUpsert, { controlId, title: "x", link: "ftp://x.example.com" }),
    ).rejects.toThrow("https");
  });

  test("an item cannot be moved to another control; removing a control removes its evidence", async () => {
    const { t, owner } = await start();
    const a = await control(owner);
    const b = await control(owner, { controlId: "CC1.1" });
    const item = await owner.mutation(api.evidence.evidenceItemUpsert, { controlId: a, title: "x" });
    await expect(
      owner.mutation(api.evidence.evidenceItemUpsert, { id: item, controlId: b }),
    ).rejects.toThrow("cannot be moved");
    await owner.mutation(api.evidence.controlRemove, { id: a });
    expect(await t.run((ctx) => ctx.db.query("evidenceItems").collect())).toEqual([]);
  });

  test("a framework is the Startup side's: someone on Globex alone cannot read or write it", async () => {
    const { t, owner } = await start();
    await control(owner);
    const kz = await signInWithAreas(t, "cofounder", ["compliance"], ["kz"]);
    expect(await kz.query(api.evidence.controls, {})).toEqual([]);
    await expect(
      kz.mutation(api.evidence.controlUpsert, { framework: "hipaa", controlId: "164.308", title: "x" }),
    ).rejects.toThrow("not_allowed");
  });
});

describe("access", () => {
  test("without the compliance area nothing is readable or writable", async () => {
    const { t } = await start();
    const other = await signInWithAreas(t, "sales", ["sales"]);
    await expect(other.query(api.evidence.agreements, {})).rejects.toThrow("not_allowed");
    await expect(
      other.mutation(api.evidence.questionnaireUpsert, { requester: "X", company: "us" }),
    ).rejects.toThrow("not_allowed");
  });
  test("someone who is not signed in is refused", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.evidence.questionnaires, {})).rejects.toThrow();
  });
});
