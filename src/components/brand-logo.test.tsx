// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { COMPANY_IDENTITY, PRODUCT, type LogoId } from "@convex/lib/identity";
import { ALL_COMPANY_IDS } from "@/lib/company";
import { CompanyLogo, LOGOS, ProductLogo } from "./brand-logo";

afterEach(cleanup);

describe("the logos the identity names", () => {
  test("every logo a company or the product names is drawn", () => {
    const named: LogoId[] = [PRODUCT.logo, ...ALL_COMPANY_IDS.map((id) => COMPANY_IDENTITY[id].logo)];
    for (const logo of named) expect(LOGOS[logo]).toBeTypeOf("function");
  });

  test("Startup's is the drawn wordmark, with the product's tag", () => {
    render(<CompanyLogo company="us" />);
    expect(screen.getByRole("img", { name: "Startup" })).toBeTruthy();
    expect(screen.getByText(PRODUCT.shortName)).toBeTruthy();
  });

  test("Globex's is its mark and its name set in type", () => {
    render(<CompanyLogo company="kz" />);
    expect(screen.getByText("Globex")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Startup" })).toBeNull();
  });

  test("with no company chosen, the default company's", () => {
    render(<CompanyLogo company={null} />);
    expect(screen.getByRole("img", { name: "Startup" })).toBeTruthy();
  });

  test("the product's logo is the one PRODUCT names", () => {
    render(<ProductLogo />);
    expect(screen.getByRole("img", { name: "Startup" })).toBeTruthy();
  });
});
