// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  DEV_FUNCTIONS,
  SELECTORS,
  appEnv,
  childEnv,
  convexArgs,
  isLocalEnvFile,
  localTarget,
  parseEnv,
  startPlan,
  type ConvexCall,
  type Where,
} from "./guard";

// What the Convex CLI writes for a local backend, and for a cloud one. The
// cloud names are made up.
const LOCAL_FILE = `# Deployment used by \`npx convex dev\`
CONVEX_DEPLOYMENT=anonymous:anonymous-agent

NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210

NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3211
`;
const CLOUD_FILE = `# Deployment used by \`npx convex dev\`
CONVEX_DEPLOYMENT=dev:happy-animal-123 # team: example, project: example

NEXT_PUBLIC_CONVEX_URL=https://happy-animal-123.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://happy-animal-123.convex.site
`;
const PROD_FILE = CLOUD_FILE.replace("dev:", "prod:");

const where = (over: Partial<Where> = {}): Where => ({
  shell: {},
  envLocal: LOCAL_FILE,
  env: null,
  ...over,
});
const reasonOf = (verdict: { ok: boolean; reason?: string }) => {
  expect(verdict.ok).toBe(false);
  return verdict.reason!;
};

describe("reading an env file as the Convex CLI does", () => {
  test("names and values, with comments, quotes and blanks handled", () => {
    expect(
      parseEnv(
        [
          "# a comment",
          "",
          "A=1",
          "B = two words ",
          'C="quoted # not a comment"',
          "D='single'",
          "E=value # trailing comment",
          "export F=exported",
          "G=",
          "not a line",
        ].join("\n"),
      ),
    ).toEqual({
      A: "1",
      B: "two words",
      C: "quoted # not a comment",
      D: "single",
      E: "value",
      F: "exported",
      G: "",
    });
  });

  test("the deployment the CLI wrote, without its comment", () => {
    expect(parseEnv(CLOUD_FILE).CONVEX_DEPLOYMENT).toBe("dev:happy-animal-123");
  });
});

describe("the backend dev:seed and dev:signin will touch", () => {
  test("a folder set up for a local backend", () => {
    expect(localTarget(where())).toEqual({
      ok: true,
      target: {
        deployment: "anonymous:anonymous-agent",
        url: "http://127.0.0.1:3210",
        siteUrl: "http://127.0.0.1:3211",
      },
    });
  });

  test("a `local:` deployment at localhost is local too", () => {
    const file = "CONVEX_DEPLOYMENT=local:example-1a2b\nNEXT_PUBLIC_CONVEX_URL=http://localhost:3210\n";
    expect(localTarget(where({ envLocal: file }))).toMatchObject({
      ok: true,
      target: { deployment: "local:example-1a2b", siteUrl: null },
    });
  });

  test.each([
    ["a dev deployment in the cloud", CLOUD_FILE],
    ["production", PROD_FILE],
    [
      "a cloud deployment with a local-looking address",
      CLOUD_FILE.replace("https://happy-animal-123.convex.cloud", "http://127.0.0.1:3210"),
    ],
    [
      "a local name with a cloud address",
      LOCAL_FILE.replace("http://127.0.0.1:3210", "https://happy-animal-123.convex.cloud"),
    ],
    [
      "a local name with a cloud site address",
      LOCAL_FILE.replace("http://127.0.0.1:3211", "https://happy-animal-123.convex.site"),
    ],
    [
      "an address that only looks local",
      LOCAL_FILE.replace("http://127.0.0.1:3210", "http://127.0.0.1.example.com:3210"),
    ],
    ["a name with no kind", LOCAL_FILE.replace("anonymous:anonymous-agent", "happy-animal-123")],
  ])("%s in .env.local is refused, and the reason says what to do", (_name, envLocal) => {
    const reason = reasonOf(localTarget(where({ envLocal })));
    expect(reason).toMatch(/^Refusing to run: this command only ever touches a local development backend\./);
    expect(reason).toContain(".env.local");
    expect(reason).toContain("pnpm dev:local");
  });

  test("a folder with no backend set up says to start one, in one sentence", () => {
    for (const envLocal of [null, "", "OTHER=1\n", "CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n"]) {
      expect(reasonOf(localTarget(where({ envLocal })))).toMatch(
        /^No local backend is set up in this folder yet\. Run `pnpm dev:local` first/,
      );
    }
  });

  // The CLI reads the shell before any file, so a shell value wins.
  test.each([
    ["CONVEX_DEPLOYMENT", "prod:happy-animal-123"],
    ["CONVEX_DEPLOYMENT", "dev:happy-animal-123"],
    ["CONVEX_DEPLOYMENT", "preview:happy-animal-123"],
    ["NEXT_PUBLIC_CONVEX_URL", "https://happy-animal-123.convex.cloud"],
    ["NEXT_PUBLIC_CONVEX_SITE_URL", "https://happy-animal-123.convex.site"],
  ])("%s=%s in the shell is refused though the files say local", (name, value) => {
    const reason = reasonOf(localTarget(where({ shell: { [name]: value } })));
    expect(reason).toContain(`${name} in your shell`);
  });

  test("so is a cloud deployment in .env, when .env.local names none", () => {
    const reason = reasonOf(
      localTarget(where({ envLocal: "NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210\n", env: CLOUD_FILE })),
    );
    expect(reason).toContain("CONVEX_DEPLOYMENT in .env ");
  });

  test.each(SELECTORS)("%s anywhere is refused, whatever else says local", (name) => {
    for (const [place, over] of [
      ["your shell", { shell: { [name]: "anything" } }],
      [".env.local", { envLocal: `${LOCAL_FILE}${name}=anything\n` }],
      [".env", { env: `${name}=anything\n` }],
    ] as const) {
      const reason = reasonOf(localTarget(where(over)));
      expect(reason).toContain(`${name} is set in ${place}`);
      // The value is a secret: the reason names the variable, never what it holds.
      expect(reason).not.toContain("anything");
    }
  });

  test("a deploy key in a file is refused even when the shell blanks it", () => {
    const verdict = localTarget(
      where({ shell: { CONVEX_DEPLOY_KEY: "" }, env: "CONVEX_DEPLOY_KEY=prod:happy-animal-123|secret\n" }),
    );
    expect(reasonOf(verdict)).toContain("CONVEX_DEPLOY_KEY is set in .env");
  });

  test("a selector that is present but empty is not one", () => {
    expect(localTarget(where({ shell: { CONVEX_DEPLOY_KEY: "" }, env: "CONVEX_DEPLOY_KEY=\n" })).ok).toBe(true);
  });

  test("an empty CONVEX_DEPLOYMENT in the shell hides the file's, as it does for the CLI", () => {
    // dotenv never overrides a variable the shell has, even an empty one: the
    // CLI would then see no deployment at all, so neither does the guard.
    expect(reasonOf(localTarget(where({ shell: { CONVEX_DEPLOYMENT: "" } })))).toMatch(
      /^No local backend is set up/,
    );
  });

  test("no flag can change the answer: the guard takes no arguments at all", () => {
    expect(localTarget.length).toBe(1);
  });
});

