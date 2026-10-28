// Keep the chat's runner going across logins (docs/assistant.md, "The chat"):
//
//   pnpm assistant:runner:install     writes ~/Library/LaunchAgents/<LAUNCHD_LABEL>.plist (convex/lib/identity.ts)
//   pnpm assistant:runner:uninstall   removes it
//
// Either prints the `launchctl` command to run yourself. Neither starts or
// stops anything. The logic is in assistantLaunchd.ts.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { install, uninstall } from "./assistantLaunchd";

const [command, ...argv] = process.argv.slice(2);
const where = { home: homedir(), repo: process.cwd(), node: process.execPath };
const deps = {
  exists: (path: string) => existsSync(path),
  writeFile: (path: string, text: string, mode: number) => writeFileSync(path, text, { mode }),
  makeDir: (path: string) => void mkdirSync(path, { recursive: true }),
  remove: (path: string) => rmSync(path, { force: true }),
  print: (line: string) => console.log(line),
  printError: (line: string) => console.error(line),
};

try {
  if (command === "install") process.exitCode = install(argv, where, deps);
  else if (command === "uninstall") process.exitCode = uninstall(argv, where, deps);
  else {
    console.error("Usage: pnpm assistant:runner:install | pnpm assistant:runner:uninstall");
    process.exitCode = 1;
  }
} catch {
  console.error("That could not be done.");
  process.exitCode = 1;
}
