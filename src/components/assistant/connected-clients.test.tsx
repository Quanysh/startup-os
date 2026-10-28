// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CLIENT_WORDS } from "@convex/lib/agentRules";
import { CONSENT_WORDS, OAUTH_WORDS } from "@convex/lib/oauthRules";
import {
  CLAUDE_AI_STEPS,
  GROK_APP_STEPS,
  MCP_SERVER_NAME,
  TOKEN_PLACEHOLDER,
  grokTools,
  mcpAddCommand,
  mcpJson,
} from "@/lib/assistant/snippets";
import { deferred, mockConvex } from "@/test-support/convex";
import { CONNECTED_CLIENTS_INTRO, ConnectedClients, RUNNER_TAG, SCOPES } from "./connected-clients";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed clock: the shared one is read once per module and would drift between tests.
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 14, 6) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;
const URL = "https://os.example.test/mcp/v1";
// Obviously not real.
const FAKE_TOKEN = "sosa_FAKE-token-for-tests-0123456789-abcdefghij";

type Row = {
  id: string;
  kind: "token" | "oauth";
  host?: string | null;
  name: string;
  scope: "read" | "act";
  runner: boolean;
  botsOnly: boolean;
  onlyBot?: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};
const MAC: Row = {
  id: "token-1",
  kind: "token",
  name: "Claude Code on the Mac",
  scope: "act",
  runner: true,
  botsOnly: false,
  createdAt: NOW - 50 * HOUR,
  lastUsedAt: NOW - 3 * HOUR,
};
const GROK: Row = { ...MAC, id: "token-2", name: "Grok bot", scope: "read", runner: false, botsOnly: true, createdAt: NOW - HOUR, lastUsedAt: null };

let convex: ReturnType<typeof mockConvex>;
const setClients = (rows: Row[], hand: unknown[] = []) => {
  convex.setQuery(api.assistant.clients, rows.map((row) => ({ host: null, onlyBot: null, ...row })));
  convex.setQuery(api.oauth.handClients, hand);
};
const show = (mcpUrl: string | null = URL) => render(<ConnectedClients mcpUrl={mcpUrl} />);
const created = () => convex.mutation(api.assistant.createToken);
const revoked = () => convex.mutation(api.assistant.revokeClient);
const dialog = () => within(screen.getByRole("dialog"));
const text = (id: string) => screen.getByTestId(id).textContent ?? "";
const rows = () =>
  [...document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("th, td")].map((cell) => cell.textContent),
  );

let copied: string[];
function setup() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (value: string) => void copied.push(value)) },
  });
  return user;
}
async function makeOne(user: ReturnType<typeof setup>, name = "Grok bot") {
  await user.type(screen.getByLabelText("Name"), name);
  await user.click(screen.getByRole("button", { name: "Create token" }));
}

