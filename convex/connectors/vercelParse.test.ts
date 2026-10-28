import { describe, expect, test } from "vitest";
import { validateSnapshots } from "../lib/snapshotRules";
import { closedWeeks } from "../lib/weeks";
import { ConnectorError } from "./errors";
import { DEPLOYMENTS, daysFrom, dep, pageviewsFor } from "./vercel.fixtures";
import { parseDeployments, parsePageviews, toSnapshots, weeklyDeploys } from "./vercelParse";

// A Wednesday: the week in progress began on Monday, October 12.
const NOW = Date.UTC(2026, 9, 14, 6, 20);
const WEEKS = closedWeeks(NOW, 8);
const listed = parseDeployments(DEPLOYMENTS).deployments;

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("parseDeployments", () => {
  test("keeps the four fields that are counted, and the next page's marker", () => {
    const parsed = parseDeployments(DEPLOYMENTS);
    expect(parsed.pagination.next).toBeNull();
    expect(parsed.deployments[1]).toEqual({
      uid: "d-c",
      created: Date.parse("2026-10-08T10:00:00Z"),
      readyState: "READY",
      target: "production",
    });
  });

  test("a response in another shape is refused, naming where", () => {
    const error = refusal(() =>
      parseDeployments({ deployments: [{ uid: "x" }], pagination: { next: null } }),
    );
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(
      "Vercel's deployments response is not in the expected shape (deployments.0.created).",
    );
  });
});

describe("weeklyDeploys", () => {
  test("production deployments by the week they were created: ready, and failed", () => {
    expect(weeklyDeploys(listed, WEEKS)).toEqual([
      { periodStart: "2026-09-14", ready: 1, failed: 0 },
      { periodStart: "2026-09-21", ready: 0, failed: 0 },
      { periodStart: "2026-09-28", ready: 1, failed: 0 },
      { periodStart: "2026-10-05", ready: 2, failed: 1 },
    ]);
  });

  test("the week in progress is never a row", () => {
    expect(weeklyDeploys(listed, WEEKS).map((w) => w.periodStart)).not.toContain("2026-10-12");
  });

  test("a preview deployment is not counted, and previews alone give nothing", () => {
    const previews = [dep("p1", "2026-10-06T10:00:00Z", "READY", null)].map(only);
    expect(weeklyDeploys(previews, WEEKS)).toEqual([]);
  });

  test("cancelled, queued, building and unknown states are in neither count", () => {
    const mixed = [
      dep("a", "2026-10-06T10:00:00Z"),
      dep("b", "2026-10-06T11:00:00Z", "CANCELED"),
      dep("c", "2026-10-06T12:00:00Z", "QUEUED"),
      dep("d", "2026-10-06T13:00:00Z", "BUILDING"),
      dep("e", "2026-10-06T14:00:00Z", "SOMETHING_NEW"),
    ].map(only);
    expect(weeklyDeploys(mixed, WEEKS)).toEqual([
      { periodStart: "2026-10-05", ready: 1, failed: 0 },
    ]);
  });

  test("a deployment listed twice, by overlapping pages, is counted once", () => {
    const twice = [dep("a", "2026-10-06T10:00:00Z"), dep("a", "2026-10-06T10:00:00Z")].map(only);
    expect(weeklyDeploys(twice, WEEKS)).toEqual([
      { periodStart: "2026-10-05", ready: 1, failed: 0 },
    ]);
  });

  test("a deployment from before the window shows the project existed, so the window starts as zeros", () => {
    const old = [dep("old", "2026-07-01T10:00:00Z"), dep("new", "2026-10-06T10:00:00Z")].map(only);
    const weeks = weeklyDeploys(old, WEEKS);
    expect(weeks).toHaveLength(8);
    expect(weeks[0]).toEqual({ periodStart: "2026-08-17", ready: 0, failed: 0 });
    expect(weeks.at(-1)).toEqual({ periodStart: "2026-10-05", ready: 1, failed: 0 });
  });

  test("no deployment at all gives no rows, rather than eight weeks of zeros", () => {
    expect(weeklyDeploys([], WEEKS)).toEqual([]);
  });

  test("deployments only in the week in progress give no rows", () => {
    expect(weeklyDeploys([dep("f", "2026-10-13T10:00:00Z")].map(only), WEEKS)).toEqual([]);
  });
});

