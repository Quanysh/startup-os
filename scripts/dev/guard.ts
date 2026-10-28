// The local-only guard of the three developer commands (`pnpm dev:local`,
// `dev:seed`, `dev:signin`). They wipe tables, set an owner and mint sessions,
// so they must never reach anything but a backend on this machine.
//
// The Convex CLI decides where it writes from four places, in this order: a
// deploy key or a self-hosted address (in the shell, `.env.local` or `.env`),
// then `CONVEX_DEPLOYMENT` (the shell first, then `.env.local`, then `.env`).
// So this module reads the same three places the same way, and:
//
//   1. refuses if any of them holds a deploy key or a self-hosted address,
//      whatever else is set: those win over everything;
//   2. refuses unless `CONVEX_DEPLOYMENT` begins with `anonymous:` or
//      `local:`, and the backend's address is `127.0.0.1` or `localhost`;
//   3. hands the CLI an environment in which those answers are pinned
//      (`childEnv`), so nothing read later can change them;
//   4. builds every CLI call from a fixed list (`convexArgs`): no command
//      here can carry `--prod`, `--url`, `--env-file` or any other flag that
//      chooses a deployment, because none takes a flag from the caller.
//
// The functions the commands call check again inside the backend
// (convex/lib/devLocal.ts). Pure: no file or process is touched here.

import { isLocalDeployment, isLocalUrl } from "../../convex/lib/devLocal";

/** Variables that point the Convex CLI at a deployment whatever `CONVEX_DEPLOYMENT` says. */
export const SELECTORS = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
] as const;

const DEPLOYMENT = "CONVEX_DEPLOYMENT";
const URL_VAR = "NEXT_PUBLIC_CONVEX_URL";
const SITE_VAR = "NEXT_PUBLIC_CONVEX_SITE_URL";

export type Env = Record<string, string | undefined>;

/** The three places the Convex CLI reads its target from. A file that does not exist is null. */
export type Where = { shell: Env; envLocal: string | null; env: string | null };

type Place = "your shell" | ".env.local" | ".env";

/** A dotenv file's variables: `NAME=value` lines, quotes removed, comments and blanks skipped. */
export function parseEnv(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (line.startsWith("#") || match === null) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      // An unquoted value ends at a comment.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    found[match[1]!] = value;
  }
  return found;
}

/**
 * A variable as the Convex CLI would see it: the shell's if the shell has
 * one at all (even empty: dotenv never overrides), else `.env.local`'s, else
 * `.env`'s. Empty counts as unset, as it does for the CLI.
 */
function read(where: Where, name: string): { value: string; from: Place } | null {
  const files = {
    ".env.local": where.envLocal === null ? {} : parseEnv(where.envLocal),
    ".env": where.env === null ? {} : parseEnv(where.env),
  };
  const found: [string | undefined, Place][] = [
    [where.shell[name], "your shell"],
    [files[".env.local"][name], ".env.local"],
    [files[".env"][name], ".env"],
  ];
  const first = found.find(([value]) => value !== undefined);
  return first === undefined || first[0] === "" ? null : { value: first[0]!, from: first[1] };
}

export type Target = {
  /** `CONVEX_DEPLOYMENT`, e.g. "anonymous:anonymous-agent". */
  deployment: string;
  /** The local backend's address, e.g. "http://127.0.0.1:3210". */
  url: string;
  /** Its HTTP-actions address, when known. */
  siteUrl: string | null;
};

export type Refusal = { ok: false; reason: string };

const refuse = (reason: string): Refusal => ({ ok: false, reason });

const NOT_LOCAL =
  "Refusing to run: this command only ever touches a local development backend.";

/** A deploy key or a self-hosted address anywhere the CLI would read one, or null. */
function selectorRefusal(where: Where): Refusal | null {
  for (const name of SELECTORS) {
    // Any of the three places, not only the one that would win: a key in a
    // file is a key the next tool reads.
    for (const [from, value] of [
      ["your shell", where.shell[name]],
      [".env.local", where.envLocal === null ? undefined : parseEnv(where.envLocal)[name]],
      [".env", where.env === null ? undefined : parseEnv(where.env)[name]],
    ] as const) {
      if (value !== undefined && value !== "") {
        return refuse(
          `${NOT_LOCAL} ${name} is set in ${from}, and it points the Convex CLI at a deployment that is not on this machine. Remove it (or open a shell without it) and run this again.`,
        );
      }
    }
  }
  return null;
}

function cloudRefusal(name: string, from: Place): Refusal {
  const cure =
    from === ".env.local"
      ? "Run `pnpm dev:local`, which sets that file aside and brings it back when it stops."
      : `Remove ${name} from ${from} and run this again.`;
  return refuse(
    `${NOT_LOCAL} ${name} in ${from} is not a local one (a local deployment begins with "anonymous:" or "local:", at http://127.0.0.1 or http://localhost). ${cure}`,
  );
}

/**
 * For `dev:seed` and `dev:signin`: the local backend this project is set up
 * for, or why the command will not run. Everything must say "local": no
 * deploy key anywhere, a local deployment name, and local addresses.
 */
