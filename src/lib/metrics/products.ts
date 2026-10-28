// The products the /product page has a tab for, and the sources whose failed
// run belongs on each tab. A product's id is its scope in the registry.

import { productOn } from "@convex/lib/featureGates";
import type { Scope, SourceId } from "@convex/lib/metricRegistry";
import { companyOfMetric, type CompanyId } from "@/lib/company";

export type Product = { id: Scope; label: string; sources: readonly SourceId[] };

export const PRODUCTS = [
  { id: "startup_insights", label: "Startup Insights", sources: ["posthog", "vercel"] },
  { id: "vertical_startup", label: "Vertical Startup", sources: ["vertical_startup"] },
  { id: "kz_product", label: "Kazakhstan", sources: ["cfo_workbook", "posthog_globex"] },
] as const satisfies readonly Product[];

export type ProductId = (typeof PRODUCTS)[number]["id"];

/**
 * The products of one company, or all of them when none is chosen. A product
 * a switched-off feature takes away (convex/lib/featureGates.ts) is in neither.
 */
export function productsOf(company: CompanyId | null): (typeof PRODUCTS)[number][] {
  return PRODUCTS.filter((p) => productOn(p.id) && (company === null || companyOfMetric("", p.id) === company));
}

/**
 * The tab a `?product=` value names among the company's products; the
 * company's first tab for anything else, another company's product included.
 * Null when every product is switched off (convex/lib/featureGates.ts): a
 * fork that has connected none.
 */
export function productOf(
  param: string | null,
  company: CompanyId | null = null,
): (typeof PRODUCTS)[number] | null {
  const products = productsOf(company);
  return products.find((p) => p.id === param) ?? products[0] ?? productsOf(null)[0] ?? null;
}

export function productHref(id: ProductId): string {
  return id === PRODUCTS[0].id ? "/product" : `/product?product=${id}`;
}
