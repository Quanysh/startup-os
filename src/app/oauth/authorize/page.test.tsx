// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { CONSENT_WORDS } from "@convex/lib/oauthRules";
import { mockConvex } from "@/test-support/convex";
import AuthorizePage from "./page";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));
const left = vi.hoisted(() => ({ to: [] as string[] }));
vi.mock("@/lib/os/navigate", () => ({ leaveTo: (address: string) => left.to.push(address) }));
vi.mock("@/components/theme-provider", () => ({ ThemeSwitch: () => null }));

const REQUEST = {
  response_type: "code",
  client_id: "sosc_made-up",
  redirect_uri: "https://claude.example.test/api/mcp/auth_callback",
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
  scope: "read act",
  resource: "https://os.example.test/mcp/v1",
  state: "made-up state",
};
const SENT = {
  clientId: REQUEST.client_id,
  redirectUri: REQUEST.redirect_uri,
  responseType: "code",
  codeChallenge: REQUEST.code_challenge,
  codeChallengeMethod: "S256",
  scope: "read act",
  resource: REQUEST.resource,
  state: "made-up state",
};
const OWNER = { isOwner: true, isMember: true, areas: ["personal"] };
const ASK = {
  status: "ask",
  clientName: "Made-up Claude",
  redirectHost: "claude.example.test",
  asked: "act",
  denyUrl: "https://claude.example.test/api/mcp/auth_callback?error=access_denied&state=made-up+state",
};

let convex: ReturnType<typeof mockConvex>;
const approve = () => convex.mutation(api.oauth.approve);
const show = () => render(<AuthorizePage />);

beforeEach(() => {
  convex = mockConvex();
  nav.search = new URLSearchParams(REQUEST).toString();
  left.to = [];
});
afterEach(() => cleanup());

describe("who may approve", () => {
  test("a teammate is told only the owner can connect a client, and the request is never even described", () => {
    convex.setQuery(api.viewer.me, { isOwner: false, isMember: true, areas: ["board"] });
    convex.setQuery(api.oauth.describe, ASK);
    show();
    expect(screen.getByRole("alert").textContent).toBe(CONSENT_WORDS.ownerOnly);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(document.body.textContent).not.toContain("Made-up Claude");
  });

  test("someone not let in at all is told the same", () => {
    convex.setQuery(api.viewer.me, { isOwner: false, isMember: false });
    show();
    expect(screen.getByRole("alert").textContent).toBe(CONSENT_WORDS.ownerOnly);
  });
});

describe("the owner's choice", () => {
  test("it names the client and where it will be sent, and asks what it may do: read only first", () => {
    convex.setQuery(api.viewer.me, OWNER);
    convex.setQuery(api.oauth.describe, ASK);
    show();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Connect Made-up Claude to Startup OS?");
    expect(document.body.textContent).toContain("claude.example.test");
    expect(document.body.textContent).toContain("It asked to read and act.");
    expect((screen.getByRole("radio", { name: /Read only/ }) as HTMLInputElement).checked).toBe(true);
  });

  test("Approve sends the request as the client sent it, the choice and fresh randomness, then leaves for the client", async () => {
    convex.setQuery(api.viewer.me, OWNER);
    convex.setQuery(api.oauth.describe, ASK);
    approve().mockResolvedValue({ redirect: "https://claude.example.test/api/mcp/auth_callback?code=sosx_x&state=made-up+state" });
    show();
    await userEvent.click(screen.getByRole("radio", { name: /Read and act/ }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    const sent = approve().mock.calls[0]![0] as Record<string, string>;
    expect(sent).toMatchObject({ ...SENT, granted: "act" });
    expect(sent.entropy).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(left.to).toEqual(["https://claude.example.test/api/mcp/auth_callback?code=sosx_x&state=made-up+state"]);
  });

  test("Deny leaves for the client with access_denied, and approves nothing", async () => {
    convex.setQuery(api.viewer.me, OWNER);
    convex.setQuery(api.oauth.describe, ASK);
    show();
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(approve()).not.toHaveBeenCalled();
    expect(left.to).toEqual([ASK.denyUrl]);
  });

  test("a refusal is said in the server's words, and the browser stays", async () => {
    convex.setQuery(api.viewer.me, OWNER);
    convex.setQuery(api.oauth.describe, ASK);
    approve().mockRejectedValue(new ConvexError(CONSENT_WORDS.badRequest));
    show();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toBe(CONSENT_WORDS.badRequest);
    expect(left.to).toEqual([]);
  });

  test("a name the client gave itself is shown as the characters it is", () => {
    convex.setQuery(api.viewer.me, OWNER);
    convex.setQuery(api.oauth.describe, { ...ASK, clientName: '<img src=x onerror="alert(1)">' });
    show();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain('<img src=x onerror="alert(1)">');
  });
});

describe("a request that cannot be approved", () => {
  test("an unknown client or address is said here, and nobody is sent anywhere", () => {
    convex.setQuery(api.viewer.me, OWNER);
    convex.setQuery(api.oauth.describe, { status: "invalid", words: CONSENT_WORDS.badRedirect });
    show();
    expect(screen.getByRole("alert").textContent).toBe(CONSENT_WORDS.badRedirect);
    expect(screen.queryByRole("button")).toBeNull();
    expect(left.to).toEqual([]);
  });

  test("one the client got wrong can be returned to it with the error", async () => {
    convex.setQuery(api.viewer.me, OWNER);
    const redirect = "https://claude.example.test/api/mcp/auth_callback?error=invalid_request&state=made-up+state";
    convex.setQuery(api.oauth.describe, { status: "error", redirect });
    show();
    expect(screen.getByRole("alert").textContent).toBe(CONSENT_WORDS.badRequest);
    await userEvent.click(screen.getByRole("button", { name: "Back to the client" }));
    expect(left.to).toEqual([redirect]);
  });

  test("with no client named, nothing is asked of the server", () => {
    nav.search = "";
    convex.setQuery(api.viewer.me, OWNER);
    show();
    expect(screen.getByRole("alert").textContent).toBe(CONSENT_WORDS.badRequest);
  });
});
