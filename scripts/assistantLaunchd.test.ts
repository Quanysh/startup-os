import { describe, expect, test } from "vitest";
import * as launchd from "./assistantLaunchd";
import { LABEL, install, plist, uninstall } from "./assistantLaunchd";

// The keep-alive helper writes one file and prints two commands. It runs
// nothing: there is no way for it to start a program. The disk here is made up.

const HOME = "/Users/made-up";
const REPO = "/Users/made-up/code/startup & os";
const NODE = "/opt/made-up/node/bin/node";
const PLIST = `${HOME}/Library/LaunchAgents/ai.startup.os.assistant.plist`;
const TSX = `${REPO}/node_modules/tsx/dist/cli.mjs`;

function disk(present: string[] = [NODE, TSX, `${REPO}/scripts/assistant-runner.ts`]) {
  const files = new Map<string, { text: string; mode: number }>();
  const dirs: string[] = [];
  const removed: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    files,
    dirs,
    removed,
    out,
    err,
    deps: {
      exists: (path: string) => present.includes(path) || files.has(path),
      writeFile: (path: string, text: string, mode: number) => void files.set(path, { text, mode }),
      makeDir: (path: string) => void dirs.push(path),
      remove: (path: string) => {
        removed.push(path);
        files.delete(path);
      },
      print: (line: string) => void out.push(line),
      printError: (line: string) => void err.push(line),
    },
  };
}
const where = { home: HOME, repo: REPO, node: NODE };

describe("the launchd agent", () => {
  test("starts the runner at login and keeps it running, from the repository, logging to the user's own log", () => {
    const text = plist({ ...where, tsx: TSX });
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const value = (key: string) => text.split(`<key>${key}</key>`)[1]!.trim().split("\n")[0]!.trim();
    expect(value("Label")).toBe(`<string>${LABEL}</string>`);
    expect(LABEL).toBe("ai.startup.os.assistant");
    expect(value("RunAtLoad")).toBe("<true/>");
    expect(value("KeepAlive")).toBe("<true/>");
    expect(value("WorkingDirectory")).toBe("<string>/Users/made-up/code/startup &amp; os</string>");
    expect(value("StandardOutPath")).toBe("<string>/Users/made-up/Library/Logs/startup-os-assistant.log</string>");
    expect(value("StandardErrorPath")).toBe("<string>/Users/made-up/Library/Logs/startup-os-assistant.log</string>");
    // Absolute paths, resolved when it was installed: launchd has no shell and almost no PATH.
    const args = [...text.split("<key>ProgramArguments</key>")[1]!.split("</array>")[0]!.matchAll(/<string>(.*)<\/string>/g)].map((m) => m[1]);
    expect(args).toEqual([
      NODE,
      "/Users/made-up/code/startup &amp; os/node_modules/tsx/dist/cli.mjs",
      "/Users/made-up/code/startup &amp; os/scripts/assistant-runner.ts",
    ]);
    expect(text).toContain("<string>/opt/made-up/node/bin:/Users/made-up/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(text).toContain(`<key>HOME</key>\n      <string>${HOME}</string>`);
    // No token, no key, and nothing that would pass one.
    expect(text).not.toMatch(/sosa_|TOKEN|API_KEY|Bearer/);
  });

  test("install writes that one file and prints the two commands, without running them", () => {
    const d = disk();
    expect(install([], where, d.deps)).toBe(0);
    expect([...d.files.keys()]).toEqual([PLIST]);
    expect(d.files.get(PLIST)).toEqual({ text: plist({ ...where, tsx: TSX }), mode: 0o644 });
    expect(d.dirs).toEqual([`${HOME}/Library/LaunchAgents`]);
    const printed = d.out.join("\n");
    expect(printed).toContain(`launchctl bootstrap gui/$(id -u) "${PLIST}"`);
    expect(printed).toContain(`launchctl bootout gui/$(id -u)/${LABEL}`);
    expect(printed).toMatch(/Nothing was started/);
    expect(d.err).toEqual([]);
  });

  test("the module has no way to start a program", () => {
    expect(Object.keys(launchd).sort()).toEqual(["LABEL", "install", "plist", "uninstall"]);
    const d = disk();
    expect(Object.keys(d.deps).sort()).toEqual(["exists", "makeDir", "print", "printError", "remove", "writeFile"]);
  });

  test("install refuses when the pieces it would point at are missing, and writes nothing", () => {
    for (const missing of [NODE, TSX, `${REPO}/scripts/assistant-runner.ts`]) {
      const d = disk([NODE, TSX, `${REPO}/scripts/assistant-runner.ts`].filter((path) => path !== missing));
      expect(install([], where, d.deps)).toBe(1);
      expect(d.files.size).toBe(0);
      expect(d.err).toHaveLength(1);
    }
    const d = disk();
    expect(install(["--now"], where, d.deps)).toBe(1);
    expect(d.files.size).toBe(0);
  });

  test("uninstall removes the file, says how to stop the one that is running, and is content when there is none", () => {
    const d = disk();
    install([], where, d.deps);
    d.out.length = 0;
    expect(uninstall([], where, d.deps)).toBe(0);
    expect(d.removed).toEqual([PLIST]);
    expect(d.out.join("\n")).toContain(`launchctl bootout gui/$(id -u)/${LABEL}`);
    const none = disk();
    expect(uninstall([], where, none.deps)).toBe(0);
    expect(none.removed).toEqual([]);
    expect(none.out.join("\n")).toMatch(/not installed/);
  });
});
