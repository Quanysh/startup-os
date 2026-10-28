// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "@convex/_generated/api";
import { AREAS, areasOf } from "@convex/lib/roles";
import { useViewer } from "@/hooks/use-viewer";
import { mockConvex } from "@/test-support/convex";
import AppLayout from "./layout";

vi.mock("convex/react", () => ({ useQuery: vi.fn(), useMutation: vi.fn() }));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
// The shell is its own subject; here it only has to show what it was given.
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

afterEach(() => {
  cleanup();
  replace.mockClear();
});

/** Prints what a page inside the layout learns from useViewer(). */
function Probe() {
  const viewer = useViewer();
  return (
    <p data-testid="probe">
      {[
        viewer.role,
        viewer.isOwner ? "owner" : "not-owner",
        viewer.companies.join("+"),
        viewer.email,
        viewer.name,
        `finance:${viewer.can("finance")}`,
        `product:${viewer.can("product")}`,
        `admin:${viewer.can("admin")}`,
      ].join(" | ")}
    </p>
  );
}

const show = (viewer: unknown) => {
  const convex = mockConvex();
  convex.setQuery(api.viewer.me, viewer);
  return render(
    <AppLayout>
      <Probe />
    </AppLayout>,
  );
};

const ENGINEER = {
  isOwner: false,
  isMember: true,
  role: "engineer",
  companies: ["kz"],
  areas: [...areasOf("engineer")],
  email: "eng@example.test",
  name: "Eng Ineer",
  image: null,
};

describe("the app layout", () => {
  test("a teammate, not only the owner, gets the app, with their role and areas", () => {
    show(ENGINEER);
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(screen.getByTestId("probe").textContent).toBe(
      "engineer | not-owner | kz | eng@example.test | Eng Ineer | finance:false | product:true | admin:false",
    );
  });

  test("the owner gets the app with every area", () => {
    show({
      ...ENGINEER,
      isOwner: true,
      role: "owner",
      companies: ["us", "kz"],
      areas: [...AREAS],
    });
    expect(screen.getByTestId("probe").textContent).toContain(
      "owner | owner | us+kz | eng@example.test | Eng Ineer | finance:true | product:true | admin:true",
    );
  });

  test("someone signed in who is not let in gets the refusal and no page", () => {
    show({ isOwner: false, isMember: false });
    expect(screen.getByRole("heading").textContent).toBe("This account does not have access");
    expect(screen.queryByTestId("shell")).toBeNull();
    expect(screen.queryByTestId("probe")).toBeNull();
  });

  test("signed out: nothing is shown and the browser is sent to sign in", () => {
    show(null);
    expect(screen.queryByTestId("shell")).toBeNull();
    expect(replace).toHaveBeenCalledWith("/signin");
  });

  test("while the answer is on its way, neither the page nor the refusal shows", () => {
    show(undefined);
    expect(screen.queryByTestId("shell")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("useViewer outside the layout", () => {
  test("a component rendered on its own is shown everything", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toContain("owner | owner | us+kz");
    expect(screen.getByTestId("probe").textContent).toContain("admin:true");
  });
});
