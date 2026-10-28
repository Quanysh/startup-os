// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import { customersToEnvelope, type RegisterConfig } from "./customersToEnvelope";
import { USAGE, run } from "./pushCustomers";
import { SheetError, type Sheet } from "./registerSheet";

const CONFIG: RegisterConfig = {
  headerRow: 1,
  columns: {
    name: "Clinic",
    market: "Market",
    status: "Status",
    monthlyFee: "Monthly fee",
    lastPaymentDate: "Last payment",
    amountOwed: "Owed",
    contractDate: "Contract date",
    baaDate: "BAA date",
  },
  markets: { us: "us", kz: "kz" },
  statuses: { active: "active", paused: "paused", churned: "churned" },
};

// A made-up register. Names and people contain "SECRET".
const SHEET: Sheet = {
  headers: ["Clinic", "Market", "Status", "Monthly fee", "Last payment", "Owed", "Contract date", "BAA date", "Director"],
  firstDataRow: 2,
  rows: [
    ["SECRET CLINIC ALPHA", "kz", "active", "200000", "2026-10-01", "0", "2025-03-01", null, "SECRET PERSON ONE"],
    ["SECRET CLINIC BETA", "us", "active", null, null, null, null, "2026-03-03", "SECRET PERSON TWO"],
    ["SECRET CLINIC GAMMA", "kz", "churned", "150000", "2026-06-15", "450000", null, null, null],
  ],
};
const NOW = new Date("2026-10-12T09:30:00Z");
const TOKEN = "fake-token-0123456789abcdefghijklmnopqrstuvwxyz";
const URL = "https://fake-otter-123.convex.site/ingest/v1";
const ENV = { STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_CLIENT_REGISTER: TOKEN };
const PATH = "/fake/register.csv";
const CONFIRMED = JSON.stringify({ ok: true, inserted: 3, updated: 0, unchanged: 0, archived: 0 });

