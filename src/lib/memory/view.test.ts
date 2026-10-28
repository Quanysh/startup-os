import { describe, expect, test } from "vitest";
import { dueForRevisit, filterDecisions, readView, writeView, type DecisionRow } from "./view";

const row = (over: Partial<Omit<DecisionRow, "id">> & { id?: string }): DecisionRow =>
  ({
    id: "d",
    company: "us",
    title: "Price per seat",
    decision: "We charge per seat.",
    context: null,
    owner: null,
    decidedOn: "2026-10-01",
    status: "decided",
    revisitOn: null,
    tags: [],
    ...over,
  }) as DecisionRow;

describe("the view in the address", () => {
  test("is read back as it was written, and anything unknown is dropped", () => {
    const view = { tab: "notes" as const, status: "revisit" as const, owner: "a@example.test", tag: "pricing", q: "seat", from: "2026-09-01" };
    expect(readView(new URLSearchParams(writeView(view)))).toEqual(view);
    expect(readView(new URLSearchParams("tab=x&status=nope&from=yesterday"))).toEqual({
      tab: "decisions",
      status: null,
      owner: null,
      tag: null,
      q: "",
      from: null,
    });
  });
});

describe("the decisions shown", () => {
  const rows = [
    row({ id: "a", title: "Price per seat", tags: ["pricing"], owner: { email: "a@example.test", name: "Ada" } }),
    row({ id: "b", title: "Hire in Q1", status: "proposed", decidedOn: "2026-08-01", context: "Seat budget" }),
  ];
  const view = readView(new URLSearchParams());

  test("narrow by status, owner, tag, date and words in the title, decision or context", () => {
    expect(filterDecisions(rows, { ...view, status: "proposed" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterDecisions(rows, { ...view, owner: "a@example.test" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterDecisions(rows, { ...view, tag: "pricing" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterDecisions(rows, { ...view, from: "2026-09-01" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterDecisions(rows, { ...view, q: "SEAT" }).map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("due for a revisit: the date has come and it was not reversed", () => {
    const due = dueForRevisit(
      [
        row({ id: "a", revisitOn: "2026-10-14" }),
        row({ id: "b", revisitOn: "2026-10-15" }),
        row({ id: "c", revisitOn: "2026-10-01", status: "reversed" }),
      ],
      "2026-10-14",
    );
    expect(due.map((r) => r.id)).toEqual(["a"]);
  });
});
