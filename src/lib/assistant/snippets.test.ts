import { describe, expect, test } from "vitest";
import {
  CLAUDE_AI_STEPS,
  MCP_SERVER_NAME,
  TOKEN_PLACEHOLDER,
  grokTools,
  mcpAddCommand,
  mcpJson,
} from "./snippets";

const URL = "https://os.example.test/mcp/v1";
// Obviously not real.
const TOKEN = "sosa_FAKE-token-for-tests-0123456789-abcdefghij";

describe("mcpJson: the .mcp.json for Claude Code", () => {
  test("is the HTTP server entry Claude Code reads, with the token as a bearer header", () => {
    expect(JSON.parse(mcpJson({ url: URL, token: TOKEN }))).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: URL,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
  });

  test("with no token it holds the placeholder, and nothing that looks like one", () => {
    const text = mcpJson({ url: URL, token: null });
    expect(JSON.parse(text).mcpServers[MCP_SERVER_NAME].headers.Authorization).toBe(
      `Bearer ${TOKEN_PLACEHOLDER}`,
    );
    expect(text).not.toContain("sosa_");
  });

  test("is laid out to be read and pasted", () => {
    expect(mcpJson({ url: URL, token: null })).toContain('\n  "mcpServers": {\n');
  });
});

describe("mcpAddCommand: the same thing as a command", () => {
  test("names the server, the address and the header, with the placeholder where the token goes", () => {
    expect(mcpAddCommand(URL)).toBe(
      `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${URL} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
    );
  });

  test("it takes no token at all: a token is never put on a command line", () => {
    expect(mcpAddCommand.length).toBe(1);
    expect(mcpAddCommand(URL)).not.toContain("sosa_");
  });
});

describe("grokTools: the remote MCP tool for xAI's API", () => {
  test("is the `tools` entry xAI's API takes: the address, a label and the bearer header's value", () => {
    expect(JSON.parse(grokTools({ url: URL, token: TOKEN }))).toEqual({
      tools: [
        {
          type: "mcp",
          server_url: URL,
          server_label: MCP_SERVER_NAME,
          authorization: `Bearer ${TOKEN}`,
        },
      ],
    });
  });

  test("with no token it holds the placeholder", () => {
    const text = grokTools({ url: URL, token: null });
    expect(JSON.parse(text).tools[0].authorization).toBe(`Bearer ${TOKEN_PLACEHOLDER}`);
    expect(text).not.toContain("sosa_");
  });
});

describe("claude.ai: a custom connector", () => {
  test("is the address alone and steps in words: it signs in, so there is no token to paste", () => {
    expect(CLAUDE_AI_STEPS.join(" ")).toMatch(/Settings.*Connectors.*Add custom connector/);
    expect(CLAUDE_AI_STEPS.join(" ")).not.toMatch(/token/i);
  });
});
