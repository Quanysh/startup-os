// `pnpm assistant:runner:install` and `:uninstall`: a per-user launchd agent
// that starts the chat's runner (scripts/assistantRunner.ts) when the owner
// logs in to his Mac and keeps it running.
//
// It writes or removes one file under ~/Library/LaunchAgents and prints the
// two `launchctl` commands for the owner to run himself. **It starts and
// stops nothing**: it is given no way to run a program. The file holds paths
// and no secret: the runner finds the token in Claude Code's own
// configuration when it starts.

import { LAUNCHD_LABEL, PRODUCT } from "../convex/lib/identity";

export const LABEL = LAUNCHD_LABEL;

type Where = {
  home: string;
  /** This checkout: the runner's working directory. */
  repo: string;
  /** The node program running this script, by its absolute path. */
  node: string;
};

export type LaunchdDeps = {
  exists: (path: string) => boolean;
  writeFile: (path: string, text: string, mode: number) => void;
  makeDir: (path: string) => void;
  remove: (path: string) => void;
  print: (line: string) => void;
  printError: (line: string) => void;
};

const plistPath = (home: string) => `${home}/Library/LaunchAgents/${LABEL}.plist`;
const logPath = (home: string) => `${home}/Library/Logs/${PRODUCT.slug}-assistant.log`;
const tsxOf = (repo: string) => `${repo}/node_modules/tsx/dist/cli.mjs`;
const scriptOf = (repo: string) => `${repo}/scripts/assistant-runner.ts`;

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The agent's property list. Every path is absolute: launchd has no shell and almost no PATH. */
export function plist(where: Where & { tsx: string }): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const nodeDir = where.node.slice(0, where.node.lastIndexOf("/"));
  const path = [nodeDir, `${where.home}/.local/bin`, "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${string(LABEL)}
    <key>ProgramArguments</key>
    <array>
      ${string(where.node)}
      ${string(where.tsx)}
      ${string(scriptOf(where.repo))}
    </array>
    <key>WorkingDirectory</key>
    ${string(where.repo)}
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      ${string(where.home)}
      <key>PATH</key>
      ${string(path)}
    </dict>
    <key>StandardOutPath</key>
    ${string(logPath(where.home))}
    <key>StandardErrorPath</key>
    ${string(logPath(where.home))}
  </dict>
</plist>
`;
}

const commands = (home: string) => ({
  load: `launchctl bootstrap gui/$(id -u) "${plistPath(home)}"`,
  unload: `launchctl bootout gui/$(id -u)/${LABEL}`,
});

/** Write the agent's file and print how to load it. Returns the exit code. */
export function install(argv: string[], where: Where, deps: LaunchdDeps): number {
  if (argv.length > 0) {
    deps.printError("Usage: pnpm assistant:runner:install");
    return 1;
  }
  const tsx = tsxOf(where.repo);
  if (![where.node, tsx, scriptOf(where.repo)].every((path) => deps.exists(path))) {
    deps.printError("Run this from the repository, after pnpm install: node, tsx or the runner script was not found.");
    return 1;
  }
  const path = plistPath(where.home);
  deps.makeDir(`${where.home}/Library/LaunchAgents`);
  deps.writeFile(path, plist({ ...where, tsx }), 0o644);
  const { load, unload } = commands(where.home);
  deps.print(`Wrote ${path}`);
  deps.print("Nothing was started. To start the runner now and at every login, run:");
  deps.print(`  ${load}`);
  deps.print("To stop it:");
  deps.print(`  ${unload}`);
  deps.print(`It logs to ${logPath(where.home)}: a line when it starts and a line an answer, never a question or an answer.`);
  return 0;
}

/** Remove the agent's file and print how to stop the one running. Returns the exit code. */
export function uninstall(argv: string[], where: Where, deps: LaunchdDeps): number {
  if (argv.length > 0) {
    deps.printError("Usage: pnpm assistant:runner:uninstall");
    return 1;
  }
  const path = plistPath(where.home);
  if (!deps.exists(path)) {
    deps.print("The runner's launchd agent is not installed: there is nothing to remove.");
    return 0;
  }
  deps.remove(path);
  deps.print(`Removed ${path}`);
  deps.print("Nothing was stopped. If the runner is running, stop it with:");
  deps.print(`  ${commands(where.home).unload}`);
  return 0;
}
