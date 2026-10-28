// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { TOKEN_PLACEHOLDER, connectPrompt } from "@convex/lib/connectPrompt";
import { ViewerProvider } from "@/components/viewer-provider";
import { deferred, mockConvex } from "@/test-support/convex";
import { ConnectView } from "./connect-view";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed clock: the shared one is read once per module and would drift between tests.
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 13, 6) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));

const HOUR = 60 * 60 * 1000;
const URL = "https://made-up-deployment-123.convex.site/ingest/v1";
// Obviously not real.
const FAKE_TOKEN = "sos_FAKE-token-for-tests-0123456789-abcdefghijk";
const EMAIL = "ada.teammate@example.test";

type Tool = { source: string; lastOkAt: number | null; held: number };
const TOOLS: Tool[] = [
  { source: "gmail", lastOkAt: NOW - 3 * HOUR, held: 4 },
  { source: "google_calendar", lastOkAt: NOW - 3 * HOUR, held: 6 },
  { source: "linear", lastOkAt: null, held: 0 },
  { source: "fireflies", lastOkAt: NOW - 26 * HOUR, held: 2 },
];
const NOTHING: Tool[] = TOOLS.map((tool) => ({ ...tool, lastOkAt: null, held: 0 }));
const TOKEN = { createdAt: NOW - 50 * HOUR, lastUsedAt: NOW - 3 * HOUR };

let convex: ReturnType<typeof mockConvex>;
const setStatus = (token: typeof TOKEN | null | { createdAt: number; lastUsedAt: null }, tools = TOOLS) =>
  convex.setQuery(api.connect.status, { owner: false, token, tools });
const page = (ingestUrl: string | null = URL) => (
  <ViewerProvider
    viewer={{ role: "engineer", companies: ["us"], areas: ["today"], email: EMAIL, name: null }}
  >
    <ConnectView ingestUrl={ingestUrl} />
  </ViewerProvider>
);
const show = (ingestUrl: string | null = URL) => render(page(ingestUrl));

const promptText = () => screen.getByTestId("prompt").textContent ?? "";
const dialog = () => within(screen.getByRole("dialog"));
const created = () => convex.mutation(api.connect.createToken);
const revoked = () => convex.mutation(api.connect.revokeToken);
const forgotten = () => convex.mutation(api.connect.forget);

let copied: string[];
/** A user, and a clipboard that records what was copied (userEvent installs one of its own). */
function setup() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        copied.push(text);
      }),
    },
  });
  return user;
}
beforeEach(() => {
  convex = mockConvex();
  copied = [];
});
afterEach(cleanup);

