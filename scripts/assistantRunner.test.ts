import { afterEach, describe, expect, test } from "vitest";
import { AGENT_WORDS, CALL_WINDOW_MS } from "../convex/lib/agentRules";
import {
  CHAT_DENIED_TOOLS,
  CHAT_TOOLS,
  CHAT_WORDS,
  MAX_RUNNER_CALLS_PER_WINDOW,
  RUNNER_TOOLS,
} from "../convex/lib/chatRules";
import { CONFIG_WORDS } from "./assistantConfig";
import {
  ANSWER_LIMIT_MS,
  HEARTBEAT_MS,
  PROGRESS_EVERY_MS,
  RUNNER_WORDS,
  USAGE,
  backoff,
  claudeArgs,
  pollEvery,
  run,
} from "./assistantRunner";
import {
  ANSWER,
  CLAIM,
  HOME,
  INSTRUCTIONS,
  PATHS,
  QUESTION,
  TOKEN,
  URL_,
  delta,
  harness,
  messageStart,
  success,
  toolUse,
  type Harness,
} from "./assistantRunner.kit";

// The chat's runner: it never starts the real `claude`, never calls the real
// endpoint and never reads the real ~/.claude.json. Everything SECRET here is
// made up, and one assertion at the end of every test proves none of it, and
// no token, was printed or put on a command line.

const live: Harness[] = [];
function start(options: Parameters<typeof harness>[0] = {}, argv: string[] = []) {
  const h = harness(options);
  live.push(h);
  // Started a turn later, so a test can first say how the endpoint answers.
  const done = Promise.resolve().then(() => run(argv, h.env, PATHS, h.deps));
  return { h, done };
}

afterEach(() => {
  for (const h of live.splice(0)) {
    // The token: in the request's header and the temp file's text, and nowhere else.
    expect(h.printed()).not.toContain(TOKEN);
    expect(h.printed()).not.toMatch(/sosa_|SECRET|Bearer/);
    for (const { command, args, options } of h.spawned) {
      const shown = JSON.stringify([command, args, options]);
      expect(shown).not.toContain(TOKEN);
      expect(shown).not.toMatch(/SECRET|sk-ant|NEVER PASSED/);
    }
    for (const call of h.sent) {
      expect(call.url).toBe(URL_);
      expect(String(call.init.body)).not.toContain(TOKEN);
    }
  }
});

/** Run until the made-up Claude has been started for the one waiting question. */
async function claimed(options: Parameters<typeof harness>[0] = {}, argv: string[] = []) {
  const { h, done } = start(options, argv);
  h.answers.chat_next = (_args, nth) => (nth === 1 ? { output: CLAIM } : { output: { none: true, truncated: false } });
  await h.settle();
  expect(h.spawned).toHaveLength(1);
  return { h, done, child: h.spawned[0]!.child, spawn: h.spawned[0]! };
}

async function end(h: Harness, done: Promise<number>) {
  h.stop();
  await h.advance(120_000);
  return done;
}

