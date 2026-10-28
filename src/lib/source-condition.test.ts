import { describe, expect, test } from "vitest";
import { feedLabel, sourceCondition } from "./source-condition";

const status = (state: string) => ({ state });

describe("sourceCondition", () => {
  test("a source missing its variables is unconfigured, whatever its log says", () => {
    expect(sourceCondition({ kind: "api", configured: false, status: status("ok") })).toBe(
      "unconfigured",
    );
  });

  test("typed-in numbers need no run: ready", () => {
    expect(sourceCondition({ kind: "manual", configured: true, status: null })).toBe("ready");
  });

  test("configured and never run is waiting", () => {
    expect(sourceCondition({ kind: "api", configured: true, status: null })).toBe("waiting");
  });

  test("configured now, but the last run was before it was: waiting, not failed", () => {
    // The daily run logs "not configured" until the token is set.
    expect(
      sourceCondition({ kind: "api", configured: true, status: status("not_configured") }),
    ).toBe("waiting");
  });

  test("a good last run is ok", () => {
    expect(sourceCondition({ kind: "api", configured: true, status: status("ok") })).toBe("ok");
  });

  test("an error or an empty answer is failed", () => {
    expect(sourceCondition({ kind: "api", configured: true, status: status("error") })).toBe(
      "failed",
    );
    expect(sourceCondition({ kind: "api", configured: true, status: status("empty") })).toBe(
      "failed",
    );
  });
});

describe("feedLabel", () => {
  test("typed-in numbers", () => {
    expect(feedLabel({ kind: "manual", fedBy: "manual" })).toBe("Manual");
  });

  test("a source that is only ever pushed", () => {
    expect(feedLabel({ kind: "ingest", fedBy: "push" })).toBe("Pushed");
    expect(feedLabel({ kind: "ingest", fedBy: null })).toBe("Pushed");
  });

  test("a pulled source read with its own key", () => {
    expect(feedLabel({ kind: "api", fedBy: "pull" })).toBe("Synced");
  });

  test("a pulled source fed by its ingest token says so", () => {
    expect(feedLabel({ kind: "api", fedBy: "push" })).toBe("Pushed by a connector run");
  });

  test("a pulled source with nothing set keeps its usual name", () => {
    expect(feedLabel({ kind: "api", fedBy: null })).toBe("Synced");
  });
});
