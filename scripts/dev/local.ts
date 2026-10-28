// pnpm dev:local
//
// The whole app on this machine, with made-up data and no cloud: a local
// Convex backend (`CONVEX_AGENT_MODE=anonymous`: no account, no login) and
// Next.js on http://localhost:3100. Nothing here can reach a cloud
// deployment (scripts/dev/guard.ts says how that is held).
//
// What it does, in order:
//   1. sets a cloud `.env.local` aside as `.env.local.cloud`, to bring it back
//      when it stops (scripts/dev/envSwap.ts);
//   2. pushes the functions to the local backend, which writes a local
//      `.env.local`;
//   3. sets the local backend's variables: the made-up owner, the site
//      address, and signing keys made here on the first run;
//   4. on the first run, fills it with the made-up data set (`pnpm dev:seed`
//      does the same later, to reset);
//   5. runs `convex dev` and `next dev` until Ctrl-C.
//
// Sign in from a second terminal with `pnpm dev:signin`.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_OWNER_EMAIL } from "../../convex/lib/devLocal";
import { ROOT, bin, convex, requireLocalTarget, stop } from "./convexCli";
import { printCounts } from "./counts";
import { readEnvFiles, swapEnvLocal } from "./envSwap";
import {
  appEnv,
  childEnv,
  convexArgs,
  localTarget,
  startPlan,
  type Env,
  type Target,
} from "./guard";
import { APP_URL, envFileText, envNames, newSigningKeys } from "./session";

/** Set the local backend's variables. Returns whether this was its first setup. */
function setUp(target: Target): boolean {
  const listed = convex({ kind: "envList" }, target, { quiet: true });
  if (!listed.ok) stop("The local backend did not answer. Look at the output above.");
  const names = envNames(listed.stdout);
  const first = !names.includes("JWT_PRIVATE_KEY") || !names.includes("JWKS");

  // Written to a private file and handed over by name, so a key is never on
  // a command line. The local owner is set every time: it is what makes the
  // seed and the sign-in willing to run (convex/lib/devLocal.ts).
  const folder = mkdtempSync(join(tmpdir(), "startup-os-dev-"));
  const file = join(folder, "local.env");
  try {
    writeFileSync(
      file,
      envFileText({
        OWNER_EMAILS: LOCAL_OWNER_EMAIL,
        SITE_URL: APP_URL.replace(/\/$/, ""),
        ...(first ? newSigningKeys() : null),
      }),
      { mode: 0o600 },
    );
    if (!convex({ kind: "envSetFile", file }, target, { quiet: true }).ok) {
      stop("The local backend's variables could not be set.");
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return first;
}

const onWindows = process.platform === "win32";

/**
 * Start a tool that keeps running, in a process group of its own: `convex dev`
 * runs the local backend as a child, and stopping the group stops both. It is
 * given no keyboard, so Ctrl-C comes to this command, which passes it on.
 */
function start(command: string, args: string[], env: Env): ChildProcess {
  return spawn(command, args, {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    shell: onWindows,
    detached: !onWindows,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** Signal a started tool and everything it started. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    if (onWindows) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function main() {
  const plan = startPlan({ shell: process.env, ...readEnvFiles(ROOT) });
  if (!plan.ok) stop(plan.reason);
  const swap = swapEnvLocal(ROOT);
  if (!swap.ok) stop(swap.reason);
  // From here on, however this ends, a cloud `.env.local` goes back.
  process.on("exit", swap.restore);
  if (swap.kept) console.log("Your .env.local is kept as .env.local.cloud until this stops.");

  // Stopping: ask both tools to stop as Ctrl-C would, wait for them, make
  // sure nothing of theirs is left running (the local backend above all),
  // put `.env.local` back, and go.
  const children: ChildProcess[] = [];
  let ending = false;
  const end = (code: number) => {
    if (ending) return;
    ending = true;
    const running = children.filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    for (const child of running) signalTree(child, "SIGINT");
    const leave = () => {
      for (const child of children) signalTree(child, "SIGKILL");
      swap.restore();
      process.exit(code);
    };
    const patience = setTimeout(leave, 8_000);
    void Promise.all(
      running.map((child) => new Promise((done) => child.once("exit", done))),
    ).then(() => {
      clearTimeout(patience);
      // A moment for the backend to close its files once `convex dev` has gone.
      setTimeout(leave, 500);
    });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => end(0));

  console.log("Starting the local backend…");
  // Before the first run there is no local deployment to name: anonymous
  // mode makes one. (`startPlan` has already refused anything not local.)
  const known = localTarget({ shell: process.env, ...readEnvFiles(ROOT) });
  if (!convex({ kind: "push" }, known.ok ? known.target : null).ok) {
    stop("The functions could not be pushed to the local backend. Look at the output above.");
  }
  // Read again: this is the file the CLI just wrote, and it must say "local".
  const target = requireLocalTarget();

  if (setUp(target)) {
    console.log("First run here: filling the local backend with made-up data…");
    const seeded = convex({ kind: "run", fn: "devSeed:run", args: {} }, target);
    if (!seeded.ok) stop("The made-up data could not be written. Look at the output above.");
    printCounts(seeded.stdout);
  }

  children.push(
    start(bin("convex"), convexArgs({ kind: "watch" }), childEnv(process.env, target)),
    start(bin("next"), ["dev", "--port", "3100"], appEnv(process.env, target)),
  );
  console.log(`\nThe app will be at ${APP_URL}`);
  console.log("Sign in from a second terminal:  pnpm dev:signin   (or: pnpm dev:signin sales --company us)\n");
  // If either stops on its own, the other is no use alone.
  for (const child of children) child.once("exit", (code) => end(code ?? 1));
}

main();
