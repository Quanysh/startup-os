import { describe, expect, test } from "vitest";
import { complianceAttention } from "./attention";
import { obligation } from "./fixtures";

const TODAY = "2026-10-12";
const NOW = Date.UTC(2026, 9, 12, 12);
const confirmed = (due: string, title: string) => obligation({ due, dueConfirmed: true, title });

describe("complianceAttention", () => {
  test("nothing for undated, far-off, finished or skipped items", () => {
    expect(
      complianceAttention(
        [
          obligation(),
          confirmed("2027-06-01", "Far"),
          obligation({ due: "2026-01-01", dueConfirmed: true, status: "done" }),
          obligation({ due: "2026-01-01", dueConfirmed: true, status: "not_applicable" }),
        ],
        TODAY,
        NOW,
      ),
    ).toEqual([]);
  });

  // Titles are free text and could name a clinic ("Renew SECRET CLINIC's
  // contract"), so the home page counts obligations and never titles them.
  test("one overdue item is counted, with its date and not its title", () => {
    expect(complianceAttention([confirmed("2026-10-09", "SECRET tax")], TODAY, NOW)).toEqual([
      {
        id: "obligations:overdue",
        severity: "overdue",
        title: "1 obligation overdue",
        detail: "It was due Oct 9.",
        href: "/compliance",
      },
    ]);
  });

  test("several overdue items are counted, with the oldest date", () => {
    const [item] = complianceAttention(
      [
        confirmed("2026-10-09", "SECRET B"),
        confirmed("2026-09-01", "SECRET A"),
        confirmed("2026-10-01", "SECRET C"),
      ],
      TODAY,
      NOW,
    );
    expect(item).toEqual({
      id: "obligations:overdue",
      severity: "overdue",
      title: "3 obligations overdue",
      detail: "The oldest was due Sep 1.",
      href: "/compliance",
    });
  });

  test("due within 30 days: counted, with the next date", () => {
    expect(complianceAttention([confirmed("2026-10-20", "SECRET test")], TODAY, NOW)).toEqual([
      {
        id: "obligations:due",
        severity: "due",
        title: "1 obligation due in the next 30 days",
        detail: "It is due Oct 20.",
        href: "/compliance",
      },
    ]);
    const [item] = complianceAttention(
      [confirmed("2026-11-01", "SECRET B"), confirmed("2026-10-20", "SECRET A")],
      TODAY,
      NOW,
    );
    expect(item).toMatchObject({
      title: "2 obligations due in the next 30 days",
      detail: "The next is due Oct 20.",
    });
  });

  test("no title ever reaches the list, whatever is overdue, due or unconfirmed", () => {
    const items = complianceAttention(
      [
        confirmed("2026-09-01", "Renew SECRET CLINIC ALPHA's contract"),
        confirmed("2026-10-20", "SECRET CLINIC BETA: BAA"),
        confirmed("2026-10-25", "SECRET CLINIC GAMMA: renewal"),
        obligation({ due: "2026-01-01", title: "SECRET CLINIC DELTA: a guess" }),
      ],
      TODAY,
      NOW,
    );
    expect(items.map((i) => i.id)).toEqual([
      "obligations:overdue",
      "obligations:due",
      "obligations:unconfirmed",
    ]);
    expect(JSON.stringify(items)).not.toContain("SECRET");
    expect(JSON.stringify(items)).not.toMatch(/contract|renewal|BAA/i);
  });

  test("an unconfirmed date is asked about, never reported as due or overdue", () => {
    expect(complianceAttention([obligation({ due: "2026-01-01" })], TODAY, NOW)).toEqual([
      {
        id: "obligations:unconfirmed",
        severity: "empty",
        title: "1 obligation has a date to confirm",
        detail: "An unconfirmed date is not counted as due.",
        href: "/compliance",
      },
    ]);
  });
});