describe("starting", () => {
  test("it says it started, and nothing about where or as whom", async () => {
    const { h, done } = start();
    await h.settle();
    expect(h.out).toEqual([RUNNER_WORDS.started]);
    expect(await end(h, done)).toBe(0);
  });

  test.each([
    ["Claude's configuration is missing", { config: null }, CONFIG_WORDS.notConnected],
    ["the startup-os entry is missing", { config: JSON.stringify({ mcpServers: {} }) }, CONFIG_WORDS.notConnected],
    [
      "the address is another",
      { config: JSON.stringify({ mcpServers: { "startup-os": { url: "https://evil.test/mcp/v1", headers: { Authorization: `Bearer ${TOKEN}` } } } }) },
      CONFIG_WORDS.wrongUrl,
    ],
    ["Claude Code is not installed", { claude: null }, RUNNER_WORDS.noClaude],
  ])("it refuses to run when %s: fixed words, nothing sent, nothing started", async (_why, options, words) => {
    const { h, done } = start(options);
    expect(await done).toBe(1);
    expect(h.err).toEqual([words]);
    expect(h.sent).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  test("an argument it does not know is refused with the usage", async () => {
    for (const argv of [["--verbose"], ["extra"], ["--claude"]]) {
      const { h, done } = start({}, argv);
      expect(await done).toBe(1);
      expect(h.err).toEqual([USAGE]);
      expect(h.sent).toEqual([]);
    }
  });

  test("Claude Code is found on PATH, else in ~/.local/bin, else where --claude says", async () => {
    const found = async (options: Parameters<typeof harness>[0], argv: string[] = []) => {
      const { h, done, spawn } = await claimed(options, argv);
      spawn.child.exit(0);
      await end(h, done);
      return spawn.command;
    };
    expect(await found({})).toBe("/usr/local/bin/claude");
    expect(await found({ claude: `${HOME}/.local/bin/claude` })).toBe(`${HOME}/.local/bin/claude`);
    expect(await found({ claude: "/opt/made-up/claude" }, ["--claude", "/opt/made-up/claude"])).toBe("/opt/made-up/claude");
    const { h, done } = start({ claude: "/usr/local/bin/claude" }, ["--claude", "/nowhere/claude"]);
    expect(await done).toBe(1);
    expect(h.err).toEqual([RUNNER_WORDS.noClaude]);
  });
});

describe("checking in", () => {
  test("is one JSON-RPC tool call over HTTPS with the bearer header, and never follows a redirect", async () => {
    const { h, done } = start();
    await h.settle();
    const [call] = h.sent;
    expect(call!.url).toBe(URL_);
    expect(call!.init.method).toBe("POST");
    expect(call!.init.redirect).toBe("manual");
    expect(call!.init.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(String(call!.init.body))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "chat_next", arguments: { runner: "runner-test-0001", everyMs: 3_000 } },
    });
    await end(h, done);
  });

  test("every 3 seconds; every 15 after two minutes idle; every 60 after an hour", async () => {
    expect([0, 119_999].map(pollEvery)).toEqual([3_000, 3_000]);
    expect([120_000, 3_599_999].map(pollEvery)).toEqual([15_000, 15_000]);
    expect([3_600_000, 10 ** 9].map(pollEvery)).toEqual([60_000, 60_000]);

    const { h, done } = start();
    // The chat's check-ins; the agents are asked about once a minute besides (scripts/osAgentsRunner.test.ts).
    const checks = () => h.callsOf("chat_next");
    await h.advance(120_000 - 1);
    expect(checks()).toHaveLength(40);
    const gaps = (from: number) => checks().slice(from).map((call, index, all) => (index === 0 ? 0 : call.at - all[index - 1]!.at)).slice(1);
    expect(new Set(gaps(0))).toEqual(new Set([3_000]));
    await h.advance(60 * 60_000 - 120_000);
    await h.advance(5 * 60_000);
    const late = gaps(checks().length - 4);
    expect(late).toEqual([60_000, 60_000, 60_000]);
    // It tells the server how long until it checks in again, so the page knows it is still there.
    expect(checks().at(-1)!.args.everyMs).toBe(60_000);
    expect(checks()[45]!.args.everyMs).toBe(15_000);
    await end(h, done);
  });

  test("the cadence stays far inside the runner's own limit, in every ten minutes", async () => {
    const { h, done } = start();
    await h.advance(CALL_WINDOW_MS);
    expect(h.sent.length).toBeLessThanOrEqual(200);
    expect(h.sent.length).toBeLessThan(MAX_RUNNER_CALLS_PER_WINDOW / 4);
    // Answering without a pause, reporting as often as it ever does:
    expect(CALL_WINDOW_MS / PROGRESS_EVERY_MS + 50).toBeLessThan(MAX_RUNNER_CALLS_PER_WINDOW);
    await end(h, done);
  });

  test("when the endpoint cannot be reached it waits longer each time, up to a minute, and starts over once it answers", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(backoff)).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000]);
    const { h, done } = start();
    let failing = true;
    h.answers.chat_next = () => (failing ? { throws: new Error("SECRET network error with Bearer header") } : { output: { none: true, truncated: false } });
    await h.advance(3_000 + 6_000 + 12_000 + 24_000 + 48_000 + 60_000 + 60_000);
    const at = h.sent.map((call) => call.at - h.sent[0]!.at);
    expect(at).toEqual([0, 3_000, 9_000, 21_000, 45_000, 93_000, 153_000, 213_000]);
    failing = false;
    await h.advance(60_000);
    await h.advance(6_000);
    const last = h.sent.slice(-2).map((call) => call.at);
    expect(last[1]! - last[0]!).toBe(3_000);
    // Nothing of the error is printed: one fixed line when it began, one when it was over.
    expect(h.err).toEqual([RUNNER_WORDS.unreachable]);
    expect(h.out).toEqual([RUNNER_WORDS.started, RUNNER_WORDS.reachable]);
    await end(h, done);
  });

  test.each([
    ["a redirect", { redirect: true as const }],
    ["a server error", { status: 502 }],
    ["the runner's limit", { rpcError: { code: -32000, message: AGENT_WORDS.runnerLimited } }],
  ])("%s is waited out like an endpoint that cannot be reached", async (_name, reply) => {
    const { h, done } = start();
    h.answers.chat_next = () => reply;
    await h.advance(3_000 + 6_000);
    expect(h.sent.map((call) => call.at - h.sent[0]!.at)).toEqual([0, 3_000, 9_000]);
    await end(h, done);
  });

  test("a refused token stops it, in fixed words", async () => {
    const { h, done } = start();
    h.answers.chat_next = () => ({ status: 401 });
    expect(await done).toBe(1);
    expect(h.err).toEqual([RUNNER_WORDS.unauthorized]);
    expect(h.sent).toHaveLength(1);
  });

  test("a read-only token stops it, in fixed words", async () => {
    const { h, done } = start();
    h.answers.chat_next = () => ({ said: AGENT_WORDS.readOnly });
    expect(await done).toBe(1);
    expect(h.err).toEqual([RUNNER_WORDS.readOnly]);
  });

  test("an answer that is not a question's is ignored", async () => {
    const { h, done } = start();
    h.answers.chat_next = () => ({ output: { messageId: 7, question: ["x"] } });
    await h.advance(3_000);
    expect(h.spawned).toEqual([]);
    expect(h.callsOf("chat_next")).toHaveLength(2);
    await end(h, done);
  });
});