beforeEach(() => {
  convex = mockConvex();
  copied = [];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Connected clients: the list", () => {
  test("what it is in two sentences, and a skeleton while loading", () => {
    show();
    expect(screen.getByRole("heading", { level: 2, name: "Connected clients" })).toBeTruthy();
    expect(document.body.textContent).toContain(CONNECTED_CLIENTS_INTRO);
    expect(CONNECTED_CLIENTS_INTRO.match(/[.](\s|$)/g)).toHaveLength(2);
    expect(screen.getByTestId("clients-loading")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
  });

  test("with none it says so", () => {
    setClients([]);
    show();
    expect(text("clients-empty")).toBe("No client is connected yet.");
    expect(document.querySelector("table")).toBeNull();
  });

  test("each client is its name, its kind, its scope, when it was made and last used, and a revoke", () => {
    setClients([MAC, GROK]);
    show();
    expect(rows()).toEqual([
      [`Claude Code on the Mac${RUNNER_TAG}`, "Token", "Read and act", "AnyoneAllow bots only", "2d ago", "3h ago", "Revoke"],
      ["Grok bot", "Token", "Read onlyAllow changes", "Bots onlyLet anyone", "1h ago", "Not yet", "Revoke"],
    ]);
    expect(screen.getByRole("button", { name: "Revoke Grok bot" })).toBeTruthy();
  });

  test("the two switches are outlined buttons that say what a click does", () => {
    setClients([MAC, GROK]);
    show();
    for (const name of ["Allow changes: Grok bot", "Only bots may use this client: Grok bot", "Only bots may use this client: Claude Code on the Mac"]) {
      expect(screen.getByRole("button", { name }).className).toContain("border");
    }
    expect(screen.getByRole("button", { name: "Only bots may use this client: Claude Code on the Mac" }).textContent).toBe("Allow bots only");
  });

  test("whether only bots may use a client is shown on its row and changed in one click", async () => {
    const user = setup();
    setClients([MAC, GROK]);
    show();
    expect(text("bots-only-token-2")).toBe("Bots only");
    expect(text("bots-only-token-1")).toBe("Anyone");
    await user.click(screen.getByRole("button", { name: "Only bots may use this client: Grok bot" }));
    expect(convex.mutation(api.assistant.setBotsOnly)).toHaveBeenCalledWith({ kind: "token", id: "token-2", on: false });
    await user.click(screen.getByRole("button", { name: "Only bots may use this client: Claude Code on the Mac" }));
    expect(convex.mutation(api.assistant.setBotsOnly)).toHaveBeenCalledWith({ kind: "token", id: "token-1", on: true });
  });

  test("what a client may do is changed in place, no reconnecting; the Mac runner's stays read and act", async () => {
    const user = setup();
    setClients([MAC, { ...GROK }]);
    show();
    await user.click(screen.getByRole("button", { name: "Allow changes: Grok bot" }));
    expect(convex.mutation(api.assistant.setScope)).toHaveBeenCalledWith({ kind: "token", id: "token-2", scope: "act" });
    expect(screen.queryByRole("button", { name: "Hold to reading: Claude Code on the Mac" })).toBeNull();
  });

  test("a name with markup in it is shown as the characters it is", () => {
    setClients([{ ...GROK, name: '<img src=x onerror="alert(1)">' }]);
    show();
    expect(document.querySelector("tbody img")).toBeNull();
    expect(rows()[0]![0]).toBe('<img src=x onerror="alert(1)">');
  });
});

describe("Connected clients: making a token", () => {
  test("each scope is said in a line, and read only is chosen first", () => {
    setClients([]);
    show();
    for (const { label, line } of SCOPES) {
      expect(document.body.textContent).toContain(`${label}.`);
      expect(document.body.textContent).toContain(line);
    }
    expect((screen.getByRole("radio", { name: /Read only/ }) as HTMLInputElement).checked).toBe(true);
  });

  test("a client needs a name: none is refused here, before the server is asked", async () => {
    const user = setup();
    setClients([]);
    show();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    expect(screen.getByRole("alert").textContent).toBe(CLIENT_WORDS.nameMissing);
    expect(created()).not.toHaveBeenCalled();
  });

  test("Create token sends the name, the scope, whether it is the Mac's and randomness drawn here", async () => {
    const user = setup();
    setClients([]);
    created().mockResolvedValue({ token: FAKE_TOKEN, id: "token-9" });
    show();
    await user.click(screen.getByRole("radio", { name: /Read and act/ }));
    await makeOne(user);
    const sent = created().mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ name: "Grok bot", scope: "act", runner: false, botsOnly: true });
    expect(sent.entropy).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the Mac's runner is always read and act, and cannot be chosen while another client is it", async () => {
    const user = setup();
    setClients([]);
    created().mockResolvedValue({ token: FAKE_TOKEN, id: "token-9" });
    const view = show();
    await user.click(screen.getByRole("checkbox", { name: /runs the chat and the agents/ }));
    expect((screen.getByRole("radio", { name: /Read and act/ }) as HTMLInputElement).checked).toBe(true);
    await makeOne(user, "Claude Code on the Mac");
    expect(created().mock.calls[0]![0]).toMatchObject({ scope: "act", runner: true, botsOnly: false });

    setClients([MAC]);
    view.rerender(<ConnectedClients mcpUrl={URL} />);
    const box = screen.getByRole("checkbox", { name: /runs the chat and the agents/ }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(document.body.textContent).toContain("Another client already does this: one at a time.");
  });

  test("the token is shown once, and is in Claude Code's file and Grok's tool but never the command", async () => {
    const user = setup();
    setClients([]);
    created().mockResolvedValue({ token: FAKE_TOKEN, id: "token-9" });
    show();
    await makeOne(user);
    expect((await screen.findByTestId("fresh-token")).textContent).toBe(FAKE_TOKEN);
    expect(document.body.textContent).toContain("This is the token for Grok bot. You will not see it again.");
    expect(text("mcp-json")).toBe(mcpJson({ url: URL, token: FAKE_TOKEN }));
    expect(text("grok-tools")).toBe(grokTools({ url: URL, token: FAKE_TOKEN }));
    expect(text("mcp-command")).toBe(mcpAddCommand(URL));
    expect(text("mcp-command")).not.toContain("sosa_");
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    await user.click(screen.getByRole("button", { name: "Copy Grok tool" }));
    expect(copied).toEqual([FAKE_TOKEN, grokTools({ url: URL, token: FAKE_TOKEN })]);
    // The name field is empty again for the next client.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
  });

  test("leaving the page loses it for good: it comes back as a placeholder", async () => {
    const user = setup();
    setClients([]);
    created().mockResolvedValue({ token: FAKE_TOKEN, id: "token-9" });
    const view = show();
    await makeOne(user);
    await screen.findByTestId("fresh-token");
    view.unmount();
    setClients([GROK]);
    show();
    expect(screen.queryByTestId("fresh-token")).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_TOKEN);
    expect(text("mcp-json")).toContain(`Bearer ${TOKEN_PLACEHOLDER}`);
  });

  test("the token is kept in the page's memory alone: not in storage, a cookie, the address or an attribute", async () => {
    const user = setup();
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const pushed = vi.spyOn(window.history, "pushState");
    const before = window.location.href;
    setClients([]);
    created().mockResolvedValue({ token: FAKE_TOKEN, id: "token-9" });
    show();
    await makeOne(user);
    await screen.findByTestId("fresh-token");
    expect(stored).not.toHaveBeenCalled();
    expect(pushed).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(document.cookie).not.toContain("sosa_");
    // Only as the text of the three blocks: the token, the file and Grok's tool.
    expect(document.body.innerHTML.split(FAKE_TOKEN)).toHaveLength(4);
    expect(document.querySelector(`[href*="${FAKE_TOKEN}"], [value*="${FAKE_TOKEN}"], [title*="${FAKE_TOKEN}"]`)).toBeNull();
  });

  test("a second press while the first is in flight does nothing", async () => {
    const user = setup();
    setClients([]);
    const pending = deferred<{ token: string; id: string }>();
    created().mockReturnValue(pending.promise);
    show();
    await user.type(screen.getByLabelText("Name"), "Grok bot");
    const button = screen.getByRole("button", { name: "Create token" });
    await user.click(button);
    await user.click(button);
    expect(created()).toHaveBeenCalledTimes(1);
    pending.resolve({ token: FAKE_TOKEN, id: "token-9" });
    expect((await screen.findByTestId("fresh-token")).textContent).toBe(FAKE_TOKEN);
  });

  test("a refusal is shown in the server's words, and no token appears", async () => {
    const user = setup();
    setClients([]);
    created().mockRejectedValue(new ConvexError(CLIENT_WORDS.tooMany));
    show();
    await makeOne(user);
    expect((await screen.findByRole("alert")).textContent).toBe(CLIENT_WORDS.tooMany);
    expect(screen.queryByTestId("fresh-token")).toBeNull();
  });
});

