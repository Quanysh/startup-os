import { describe, expect, test } from "vitest";
import { APP_ID, DAY_S, NOW_MS, NOW_S, conversation, searchPage, startedOn } from "../convex/connectors/intercom.fixtures";
import { parseSupportPush } from "../convex/lib/supportRecords";
import { GLOBEX_APP_ID, INCOMPLETE, USAGE, run, type EnvelopeDeps } from "./supportEnvelope";

const RAW = "/private/scratch/intercom-raw.json";

function setup(raw: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const written: { path: string; text: string; mode: number }[] = [];
  const deps: EnvelopeDeps = {
    readFile: (path) => {
      if (path !== RAW) throw new Error("no such file");
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    },
    writeFile: (path, text, mode) => written.push({ path, text, mode }),
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    now: () => new Date(NOW_MS),
  };
  const printed = () => [...out, ...err].join("\n");
  const envelope = () => JSON.parse(written[0]!.text) as Record<string, unknown> & { records: unknown[] };
  return { deps, out, err, written, printed, envelope };
}

describe("pnpm support:envelope", () => {
  test("maps every conversation of the two searches to one envelope the endpoint accepts", async () => {
    const h = setup({
      // The open chats, two pages.
      open: [
        { ...searchPage([conversation({ id: "1" })], "cursor-2"), total_count: 2 },
        { ...searchPage([conversation({ id: "2", ...startedOn("http://localhost:3000/") })]), total_count: 2 },
      ],
      // Updated in 90 days: one already listed, one closed.
      updated: [
        searchPage([
          conversation({ id: "2", ...startedOn("http://localhost:3000/") }),
          conversation({ id: "3", state: "closed", open: false }),
        ]),
      ],
    });
    expect(await run([RAW], h.deps)).toBe(0);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.path).toBe("/private/scratch/intercom-raw.envelope.json");
    expect(h.written[0]!.mode).toBe(0o600);
    const envelope = h.envelope();
    expect(envelope).toMatchObject({
      version: 1,
      source: "intercom",
      batchId: "intercom-2026-10-17",
      observedAt: "2026-10-17T09:00:00.000Z",
      appIdCode: GLOBEX_APP_ID,
    });
    expect(envelope).not.toHaveProperty("empty");
    expect(envelope).not.toHaveProperty("allowShrink");
    expect(envelope.records.map((r) => (r as { id: string }).id)).toEqual(["1", "2", "3"]);
    expect(parseSupportPush(envelope.records, envelope.appIdCode, NOW_MS).ok).toBe(true);
    expect(h.out).toEqual([
      "Intercom: 3 conversations (customer 2, test 1, other 0, unknown 0).",
      "Envelope written to /private/scratch/intercom-raw.envelope.json",
    ]);
  });

  test("nothing but the two searches will do: never an empty or a partial file that would wipe what is stored", async () => {
    const page = searchPage([conversation()]);
    for (const raw of [
      [],
      {},
      [[page]],
      [[page], [page]],
      { open: [page] },
      { updated: [page] },
      { open: [], updated: [page] },
      { open: [page], updated: [page], extra: [page] },
    ]) {
      const h = setup(raw);
      expect([JSON.stringify(raw).slice(0, 40), await run([RAW], h.deps)]).toEqual([JSON.stringify(raw).slice(0, 40), 1]);
      expect(h.written).toEqual([]);
    }
  });

  test("each search must say how many it matched, so its count can be checked", async () => {
    const { total_count: _dropped, ...noTotal } = searchPage([conversation()]);
    const h = setup({ open: [noTotal], updated: [searchPage([conversation()])] });
    expect(await run([RAW], h.deps)).toBe(1);
    expect(h.err).toEqual([INCOMPLETE]);
    expect(h.written).toEqual([]);
  });

  test("the open search holds open chats only: two searches swapped are refused", async () => {
    const h = setup({
      open: [searchPage([conversation({ state: "closed", open: false })])],
      updated: [searchPage([conversation()])],
    });
    expect(await run([RAW], h.deps)).toBe(1);
    expect(h.written).toEqual([]);
  });

  test("no conversation at all is written only with --allow-empty, and a shrink only with --allow-shrink", async () => {
    const empty = { open: [searchPage([])], updated: [searchPage([])] };
    const refused = setup(empty);
    expect(await run([RAW], refused.deps)).toBe(1);
    expect(refused.err).toEqual([
      "No conversation was read. If the inbox really has none, run again with --allow-empty. Nothing was written.",
    ]);
    expect(refused.written).toEqual([]);
    const allowed = setup(empty);
    expect(await run([RAW, "--allow-empty"], allowed.deps)).toBe(0);
    expect(allowed.envelope()).toMatchObject({ records: [], empty: true });
    expect(allowed.envelope()).not.toHaveProperty("allowShrink");
    const shrink = setup({ open: [searchPage([conversation()])], updated: [searchPage([conversation()])] });
    expect(await run([RAW, "--allow-shrink"], shrink.deps)).toBe(0);
    expect(shrink.envelope()).toMatchObject({ allowShrink: true });
  });

  test("nothing private reaches the envelope or the terminal", async () => {
    const h = setup({ open: [searchPage([conversation()])], updated: [searchPage([conversation()])] });
    expect(await run([RAW], h.deps)).toBe(0);
    for (const text of [h.written[0]!.text, h.printed()]) {
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("@");
      expect(text).not.toContain("patient");
    }
    expect(h.printed()).not.toContain("900000001");
  });

  test("--out and --app choose the file and the workspace", async () => {
    const both = { open: [searchPage([conversation()])], updated: [searchPage([conversation()])] };
    const h = setup(both);
    expect(await run([RAW, "--out", "/private/scratch/out.json", "--app", APP_ID], h.deps)).toBe(0);
    expect(h.written[0]!.path).toBe("/private/scratch/out.json");
    expect(h.envelope().appIdCode).toBe(APP_ID);
    const bad = setup(both);
    expect(await run([RAW, "--app", "../x"], bad.deps)).toBe(1);
    expect(bad.written).toEqual([]);
  });

  test("an incomplete read writes nothing: a page with more after it, or fewer chats than the total", async () => {
    const whole = [searchPage([conversation()])];
    for (const open of [
      [searchPage([conversation()], "cursor-2")],
      [{ ...searchPage([conversation()]), total_count: 5 }],
      [searchPage([conversation({ id: "1" })], "cursor-2"), searchPage([conversation({ id: "2" })], "cursor-3")],
    ]) {
      const h = setup({ open, updated: whole });
      expect(await run([RAW], h.deps)).toBe(1);
      expect(h.written).toEqual([]);
      expect(h.err).toEqual([INCOMPLETE]);
    }
  });

  test("a chat neither open nor updated in 90 days is left out", async () => {
    const old = NOW_S - 100 * DAY_S;
    const stale = conversation({ id: "9", state: "closed", open: false, updated_at: old, created_at: old });
    const h = setup({ open: [searchPage([conversation({ id: "1" })])], updated: [searchPage([stale])] });
    expect(await run([RAW], h.deps)).toBe(0);
    expect(h.envelope().records.map((r) => (r as { id: string }).id)).toEqual(["1"]);
  });

  test("a file that is not the connector's results is refused in fixed words", async () => {
    for (const raw of ["not json", { open: [{ nope: true }], updated: [] }, { open: [{ conversations: [{ id: "SECRET" }] }], updated: [] }]) {
      const h = setup(raw);
      expect(await run([RAW], h.deps)).toBe(1);
      expect(h.written).toEqual([]);
      expect(h.printed()).not.toContain("SECRET");
    }
  });

  test("usage, and a file that cannot be read", async () => {
    const h = setup({});
    expect(await run([], h.deps)).toBe(1);
    expect(h.err).toEqual([USAGE]);
    const missing = setup({});
    expect(await run(["/elsewhere.json"], missing.deps)).toBe(1);
    expect(missing.err).toEqual(["Could not read the file."]);
  });
});
