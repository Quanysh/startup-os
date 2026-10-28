// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { Id } from "@convex/_generated/dataModel";
import { BotRequestList, type RequestRow } from "./bot-requests";

afterEach(cleanup);

const idOf = (id: string) => id as Id<"devRequests">;
const row = (over: Partial<RequestRow>): RequestRow => ({
  id: idOf("r1"),
  title: "Made-up request",
  status: "issue_open",
  decision: null,
  tool: null,
  refusalCode: null,
  issueUrl: "https://github.com/Made-Up-Org/made-up-os/issues/12",
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("BotRequestList", () => {
  test("a row a request: its status in words, its title, the answer and links to the issue and the pull request", () => {
    render(
      <BotRequestList
        name="Growth Bot"
        rows={[
          row({
            id: idOf("a"),
            title: "<b>Deals</b> needs a stage filter",
            status: "fix_proposed",
            decision: "The deals tool takes a stage now.",
            prUrl: "https://github.com/Made-Up-Org/made-up-os/pull/77",
          }),
          row({ id: idOf("b"), status: "needs_owner", decision: "The owner decides." }),
          row({ id: idOf("c"), status: "filed", issueUrl: null }),
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Growth Bot's requests" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Text a bot chose is text.
    expect(items[0]!.textContent).toContain("<b>Deals</b> needs a stage filter");
    expect(items[0]!.textContent).toContain("Fix proposed");
    expect(items[0]!.textContent).toContain("The deals tool takes a stage now.");
    expect(within(items[0]!).getByRole("link", { name: "Issue #12" }).getAttribute("href")).toBe(
      "https://github.com/Made-Up-Org/made-up-os/issues/12",
    );
    const pr = within(items[0]!).getByRole("link", { name: "Pull request #77" });
    expect(pr.getAttribute("href")).toBe("https://github.com/Made-Up-Org/made-up-os/pull/77");
    expect(pr.getAttribute("rel")).toBe("noopener noreferrer");
    expect(items[1]!.textContent).toContain("Needs you");
    expect(items[2]!.textContent).toContain("Waiting for an issue");
    expect(within(items[2]!).queryByRole("link")).toBeNull();
  });

  test("none yet says so", () => {
    render(<BotRequestList name="Research Bot" rows={[]} />);
    expect(screen.getByText("No requests yet. A bot files one with dev_request when Startup OS lacks something it needs.")).toBeTruthy();
  });

  test("a link that is not the repository's is not shown", () => {
    render(<BotRequestList name="x" rows={[row({ issueUrl: "https://evil.example/issues/1", prUrl: "javascript:alert(1)" })]} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
