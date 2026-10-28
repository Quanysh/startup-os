// The chat's runner, on the owner's Mac (docs/assistant.md, "The chat"):
//
//   pnpm assistant:runner            answers questions asked on /assistant
//   pnpm assistant:runner --local    the same, against a local backend
//
// It answers with Claude Code, on the Claude subscription this Mac is signed
// in to. The endpoint and the token are read from Claude Code's own
// configuration (~/.claude.json, the `startup-os` server), where connecting
// Claude on /assistant put them: nothing to set here, and the token is never
// printed. The logic, and everything it must not do, is in assistantRunner.ts.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { run, type Child } from "./assistantRunner";

let stopped = false;
/** Waits in progress, so a stop ends them at once. */
const waiting = new Set<() => void>();
let current: { kill: () => void } | null = null;

function start(command: string, args: string[], options: { cwd: string; env: Record<string, string> }): Child {
  // Its error output goes nowhere: it can hold anything, and none of it is used.
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(command, args, {
    cwd: options.cwd,
    // These few variables and no others: nothing of the shell's own is passed on.
    env: options.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdout.setEncoding("utf8");
  const kill = () => void child.kill("SIGKILL");
  current = { kill };
  return {
    stdin: {
      // A program that has already gone cannot be written to: the exit says so.
      write: (text) => void child.stdin.write(text, () => {}),
      end: () => child.stdin.end(),
    },
    onStdout: (listener) => void child.stdout.on("data", listener),
    exited: new Promise((resolve) => {
      child.on("error", () => resolve({ code: null }));
      child.on("close", (code) => resolve({ code }));
      child.stdin.on("error", () => {});
    }),
    kill,
  };
}

async function main(): Promise<void> {
  const home = homedir();
  const stop = () => {
    stopped = true;
    current?.kill();
    for (const wake of [...waiting]) wake();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.exitCode = await run(
    process.argv.slice(2),
    process.env,
    {
      home,
      configPath: join(home, ".claude.json"),
      instructionsPath: join(process.cwd(), "docs", "agents", "chat.md"),
    },
    {
      readFile: (path) => readFileSync(path, "utf8"),
      fileMode: (path) => statSync(path).mode & 0o777,
      fetch,
      spawn: start,
      writeFile: (path, text, mode) => {
        writeFileSync(path, text, { mode, flag: "wx" });
        chmodSync(path, mode);
      },
      makeTempDir: () => mkdtempSync(join(tmpdir(), "startup-os-chat-")),
      makeDir: (path) => void mkdirSync(path, { mode: 0o700 }),
      remove: (path) => rmSync(path, { recursive: true, force: true }),
      exists: (path) => existsSync(path),
      now: () => Date.now(),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            waiting.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, ms);
          waiting.add(wake);
          if (stopped) wake();
        }),
      timeLabel: (at) => new Date(at).toTimeString().slice(0, 8),
      print: (line) => console.log(line),
      printError: (line) => console.error(line),
      newId: () => `runner-${randomBytes(8).toString("hex")}`,
      stopped: () => stopped,
    },
  );
  process.exit();
}

main().catch(() => {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The runner stopped unexpectedly.");
  process.exit(1);
});
