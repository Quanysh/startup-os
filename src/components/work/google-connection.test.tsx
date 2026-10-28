// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { deferred, mockConvex } from "@/test-support/convex";
import { GOOGLE_RESULTS, GoogleConnection, GoogleResult } from "./google-connection";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
// A fixed clock: the shared one is read once per module and would drift between tests.
const { NOW } = vi.hoisted(() => ({ NOW: Date.UTC(2026, 9, 12, 12) }));
vi.mock("@/hooks/use-now", () => ({ useNow: () => NOW }));
let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search) }));

const HOUR = 60 * 60 * 1000;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth?state=made-up";

let convex: ReturnType<typeof mockConvex>;
const set = (value: { missingEnv: string[]; connected: boolean; connectedAt: number | null }) =>
  convex.setQuery(api.google.connection, value);

beforeEach(() => {
  search = "";
  convex = mockConvex();
  set({ missingEnv: [], connected: false, connectedAt: null });
});
afterEach(cleanup);

const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim();

describe("GoogleConnection", () => {
  test("a skeleton while loading", () => {
    convex.setQuery(api.google.connection, undefined);
    render(<GoogleConnection />);
    expect(screen.getByTestId("google-loading")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("names the variables still to set, and offers no button", () => {
    set({
      missingEnv: ["GOOGLE_WORK_CLIENT_ID", "TOKEN_ENCRYPTION_KEY"],
      connected: false,
      connectedAt: null,
    });
    const { container } = render(<GoogleConnection />);
    expect(text(container.querySelector("p"))).toBe(
      "Google cannot be connected yet. Set GOOGLE_WORK_CLIENT_ID, TOKEN_ENCRYPTION_KEY in the Convex dashboard.",
    );
    expect([...container.querySelectorAll("code")].map((c) => c.textContent)).toEqual([
      "GOOGLE_WORK_CLIENT_ID",
      "TOKEN_ENCRYPTION_KEY",
    ]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("not connected: says what will be asked for, word for word", () => {
    render(<GoogleConnection />);
    expect(screen.getByText("Not connected.")).toBeTruthy();
    expect(
      screen.getByText(
        "Startup OS will ask to see message headers (sender, subject, date, labels) and your calendar's events. It cannot read message bodies, send mail or change anything.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeTruthy();
  });

  test("Connect sends three fresh 43-character values, then leaves for Google", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    convex.mutation(api.google.begin).mockResolvedValue(AUTH_URL);
    render(<GoogleConnection navigate={navigate} />);
    await user.click(screen.getByRole("button", { name: "Connect Google" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(AUTH_URL));

    const begin = convex.mutation(api.google.begin);
    expect(begin).toHaveBeenCalledTimes(1);
    const args = begin.mock.calls[0]?.[0] as Record<string, string>;
    expect(Object.keys(args).sort()).toEqual(["challenge", "state", "verifier"]);
    for (const value of Object.values(args)) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Object.values(args)).size).toBe(3);
  });

  test("a failing begin shows its message and goes nowhere", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    convex
      .mutation(api.google.begin)
      .mockRejectedValue(new ConvexError("Set GOOGLE_WORK_CLIENT_SECRET on the Convex deployment first."));
    render(<GoogleConnection navigate={navigate} />);
    await user.click(screen.getByRole("button", { name: "Connect Google" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Set GOOGLE_WORK_CLIENT_SECRET on the Convex deployment first.",
    );
    expect(navigate).not.toHaveBeenCalled();
    // And it can be tried again.
    expect(screen.getByRole("button", { name: "Connect Google" }).getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  test("an address that is not Google's sign-in page is not followed", async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    convex.mutation(api.google.begin).mockResolvedValue("https://evil.test/o/oauth2/v2/auth");
    render(<GoogleConnection navigate={navigate} />);
    await user.click(screen.getByRole("button", { name: "Connect Google" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Google could not be reached. Try again.",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  test("while connecting, the button is aria-disabled, keeps focus and starts nothing twice", async () => {
    const user = userEvent.setup();
    const gate = deferred<string>();
    convex.mutation(api.google.begin).mockReturnValue(gate.promise);
    render(<GoogleConnection navigate={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Connect Google" });
    await user.click(button);
    await waitFor(() => expect(button.getAttribute("aria-disabled")).toBe("true"));
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    await user.click(button);
    expect(convex.mutation(api.google.begin)).toHaveBeenCalledTimes(1);
    gate.resolve(AUTH_URL);
  });

  test("connected: says since when", () => {
    set({ missingEnv: [], connected: true, connectedAt: NOW - 3 * HOUR });
    const { container } = render(<GoogleConnection />);
    expect(text(container.querySelector("p"))).toBe("Connected 3h ago.");
    expect(screen.getByRole("button", { name: "Disconnect and delete" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Google" })).toBeNull();
  });

  test("a connected grant can still be deleted when a variable has gone missing", () => {
    set({ missingEnv: ["TOKEN_ENCRYPTION_KEY"], connected: true, connectedAt: NOW - HOUR });
    render(<GoogleConnection />);
    expect(screen.getByRole("button", { name: "Disconnect and delete" })).toBeTruthy();
  });

  test("disconnect asks first, in these words, and Keep it calls nothing", async () => {
    const user = userEvent.setup();
    set({ missingEnv: [], connected: true, connectedAt: NOW - HOUR });
    render(<GoogleConnection />);
    await user.click(screen.getByRole("button", { name: "Disconnect and delete" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Disconnect Google?");
    expect(dialog.textContent).toContain(
      "This deletes the inbox list and meetings stored here and asks Google to revoke access.",
    );
    expect(convex.mutation(api.google.disconnect)).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(convex.mutation(api.google.disconnect)).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("confirming disconnects, then says how to be sure", async () => {
    const user = userEvent.setup();
    set({ missingEnv: [], connected: true, connectedAt: NOW - HOUR });
    const view = render(<GoogleConnection />);
    await user.click(screen.getByRole("button", { name: "Disconnect and delete" }));
    const [, confirm] = screen.getAllByRole("button", { name: "Disconnect and delete" });
    await user.click(confirm ?? screen.getByRole("button", { name: "Disconnect and delete" }));
    expect(convex.mutation(api.google.disconnect)).toHaveBeenCalledWith({});
    // The live query catches up.
    set({ missingEnv: [], connected: false, connectedAt: null });
    view.rerender(<GoogleConnection />);
    expect(
      await screen.findByText(
        "Disconnected. To be sure, also remove Startup OS under Google Account → Security → Third-party access.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a failed disconnect is shown, and the question stays open", async () => {
    const user = userEvent.setup();
    set({ missingEnv: [], connected: true, connectedAt: NOW - HOUR });
    convex.mutation(api.google.disconnect).mockRejectedValue(new Error("network"));
    render(<GoogleConnection />);
    await user.click(screen.getByRole("button", { name: "Disconnect and delete" }));
    const dialog = screen.getByRole("dialog");
    const confirm = [...dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "Disconnect and delete",
    )!;
    await user.click(confirm);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Google could not be disconnected. Try again.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });
});

describe("GoogleResult", () => {
  const cases: [string, string][] = [
    ["connected", "Google is connected. The first read is running."],
    ["declined", "Google was not connected: the request was declined."],
    ["expired", "That connect attempt expired. Start again."],
    [
      "no_refresh_token",
      "Google did not return a lasting grant. Remove Startup OS under Google Account → Security → Third-party access, then connect again.",
    ],
    [
      "missing_scope",
      "Google was connected without mail or calendar access, so nothing was stored. Connect again and leave both boxes ticked.",
    ],
    ["wrong_account", "That was not the owner's Google account, so nothing was stored."],
    ["failed", "Google could not be connected. Try again."],
  ];

  test.each(cases)("?google=%s", (word, sentence) => {
    search = `google=${word}`;
    // The one result that claims a connection is shown over a real one.
    if (word === "connected") set({ missingEnv: [], connected: true, connectedAt: NOW });
    render(<GoogleResult />);
    expect(screen.getByRole("status").textContent).toBe(sentence);
  });

  // Anyone can send the owner a link ending in ?google=connected. The page
  // says Google is connected only when the deployment says so.
  test.each([
    ["not connected", { missingEnv: [], connected: false, connectedAt: null }],
    ["still loading", undefined],
  ])("?google=connected says nothing while the connection is %s", (_name, value) => {
    search = "google=connected";
    convex.setQuery(api.google.connection, value);
    render(<GoogleResult />);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByText(/Google is connected/)).toBeNull();
  });

  test("the address alone never makes the whole panel say connected", () => {
    search = "google=connected";
    render(
      <>
        <GoogleResult />
        <GoogleConnection />
      </>,
    );
    expect(screen.queryByText(/Google is connected/)).toBeNull();
    expect(screen.getByText("Not connected.")).toBeTruthy();
  });

  test("a failure is reported whatever the connection: it claims nothing", () => {
    search = "google=wrong_account";
    set({ missingEnv: [], connected: true, connectedAt: NOW });
    render(<GoogleResult />);
    expect(screen.getByRole("status").textContent).toBe(
      "That was not the owner's Google account, so nothing was stored.",
    );
  });

  test("there are exactly seven results", () => {
    expect(Object.keys(GOOGLE_RESULTS).sort()).toEqual(cases.map(([word]) => word).sort());
  });

  test.each([
    ["nothing", ""],
    ["an unknown word", "google=hello"],
    ["text someone put in the address", "google=%3Cb%3EYour+account+is+locked%3C%2Fb%3E"],
    ["a property every object has", "google=constructor"],
    ["another one", "google=toString"],
  ])("%s shows nothing", (_name, query) => {
    search = query;
    render(<GoogleResult />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