describe("Connected clients: revoking", () => {
  test("Revoke asks first, names the client, and revokes that one alone", async () => {
    const user = setup();
    setClients([MAC, GROK]);
    show();
    await user.click(screen.getByRole("button", { name: "Revoke Grok bot" }));
    expect(revoked()).not.toHaveBeenCalled();
    expect(dialog().getByText("Revoke Grok bot?")).toBeTruthy();
    expect(dialog().getByText(/Your other clients go on working/)).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Revoke" }));
    expect(revoked()).toHaveBeenCalledWith({ kind: "token", id: "token-2" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("keeping it changes nothing", async () => {
    const user = setup();
    setClients([GROK]);
    show();
    await user.click(screen.getByRole("button", { name: "Revoke Grok bot" }));
    await user.click(dialog().getByRole("button", { name: /Keep/ }));
    expect(revoked()).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a revoke that fails says so in the dialog, and the dialog stays", async () => {
    const user = setup();
    setClients([GROK]);
    revoked().mockRejectedValue(new Error("network"));
    show();
    await user.click(screen.getByRole("button", { name: "Revoke Grok bot" }));
    await user.click(dialog().getByRole("button", { name: "Revoke" }));
    expect((await dialog().findByRole("alert")).textContent).toBe("That client could not be revoked. Try again.");
  });
});

describe("Connected clients: how to connect each kind", () => {
  test("Claude Code: the file Claude Code reads, and the command, with the placeholder", () => {
    setClients([]);
    show();
    expect(JSON.parse(text("mcp-json"))).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: { type: "http", url: URL, headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } },
      },
    });
    expect(text("mcp-command")).toBe(mcpAddCommand(URL));
  });

  test("Grok (xAI API): the remote MCP tool, with the placeholder", () => {
    setClients([]);
    show();
    expect(screen.getByRole("heading", { name: "Grok (xAI API)" })).toBeTruthy();
    expect(text("grok-tools")).toBe(grokTools({ url: URL, token: null }));
  });

  test("claude.ai: the steps and the address to paste, and no token", () => {
    setClients([]);
    show();
    expect(screen.getByRole("heading", { name: "claude.ai (web, phone, routines)" })).toBeTruthy();
    expect(text("claude-ai-steps")).toBe(CLAUDE_AI_STEPS.join(""));
    expect(text("claude-ai-url")).toBe(URL);
  });

  test("the limits and what is never available are said", () => {
    setClients([]);
    show();
    // The limits are each bot's now (Agents › Bots): the old per-client line is gone.
    expect(document.body.textContent).not.toContain("120 tool calls");
    expect(document.body.textContent).toContain("Payroll, tokens, team and source settings");
  });

  test("with no address to give, it says so and shows nothing to copy, and a token can still be made", () => {
    setClients([]);
    show(null);
    expect(screen.getByRole("alert").textContent).toContain("This site is not configured with the address a client would call");
    expect(screen.queryByTestId("mcp-json")).toBeNull();
    expect(screen.queryByTestId("grok-tools")).toBeNull();
    expect(screen.getByRole("button", { name: "Create token" })).toBeTruthy();
  });
});

