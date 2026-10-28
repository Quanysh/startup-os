import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SEQUENCES, page, sequence, stubApollo } from "./apollo.fixtures";
import { readApollo } from "./apollo";
import { ConnectorError } from "./errors";

// Obviously not a real key.
const KEY = "fake-apollo-key-for-tests-only";
const NOW = Date.UTC(2026, 9, 12, 6, 20);

beforeEach(() => {
  vi.stubEnv("APOLLO_API_KEY", KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const failure = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (error: unknown) => error as Error,
  );
const values = async () =>
  (await readApollo(NOW)).map((r) => `${r.key} ${r.periodStart} ${r.value}`);

describe("readApollo", () => {
  test("returns this week's three totals across every sequence", async () => {
    stubApollo();
    expect(await values()).toEqual([
      "outbound_delivered 2026-10-12 240",
      "outbound_opened 2026-10-12 90",
      "outbound_replied 2026-10-12 8",
    ]);
  });

  test("the key goes to Apollo in the x-api-key header, and nowhere else", async () => {
    const calls = stubApollo();
    await readApollo(NOW);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url.origin).toBe("https://api.apollo.io");
    expect(call?.method).toBe("POST");
    expect(call?.apiKey).toBe(KEY);
    expect(call?.authorization).toBeNull();
    expect(call?.url.href).not.toContain(KEY);
    // A redirect is never followed, so the key can only go where it was sent.
    expect(call?.redirect).toBe("manual");
  });

  test("asks for pages of sequences and for nothing by name", async () => {
    const calls = stubApollo();
    await readApollo(NOW);
    expect([...calls[0]!.url.searchParams.keys()].sort()).toEqual(["page", "per_page"]);
  });

  test("reads every page before adding up", async () => {
    const calls = stubApollo((number) =>
      number === 1
        ? page([sequence("a", 120, 60, 5), sequence("b", 80, 20, 3)], 1, 2, 3)
        : page([sequence("c", 40, 10, 0)], 2, 2, 3),
    );
    expect(await values()).toContain("outbound_delivered 2026-10-12 240");
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls[0]?.url.searchParams.get("per_page")).toBe("100");
  });

  test("fewer sequences than Apollo counted fails the read: the totals would be short", async () => {
    stubApollo(() => page([sequence("a", 120, 60, 5)], 1, 1, 3));
    const error = await failure(readApollo(NOW));
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error?.message).toBe(
      "Apollo listed fewer sequences than it counted; the totals would be short.",
    );
  });

  test("a page that comes back empty before the last stops the read as short, not as done", async () => {
    stubApollo((number) =>
      number === 1 ? page([sequence("a", 120, 60, 5)], 1, 3, 3) : page([], number, 3, 3),
    );
    const error = await failure(readApollo(NOW));
    expect(error?.message).toBe(
      "Apollo listed fewer sequences than it counted; the totals would be short.",
    );
  });

  test("no sequence at all is no rows, for the runner to record as an empty run", async () => {
    stubApollo(() => page([], 1, 0, 0));
    expect(await readApollo(NOW)).toEqual([]);
  });

  test("sequences that have sent nothing are real zeros", async () => {
    stubApollo(() => page([sequence("a", 0, 0, 0)], 1, 1, 1));
    expect(await values()).toContain("outbound_delivered 2026-10-12 0");
  });

  test("more than twenty pages fails the read rather than adding up the first two thousand", async () => {
    const calls = stubApollo((number) => page([sequence(`s${number}`, 1, 0, 0)], number, 21, 21));
    const error = await failure(readApollo(NOW));
    expect(error?.message).toBe("Apollo has more than 2000 sequences.");
    expect(calls).toHaveLength(20);
  });

  test("a key Apollo refuses is reported by status, and the body is not quoted", async () => {
    stubApollo(
      () =>
        new Response(
          '{"error":"api/v1/emailer_campaigns/search is not accessible with this api_key"}',
          { status: 403 },
        ),
    );
    const error = await failure(readApollo(NOW));
    expect(error?.message).toBe("Apollo answered 403 for sequences.");
  });

  test("no sequence name can reach a row", async () => {
    stubApollo();
    expect(JSON.stringify(await readApollo(NOW))).not.toContain("Fixture");
    expect(SEQUENCES[0]?.name).toContain("Fixture"); // The fixture really does carry one.
  });
});