describe("whether dev:local may start, and what it sets aside", () => {
  test("a fresh checkout: start, nothing to set aside", () => {
    expect(startPlan(where({ envLocal: null }))).toEqual({ ok: true, setAside: false });
  });

  test("a folder already set up for the local backend", () => {
    expect(startPlan(where())).toEqual({ ok: true, setAside: false });
  });

  test.each([
    ["a cloud dev deployment", CLOUD_FILE],
    ["production", PROD_FILE],
    ["a deploy key", "CONVEX_DEPLOY_KEY=prod:happy-animal-123|secret\n"],
    ["a self-hosted address", "CONVEX_SELF_HOSTED_URL=https://convex.example.com\n"],
    ["only a cloud address", "NEXT_PUBLIC_CONVEX_URL=https://happy-animal-123.convex.cloud\n"],
  ])("an .env.local holding %s is set aside, not used and not refused", (_name, envLocal) => {
    expect(isLocalEnvFile(envLocal)).toBe(false);
    expect(startPlan(where({ envLocal }))).toEqual({ ok: true, setAside: true });
  });

  test("an .env.local with nothing of Convex's in it is left where it is", () => {
    expect(startPlan(where({ envLocal: "SOMETHING_ELSE=1\n" }))).toEqual({ ok: true, setAside: false });
  });

  test.each([
    [{ shell: { CONVEX_DEPLOYMENT: "prod:happy-animal-123" } }, "CONVEX_DEPLOYMENT in your shell"],
    [{ shell: { CONVEX_DEPLOY_KEY: "prod:happy-animal-123|secret" } }, "CONVEX_DEPLOY_KEY is set in your shell"],
    [{ shell: { CONVEX_SELF_HOSTED_URL: "https://convex.example.com" } }, "CONVEX_SELF_HOSTED_URL is set in your shell"],
    [{ shell: { NEXT_PUBLIC_CONVEX_URL: "https://happy-animal-123.convex.cloud" } }, "NEXT_PUBLIC_CONVEX_URL in your shell"],
    [{ env: CLOUD_FILE }, "CONVEX_DEPLOYMENT in .env "],
    [{ env: "CONVEX_DEPLOY_KEY=preview:example|secret\n" }, "CONVEX_DEPLOY_KEY is set in .env"],
  ])("a cloud target outside .env.local is refused, not moved: %j", (over, words) => {
    expect(reasonOf(startPlan(where({ envLocal: null, ...over })))).toContain(words);
  });
});

