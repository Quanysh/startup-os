import { describe, expect, test } from "vitest";
import { SOURCES } from "../connectors/manifest";
import {
  FAILURE_SENTENCES,
  cadenceOf,
  cadenceWords,
  expectedMs,
  failureKeyOf,
  type Cadence,
} from "./cadence";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("a source's cadence", () => {
  test("every source in the manifest has one", () => {
    for (const source of SOURCES) expect([source.id, cadenceOf(source.id)]).toEqual([source.id, source.cadence]);
  });

  test("only typed-in figures have no expected interval", () => {
    for (const source of SOURCES) {
      expect([source.id, expectedMs(source.cadence) === null]).toEqual([
        source.id,
        source.kind === "manual",
      ]);
    }
  });

  test("the four work tools say how a teammate's own push is expected too", () => {
    const tools = SOURCES.filter((s) => s.personal !== undefined).map((s) => s.id);
    expect(tools.sort()).toEqual(["fireflies", "gmail", "google_calendar", "linear"]);
  });

  test("the pulled sources keep the times crons.ts runs them at", () => {
    // convex/crons.ts: mercury 06:00, posthog 06:10, vercel and apollo 06:20,
    // posthog_globex and vertical 06:30, search console 12:00 UTC; gmail, calendar
    // and linear every 15 minutes, fireflies hourly.
    expect(cadenceOf("mercury")).toEqual({ kind: "daily", hourUtc: 6, minuteUtc: 0 });
    expect(cadenceOf("posthog")).toEqual({ kind: "daily", hourUtc: 6, minuteUtc: 10 });
    expect(cadenceOf("vercel")).toEqual({ kind: "daily", hourUtc: 6, minuteUtc: 20 });
    expect(cadenceOf("apollo")).toEqual({ kind: "daily", hourUtc: 6, minuteUtc: 20 });
    expect(cadenceOf("posthog_globex")).toEqual({ kind: "daily", hourUtc: 6, minuteUtc: 30 });
    expect(cadenceOf("vertical_startup")).toEqual({ kind: "daily", hourUtc: 6, minuteUtc: 30 });
    expect(cadenceOf("search_console")).toEqual({ kind: "daily", hourUtc: 12, minuteUtc: 0 });
    expect(cadenceOf("linear")).toEqual({ kind: "every", minutes: 15 });
    expect(cadenceOf("fireflies")).toEqual({ kind: "every", minutes: 60 });
  });

  test("an unknown source has none", () => {
    expect(cadenceOf("nothing")).toBeNull();
  });
});

describe("how long a source has before it is late", () => {
  test("a daily read: a day, and an hour for a run that finishes late", () => {
    expect(expectedMs({ kind: "daily", hourUtc: 6, minuteUtc: 0 })).toBe(DAY + HOUR);
  });
  test("an interval: the interval and five minutes", () => {
    expect(expectedMs({ kind: "every", minutes: 15 })).toBe(20 * MINUTE);
  });
  test("a push: its days, and six hours for a run that comes late", () => {
    expect(expectedMs({ kind: "pushed", everyDays: 1 })).toBe(DAY + 6 * HOUR);
    expect(expectedMs({ kind: "pushed", everyDays: 31 })).toBe(31 * DAY + 6 * HOUR);
  });
  test("typed in: no interval at all", () => {
    expect(expectedMs({ kind: "typed" })).toBeNull();
  });
});

describe("the words for a cadence", () => {
  const daily: Cadence = { kind: "daily", hourUtc: 6, minuteUtc: 0 };
  test("a daily read is said in the viewer's time zone", () => {
    expect(cadenceWords(daily, "Asia/Almaty")).toBe("Read daily at about 11:00");
    expect(cadenceWords(daily, "UTC")).toBe("Read daily at about 06:00");
  });
  test("an interval", () => {
    expect(cadenceWords({ kind: "every", minutes: 15 })).toBe("Read every 15 minutes");
    expect(cadenceWords({ kind: "every", minutes: 60 })).toBe("Read every hour");
  });
  test("a push", () => {
    expect(cadenceWords({ kind: "pushed", everyDays: 1 })).toBe("Pushed, expected daily");
    expect(cadenceWords({ kind: "pushed", everyDays: 14 })).toBe("Pushed, expected every 14 days");
    expect(cadenceWords({ kind: "pushed", everyDays: 31 })).toBe("Pushed, expected monthly");
  });
  test("typed in", () => {
    expect(cadenceWords({ kind: "typed" })).toBe("Typed in when it changes");
  });
});

describe("a failure is a key, never what was stored", () => {
  test("a failed or empty run has a key; anything else has none", () => {
    expect(failureKeyOf("error")).toBe("failed");
    expect(failureKeyOf("empty")).toBe("empty");
    expect(failureKeyOf("ok")).toBeNull();
    expect(failureKeyOf("not_configured")).toBeNull();
    expect(failureKeyOf(null)).toBeNull();
  });
  test("each key has one fixed sentence", () => {
    expect(Object.keys(FAILURE_SENTENCES).sort()).toEqual(["empty", "failed"]);
    for (const sentence of Object.values(FAILURE_SENTENCES)) expect(sentence).toMatch(/^[A-Z].*\.$/);
  });
});