function setup(options: { sheet?: Sheet; readSheet?: () => Sheet; reply?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const readFile = vi.fn((_path: string): Uint8Array => new Uint8Array());
  const readSheet = vi.fn(
    options.readSheet ?? ((_data: Uint8Array, _row: number) => options.sheet ?? SHEET),
  );
  const fetchMock = vi.fn(async () => new Response(options.reply ?? CONFIRMED, { status: 200 }));
  return {
    out,
    err,
    readFile,
    readSheet,
    fetchMock,
    printed: () => [...out, ...err].join("\n"),
    deps: {
      readFile,
      readSheet,
      fetch: fetchMock as unknown as typeof fetch,
      print: (line: string) => void out.push(line),
      printError: (line: string) => void err.push(line),
      now: () => NOW,
      config: CONFIG,
    },
  };
}

describe("run: printing is the default, and it prints no row", () => {
  test("a summary in counts and column headings; nothing sent, even with credentials set", async () => {
    const h = setup();
    expect(await run([PATH], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.out).toEqual([
      "3 clinics read.",
      "By market: US 1, Kazakhstan 2.",
      "By status: Active 2, Paused 0, Churned 1.",
      "On record: monthly fee 2, last payment 2, amount owed 2, last use 0, contract date 1, BAA date 1.",
      "Columns read: Clinic, Market, Status, Monthly fee, Last payment, Owed, Contract date, BAA date.",
      "Columns not read: Director.",
    ]);
    expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
  });

  test("no clinic, no person and no token is ever printed, in either mode", async () => {
    for (const argv of [[PATH], [PATH, "--send"]]) {
      const h = setup();
      await run(argv, ENV, h.deps);
      expect(h.printed()).not.toContain("SECRET");
      expect(h.printed()).not.toContain(TOKEN);
      // Not the envelope either: no JSON, no field names.
      expect(h.printed()).not.toContain("{");
      expect(h.printed()).not.toContain("monthlyFee");
    }
  });

  test("rows under the first blank row are counted in the summary", async () => {
    const blank = SHEET.headers.map(() => null);
    const h = setup({ sheet: { ...SHEET, rows: [...SHEET.rows, blank, ["Total", null, null, "1", null, null, null, null, null]] } });
    await run([PATH], ENV, h.deps);
    expect(h.out).toContain("1 row below the first blank row was not read.");
  });

  test("the header row comes from the config unless given", async () => {
    const h = setup();
    await run([PATH], ENV, h.deps);
    expect(h.readSheet).toHaveBeenCalledWith(expect.anything(), 1);
    const other = setup();
    await run([PATH, "--header-row", "3"], ENV, other.deps);
    expect(other.readSheet).toHaveBeenCalledWith(expect.anything(), 3);
  });
});

describe("run: --send", () => {
  // A blank row in the middle of the register ends the read. Sent as the whole
  // list, what was read would archive every clinic under the blank row.
  const blank = SHEET.headers.map(() => null);
  const cut = (below: number): Sheet => ({
    ...SHEET,
    rows: [
      SHEET.rows[0]!,
      blank,
      ...SHEET.rows.slice(1, 1 + below),
    ],
  });

  test("rows left unread under a blank row refuse the send", async () => {
    const h = setup({ sheet: cut(2) });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.err).toEqual([
      "2 rows below the first blank row were not read. Remove the blank row or pass --stop-at-blank to send only the rows above it.",
    ]);
    expect(h.printed()).not.toContain("SECRET");

    const one = setup({ sheet: cut(1) });
    expect(await run([PATH, "--send"], ENV, one.deps)).toBe(1);
    expect(one.fetchMock).not.toHaveBeenCalled();
    expect(one.err).toEqual([
      "1 row below the first blank row was not read. Remove the blank row or pass --stop-at-blank to send only the rows above it.",
    ]);
  });

  test("--stop-at-blank says the rows above the blank row are the whole list", async () => {
    const h = setup({ sheet: cut(2) });
    expect(await run([PATH, "--send", "--stop-at-blank"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).customers).toHaveLength(1);
  });

  test("without --send the unread rows are only counted, as before", async () => {
    const h = setup({ sheet: cut(2) });
    expect(await run([PATH], ENV, h.deps)).toBe(0);
    expect(h.out).toContain("2 rows below the first blank row were not read.");
    expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
  });

  test("a blank row with nothing under it refuses nothing", async () => {
    const h = setup({ sheet: { ...SHEET, rows: [...SHEET.rows, blank] } });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  test("posts exactly the mapped envelope, and nothing from an unread column", async () => {
    const h = setup();
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL);
    const mapped = customersToEnvelope(SHEET, NOW, CONFIG);
    expect(mapped.ok && JSON.parse(init.body as string)).toEqual(mapped.ok && mapped.envelope);
    expect(init.body as string).not.toContain("SECRET PERSON");
    expect(h.out.at(-1)).toBe("200 ok: inserted 3, updated 0, unchanged 0, archived 0");
  });

  test("--allow-shrink is sent only when asked for", async () => {
    const plain = setup();
    await run([PATH, "--send"], ENV, plain.deps);
    const sent = (h: typeof plain) =>
      JSON.parse((h.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect("allowShrink" in sent(plain)).toBe(false);
    const shrink = setup();
    await run([PATH, "--send", "--allow-shrink"], ENV, shrink.deps);
    expect(sent(shrink).allowShrink).toBe(true);
  });

  test("missing credentials: says what to set, reads nothing, sends nothing", async () => {
    for (const env of [{}, { STARTUP_OS_INGEST_URL: URL }, { INGEST_TOKEN_CLIENT_REGISTER: TOKEN }]) {
      const h = setup();
      expect(await run([PATH, "--send"], env, h.deps)).toBe(1);
      expect(h.err).toEqual([
        "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_CLIENT_REGISTER in .env.push or the environment.",
      ]);
      expect(h.readFile).not.toHaveBeenCalled();
      expect(h.fetchMock).not.toHaveBeenCalled();
    }
  });

  test("the workbook's token is not this script's token", async () => {
    const h = setup();
    expect(
      await run([PATH, "--send"], { STARTUP_OS_INGEST_URL: URL, INGEST_TOKEN_CFO_WORKBOOK: TOKEN }, h.deps),
    ).toBe(1);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    [
      "an http URL",
      { STARTUP_OS_INGEST_URL: "http://fake-otter-123.convex.site/ingest/v1" },
      "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost).",
    ],
    [
      "a host that is not the deployment's",
      { STARTUP_OS_INGEST_URL: "https://elsewhere.example/ingest/v1" },
      "STARTUP_OS_INGEST_URL must be a *.convex.site address, https://os.example.com, or localhost.",
    ],
    [
      "a token with a newline",
      { INGEST_TOKEN_CLIENT_REGISTER: `${TOKEN}\nTAILMARKER` },
      'INGEST_TOKEN_CLIENT_REGISTER must be 32 or more letters, digits, "-" or "_".',
    ],
  ])("%s: refused, nothing sent, nothing echoed", async (_label, override, message) => {
    const h = setup();
    expect(await run([PATH, "--send"], { ...ENV, ...override }, h.deps)).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.printed()).not.toContain("TAILMARKER");
  });

  test("a refusal from the endpoint is printed by code and path, and the exit code says so", async () => {
    const h = setup();
    const refusal = {
      ok: false,
      error: "register_shrank",
      issues: [{ path: "customers", message: "This push would archive 3 of 4 clinics." }],
    };
    h.fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(refusal), { status: 422 }),
    );
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "422 register_shrank",
      "customers: This push would archive 3 of 4 clinics.",
    ]);
  });
});

