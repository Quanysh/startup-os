// What the runner's tests share: a clock that moves only when told, a
// made-up OS endpoint, a made-up Claude process and a made-up disk. Nothing
// here starts a program, opens a socket or reads a real file.

import { PRODUCTION_URL, SERVER_NAME } from "./assistantConfig";
import type { Child, RunnerDeps } from "./assistantRunner";

export const T0 = Date.UTC(2026, 9, 14, 9, 0, 0);
export const TOKEN = "sosa_fake-agent-token-0123456789-abcdefghijklmnopq";
export const URL_ = PRODUCTION_URL;
export const HOME = "/fake/home";
export const PATHS = {
  home: HOME,
  configPath: `${HOME}/.claude.json`,
  instructionsPath: "/fake/repo/docs/agents/chat.md",
};
export const INSTRUCTIONS = "MADE-UP INSTRUCTIONS: answer only from tool results.";
export const QUESTION = "SECRET made-up question about a clinic?";
export const ANSWER = "SECRET made-up answer.";
export const CLAIM = {
  messageId: "msg123",
  threadId: "thread123",
  company: "kz",
  question: QUESTION,
  history: [
    { role: "user", text: "SECRET earlier question" },
    { role: "assistant", text: "SECRET earlier answer" },
  ],
  today: "2026-10-14",
  truncated: false,
};

export type ToolReply =
  | { output: Record<string, unknown> }
  | { said: string }
  | { rpcError: { code: number; message: string } }
  | { status: number }
  | { throws: unknown }
  | { redirect: true };

type Sent = { url: string; init: RequestInit; name: string; args: Record<string, unknown>; at: number };

const settle = async () => {
  for (let turn = 0; turn < 60; turn += 1) await Promise.resolve();
};

export function harness(options: { claude?: string | null; config?: string | null; env?: Record<string, string> } = {}) {
  let now = T0;
  let stopped = false;
  const sleepers: { at: number; wake: () => void }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sent: Sent[] = [];
  const spawned: { command: string; args: string[]; options: { cwd: string; env: Record<string, string> }; child: FakeChild }[] = [];
  const written: { path: string; text: string; mode: number }[] = [];
  const removed: string[] = [];
  const dirs: string[] = [];
  let spawnThrows = false;

  /** How the made-up endpoint answers each tool. A test replaces entries. */
  const answers: Record<string, (args: Record<string, unknown>, nth: number) => ToolReply> = {
    chat_next: () => ({ output: { none: true, truncated: false } }),
    chat_progress: () => ({ output: { ok: true, truncated: false } }),
    chat_finish: () => ({ output: { ok: true, truncated: false } }),
    // Startup OS's own four agents on the Mac (scripts/osAgentsRunner.ts): none due unless a test says so.
    os_agents_due: () => ({ output: { none: true, runs: [], truncated: false } }),
    os_agent_start: () => ({ output: { ok: true, truncated: false } }),
    os_agent_finish: () => ({ output: { ok: true, truncated: false } }),
  };
  const counts: Record<string, number> = {};

  const fetchFake = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
    const { name, arguments: args } = body.params;
    sent.push({ url: String(url), init: init!, name, args, at: now });
    counts[name] = (counts[name] ?? 0) + 1;
    const reply = answers[name]!(args, counts[name]!);
    if ("throws" in reply) throw reply.throws;
    if ("redirect" in reply) return new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } });
    if ("status" in reply) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "no" } }), { status: reply.status });
    if ("rpcError" in reply) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: reply.rpcError }));
    const result =
      "said" in reply
        ? { content: [{ type: "text", text: reply.said }], isError: true }
        : { content: [{ type: "text", text: JSON.stringify(reply.output) }], structuredContent: reply.output, isError: false };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  };

  type FakeChild = Child & {
    stdinText: string;
    stdinEnded: boolean;
    killed: boolean;
    emit: (chunk: string) => void;
    exit: (code: number | null) => void;
  };
  const makeChild = (): FakeChild => {
    let listener: (chunk: string) => void = () => {};
    let finish!: (value: { code: number | null }) => void;
    const child: FakeChild = {
      stdinText: "",
      stdinEnded: false,
      killed: false,
      stdin: {
        write: (text) => void (child.stdinText += text),
        end: () => void (child.stdinEnded = true),
      },
      onStdout: (cb) => void (listener = cb),
      exited: new Promise((resolve) => (finish = resolve)),
      kill: () => {
        child.killed = true;
        finish({ code: null });
      },
      emit: (chunk) => listener(chunk),
      exit: (code) => finish({ code }),
    };
    return child;
  };

  const config =
    options.config === undefined
      ? JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "http", url: URL_, headers: { Authorization: `Bearer ${TOKEN}` } } } })
      : options.config;
  const claude = options.claude === undefined ? "/usr/local/bin/claude" : options.claude;

  const deps: RunnerDeps = {
    readFile: (path) => {
      if (path === PATHS.configPath && config !== null) return config;
      if (path === PATHS.instructionsPath) return INSTRUCTIONS;
      throw new Error("ENOENT");
    },
    fileMode: () => 0o600,
    fetch: fetchFake as unknown as typeof fetch,
    spawn: (command, args, spawnOptions) => {
      if (spawnThrows) throw new Error("ENOENT SECRET spawn error");
      const child = makeChild();
      spawned.push({ command, args, options: spawnOptions, child });
      return child;
    },
    writeFile: (path, text, mode) => void written.push({ path, text, mode }),
    makeTempDir: () => {
      const dir = `/fake/tmp/startup-os-chat-${dirs.length + 1}`;
      dirs.push(dir);
      return dir;
    },
    makeDir: () => {},
    remove: (path) => void removed.push(path),
    exists: (path) => path === claude,
    now: () => now,
    sleep: (ms) => new Promise<void>((wake) => sleepers.push({ at: now + ms, wake })),
    timeLabel: (at) => new Date(at).toISOString().slice(11, 19),
    print: (line) => void out.push(line),
    printError: (line) => void err.push(line),
    newId: () => "runner-test-0001",
    stopped: () => stopped,
  };

  /** Move the clock on, waking each sleeper when its time comes, in order. */
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      await settle();
      const due = sleepers.filter((sleeper) => sleeper.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      sleepers.splice(sleepers.indexOf(due), 1);
      now = Math.max(now, due.at);
      due.wake();
    }
    now = end;
    await settle();
  }

  return {
    deps,
    out,
    err,
    sent,
    spawned,
    written,
    removed,
    dirs,
    answers,
    advance,
    settle,
    now: () => now,
    stop: () => void (stopped = true),
    failSpawn: () => void (spawnThrows = true),
    callsOf: (name: string) => sent.filter((call) => call.name === name),
    printed: () => [...out, ...err].join("\n"),
    env: { PATH: "/usr/local/bin:/usr/bin", HOME, USER: "made-up", ANTHROPIC_API_KEY: "sk-ant-NEVER-PASSED", SECRET_OTHER: "NEVER PASSED", ...options.env },
  };
}

export type Harness = ReturnType<typeof harness>;

export const line = (value: unknown) => `${JSON.stringify(value)}\n`;
export const delta = (text: string) =>
  line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
export const messageStart = () => line({ type: "stream_event", event: { type: "message_start" } });
export const toolUse = (id: string, name: string) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__startup-os__${name}`, input: { company: "kz" } }] } });
export const success = (text: string) => line({ type: "result", subtype: "success", is_error: false, result: text });
