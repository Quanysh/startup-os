// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

const signIn = vi.fn(async () => ({ signingIn: false }));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signIn }) }));
vi.mock("@/components/theme-provider", () => ({ ThemeSwitch: () => null }));

import SignInPage from "./page";

afterEach(() => {
  cleanup();
  signIn.mockClear();
  window.history.replaceState(null, "", "/signin");
});

describe("where signing in returns to", () => {
  test("Today, as before", async () => {
    render(<SignInPage />);
    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: "/" });
  });

  test("OAuth's consent page, with the client's request, when that is where the visitor came from", async () => {
    const next = "/oauth/authorize?client_id=sosc_x&state=a%20b";
    window.history.replaceState(null, "", `/signin?next=${encodeURIComponent(next)}`);
    render(<SignInPage />);
    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: next });
  });

  test("never anywhere else a link could name", async () => {
    window.history.replaceState(null, "", `/signin?next=${encodeURIComponent("https://evil.example.test/")}`);
    render(<SignInPage />);
    await userEvent.click(screen.getByRole("button", { name: /Continue with Google/ }));
    expect(signIn).toHaveBeenCalledWith("google", { redirectTo: "/" });
  });
});
