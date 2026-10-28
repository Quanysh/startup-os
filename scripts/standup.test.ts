import { describe, expect, test, vi } from "vitest";
import { standupUrls } from "./standupHttp";
import { run as runOpen } from "./standupOpen";
import { run as runPush } from "./standupPush";

// Made-up tasks. Every title, context and address in a file says "SECRET", so
// one assertion proves `standup:push` never prints one.
const NOW = new Date("2026-10-13T07:00:00Z");
const TOKEN = "fake-standup-0123456789abcdefghijklmnopqrstuv";
const INGEST_URL = "https://fake-otter-123.convex.site/ingest/v1";
const ENV = { STARTUP_OS_INGEST_URL: INGEST_URL, INGEST_TOKEN_STANDUP: TOKEN };
const PATH = "/fake/standup.json";

const FILE = {
  version: 1,
  meetingId: "01KFIREFLIES0001",
  meetingDate: "2026-10-13",
  tasks: [
    {
      key: "a1",
      title: "SECRET title one",
      company: "us",
      assignee: "secret.person@example.com",
      due: "2026-10-20",
      context: "SECRET context",
    },
    { key: "a2", title: "SECRET title two", company: "kz", kind: "issue" },
    { key: "a3", title: "SECRET title three", company: null },
  ],
};

type Reply = { status?: number; body?: unknown; throws?: unknown; redirect?: boolean };

function harness(reply: Reply = {}, file: unknown = FILE) {
  const out: string[] = [];
  const err: string[] = [];
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (reply.throws !== undefined) throw reply.throws;
    if (reply.redirect) return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } });
    const body = reply.body ?? { ok: true, added: 2, known: 0, duplicate: 1, nearDuplicate: 0, unassigned: 1 };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: reply.status ?? 200,
    });
  });
  const deps = {
    readFile: (path: string) => {
      if (path !== PATH) throw new Error("ENOENT");
      return typeof file === "string" ? file : JSON.stringify(file);
    },
    fetch: fetchMock as unknown as typeof fetch,
    print: (line: string) => void out.push(line),
    printError: (line: string) => void err.push(line),
    now: () => NOW,
  };
  const printed = () => [...out, ...err].join("\n");
  return { deps, out, err, fetchMock, printed };
}

describe("standupUrls", () => {
  test("the two routes are on the ingest endpoint's own host", () => {
    expect(standupUrls(INGEST_URL)).toEqual({
      open: "https://fake-otter-123.convex.site/standup/v1/open",
      tasks: "https://fake-otter-123.convex.site/standup/v1/tasks",
    });
    expect(standupUrls("http://localhost:3211/ingest/v1")).toEqual({
      open: "http://localhost:3211/standup/v1/open",
      tasks: "http://localhost:3211/standup/v1/tasks",
    });
  });

  test("nothing of the ingest URL but its origin is carried over", () => {
    expect(standupUrls(`${INGEST_URL}?x=1#y`).open).toBe(
      "https://fake-otter-123.convex.site/standup/v1/open",
    );
  });
});