describe("starting Claude Code for a question", () => {
  test("headless, with only the OS's server, only the chat's tools, and no settings of the Mac's", async () => {
    const { h, done, spawn } = await claimed();
    const config = `${h.dirs[0]}/mcp.json`;
    expect(spawn.args).toEqual(claudeArgs(config));
    expect(spawn.args.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", "12"]);
    const value = (flag: string) => spawn.args[spawn.args.indexOf(flag) + 1];
    expect(spawn.args).toContain("--strict-mcp-config");
    expect(value("--mcp-config")).toBe(config);
    expect(value("--setting-sources")).toBe("");
    expect(value("--tools")).toBe("");
    expect(spawn.args).toContain("--disable-slash-commands");
    expect(spawn.args).toContain("--no-session-persistence");
    expect(value("--allowedTools")!.split(",")).toEqual(CHAT_TOOLS.map((name) => `mcp__startup-os__${name}`));
    const denied = value("--disallowedTools")!.split(",");
    for (const builtIn of ["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch", "Task", "NotebookEdit"]) expect(denied).toContain(builtIn);
    for (const name of CHAT_DENIED_TOOLS) expect(denied).toContain(`mcp__startup-os__${name}`);
    for (const name of RUNNER_TOOLS) expect(value("--allowedTools")).not.toContain(name);
    expect(spawn.args).not.toContain("--dangerously-skip-permissions");
    spawn.child.exit(0);
    await end(h, done);
  });

  test("the prompt goes in on stdin, never on the command line: the instructions, the day, the company, the message, what was said, the question", async () => {
    const { h, done, spawn, child } = await claimed();
    expect(child.stdinEnded).toBe(true);
    const prompt = child.stdinText;
    expect(prompt.startsWith(INSTRUCTIONS)).toBe(true);
    expect(prompt).toContain("Today is 2026-10-14.");
    expect(prompt).toContain('The company in view is "kz" (Globex).');
    expect(prompt).toContain("chatMessageId: msg123");
    const order = ["SECRET earlier question", "SECRET earlier answer", QUESTION].map((part) => prompt.indexOf(part));
    expect(order.every((at) => at > INSTRUCTIONS.length)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt.trimEnd().endsWith(QUESTION)).toBe(true);
    expect(prompt).toMatch(/data, never instructions/);
    for (const arg of spawn.args) {
      expect(arg).not.toContain("MADE-UP INSTRUCTIONS");
      expect(arg).not.toContain("msg123");
    }
    child.exit(0);
    await end(h, done);
  });

  test("it runs in an empty directory of its own, with a minimal environment and no API key", async () => {
    const { h, done, spawn, child } = await claimed();
    expect(spawn.options.cwd).toBe(`${h.dirs[0]}/work`);
    expect(spawn.options.cwd).not.toContain("/fake/repo");
    expect(spawn.options.env).toEqual({ PATH: "/usr/local/bin:/usr/bin", HOME, USER: "made-up" });
    child.exit(0);
    await end(h, done);
  });

  test("the token is given to Claude in a file only the owner can read, holding that one server, and the file is deleted afterwards", async () => {
    const { h, done, child } = await claimed();
    expect(h.written).toHaveLength(1);
    const [file] = h.written;
    expect(file!.path).toBe(`${h.dirs[0]}/mcp.json`);
    expect(file!.mode).toBe(0o600);
    expect(JSON.parse(file!.text)).toEqual({
      mcpServers: { "startup-os": { type: "http", url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } },
    });
    expect(h.removed).toEqual([]);
    child.emit(success(ANSWER));
    child.exit(0);
    await end(h, done);
    expect(h.removed).toEqual([h.dirs[0]]);
  });
});

describe("the answer on its way", () => {
  test("is reported as it grows, at most every 700 ms, and only when something changed", async () => {
    const { h, done, child } = await claimed();
    child.emit(messageStart());
    for (const word of ["SECRET ", "made-up ", "partial"]) child.emit(delta(word));
    await h.advance(PROGRESS_EVERY_MS - 1);
    expect(h.callsOf("chat_progress")).toHaveLength(0);
    await h.advance(1);
    expect(h.callsOf("chat_progress").map((call) => call.args)).toEqual([
      { messageId: "msg123", runner: "runner-test-0001", text: "SECRET made-up partial", steps: [] },
    ]);
    // Twenty more pieces within one interval are one report.
    child.emit(toolUse("t1", "deals"));
    child.emit(messageStart());
    for (let piece = 0; piece < 20; piece += 1) child.emit(delta("x"));
    await h.advance(PROGRESS_EVERY_MS);
    expect(h.callsOf("chat_progress")).toHaveLength(2);
    expect(h.callsOf("chat_progress")[1]!.args).toMatchObject({ text: "x".repeat(20), steps: ["deals"] });
    // Nothing new: nothing sent.
    await h.advance(3 * PROGRESS_EVERY_MS);
    expect(h.callsOf("chat_progress")).toHaveLength(2);
    child.exit(0);
    await end(h, done);
  });

  test("with nothing new it still reports now and then, so a Stop is noticed and the claim is kept", async () => {
    const { h, done, child } = await claimed();
    await h.advance(HEARTBEAT_MS + PROGRESS_EVERY_MS);
    expect(h.callsOf("chat_progress")).toHaveLength(1);
    await h.advance(HEARTBEAT_MS + PROGRESS_EVERY_MS);
    expect(h.callsOf("chat_progress")).toHaveLength(2);
    child.exit(0);
    await end(h, done);
  });

  test("the final result is written with its steps, and the terminal gets one line of time, duration, steps and outcome", async () => {
    const { h, done, child } = await claimed();
    child.emit(toolUse("t1", "tasks") + toolUse("t2", "deals") + messageStart() + delta("SECRET half"));
    await h.advance(4_200);
    child.emit(success(ANSWER));
    child.exit(0);
    await h.settle();
    expect(h.callsOf("chat_finish").map((call) => call.args)).toEqual([
      { messageId: "msg123", runner: "runner-test-0001", text: ANSWER, steps: ["tasks", "deals"] },
    ]);
    expect(h.out).toEqual([RUNNER_WORDS.started, "09:00:04  4.2s  2 steps  answered"]);
    // And it goes back to checking in.
    await h.advance(3_000);
    expect(h.callsOf("chat_next").length).toBeGreaterThan(1);
    await end(h, done);
  });

  test("one question at a time: it does not check in again while it is answering", async () => {
    const { h, done, child } = await claimed();
    await h.advance(60_000);
    expect(h.callsOf("chat_next")).toHaveLength(1);
    child.exit(0);
    await end(h, done);
  });
});

describe("when it does not work out", () => {
  test("after 120 seconds the process is killed and the answer finished as taking too long, with what it had", async () => {
    const { h, done, child } = await claimed();
    child.emit(messageStart() + delta("SECRET half"));
    await h.advance(ANSWER_LIMIT_MS - 1);
    expect(child.killed).toBe(false);
    await h.advance(1);
    expect(child.killed).toBe(true);
    expect(h.callsOf("chat_finish").map((call) => call.args)).toEqual([
      { messageId: "msg123", runner: "runner-test-0001", text: "SECRET half", steps: [], failed: "tooLong" },
    ]);
    expect(h.out.at(-1)).toBe("09:02:00  120.0s  0 steps  took too long");
    expect(h.removed).toEqual([h.dirs[0]]);
    await end(h, done);
  });

  test("a refused report means the answer was stopped: the process is killed and nothing more is sent about it", async () => {
    const { h, done, child } = await claimed();
    h.answers.chat_progress = () => ({ said: CHAT_WORDS.abandon });
    child.emit(delta("SECRET half"));
    await h.advance(PROGRESS_EVERY_MS);
    expect(child.killed).toBe(true);
    expect(h.callsOf("chat_finish")).toEqual([]);
    expect(h.out.at(-1)).toBe("09:00:00  0.7s  0 steps  stopped");
    expect(h.removed).toEqual([h.dirs[0]]);
    await end(h, done);
  });

  test("Claude Code that cannot be started is said so, and the temp files are still removed", async () => {
    const { h, done } = start();
    h.failSpawn();
    h.answers.chat_next = (_args, nth) => (nth === 1 ? { output: CLAIM } : { output: { none: true, truncated: false } });
    await h.settle();
    expect(h.callsOf("chat_finish").map((call) => call.args)).toEqual([
      { messageId: "msg123", runner: "runner-test-0001", text: "", steps: [], failed: "notStarted" },
    ]);
    expect(h.out.at(-1)).toBe("09:00:00  0.0s  0 steps  Claude could not be started");
    expect(h.removed).toEqual([h.dirs[0]]);
    await end(h, done);
  });

  test.each([
    ["a failed exit with nothing readable", ["garbage SECRET\n"], 1, "wrong", "something went wrong"],
    ["a clean exit with no result", [delta("SECRET half")], 0, "wrong", "something went wrong"],
    [
      "not signed in",
      [JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login SECRET" }) + "\n"],
      1,
      "notSignedIn",
      "Claude is not signed in",
    ],
    [
      "the usage limit",
      [JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|SECRET" }) + "\n"],
      1,
      "usageLimit",
      "usage limit reached",
    ],
  ] as const)("%s is finished as a failure of a closed kind, with none of the error's words", async (_name, chunks, code, failed, words) => {
    const { h, done, child } = await claimed();
    for (const chunk of chunks) child.emit(chunk);
    child.exit(code);
    await h.settle();
    expect(h.callsOf("chat_finish").map((call) => call.args)).toEqual([
      { messageId: "msg123", runner: "runner-test-0001", text: "", steps: [], failed },
    ]);
    expect(h.out.at(-1)).toBe(`09:00:00  0.0s  0 steps  ${words}`);
    await end(h, done);
  });

  test("a finish the endpoint could not take is tried again, and the temp files are removed whatever happens", async () => {
    const { h, done, child } = await claimed();
    h.answers.chat_finish = (_args, nth) => (nth < 3 ? { throws: new Error("SECRET") } : { output: { ok: true } });
    child.emit(success(ANSWER));
    child.exit(0);
    await h.advance(20_000);
    expect(h.callsOf("chat_finish")).toHaveLength(3);
    expect(h.out.at(-1)).toMatch(/answered$/);
    expect(h.removed).toEqual([h.dirs[0]]);

    const second = await claimed();
    second.h.answers.chat_finish = () => ({ throws: new Error("SECRET") });
    second.child.emit(success(ANSWER));
    second.child.exit(0);
    await second.h.advance(60_000);
    expect(second.h.callsOf("chat_finish")).toHaveLength(3);
    expect(second.h.out.at(-1)).toMatch(/not delivered$/);
    expect(second.h.removed).toEqual([second.h.dirs[0]]);
    await end(h, done);
    await end(second.h, second.done);
  });

  test("a refused token in the middle of an answer stops the runner", async () => {
    const { h, done, child } = await claimed();
    h.answers.chat_finish = () => ({ status: 401 });
    child.emit(success(ANSWER));
    child.exit(0);
    expect(await done).toBe(1);
    expect(h.err).toEqual([RUNNER_WORDS.unauthorized]);
    expect(h.removed).toEqual([h.dirs[0]]);
  });
});