describe("run: refusals", () => {
  test.each([
    [[]],
    [["a.csv", "b.csv"]],
    [["--send"]],
    [[PATH, "--Send"]],
    [[PATH, "--dry-run"]],
    [[PATH, "--show"]],
    [[PATH, "--rows"]],
    [[PATH, "--allow-shrink"]],
    [[PATH, "--stop-at-blank"]],
    [[PATH, "--header-row", "0"]],
    [[PATH, "--header-row"]],
    [[PATH, "--sheet", "Register"]],
  ])("%j is refused with the usage line and reads nothing", async (argv) => {
    const h = setup();
    expect(await run(argv, ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([USAGE]);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("a mapping problem is printed by column and row, and nothing is sent", async () => {
    const bad = { ...SHEET, rows: [["SECRET CLINIC ALPHA", "SECRET REGION", "active", "1", null, null, null, null, null]] };
    const h = setup({ sheet: bad });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(['Column "Market": not a market this script knows (1 row: 2).']);
    expect(h.out).toEqual([]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("the endpoint's own rules are applied before anything is shown", async () => {
    // The same clinic on two rows passes the mapping and is caught here.
    const twice = { ...SHEET, rows: [SHEET.rows[0]!, SHEET.rows[0]!] };
    const h = setup({ sheet: twice });
    expect(await run([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["customers.1.name: is the same clinic as row 0"]);
    expect(h.out).toEqual([]);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.printed()).not.toContain("SECRET");
  });

  test("an export that cannot be read says so in fixed words", async () => {
    const h = setup({
      readSheet: () => {
        throw new SheetError("Row 1 holds no text, so it is not the header row.");
      },
    });
    expect(await run([PATH], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["Row 1 holds no text, so it is not the header row."]);

    const odd = setup({
      readSheet: () => {
        throw new Error("SECRET internal detail");
      },
    });
    expect(await run([PATH], ENV, odd.deps)).toBe(1);
    expect(odd.err).toEqual(["The export could not be read."]);
  });

  test("a file that cannot be read is reported by path only", async () => {
    const h = setup();
    h.readFile.mockImplementation(() => {
      throw new Error("EACCES SECRET detail");
    });
    expect(await run([PATH], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([`Could not read ${PATH}.`]);
  });
});