describe("the environment a Convex CLI child runs in", () => {
  const TARGET = { deployment: "anonymous:anonymous-agent" };
  const SHELL = {
    PATH: "/usr/bin",
    CONVEX_DEPLOY_KEY: "prod:happy-animal-123|secret",
    CONVEX_DEPLOYMENT_TOKEN: "token",
    CONVEX_SELF_HOSTED_URL: "https://convex.example.com",
    CONVEX_SELF_HOSTED_ADMIN_KEY: "key",
    CONVEX_DEPLOYMENT: "prod:happy-animal-123",
    CONVEX_AGENT_MODE: "something-else",
  };

  test("no deploy key or self-hosted address survives, and each is set empty so no file can supply one", () => {
    const env = childEnv(SHELL, TARGET);
    for (const name of SELECTORS) expect([name, env[name]]).toEqual([name, ""]);
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(JSON.stringify(env)).not.toContain("happy-animal");
  });

  test("the deployment is the checked local one, whatever the shell said, in anonymous mode", () => {
    const env = childEnv(SHELL, TARGET);
    expect(env.CONVEX_DEPLOYMENT).toBe("anonymous:anonymous-agent");
    expect(env.CONVEX_AGENT_MODE).toBe("anonymous");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("before the first run no deployment is named at all", () => {
    expect(childEnv(SHELL, null)).not.toHaveProperty("CONVEX_DEPLOYMENT");
  });

  test.each(["prod:happy-animal-123", "dev:happy-animal-123", "happy-animal-123", ""])(
    "it cannot be built for %j",
    (deployment) => {
      expect(() => childEnv({}, { deployment })).toThrow("Refusing to run");
    },
  );

  test("the app is started against the local backend's own addresses", () => {
    const env = appEnv(
      { NEXT_PUBLIC_CONVEX_URL: "https://happy-animal-123.convex.cloud" },
      { ...TARGET, url: "http://127.0.0.1:3210", siteUrl: "http://127.0.0.1:3211" },
    );
    expect(env.NEXT_PUBLIC_CONVEX_URL).toBe("http://127.0.0.1:3210");
    expect(env.NEXT_PUBLIC_CONVEX_SITE_URL).toBe("http://127.0.0.1:3211");
    expect(() =>
      appEnv({}, { ...TARGET, url: "https://happy-animal-123.convex.cloud", siteUrl: null }),
    ).toThrow("Refusing to run");
  });
});

describe("the only Convex CLI calls the commands make", () => {
  const CALLS: ConvexCall[] = [
    { kind: "push" },
    { kind: "watch" },
    { kind: "envList" },
    { kind: "envGet", name: "JWT_PRIVATE_KEY" },
    { kind: "envSetFile", file: "/tmp/example/local.env" },
    { kind: "run", fn: "devSeed:run", args: {} },
    { kind: "run", fn: "devSession:create", args: { role: "sales", companies: "us" } },
  ];
  // Every flag of the CLI that chooses where a command lands.
  const TARGETING = /^--(prod|url|admin-key|env-file|deployment|deployment-name|preview-name|preview-create|preview-run|cloud|local|configure|team|project|dev-deployment|component|cmd)\b/;

  test("none carries a flag that picks a deployment", () => {
    for (const call of CALLS) {
      const flags = convexArgs(call).filter((arg) => arg.startsWith("-"));
      for (const flag of flags) expect([call.kind, flag]).toEqual([call.kind, expect.not.stringMatching(TARGETING)]);
      expect(["--once", "--from-file", "--force", "--push"]).toEqual(expect.arrayContaining(flags));
    }
  });

  test("each is exactly what it says", () => {
    expect(CALLS.map(convexArgs)).toEqual([
      ["dev", "--once"],
      ["dev"],
      ["env", "list"],
      ["env", "get", "JWT_PRIVATE_KEY"],
      ["env", "set", "--from-file", "/tmp/example/local.env", "--force"],
      ["run", "devSeed:run", "{}", "--push"],
      ["run", "devSession:create", '{"role":"sales","companies":"us"}', "--push"],
    ]);
  });

  test("only the two development functions can be run, and a flag cannot pose as a file", () => {
    expect(DEV_FUNCTIONS).toEqual(["devSeed:run", "devSession:create"]);
    expect(() => convexArgs({ kind: "run", fn: "team:remove" as never, args: {} })).toThrow(
      "Not a development function.",
    );
    expect(() => convexArgs({ kind: "run", fn: "--prod" as never, args: {} })).toThrow();
    expect(() => convexArgs({ kind: "envSetFile", file: "--prod" })).toThrow("Not a file.");
  });

  test("an argument's value cannot become a flag: it travels inside one JSON string", () => {
    const args = convexArgs({ kind: "run", fn: "devSession:create", args: { role: "--prod" } });
    expect(args).toEqual(["run", "devSession:create", '{"role":"--prod"}', "--push"]);
  });
});
