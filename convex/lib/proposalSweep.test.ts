import { describe, expect, test } from "vitest";
import { planSweep, sweepSeesAll, sweepSubject, type SweepRow } from "./proposalSweep";

// The sweep's plan is pure: which open proposals an older duplicate or a
// newer one on the same subject makes unnecessary. Made-up titles only.

const row = (over: Partial<SweepRow> & Pick<SweepRow, "id" | "dedupeKey" | "createdAt">): SweepRow => ({
  company: "us",
  kind: "task_create",
  payload: { title: "Made-up pricing page" },
  ...over,
});

describe("sweepSubject", () => {
  test("a title, an id, or nothing when only the dedupeKey can match", () => {
    expect(sweepSubject("memory_note", { title: "  Made-up   Pricing " })).toBe("made-up pricing");
    expect(sweepSubject("task_create", { title: "" })).toBeNull();
    expect(sweepSubject("task_archive", { taskId: "task_1" })).toBe("task_1");
    expect(sweepSubject("task_change", { taskId: "task_1" })).toBe("task_1");
    expect(sweepSubject("comment", { subjectKind: "Deal", subjectId: "deal_1" })).toBe("deal:deal_1");
    expect(sweepSubject("comment", { subjectKind: "task" })).toBeNull();
    expect(sweepSubject("goal_create", { quarter: "2026 Q4", title: "Made-up runway" })).toBe("2026 q4:made-up runway");
    expect(sweepSubject("goal_create", { title: "Made-up runway" })).toBeNull();
    expect(sweepSubject("handoff_reassign", { handoffId: "hand_1" })).toBe("hand_1");
    expect(sweepSubject("deal_create", { name: "Made-up Clinic" })).toBe("made-up clinic");
    expect(sweepSubject("bot_permission", { bot: "growth", area: "board" })).toBeNull();
  });
});

describe("planSweep", () => {
  test("the same dedupeKey keeps the newest and withdraws the older as a duplicate", () => {
    const plan = planSweep([
      row({ id: "old", dedupeKey: "growth:task_create:one", createdAt: 1 }),
      row({ id: "new", dedupeKey: "growth:task_create:one", createdAt: 2, payload: { title: "Made-up other words" } }),
    ]);
    expect(plan).toEqual({ actions: [{ id: "old", keptId: "new", reason: "duplicate" }], more: false });
  });

  test("the same subject keeps the newest and withdraws the older as superseded, and a duplicate wins when both match", () => {
    const same = [
      row({ id: "old", dedupeKey: "growth:task_create:a", createdAt: 1, payload: { title: "Made-up pricing page" } }),
      row({ id: "new", dedupeKey: "growth:task_create:b", createdAt: 2, payload: { title: "Made-up pricing page" } }),
    ];
    expect(planSweep(same).actions).toEqual([{ id: "old", keptId: "new", reason: "superseded" }]);

    // Same key and same subject: one withdrawal, and it is the duplicate.
    const both = planSweep([
      row({ id: "old", dedupeKey: "growth:task_create:one", createdAt: 1 }),
      row({ id: "new", dedupeKey: "growth:task_create:one", createdAt: 2 }),
    ]);
    expect(both.actions).toEqual([{ id: "old", keptId: "new", reason: "duplicate" }]);
  });

  test("a task change does not supersede an archive, and another company does not", () => {
    const plan = planSweep([
      row({ id: "change", kind: "task_change", dedupeKey: "growth:task_change:t", createdAt: 1, payload: { taskId: "task_1" } }),
      row({ id: "archive", kind: "task_archive", dedupeKey: "growth:task_archive:t", createdAt: 2, payload: { taskId: "task_1" } }),
      row({ id: "kz", company: "kz", dedupeKey: "growth:task_create:kz", createdAt: 3, payload: { title: "Made-up pricing page" } }),
      row({ id: "us", dedupeKey: "growth:task_create:us", createdAt: 4, payload: { title: "Made-up pricing page" } }),
    ]);
    expect(plan.actions).toEqual([]);
  });

  test("a tie on time keeps the later id, and a full cap sets more", () => {
    const tied = planSweep([
      row({ id: "a", dedupeKey: "growth:task_create:one", createdAt: 1 }),
      row({ id: "b", dedupeKey: "growth:task_create:one", createdAt: 1 }),
    ]);
    expect(tied.actions).toEqual([{ id: "a", keptId: "b", reason: "duplicate" }]);

    const many = planSweep(
      [1, 2, 3].map((createdAt) => row({ id: `p${createdAt}`, dedupeKey: "growth:task_create:one", createdAt })),
      1,
    );
    expect(many.actions).toHaveLength(1);
    expect(many.more).toBe(true);
    expect(many.actions[0]).toMatchObject({ keptId: "p3", reason: "duplicate" });
  });
});

describe("who sweeps every proposer", () => {
  test("the chief of staff, on the Mac or as the external bot", () => {
    expect(sweepSeesAll({ agent: "chief_of_staff" })).toBe(true);
    expect(sweepSeesAll({ bot: "chief_of_staff" })).toBe(true);
    expect(sweepSeesAll({ bot: "chief_of_staff", agent: "finance" })).toBe(true);
    expect(sweepSeesAll({ agent: "finance" })).toBe(false);
    expect(sweepSeesAll({ bot: "growth" })).toBe(false);
    expect(sweepSeesAll({})).toBe(false);
  });
});