describe("Connected clients: OAuth sign-ins", () => {
  const SIGNED_IN: Row = { ...GROK, id: "grant-1", kind: "oauth", name: "Made-up Claude", host: "claude.example.test", scope: "act" };

  test("a client that signed in is listed as a sign-in, with where it signed in from, and revoked the same way", async () => {
    const user = setup();
    setClients([MAC, SIGNED_IN]);
    show();
    expect(rows()[1]).toEqual(["Made-up Claude · via claude.example.test", "Sign-in", "Read and actHold to reading", "Bots onlyLet anyone", "1h ago", "Not yet", "Revoke"]);
    await user.click(screen.getByRole("button", { name: "Revoke Made-up Claude" }));
    await user.click(dialog().getByRole("button", { name: "Revoke" }));
    expect(revoked()).toHaveBeenCalledWith({ kind: "oauth", id: "grant-1" });
  });

  test("the Grok app: its steps and the address, and that a client id and secret can be made below", () => {
    setClients([]);
    show();
    expect(screen.getByRole("heading", { name: "Grok app" })).toBeTruthy();
    expect(text("grok-app-steps")).toBe(GROK_APP_STEPS.join(""));
  });
});

describe("Connected clients: an OAuth client added by hand", () => {
  const made = () => convex.mutation(api.oauth.createClient);
  const removed = () => convex.mutation(api.oauth.removeClient);
  const HAND = {
    id: "client-1",
    clientId: "sosc_made-up-id",
    name: "Made-up Grok app",
    redirectUris: ["https://grok.example.test/cb"],
    createdAt: NOW - HOUR,
  };

  test("lists each with its client id and addresses, and no secret", () => {
    setClients([], [HAND]);
    show();
    const list = within(screen.getByTestId("hand-clients"));
    expect(list.getByText("Made-up Grok app")).toBeTruthy();
    expect(list.getByText("sosc_made-up-id")).toBeTruthy();
    expect(list.getByText("https://grok.example.test/cb")).toBeTruthy();
  });

  test("adding one sends the name and one address a line, and shows the id and the secret once", async () => {
    const user = setup();
    setClients([]);
    made().mockResolvedValue({ clientId: "sosc_new-id", clientSecret: "sosk_FAKE-secret-for-tests" });
    show();
    await user.type(screen.getByLabelText("Client name"), "Made-up Grok app");
    await user.type(screen.getByLabelText("Redirect URIs"), "https://grok.example.test/cb{enter}https://grok.example.test/cb2");
    await user.click(screen.getByRole("button", { name: "Add client" }));
    const sent = made().mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      name: "Made-up Grok app",
      redirectUris: ["https://grok.example.test/cb", "https://grok.example.test/cb2"],
    });
    expect(sent.entropy).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await screen.findByTestId("hand-secret")).textContent).toBe("sosk_FAKE-secret-for-tests");
    expect(text("hand-client-id")).toBe("sosc_new-id");
    expect(document.body.textContent).toContain("You will not see the secret again.");
  });

  test("a refusal is shown in the server's words", async () => {
    const user = setup();
    setClients([]);
    made().mockRejectedValue(new ConvexError(OAUTH_WORDS.redirectUris));
    show();
    await user.type(screen.getByLabelText("Client name"), "x");
    await user.type(screen.getByLabelText("Redirect URIs"), "http://grok.example.test/cb");
    await user.click(screen.getByRole("button", { name: "Add client" }));
    expect((await screen.findByRole("alert")).textContent).toBe(OAUTH_WORDS.redirectUris);
  });

  test("a name is needed before the server is asked", async () => {
    const user = setup();
    setClients([]);
    show();
    await user.click(screen.getByRole("button", { name: "Add client" }));
    expect(screen.getByRole("alert").textContent).toBe(CONSENT_WORDS.nameMissing);
    expect(made()).not.toHaveBeenCalled();
  });

  test("Remove asks first, then removes it", async () => {
    const user = setup();
    setClients([], [HAND]);
    show();
    await user.click(screen.getByRole("button", { name: "Remove Made-up Grok app" }));
    expect(dialog().getByText(/Its sign-ins end with it/)).toBeTruthy();
    await user.click(dialog().getByRole("button", { name: "Remove" }));
    expect(removed()).toHaveBeenCalledWith({ id: "client-1" });
  });
});
