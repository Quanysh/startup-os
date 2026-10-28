import { describe, expect, test } from "vitest";
import { PRODUCTS, productHref, productOf } from "./products";

describe("products", () => {
  test("three tabs, in this order, each with the sources that feed it", () => {
    expect(PRODUCTS.map((p) => [p.id, p.label, p.sources])).toEqual([
      ["startup_insights", "Startup Insights", ["posthog", "vercel"]],
      ["vertical_startup", "Vertical Startup", ["vertical_startup"]],
      ["kz_product", "Kazakhstan", ["cfo_workbook", "posthog_globex"]],
    ]);
  });

  test("a URL names its tab, and anything else is the first tab", () => {
    expect(productOf("vertical_startup")?.id).toBe("vertical_startup");
    expect(productOf("kz_product")?.id).toBe("kz_product");
    expect(productOf(null)?.id).toBe("startup_insights");
    expect(productOf("nonsense")?.id).toBe("startup_insights");
  });

  test("the first tab is the bare page; the others say which", () => {
    expect(productHref("startup_insights")).toBe("/product");
    expect(productHref("kz_product")).toBe("/product?product=kz_product");
  });
});