describe("pnpm standup:push", () => {
  const USAGE = "Usage: pnpm standup:push <file.json> [--send]";

  test("without --send it checks the file, says what it holds in counts, and sends nothing", async () => {
    const h = harness();
    expect(await runPush([PATH], ENV, h.deps)).toBe(0);
    expect(h.out).toEqual([
      "Kind: standup tasks",
      "Meeting date: 2026-10-13",
      "Tasks: 3",
      "Startup: 1, Globex: 1, shared: 1",
      "With an assignee: 1",
      "With a due date: 1",
    ]);
    expect(h.err).toEqual(["Nothing was sent. Add --send to push it."]);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.printed()).not.toContain("SECRET");
    expect(h.printed().toLowerCase()).not.toContain("secret.person");
  });

  test("the check needs neither the URL nor the token", async () => {
    const h = harness();
    expect(await runPush([PATH], {}, h.deps)).toBe(0);
  });

  test("with --send it posts the file to the tasks route and prints the server's counts", async () => {
    const h = harness();
    expect(await runPush([PATH, "--send"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://fake-otter-123.convex.site/standup/v1/tasks");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    });
    expect(JSON.parse(init!.body as string)).toEqual(FILE);
    expect(h.out.slice(-2)).toEqual([
      "Sending to fake-otter-123.convex.site.",
      "200 ok: added 2, known 0, duplicate 1, nearDuplicate 0, unassigned 1",
    ]);
    expect(h.printed()).not.toContain(TOKEN);
    expect(h.printed()).not.toContain("SECRET");
  });

  test.each([
    ["no file", []],
    ["two files", [PATH, PATH]],
    ["a misspelled flag", [PATH, "--sned"]],
    ["both flags", [PATH, "--send", "--dry-run"]],
  ])("%s prints the usage and sends nothing", async (_what, argv) => {
    const h = harness();
    expect(await runPush(argv, ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([USAGE]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("--dry-run is the long way to say the default", async () => {
    const h = harness();
    expect(await runPush([PATH, "--dry-run"], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("a file that is not JSON is said without quoting it", async () => {
    const h = harness({}, "{SECRET");
    expect(await runPush([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([`${PATH} is not valid JSON.`]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test("a file that cannot be read", async () => {
    const h = harness();
    expect(await runPush(["/fake/missing.json"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["Could not read /fake/missing.json."]);
  });

  test("a file the server would refuse is refused here, by path and fixed words, and never sent", async () => {
    const bad = {
      ...FILE,
      summary: "SECRET summary",
      tasks: [{ ...FILE.tasks[0], notes: "SECRET" }],
    };
    const h = harness({}, bad);
    expect(await runPush([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "tasks.0: has a field the OS does not accept",
      "push: has a field the OS does not accept",
    ]);
    expect(h.out).toEqual([]);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.printed()).not.toContain("SECRET");
  });

  test("the same rules as the server: a title too long, a key used twice", async () => {
    const h = harness(
      {},
      {
        ...FILE,
        tasks: [
          { key: "a1", title: `SECRET ${"x".repeat(200)}`, company: "us" },
          { key: "a1", title: "SECRET again", company: "us" },
        ],
      },
    );
    expect(await runPush([PATH], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "tasks.0.title: is too long (200 characters at most)",
      "tasks.1.key: repeats an earlier key",
    ]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test.each([
    ["no URL", { INGEST_TOKEN_STANDUP: TOKEN }, "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_STANDUP in .env.push or the environment."],
    ["no token", { STARTUP_OS_INGEST_URL: INGEST_URL }, "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_STANDUP in .env.push or the environment."],
    ["a token too short", { ...ENV, INGEST_TOKEN_STANDUP: "SECRET-short" }, 'INGEST_TOKEN_STANDUP must be 32 or more letters, digits, "-" or "_".'],
    ["a URL that is not the deployment's", { ...ENV, STARTUP_OS_INGEST_URL: "https://SECRET.example.com/ingest/v1" }, "STARTUP_OS_INGEST_URL must be a *.convex.site address, https://os.example.com, or localhost."],
    ["a URL with another path", { ...ENV, STARTUP_OS_INGEST_URL: "https://fake-otter-123.convex.site/standup/v1/tasks" }, "STARTUP_OS_INGEST_URL must end in /ingest/v1."],
  ])("--send with %s stops before anything is sent", async (_what, env, message) => {
    const h = harness();
    expect(await runPush([PATH, "--send"], env, h.deps)).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a refusal is printed as the server's code, paths and fixed words, and nothing else of the reply", async () => {
    const h = harness({
      status: 429,
      body: {
        ok: false,
        error: "too_many_tasks",
        issues: [
          { path: "tasks", message: "At most 60 tasks a day are taken from the standup. Try again tomorrow." },
          { path: "SECRET path with spaces", message: "dropped" },
        ],
        echoed: "SECRET",
      },
    });
    expect(await runPush([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "429 too_many_tasks",
      "tasks: At most 60 tasks a day are taken from the standup. Try again tomorrow.",
    ]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a 200 that is not the endpoint's confirmation is not a success", async () => {
    const h = harness({ body: "<html>SECRET sign-in page</html>" });
    expect(await runPush([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["200", "That is not the endpoint's confirmation, so the push is not confirmed."]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a redirect is not followed", async () => {
    const h = harness({ redirect: true });
    expect(await runPush([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual([
      "The endpoint redirected the request. Nothing was followed and nothing was sent on.",
    ]);
  });

  test("a network failure never prints the error's own words, which can quote a header", async () => {
    const h = harness({ throws: new TypeError(`Bearer ${TOKEN} is not a legal header`) });
    expect(await runPush([PATH, "--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["The request could not reach the endpoint (unknown error)."]);
    expect(h.printed()).not.toContain(TOKEN);
  });
});

describe("pnpm standup:open", () => {
  const BOARD = {
    ok: true,
    open: [{ title: "Open card", company: "us", column: "backlog" }],
    done: [{ title: "Done card", company: null }],
    linear: [{ title: "Linear issue", company: "kz" }],
    truncated: false,
  };

  test("it prints what the board holds as JSON on stdout, and nothing else there", async () => {
    const h = harness({ body: { ...BOARD, extra: "SECRET", open: [{ ...BOARD.open[0], notes: "SECRET" }] } });
    expect(await runOpen([], ENV, h.deps)).toBe(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchMock.mock.calls[0]!;
    expect(url).toBe("https://fake-otter-123.convex.site/standup/v1/open");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(init).not.toHaveProperty("body");
    // One document on stdout; a field this script does not know is not passed on.
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual({
      open: BOARD.open,
      done: BOARD.done,
      linear: BOARD.linear,
      truncated: false,
    });
    expect(h.err).toEqual([]);
    expect(h.printed()).not.toContain(TOKEN);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a list that was cut is said on stderr, so it is not read as the whole board", async () => {
    const h = harness({ body: { ...BOARD, truncated: true } });
    expect(await runOpen([], ENV, h.deps)).toBe(0);
    expect(JSON.parse(h.out[0]!).truncated).toBe(true);
    expect(h.err).toEqual([
      "The list was cut short: the board or Linear holds more than was returned. Treat a task you cannot rule out as already there.",
    ]);
  });

  test("it takes no argument", async () => {
    const h = harness({ body: BOARD });
    expect(await runOpen(["--send"], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["Usage: pnpm standup:open"]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["no token", { STARTUP_OS_INGEST_URL: INGEST_URL }, "Set STARTUP_OS_INGEST_URL and INGEST_TOKEN_STANDUP in .env.push or the environment."],
    ["a token with a character a header cannot hold", { ...ENV, INGEST_TOKEN_STANDUP: `${TOKEN}\n` }, 'INGEST_TOKEN_STANDUP must be 32 or more letters, digits, "-" or "_".'],
    ["a plain http address", { ...ENV, STARTUP_OS_INGEST_URL: "http://fake-otter-123.convex.site/ingest/v1" }, "STARTUP_OS_INGEST_URL must be https (http is allowed only for localhost)."],
  ])("%s stops before anything is asked", async (_what, env, message) => {
    const h = harness({ body: BOARD });
    expect(await runOpen([], env, h.deps)).toBe(1);
    expect(h.err).toEqual([message]);
    expect(h.out).toEqual([]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["an unauthorised token", { status: 401, body: { ok: false, error: "unauthorized" } }, ["401 unauthorized"]],
    ["a deployment with no token set", { status: 503, body: { ok: false, error: "ingest_not_configured" } }, ["503 ingest_not_configured"]],
    ["an error with words that are not a code", { status: 500, body: { ok: false, error: "SECRET words here" } }, ["500"]],
  ])("%s prints the status and the code only", async (_what, reply, lines) => {
    const h = harness(reply);
    expect(await runOpen([], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(lines);
    expect(h.out).toEqual([]);
    expect(h.printed()).not.toContain("SECRET");
  });

  test("a 200 of another shape is not printed", async () => {
    const h = harness({ body: { ok: true, open: "SECRET", done: [], linear: [], truncated: false } });
    expect(await runOpen([], ENV, h.deps)).toBe(1);
    expect(h.err).toEqual(["200", "That is not the endpoint's list, so nothing is printed."]);
    expect(h.out).toEqual([]);
  });
});
