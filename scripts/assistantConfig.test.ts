import { describe, expect, test } from "vitest";
import { CONFIG_WORDS, PRODUCTION_URL, discover } from "./assistantConfig";

// Where the runner finds the endpoint and the token: Claude Code's own user
// configuration, read through an injected reader. Never the real file.

const TOKEN = "sosa_fake-agent-token-0123456789-abcdefghijklmnopq";
const CONFIG = "/fake/home/.claude.json";

const entry = (url: string, header: unknown = `Bearer ${TOKEN}`) => ({
  type: "http",
  url,
  headers: { Authorization: header },
});
const file = (servers: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ numStartups: 7, oauthAccount: { emailAddress: "NEVER READ" }, mcpServers: servers, ...extra });

function reader(files: Record<string, { text: string; mode?: number }>) {
  const read: string[] = [];
  return {
    read,
    deps: {
      readFile: (path: string) => {
        read.push(path);
        const found = files[path];
        if (found === undefined) throw new Error("ENOENT");
        return found.text;
      },
      fileMode: (path: string) => files[path]?.mode ?? 0o644,
    },
  };
}

const find = (text: string, options: { local?: boolean; env?: Record<string, string> } = {}) =>
  discover({ configPath: CONFIG, local: options.local ?? false, env: options.env ?? {} }, reader({ [CONFIG]: { text } }).deps);

describe("finding the endpoint and the token", () => {
  test("they are the startup-os entry of Claude Code's own configuration", () => {
    expect(find(file({ other: entry("https://example.test/mcp"), "startup-os": entry(PRODUCTION_URL) }))).toEqual({
      url: "https://os.example.com/mcp/v1",
      token: TOKEN,
    });
  });

  test.each([
    ["the file is missing", null],
    ["the file is not JSON", "{ not json"],
    ["there are no servers", JSON.stringify({ numStartups: 1 })],
    ["there is no startup-os entry", file({ other: entry(PRODUCTION_URL) })],
    ["the entry is not an object", file({ "startup-os": "https://os.example.com/mcp/v1" })],
    ["the entry has no header", file({ "startup-os": { type: "http", url: PRODUCTION_URL } })],
    ["the header is not a bearer token", file({ "startup-os": entry(PRODUCTION_URL, TOKEN) })],
    ["the token is not an agent token", file({ "startup-os": entry(PRODUCTION_URL, "Bearer sos_fake-personal-token-0123456789-abcdefgh") })],
    ["the token is a placeholder", file({ "startup-os": entry(PRODUCTION_URL, "Bearer <YOUR_TOKEN>") })],
    ["the token has a space in it", file({ "startup-os": entry(PRODUCTION_URL, `Bearer ${TOKEN} extra`) })],
    ["the header is not text", file({ "startup-os": entry(PRODUCTION_URL, { value: TOKEN }) })],
  ])("it refuses to run when %s, in fixed words that say to connect Claude first", (_why, text) => {
    const files: Record<string, { text: string }> = text === null ? {} : { [CONFIG]: { text } };
    const found = discover({ configPath: CONFIG, local: false, env: {} }, reader(files).deps);
    expect(found).toEqual({ problem: CONFIG_WORDS.notConnected });
    expect(CONFIG_WORDS.notConnected).toMatch(/\/assistant/);
  });

  test.each([
    "http://os.example.com/mcp/v1",
    "https://os.example.com/mcp/v1/",
    "https://os.example.com/mcp/v1?x=1",
    "https://os.example.com.evil.test/mcp/v1",
    "https://evil.test/os.example.com/mcp/v1",
    "https://user@os.example.com/mcp/v1",
    "https://made-up-otter-1.convex.site/mcp/v1",
    "http://localhost:3100/mcp/v1",
    "not a url",
  ])("it refuses any address but the app's own: %s", (url) => {
    expect(find(file({ "startup-os": entry(url) }))).toEqual({ problem: CONFIG_WORDS.wrongUrl });
  });

  test("with --local a localhost address is taken, and nothing else new is", () => {
    for (const url of ["http://localhost:3100/mcp/v1", "http://127.0.0.1:3211/mcp/v1"]) {
      expect(find(file({ "startup-os": entry(url) }), { local: true })).toEqual({ url, token: TOKEN });
    }
    for (const url of ["http://localhost.evil.test/mcp/v1", "http://192.168.1.4:3100/mcp/v1", "https://evil.test/mcp/v1", "http://localhost:3100/other"]) {
      expect(find(file({ "startup-os": entry(url) }), { local: true })).toEqual({ problem: CONFIG_WORDS.wrongUrl });
    }
    // The app's own address still works with --local.
    expect(find(file({ "startup-os": entry(PRODUCTION_URL) }), { local: true })).toMatchObject({ url: PRODUCTION_URL });
  });

  test("only that one entry is read: nothing else of the file is returned", () => {
    const found = find(file({ "startup-os": entry(PRODUCTION_URL) }, { projects: { "/x": { mcpServers: { "startup-os": entry("https://evil.test/mcp/v1") } } } }));
    expect(Object.keys(found).sort()).toEqual(["token", "url"]);
    expect(JSON.stringify(found)).not.toContain("NEVER READ");
  });

  test("no refusal ever holds the token, the address or anything read", () => {
    for (const words of Object.values(CONFIG_WORDS)) {
      expect(words).not.toMatch(/sosa_|Bearer/);
    }
    const found = find(file({ "startup-os": entry(`https://evil.test/${TOKEN}`) }));
    expect(JSON.stringify(found)).not.toContain(TOKEN);
  });
});

describe("the override for tests and a local backend", () => {
  const TOKEN_FILE = "/fake/token";
  const env = { STARTUP_OS_MCP_URL: "http://localhost:3100/mcp/v1", STARTUP_OS_AGENT_TOKEN_FILE: TOKEN_FILE };

  test("an address and a token file only its owner can read are used instead, and Claude's configuration is not opened", () => {
    const r = reader({ [TOKEN_FILE]: { text: `${TOKEN}\n`, mode: 0o600 } });
    expect(discover({ configPath: CONFIG, local: true, env }, r.deps)).toEqual({ url: env.STARTUP_OS_MCP_URL, token: TOKEN });
    expect(r.read).toEqual([TOKEN_FILE]);
  });

  test("a token file others can read is refused", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      const r = reader({ [TOKEN_FILE]: { text: TOKEN, mode } });
      expect(discover({ configPath: CONFIG, local: true, env }, r.deps)).toEqual({ problem: CONFIG_WORDS.tokenFileMode });
      expect(r.read).toEqual([]);
    }
  });

  test("the address is held to the same rule, and both variables are needed", () => {
    const r = () => reader({ [TOKEN_FILE]: { text: TOKEN, mode: 0o600 } }).deps;
    expect(discover({ configPath: CONFIG, local: false, env }, r())).toEqual({ problem: CONFIG_WORDS.wrongUrl });
    expect(discover({ configPath: CONFIG, local: true, env: { STARTUP_OS_MCP_URL: env.STARTUP_OS_MCP_URL } }, r())).toEqual({
      problem: CONFIG_WORDS.overrideHalf,
    });
    const bad = reader({ [TOKEN_FILE]: { text: "sos_not-an-agent-token-0123456789-abcdefgh", mode: 0o600 } });
    expect(discover({ configPath: CONFIG, local: true, env }, bad.deps)).toEqual({ problem: CONFIG_WORDS.notConnected });
  });
});