describe("ConnectView: what it says", () => {
  test("what it is, what is read and what never is, and that only you see it", () => {
    setStatus(null, NOTHING);
    show();
    // A part of Settings › Connections: the page has the title, this has no h1 of its own.
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    const text = document.body.textContent ?? "";
    for (const said of [
      "Only you see them here: not the owner, and not your teammates.",
      "The sender, subject and time of mail that looks like it needs a reply. Never a message body.",
      "Meeting titles, times and attendees. Never descriptions or links.",
      "Meeting summaries and action items. Never transcripts.",
      "The issues assigned to you.",
      "once a day",
    ]) {
      expect(text).toContain(said);
    }
    expect(screen.queryByRole("link", { name: "Today" })).toBeNull();
  });

  test("a skeleton while loading, and no step is shown before the answer", () => {
    show();
    expect(screen.getByTestId("connect-loading")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create your token" })).toBeNull();
  });

  test("the schedule it suggests is one run a day for all four tools, and it says tasks need the app open", () => {
    setStatus(null, NOTHING);
    show();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Set it to run every day at 11:00. One run covers all four tools");
    expect(text).toContain("A task runs only while the Claude app is open.");
    expect(text).toContain("Click “Run now” once, so the connector approvals are stored.");
    expect(text).not.toMatch(/hourly|every hour/i);
  });

  test("the owner is told their own tools are connected with Google instead, and offered no token", () => {
    convex.setQuery(api.connect.status, { owner: true, token: null, tools: [] });
    render(<ConnectView ingestUrl={URL} />);
    expect(document.body.textContent).toContain(
      "Your own mail, calendar, meeting notes and the Linear board are connected with Google and the switches on this page, not with a personal token.",
    );
    expect(screen.queryByRole("button", { name: "Create your token" })).toBeNull();
    expect(screen.queryByTestId("prompt")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("ConnectView: the token", () => {
  test("with none: one button, and the prompt shows a placeholder where the token goes", () => {
    setStatus(null, NOTHING);
    show();
    expect(screen.getByText("You have no token yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
    expect(promptText()).toContain(`'${TOKEN_PLACEHOLDER}' > header`);
    expect(promptText()).not.toContain("sos_");
  });

  test("creating shows the token once, with a copy button and that it will not be seen again", async () => {
    const user = setup();
    setStatus(null, NOTHING);
    created().mockResolvedValueOnce({ token: FAKE_TOKEN });
    const view = show();
    await user.click(screen.getByRole("button", { name: "Create your token" }));

    // The browser's own randomness goes with the request: 32 bytes, URL-safe.
    expect(created()).toHaveBeenCalledTimes(1);
    const [{ entropy }] = created().mock.calls[0] as [{ entropy: string }];
    expect(entropy).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect((await screen.findByTestId("fresh-token")).textContent).toBe(FAKE_TOKEN);
    expect(screen.getByText("This is your token. You will not see this again.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(copied).toEqual([FAKE_TOKEN]);
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Copied.")).toBe(true);

    // The server's answer arrives: the token stays on screen for this visit.
    setStatus({ createdAt: NOW, lastUsedAt: null }, NOTHING);
    view.rerender(page());
    expect(screen.getByTestId("fresh-token").textContent).toBe(FAKE_TOKEN);
    expect(screen.getByRole("button", { name: "Replace" })).toBeTruthy();
  });

  test("the token goes into the prompt only at that moment, and the prompt is the builder's own text", async () => {
    const user = setup();
    setStatus(null, NOTHING);
    created().mockResolvedValueOnce({ token: FAKE_TOKEN });
    show();
    const before = connectPrompt({ ingestUrl: URL, token: null, email: EMAIL, today: "2026-10-13" });
    expect(promptText()).toBe(before);

    await user.click(screen.getByRole("button", { name: "Create your token" }));
    await screen.findByTestId("fresh-token");
    const withToken = connectPrompt({ ingestUrl: URL, token: FAKE_TOKEN, email: EMAIL, today: "2026-10-13" });
    expect(promptText()).toBe(withToken);
    expect(screen.getByTestId("prompt-note").textContent).toContain("Your token is in this prompt.");
    await user.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(copied).toEqual([withToken]);
  });

  test("a later visit shows when it was made and last used, never the token", () => {
    setStatus(TOKEN);
    show();
    expect(screen.getByTestId("token-state").textContent).toBe(
      "You have a token, created 2d ago. Last used 3h ago.",
    );
    expect(screen.queryByTestId("fresh-token")).toBeNull();
    expect(document.body.textContent).not.toContain("sos_");
    expect(screen.getByTestId("prompt-note").textContent).toContain(TOKEN_PLACEHOLDER);
    expect(screen.queryByRole("button", { name: "Create your token" })).toBeNull();
  });

  test("a token never used says so", () => {
    setStatus({ createdAt: NOW - HOUR, lastUsedAt: null });
    show();
    expect(screen.getByTestId("token-state").textContent).toBe(
      "You have a token, created 1h ago. It has not been used yet.",
    );
  });

  test("the prompt carries the viewer's own address and the deployment's address", () => {
    setStatus(TOKEN);
    show();
    expect(promptText()).toContain(`My email address is ${EMAIL}.`);
    expect(promptText()).toContain(`curl -sS -X POST ${URL} `);
  });

  test("Replace asks first, and nothing is sent until it is confirmed", async () => {
    const user = setup();
    setStatus(TOKEN);
    created().mockResolvedValueOnce({ token: FAKE_TOKEN });
    show();
    await user.click(screen.getByRole("button", { name: "Replace" }));
    expect(dialog().getByText(/stops working at once/)).toBeTruthy();
    expect(created()).not.toHaveBeenCalled();
    await user.click(dialog().getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(created()).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Replace" }));
    await user.click(dialog().getByRole("button", { name: "Replace" }));
    expect((await screen.findByTestId("fresh-token")).textContent).toBe(FAKE_TOKEN);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(promptText()).toContain(FAKE_TOKEN);
  });

  test("Revoke asks first, then forgets the token it was showing", async () => {
    const user = setup();
    setStatus(null, NOTHING);
    created().mockResolvedValueOnce({ token: FAKE_TOKEN });
    const view = show();
    await user.click(screen.getByRole("button", { name: "Create your token" }));
    await screen.findByTestId("fresh-token");
    setStatus({ createdAt: NOW, lastUsedAt: null }, NOTHING);
    view.rerender(page());

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(dialog().getByText(/Your Claude task will be refused from now on/)).toBeTruthy();
    expect(revoked()).not.toHaveBeenCalled();
    await user.click(dialog().getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(revoked()).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("fresh-token")).toBeNull();
    expect(promptText()).not.toContain("sos_");
  });

  test("a refusal is shown in the server's own words, and the page is as it was", async () => {
    const user = setup();
    setStatus(null, NOTHING);
    created().mockRejectedValueOnce(new ConvexError("That token could not be made. Try again."));
    show();
    await user.click(screen.getByRole("button", { name: "Create your token" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That token could not be made. Try again.",
    );
    expect(screen.queryByTestId("fresh-token")).toBeNull();
    // A failure that is not the server's own words still says something.
    created().mockRejectedValueOnce(new Error("network"));
    await user.click(screen.getByRole("button", { name: "Create your token" }));
    await waitFor(() => expect(created()).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That token could not be made. Try again.",
    );
  });

  test("a failed revoke is said in the dialog, which stays open", async () => {
    const user = setup();
    setStatus(TOKEN);
    revoked().mockRejectedValueOnce(new ConvexError("not_allowed"));
    show();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(dialog().getByRole("button", { name: "Revoke" }));
    expect((await dialog().findByRole("alert")).textContent).toBe("not_allowed");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("mid-request the button is aria-disabled, not disabled, and a second click sends nothing", async () => {
    const user = setup();
    setStatus(null, NOTHING);
    const pending = deferred<{ token: string }>();
    created().mockReturnValueOnce(pending.promise);
    show();
    const button = screen.getByRole("button", { name: "Create your token" });
    await user.click(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    await user.click(button);
    expect(created()).toHaveBeenCalledTimes(1);
    pending.resolve({ token: FAKE_TOKEN });
    await screen.findByTestId("fresh-token");
  });

  test("a clipboard that refuses is said, with what to do instead", async () => {
    const user = setup();
    setStatus(TOKEN);
    show();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    await user.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(
      await screen.findByText("Could not copy. Select the text and copy it by hand."),
    ).toBeTruthy();
  });

  test("with no address configured there is no prompt, and it says why", () => {
    setStatus(TOKEN);
    show(null);
    expect(screen.queryByTestId("prompt")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("not configured with the address");
    expect(screen.queryByRole("button", { name: "Copy prompt" })).toBeNull();
  });
});

describe("ConnectView: what has arrived", () => {
  const row = (name: string) =>
    within(screen.getByRole("row", { name: new RegExp(`^${name}`) }));

  test("one row per tool in the shared table: last received and how many are held", () => {
    setStatus(TOKEN);
    show();
    const table = screen.getByRole("table", { name: "What has arrived, by tool" });
    expect(table.getAttribute("data-slot")).toBe("data-table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Tool",
      "Last received",
      "Held",
      "Actions",
    ]);
    const cells = (name: string) =>
      row(name)
        .getAllByRole("cell")
        .slice(0, 2)
        .map((cell) => cell.textContent);
    expect(cells("Gmail")).toEqual(["3h ago", "4"]);
    expect(cells("Google Calendar")).toEqual(["3h ago", "6"]);
    expect(cells("Linear")).toEqual(["Nothing yet", "0"]);
    expect(cells("Fireflies")).toEqual(["1d ago", "2"]);
    expect(document.body.textContent).toContain("Updated once a day by your Claude task.");
  });

  test("Forget these is offered only where something is held, asks first, and names the tool", async () => {
    const user = setup();
    setStatus(TOKEN);
    show();
    expect(row("Linear").queryByRole("button")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Forget these: Gmail" }));
    expect(dialog().getByText("Forget what arrived from Gmail?")).toBeTruthy();
    expect(forgotten()).not.toHaveBeenCalled();
    await user.click(dialog().getByRole("button", { name: "Forget these" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(forgotten()).toHaveBeenCalledWith({ source: "gmail" });
  });

  test("a failed forget is said in the dialog, and Keep it sends nothing", async () => {
    const user = setup();
    setStatus(TOKEN);
    forgotten().mockRejectedValueOnce(new Error("network"));
    show();
    await user.click(screen.getByRole("button", { name: "Forget these: Fireflies" }));
    await user.click(dialog().getByRole("button", { name: "Forget these" }));
    expect((await dialog().findByRole("alert")).textContent).toBe(
      "Those could not be deleted. Try again.",
    );
    await user.click(dialog().getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(forgotten()).toHaveBeenCalledTimes(1);
    // The failure is not left on the page once the question is closed.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
