import { describe, expect, test } from "vitest";
import {
  EMPTY_STEPS,
  LEGACY_SENTENCE,
  changeWords,
  connectionReading,
  costNote,
  costWords,
  ms,
  notConnectedWords,
  percent,
  providerGroups,
  providerReading,
  usd,
} from "./view";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 60 * 60 * 1000;

describe("figures", () => {
  test("money, time and shares", () => {
    expect(usd(0.12)).toBe("$0.12");
    expect(usd(12.345)).toBe("$12.35");
    expect(usd(1234.5)).toBe("$1,235");
    expect(ms(820)).toBe("820 ms");
    expect(ms(9800)).toBe("9.8 s");
    expect(percent(0)).toBe("0%");
    expect(percent(0.0004)).toBe("<0.1%");
    expect(percent(1 / 12)).toBe("8.3%");
  });

  test("a cost that is not known says why, never $0.00", () => {
    expect(costWords({ usd: 0, why: null })).toBe("$0.00");
    expect(costWords({ usd: null, why: "unpriced" })).toBe("Not priced");
    expect(costWords({ usd: null, why: "nothing_reported" })).toBe("None reported");
    expect(costNote({ usd: 1, why: null })).toBeNull();
  });
});

describe("a provider's state", () => {
  test("in the page header's own states", () => {
    expect(providerReading(null, NOW)).toEqual({ state: "never", words: "Not connected" });
    expect(providerReading({ state: "down", checkedAt: NOW }, NOW)).toEqual({ state: "failed", words: "Down" });
    expect(providerReading({ state: "degraded", checkedAt: NOW }, NOW)).toEqual({ state: "late", words: "Degraded" });
    expect(providerReading({ state: "up", checkedAt: NOW - HOUR }, NOW)).toEqual({ state: "fresh", words: "Up" });
    expect(providerReading({ state: "up", checkedAt: NOW - 3 * 24 * HOUR }, NOW)).toEqual({
      state: "stale",
      words: "Up, not checked lately",
    });
  });

  test("the three the OS knows always, then any other that reported", () => {
    const groups = providerGroups([
      { provider: "vertex", model: "made-up-pro" },
      { provider: "other_cloud", model: "made-up-x" },
    ]);
    expect(groups.map((g) => [g.provider, g.label, g.patientData, g.models.length])).toEqual([
      ["ai_studio", "Google AI Studio", false, 0],
      ["vertex", "Vertex AI", true, 1],
      ["astana_gpu", "Made-up GPU", false, 0],
      ["other_cloud", "other_cloud", false, 1],
    ]);
  });
});

describe("words", () => {
  test("what changed, part by part", () => {
    const before = { enabled: true, provider: "ai_studio", model: "made-up-flash" };
    expect(changeWords(null, before)).toBe("Steered from here: On, made-up-flash on Google AI Studio");
    expect(
      changeWords(before, { ...before, enabled: false, provider: "vertex", model: "made-up-pro", monthlyBudgetUsd: 40 }),
    ).toBe(
      "Switched off; Model made-up-flash on Google AI Studio → made-up-pro on Vertex AI; Budget none → $40.00",
    );
    expect(changeWords(before, { ...before, harnessVersion: "h2" })).toBe("Harness the project's built-in → h2");
    expect(changeWords({ ...before, harnessVersion: "h2" }, { ...before, harnessVersion: "h1" })).toBe("Harness h2 → h1");
  });

  test("before anything is connected, Vertical Startup's legacy way, and its steering: names, never values", () => {
    expect(EMPTY_STEPS).toHaveLength(3);
    expect(EMPTY_STEPS[1]).toContain("STARTUP_AGENTS_URL and STARTUP_AGENTS_TOKEN");
    expect(LEGACY_SENTENCE).toContain("INGEST_TOKEN_VERTICAL_AGENTS");
    expect(LEGACY_SENTENCE).toContain("VERTICAL_STARTUP_URL");
    expect(LEGACY_SENTENCE).toContain("VERTICAL_AGENT_CONFIG_SECRET");
    expect(notConnectedWords(["VERTICAL_AGENT_CONFIG_SECRET"])).toBe(
      "Steering is not connected: VERTICAL_AGENT_CONFIG_SECRET is not set in the Convex env. Changes are recorded, and are not sent.",
    );
  });
});

describe("a project's connection", () => {
  const card = { connected: true, status: "active" as const, legacy: false, lastSeenAt: NOW - HOUR, lastUsageAt: null };
  test("seen lately, never seen, no token, legacy and disconnected", () => {
    expect(connectionReading(card, NOW)).toEqual({ state: "fresh", words: "Last seen 1 hour ago" });
    expect(connectionReading({ ...card, lastSeenAt: NOW - 3 * 24 * HOUR }, NOW).state).not.toBe("fresh");
    expect(connectionReading({ ...card, lastSeenAt: null }, NOW).words).toBe("Waiting for its first call");
    expect(connectionReading({ ...card, connected: false }, NOW).words).toBe("No token yet");
    expect(connectionReading({ ...card, connected: false, legacy: true, lastUsageAt: NOW - HOUR }, NOW).words).toBe(
      "Legacy push, 1 hour ago",
    );
    expect(connectionReading({ ...card, status: "disconnected", connected: false }, NOW)).toEqual({
      state: "failed",
      words: "Disconnected",
    });
  });
});
