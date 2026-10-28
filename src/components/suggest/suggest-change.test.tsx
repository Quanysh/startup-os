// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { SUGGESTION_WORDS } from "@convex/lib/suggestion";
import { ViewerProvider, type ViewerProfile } from "@/components/viewer-provider";
import { deferred, mockConvex } from "@/test-support/convex";
import { SuggestChange } from "./suggest-change";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
let pathname = "/finance";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

let convex: ReturnType<typeof mockConvex>;
beforeEach(() => {
  vi.mocked(useMutation).mockClear();
  convex = mockConvex();
  pathname = "/finance";
});
afterEach(cleanup);

// A made-up teammate. Sales has the board; `areas` says otherwise where a test needs it.
const viewer = (areas: ViewerProfile["areas"]): ViewerProfile => ({
  role: "sales",
  companies: ["us"],
  areas,
  email: "sam@example.test",
  name: "Sam Placeholder",
});

async function open(areas: ViewerProfile["areas"] = ["scorecard", "sales", "board"]) {
  const user = userEvent.setup();
  render(
    <ViewerProvider viewer={viewer(areas)}>
      <SuggestChange />
    </ViewerProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Suggest a change" }));
  return user;
}

const field = () => screen.getByLabelText("What should be better?") as HTMLTextAreaElement;
const page = () => screen.getByLabelText(/Which page/) as HTMLInputElement;
const send = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Send" }));
const sent = () => convex.mutation(api.suggestions.create).mock.calls;

describe("Suggest a change: the dialog", () => {
  test("nothing is asked of the server until the button is pressed", () => {
    render(<SuggestChange />);
    expect(vi.mocked(useMutation)).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Suggest a change" })).toBeTruthy();
  });

  test("it opens with one text field and the page filled from where the viewer is", async () => {
    await open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(field().value).toBe("");
    expect(page().value).toBe("/finance");
  });

  test("a text that is too short is refused here, in the server's own words, and nothing is sent", async () => {
    const user = await open();
    await user.type(field(), "Hmm");
    await send(user);
    expect(screen.getByRole("alert").textContent).toBe(SUGGESTION_WORDS.too_short);
    expect(sent()).toHaveLength(0);
  });

  test("the refusal goes as soon as the text is changed, and the longer text is sent", async () => {
    const user = await open();
    await user.type(field(), "Hmm");
    await send(user);
    expect(screen.getByRole("alert")).toBeTruthy();
    await user.type(field(), ", bigger numbers");
    expect(screen.queryByRole("alert")).toBeNull();
    await send(user);
    expect(sent()).toEqual([[{ text: "Hmm, bigger numbers", page: "/finance" }]]);
  });

  test("a text that is too long is refused here too", async () => {
    const user = await open();
    await user.click(field());
    await user.paste("x".repeat(501));
    await send(user);
    expect(screen.getByRole("alert").textContent).toBe(SUGGESTION_WORDS.too_long);
    expect(sent()).toHaveLength(0);
  });

  test("sending passes the text and the page, and says where it went", async () => {
    const user = await open();
    await user.type(field(), "Show which month is still open");
    await send(user);
    expect(sent()).toEqual([[{ text: "Show which month is still open", page: "/finance" }]]);
    expect(screen.getByText("Sent. It is on the team's board.")).toBeTruthy();
    // The form is gone: there is nothing left to send twice.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  test("a page cleared by hand is left out, not sent as blank", async () => {
    const user = await open();
    await user.clear(page());
    await user.type(field(), "A general thought about colours");
    await send(user);
    expect(sent()).toEqual([[{ text: "A general thought about colours" }]]);
  });

  test("someone with the board is offered a link to it", async () => {
    const user = await open(["scorecard", "sales", "board"]);
    await user.type(field(), "Show which month is still open");
    await send(user);
    expect(screen.getByRole("link", { name: "Open the board" }).getAttribute("href")).toBe("/board");
  });

  test("someone without the board is told the same, with no link they could not open", async () => {
    const user = await open(["finance"]);
    await user.type(field(), "Show which month is still open");
    await send(user);
    expect(screen.getByText("Sent. It is on the team's board.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("a refusal from the server is shown, and what was typed is kept", async () => {
    convex
      .mutation(api.suggestions.create)
      .mockRejectedValueOnce(new ConvexError(SUGGESTION_WORDS.too_many));
    const user = await open();
    await user.type(field(), "One more thought for today");
    await send(user);
    expect(screen.getByRole("alert").textContent).toBe(SUGGESTION_WORDS.too_many);
    expect(field().value).toBe("One more thought for today");
    expect(screen.queryByText("Sent. It is on the team's board.")).toBeNull();
  });

  test("any other failure is said in plain words", async () => {
    convex.mutation(api.suggestions.create).mockRejectedValueOnce(new Error("socket closed"));
    const user = await open();
    await user.type(field(), "One more thought for today");
    await send(user);
    expect(screen.getByRole("alert").textContent).toBe("That could not be sent. Try again.");
  });

  test("a second press while the first is in flight sends nothing more", async () => {
    const flight = deferred();
    convex.mutation(api.suggestions.create).mockReturnValueOnce(flight.promise);
    const user = await open();
    await user.type(field(), "Show which month is still open");
    await send(user);
    await send(user);
    expect(sent()).toHaveLength(1);
    flight.resolve(null);
    expect(await screen.findByText("Sent. It is on the team's board.")).toBeTruthy();
  });

  test("closing and opening again starts clean, on the page the viewer is on now", async () => {
    const user = await open();
    await user.type(field(), "Half a thought");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    pathname = "/board";
    await user.click(screen.getByRole("button", { name: "Suggest a change" }));
    expect(field().value).toBe("");
    expect(page().value).toBe("/board");
  });
});