/** A fixture deployment as the parser hands it on. */
function only(d: ReturnType<typeof dep>) {
  return { uid: d.uid, created: d.created, readyState: d.readyState, target: d.target };
}

describe("parsePageviews", () => {
  const week = "2026-10-05";
  const answer = (data: unknown[]) => ({ version: 1, query: {}, data });
  const day = (timestamp: string, pageviews: unknown) => ({ timestamp, pageviews, visitors: 1 });

  test("adds the week's seven days", () => {
    expect(parsePageviews(answer(daysFrom(week, [1, 2, 3, 4, 5, 6, 7])), week)).toBe(28);
  });

  test("the Monday after the week is asked for too, and is not added", () => {
    // The request runs through that Monday in case `until` leaves its day out.
    const url = new URL(`https://api.vercel.com/x?since=${week}`);
    expect(parsePageviews(pageviewsFor(url), week)).toBe(150);
  });

  test("an answer that stops before Sunday is not a week", () => {
    const error = refusal(() => parsePageviews(answer(daysFrom(week, [1, 2, 3, 4, 5, 6])), week));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe("Vercel's page views response does not cover the whole week.");
  });

  test("a day missing from the middle of the week is not a zero", () => {
    const days = daysFrom(week, [1, 2, 3, 4, 5, 6, 7]).filter((_, i) => i !== 3);
    expect(refusal(() => parsePageviews(answer(days), week)).message).toBe(
      "Vercel's page views response does not cover the whole week.",
    );
  });

  test("only the Monday after the week is no figure, not zero page views", () => {
    expect(parsePageviews(answer([day("2026-10-12T00:00:00.000Z", 9)]), week)).toBeNull();
  });

  test("no rows is no figure, not zero page views", () => {
    expect(parsePageviews(answer([]), week)).toBeNull();
  });

  test.each([
    ["a day before the week", "2026-10-04T00:00:00.000Z"],
    ["a day after the Monday that follows it", "2026-10-13T00:00:00.000Z"],
    ["something that is not a date", "last tuesday"],
  ])("%s is refused", (_name, timestamp) => {
    const error = refusal(() => parsePageviews(answer([day(timestamp, 5)]), week));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error.message).toBe(
      "Vercel's page views response has a day outside the week asked for.",
    );
  });

  test("a day listed twice is refused rather than added twice", () => {
    const monday = day("2026-10-05T00:00:00.000Z", 5);
    expect(refusal(() => parsePageviews(answer([monday, monday]), week)).message).toBe(
      "Vercel's page views response lists a day twice.",
    );
  });

  test("a count that is not a whole number is refused", () => {
    const sent = answer([day("2026-10-05T00:00:00.000Z", 1.5)]);
    expect(refusal(() => parsePageviews(sent, week)).message).toBe(
      "Vercel's page views response has a count that is not a whole number.",
    );
  });

  test("a response in another shape is refused, naming where", () => {
    expect(refusal(() => parsePageviews({ rows: [] }, week)).message).toBe(
      "Vercel's page views response is not in the expected shape (data).",
    );
  });
});

describe("toSnapshots", () => {
  test("two figures per deploy week, and a page-view figure only where one was read", () => {
    const rows = toSnapshots({
      deploys: weeklyDeploys(listed, WEEKS),
      pageviews: new Map([["2026-10-05", 150]]),
    });
    expect(rows.map((r) => `${r.key} ${r.periodStart} ${r.value}`).sort()).toEqual([
      "deploys 2026-09-14 1",
      "deploys 2026-09-21 0",
      "deploys 2026-09-28 1",
      "deploys 2026-10-05 2",
      "deploys_failed 2026-09-14 0",
      "deploys_failed 2026-09-21 0",
      "deploys_failed 2026-09-28 0",
      "deploys_failed 2026-10-05 1",
      "site_pageviews 2026-10-05 150",
    ]);
    expect(new Set(rows.map((r) => `${r.scope} ${r.period}`))).toEqual(
      new Set(["startup_insights week"]),
    );
    expect(validateSnapshots("vercel", rows, undefined, { now: NOW })).toEqual([]);
  });
});
