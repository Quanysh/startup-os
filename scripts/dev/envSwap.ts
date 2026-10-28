// Keeping a developer's cloud `.env.local` safe while the local backend runs.
//
// The Convex CLI reads and writes `.env.local` and nothing else: it has no
// option to keep a local backend's settings in another file. So `pnpm
// dev:local` moves a cloud `.env.local` to `.env.local.cloud` before it
// starts, lets the CLI write a local one, and moves the cloud one back when
// it stops, however it stops. Both names are git-ignored (`.env.*`).
//
// If the command is killed outright (no chance to clean up), the cloud file
// is still whole in `.env.local.cloud`, and the next `pnpm dev:local` puts it
// back when it stops. Nothing is ever deleted that was not written here.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isLocalEnvFile } from "./guard";

export const ENV_LOCAL = ".env.local";
export const ENV_BACKUP = ".env.local.cloud";

export type SwapState = {
  /** `.env.local` as it is now, or null when there is none. */
  envLocal: string | null;
  /** Whether `.env.local.cloud` exists. */
  backup: boolean;
};

export type SwapPlan =
  /**
   * "set_aside": a cloud file to move aside now, and bring back at the end.
   * "none" with `restore`: an earlier run left the cloud file aside; leave it
   * there and bring it back at the end. "none" without: nothing to keep safe.
   */
  | { action: "set_aside" | "none"; restore: boolean }
  | { action: "refuse"; reason: string };

/** What to do with `.env.local` before the local backend starts. Pure. */
export function planSwap(state: SwapState): SwapPlan {
  const cloud = state.envLocal !== null && !isLocalEnvFile(state.envLocal);
  if (cloud && state.backup) {
    return {
      action: "refuse",
      reason: `Both ${ENV_LOCAL} and ${ENV_BACKUP} hold a configuration that is not local, and this command will not choose between them. Keep the one you want as ${ENV_LOCAL}, move or delete the other, and run this again.`,
    };
  }
  if (cloud) return { action: "set_aside", restore: true };
  return { action: "none", restore: state.backup };
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** `.env.local` and `.env` of a project folder, as the guard reads them. */
export function readEnvFiles(root: string): { envLocal: string | null; env: string | null } {
  return { envLocal: read(join(root, ENV_LOCAL)), env: read(join(root, ".env")) };
}

/**
 * Apply the plan, and return the function that undoes it. The undo is safe to
 * call more than once and from an exit handler: it is one synchronous rename.
 */
export function swapEnvLocal(
  root: string,
): { ok: true; kept: boolean; restore: () => void } | { ok: false; reason: string } {
  const local = join(root, ENV_LOCAL);
  const backup = join(root, ENV_BACKUP);
  const plan = planSwap({ envLocal: read(local), backup: existsSync(backup) });
  if (plan.action === "refuse") return { ok: false, reason: plan.reason };
  if (plan.action === "set_aside") renameSync(local, backup);

  let done = !plan.restore;
  return {
    ok: true,
    /** Whether a cloud file is being kept aside, by this run or an earlier one. */
    kept: plan.restore,
    restore: () => {
      if (done) return;
      done = true;
      // Over the local file the CLI wrote, which the next run writes again.
      if (existsSync(backup)) renameSync(backup, local);
    },
  };
}
