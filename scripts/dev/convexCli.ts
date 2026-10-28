// The door from the developer commands to the Convex CLI. Every call is one
// of `ConvexCall` (scripts/dev/guard.ts), runs in the pinned environment
// (`childEnv`), and is made only after the caller has a local target in hand.
// (`pnpm dev:local` starts its one long-running call, `convex dev`, itself,
// from the same list and in the same environment.)

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { childEnv, convexArgs, localTarget, type ConvexCall, type Env, type Target } from "./guard";
import { readEnvFiles } from "./envSwap";

/** The project folder: where `package.json`, `convex/` and `.env.local` are. */
export const ROOT = process.cwd();

/** Print why and stop. Used for every refusal, so each ends the same way. */
export function stop(reason: string): never {
  console.error(`\n${reason}\n`);
  process.exit(1);
}

/** The local backend this folder is set up for, or stop with the reason. */
export function requireLocalTarget(): Target {
  const verdict = localTarget({ shell: process.env, ...readEnvFiles(ROOT) });
  if (!verdict.ok) stop(verdict.reason);
  return verdict.target;
}

/** A tool installed with the project, run directly so a signal reaches it (not a wrapper). */
export const bin = (name: "convex" | "next") => join(ROOT, "node_modules", ".bin", name);
const onWindows = process.platform === "win32";

/**
 * Run one CLI call to its end and return what it printed. `quiet` keeps the
 * CLI's own chatter off the terminal (and a value it prints out of it).
 */
export function convex(
  call: ConvexCall,
  target: Pick<Target, "deployment"> | null,
  options: { quiet?: boolean; shell?: Env } = {},
): { ok: boolean; stdout: string } {
  const result = spawnSync(bin("convex"), convexArgs(call), {
    shell: onWindows,
    cwd: ROOT,
    // (Next widens ProcessEnv with a required NODE_ENV; the child inherits the shell's.)
    env: childEnv(options.shell ?? process.env, target) as NodeJS.ProcessEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "inherit"],
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}
