// Gather engineering signals from GitHub and push them to the OS
// (docs/setup.md, "GitHub").
//
//   pnpm gather:github           read GitHub, check, and say what was counted
//   pnpm gather:github --send    the same, then post the three envelopes
//
// GitHub is read only through the GitHub CLI (`gh api graphql`), which must be
// signed in on this machine (`gh auth status`). `gh` holds its own credential:
// this script never reads one, is never handed one and never prints one. Every
// query is a read, and none asks for code, a diff, a description, a comment,
// a file list, a branch name or a commit message (the four queries are in
// githubGather.ts, written out). Since the owner asked for the Engineering
// page, two of them ask for a pull request's title, its author and its
// requested reviewers, for the ones that are open or were closed lately.
//
// It prints counts only: never a title, a login or a name. If any call to
// GitHub fails, nothing is sent.
//
// Reads STARTUP_OS_INGEST_URL and INGEST_TOKEN_GITHUB from the environment, or
// from an untracked .env.push file next to package.json, when sending. The
// logic is in githubGather.ts; this wrapper supplies the real `gh`, network
// and clock.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { run, type Gh } from "./githubGather";

/** Long enough for GitHub's slowest page; short enough that a hung call ends. */
const GH_TIMEOUT_MS = 30_000;
/** A page of 100 rows is a few tens of kilobytes. Past this, it is not a page. */
const GH_MAX_BYTES = 16 * 1024 * 1024;

/**
 * `gh` as a child process, given its arguments as a list: no shell reads
 * them. It is not given this script's own secrets (the ingest tokens and the
 * endpoint .env.push holds); everything else it inherits, so it finds its
 * own sign-in. Any failure is `ok: false`, and what `gh` wrote about it is
 * dropped: an error from GitHub can quote what was asked.
 */
function realGh(): Gh {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("INGEST_TOKEN_") || name === "STARTUP_OS_INGEST_URL") delete env[name];
  }
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "gh",
        [...args],
        { encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BYTES, env, windowsHide: true },
        (error, stdout) => resolve(error ? { ok: false } : { ok: true, stdout }),
      );
    });
}

async function main(): Promise<void> {
  // Said here rather than with an `engines` range in package.json, which on
  // Vercel can change the Node version the app itself is built with.
  if (typeof process.loadEnvFile !== "function") {
    console.error("This script needs a Node version with process.loadEnvFile (20.12+, or 21.7+).");
    process.exitCode = 1;
    return;
  }

  // A missing file is fine: the variables may come from the environment. One
  // that is there but cannot be read is reported, never skipped. A variable
  // already set in the environment wins over the file's.
  if (existsSync(".env.push")) {
    try {
      process.loadEnvFile(".env.push");
    } catch {
      console.error("Could not read .env.push.");
      process.exitCode = 1;
      return;
    }
  }

  // exitCode, not process.exit(): exiting can cut off output still being
  // written to a pipe.
  process.exitCode = await run(process.argv.slice(2), process.env, {
    gh: realGh(),
    fetch,
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
    now: () => new Date(),
  });
}

main().catch(() => {
  // Fixed text: nothing that failed here is safe to quote.
  console.error("The gather failed.");
  process.exitCode = 1;
});