export function localTarget(where: Where): { ok: true; target: Target } | Refusal {
  const selector = selectorRefusal(where);
  if (selector !== null) return selector;

  const deployment = read(where, DEPLOYMENT);
  const url = read(where, URL_VAR);
  const site = read(where, SITE_VAR);
  if (deployment === null || url === null) {
    return refuse(
      "No local backend is set up in this folder yet. Run `pnpm dev:local` first (and leave it running), then run this again in a second terminal.",
    );
  }
  if (!isLocalDeployment(deployment.value)) return cloudRefusal(DEPLOYMENT, deployment.from);
  if (!isLocalUrl(url.value)) return cloudRefusal(URL_VAR, url.from);
  if (site !== null && !isLocalUrl(site.value)) return cloudRefusal(SITE_VAR, site.from);
  return {
    ok: true,
    target: { deployment: deployment.value, url: url.value, siteUrl: site?.value ?? null },
  };
}

/**
 * For `dev:local`, before it starts anything: whether it may start, and
 * whether `.env.local` holds a cloud configuration to set aside first. A
 * cloud target in the shell or in `.env` is refused: neither is this
 * command's to move.
 */
export function startPlan(where: Where): { ok: true; setAside: boolean } | Refusal {
  const others: Where = { ...where, envLocal: null };
  const selector = selectorRefusal(others);
  if (selector !== null) return selector;
  for (const name of [DEPLOYMENT, URL_VAR, SITE_VAR]) {
    const found = read(others, name);
    if (found === null) continue;
    const local = name === DEPLOYMENT ? isLocalDeployment(found.value) : isLocalUrl(found.value);
    if (!local) return cloudRefusal(name, found.from);
  }
  // `.env.local` is this command's to manage: anything in it that is not
  // plainly local is a developer's cloud configuration, kept safe meanwhile.
  return { ok: true, setAside: where.envLocal !== null && !isLocalEnvFile(where.envLocal) };
}

/** Whether a `.env.local` holds nothing that points away from this machine. */
export function isLocalEnvFile(text: string): boolean {
  const vars = parseEnv(text);
  if (SELECTORS.some((name) => (vars[name] ?? "") !== "")) return false;
  const local = (name: string, test: (value: string) => boolean) =>
    (vars[name] ?? "") === "" || test(vars[name]!);
  return (
    local(DEPLOYMENT, isLocalDeployment) && local(URL_VAR, isLocalUrl) && local(SITE_VAR, isLocalUrl)
  );
}

/**
 * The environment a Convex CLI child runs in. Whatever the shell held, the
 * child sees no deploy key and no self-hosted address (each is set empty,
 * which also stops the CLI loading one from a file), is in anonymous mode,
 * and has `CONVEX_DEPLOYMENT` pinned to the local deployment that was checked
 * (or absent before the first run, when anonymous mode makes one).
 */
export function childEnv(shell: Env, target: Pick<Target, "deployment"> | null): Env {
  const env: Env = { ...shell, CONVEX_AGENT_MODE: "anonymous" };
  for (const name of SELECTORS) env[name] = "";
  delete env[DEPLOYMENT];
  if (target !== null) {
    if (!isLocalDeployment(target.deployment)) throw new Error(NOT_LOCAL);
    env[DEPLOYMENT] = target.deployment;
  }
  return env;
}

/** What Next.js is started with, so the app talks to the local backend whatever a file says. */
export function appEnv(shell: Env, target: Target): Env {
  if (!isLocalUrl(target.url)) throw new Error(NOT_LOCAL);
  return {
    ...childEnv(shell, target),
    [URL_VAR]: target.url,
    ...(target.siteUrl === null ? null : { [SITE_VAR]: target.siteUrl }),
  };
}

// ── The only Convex CLI calls these commands make ───────────────────────────

/** The two functions the commands run. Both refuse anywhere but a local backend. */
export const DEV_FUNCTIONS = ["devSeed:run", "devSession:create"] as const;
export type DevFunction = (typeof DEV_FUNCTIONS)[number];

export type ConvexCall =
  /** Push the functions once and stop. */
  | { kind: "push" }
  /** Push and keep watching. */
  | { kind: "watch" }
  | { kind: "envList" }
  | { kind: "envGet"; name: "JWT_PRIVATE_KEY" }
  | { kind: "envSetFile"; file: string }
  | { kind: "run"; fn: DevFunction; args: Record<string, string> };

/**
 * The arguments of one CLI call. Nothing here is taken from a command line:
 * the only values are a file this code wrote, one of two function names, and
 * arguments it built. So no call can carry a flag that picks a deployment.
 */
export function convexArgs(call: ConvexCall): string[] {
  switch (call.kind) {
    case "push":
      return ["dev", "--once"];
    case "watch":
      return ["dev"];
    case "envList":
      return ["env", "list"];
    case "envGet":
      return ["env", "get", call.name];
    case "envSetFile":
      if (call.file.startsWith("-")) throw new Error("Not a file.");
      return ["env", "set", "--from-file", call.file, "--force"];
    case "run":
      if (!DEV_FUNCTIONS.includes(call.fn)) throw new Error("Not a development function.");
      // `--push` first makes sure the backend runs this checkout's code.
      return ["run", call.fn, JSON.stringify(call.args), "--push"];
  }
}
