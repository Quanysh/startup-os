// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Area } from "@convex/lib/roles";
import { ViewerProvider } from "@/components/viewer-provider";
import ConnectionsPage from "./page";

// Each part is its own component with its own tests; here, which are mounted for whom.
vi.mock("@/components/work/connect-view", () => ({
  ConnectView: () => <div data-testid="teammate-token" />,
}));
vi.mock("@/components/work/google-connection", () => ({
  GoogleConnection: () => <div data-testid="google" />,
  GoogleResult: () => null,
}));
vi.mock("@/components/work/source-switches", () => ({
  SourceSwitches: () => <div data-testid="switches" />,
}));
vi.mock("@/components/work/domain-lists", () => ({ DomainLists: () => <div data-testid="domains" /> }));
vi.mock("@/components/assistant/connected-clients", () => ({
  ConnectedClients: () => <div data-testid="agent-token" />,
}));
vi.mock("@/components/assistant/recent-calls", () => ({
  RecentCalls: () => <div data-testid="recent-calls" />,
}));

afterEach(cleanup);

const OWNER_AREAS: Area[] = ["scorecard", "today", "personal", "admin", "settings"];

function show(owner: boolean, areas: Area[]) {
  render(
    <ViewerProvider
      viewer={{
        role: owner ? "owner" : "cofounder",
        companies: ["us", "kz"],
        areas,
        email: "me@example.test",
        name: null,
      }}
    >
      <ConnectionsPage />
    </ViewerProvider>,
  );
}
const part = (name: string) => within(screen.getByRole("region", { name }));
const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("Settings › Connections", () => {
  test("the owner: their Google and switches under 'Send your tools', and Claude's token and calls under 'Let Claude read'", () => {
    show(true, OWNER_AREAS);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Connections");
    expect(headings()).toEqual(["Send your tools to Startup OS", "Let Claude read Startup OS"]);
    const send = part("Send your tools to Startup OS");
    for (const id of ["google", "switches", "domains"]) expect(send.getByTestId(id)).toBeTruthy();
    // The owner has no personal token: their tools are the shared mirror.
    expect(screen.queryByTestId("teammate-token")).toBeNull();
    const read = part("Let Claude read Startup OS");
    expect(read.getByTestId("agent-token")).toBeTruthy();
    expect(read.getByTestId("recent-calls")).toBeTruthy();
  });

  test("a teammate with Today sees only their own token, and nothing of the owner's", () => {
    show(false, ["scorecard", "today", "settings"]);
    expect(headings()).toEqual(["Send your tools to Startup OS"]);
    expect(part("Send your tools to Startup OS").getByTestId("teammate-token")).toBeTruthy();
    for (const id of ["google", "switches", "domains", "agent-token", "recent-calls"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    expect(screen.queryByRole("region", { name: "Let Claude read Startup OS" })).toBeNull();
  });
});
