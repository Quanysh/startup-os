import { describe, expect, test } from "vitest";
import { failureOf, inboxLink, intercomLink, isPageArea, originOf, pageAreaOf } from "./support";

describe("originOf: where a chat started", () => {
  test.each([
    ["https://app.second.example.test/dashboard", "customer"],
    ["https://app.second.example.test/dashboard/studies/1?x=1", "customer"],
    ["https://APP.second.example.test/login", "customer"],
    ["http://localhost:3000/dashboard", "test"],
    ["http://127.0.0.1:5173/", "test"],
    ["https://staging.second.example.test/dashboard", "test"],
    ["https://app.staging.second.example.test/dashboard", "test"],
    ["https://app.intercom.com/hosted_messenger/abc/fin_demo_preview", "test"],
    ["https://made0up1.intercom.com/preview", "test"],
    ["https://example.test/whatever/fin_demo_preview", "test"],
    ["https://atlas.example.com/search", "other"],
    ["https://second.example.test/", "other"],
    ["https://app.second.example.test.evil.example/dashboard", "other"],
    ["ftp://app.second.example.test/dashboard", "other"],
    ["not a url", "unknown"],
    ["", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ] as const)("%s is %s", (url, origin) => {
    expect(originOf(url)).toBe(origin);
  });
});

describe("pageAreaOf: which part of Globex a customer was on", () => {
  test.each([
    ["https://app.second.example.test/dashboard", "dashboard"],
    ["https://app.second.example.test/dashboard/", "dashboard"],
    ["https://app.second.example.test/dashboard/studies", "studies"],
    ["https://app.second.example.test/dashboard/studies/123456/report?patient=x#y", "studies/report"],
    ["https://app.second.example.test/dashboard/studies/9f0c2d1e-3b4a-4c5d-8e6f-7a8b9c0d1e2f", "studies"],
    ["https://app.second.example.test/dashboard/billing/invoices/inv_8F3k2JD9/print", "billing/invoices"],
    ["https://app.second.example.test/dashboard/a1b2c3d4e5f6/settings", "settings"],
    ["https://app.second.example.test/dashboard/someone%40mail.kz/settings", "settings"],
    ["https://app.second.example.test/dashboard/Settings/Team", "settings/team"],
    ["https://app.second.example.test/login", null],
    ["https://app.second.example.test/", null],
    ["https://staging.second.example.test/dashboard/studies", null],
    ["https://atlas.example.com/dashboard/studies", null],
    [null, null],
  ] as const)("%s → %s", (url, area) => {
    expect(pageAreaOf(url)).toBe(area);
  });

  test("never more than two segments, never a query, never long", () => {
    const area = pageAreaOf(
      `https://app.second.example.test/dashboard/one/two/three/four?token=abc&email=x@y.kz`,
    );
    expect(area).toBe("one/two");
    expect(pageAreaOf(`https://app.second.example.test/dashboard/${"a".repeat(80)}/x`)).toBe("x");
  });
});

describe("links into Intercom", () => {
  test("a conversation, by the workspace's id code and the chat's id", () => {
    expect(intercomLink("made0up1", "900000001")).toBe(
      "https://app.intercom.com/a/inbox/made0up1/inbox/conversation/900000001",
    );
    expect(inboxLink("made0up1")).toBe("https://app.intercom.com/a/inbox/made0up1/inbox");
  });

  test("nothing is built from a value that is not plainly an id", () => {
    expect(intercomLink(null, "900000001")).toBeNull();
    expect(intercomLink("made0up1/../x", "1")).toBeNull();
    expect(intercomLink("made0up1", "1?x=1")).toBeNull();
    expect(inboxLink(null)).toBeNull();
    expect(inboxLink("javascript:alert(1)")).toBeNull();
  });
});

describe("isPageArea: what a push may say a chat began on", () => {
  test.each([
    ["dashboard", true],
    ["studies", true],
    ["studies/report", true],
    ["billing/invoices", true],
    ["settings/team-members", true],
    ["studies/report/print", false],
    ["studies/123456", false],
    ["studies/inv_8F3k2JD9", false],
    ["Studies", false],
    ["/studies", false],
    ["studies/", false],
    ["studies?x=1", false],
    ["https://app.second.example.test/dashboard", false],
    ["someone@mail.kz", false],
    ["a".repeat(41), false],
    ["", false],
    [null, false],
  ])("%s → %s", (value, ok) => {
    expect(isPageArea(value)).toBe(ok);
  });

  test("every area pageAreaOf makes passes", () => {
    for (const url of [
      "https://app.second.example.test/dashboard",
      "https://app.second.example.test/dashboard/studies/123456/report?patient=x",
      "https://app.second.example.test/dashboard/billing/invoices/inv_8F3k2JD9/print",
    ]) {
      expect(isPageArea(pageAreaOf(url))).toBe(true);
    }
  });
});

describe("failureOf: a stored run's state as a key, never its message", () => {
  test.each([
    ["ok", null],
    [null, null],
    [undefined, null],
    ["not_configured", "not_configured"],
    ["error", "refused"],
    ["empty", "refused"],
  ] as const)("%s → %s", (state, key) => {
    expect(failureOf(state)).toBe(key);
  });
});
