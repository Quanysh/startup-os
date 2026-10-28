"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AttentionList } from "@/components/attention-list";
import { useCompany } from "@/components/company-provider";
import { PageFreshness } from "@/components/freshness/freshness-indicator";
import { GatedLink } from "@/components/gated-link";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { KazakhstanTab } from "@/components/product/kazakhstan-tab";
import { VerticalTab } from "@/components/product/vertical-tab";
import { ProductNav } from "@/components/product/product-nav";
import { StartupInsightsTab } from "@/components/product/startup-insights-tab";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useScorecard } from "@/hooks/use-scorecard";
import { useViewer } from "@/hooks/use-viewer";
import { productOf, productsOf } from "@/lib/metrics/products";
import { attentionItems } from "@/lib/metrics/scorecard";

const TABS = {
  startup_insights: StartupInsightsTab,
  vertical_startup: VerticalTab,
  kz_product: KazakhstanTab,
};

function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-44 rounded-card" />
        <Skeleton className="h-44 rounded-card" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-44 rounded-card" />
        ))}
      </div>
    </div>
  );
}

/** Reads the address, so it sits under the page's Suspense boundary. */
function Product() {
  const company = useCompany();
  const product = productOf(useSearchParams().get("product"), company);
  const data = useScorecard();
  const now = useNow();
  const { can } = useViewer();

  // Every product switched off (convex/lib/featureGates.ts): a fork that has
  // connected none. Said once, with no tab and no tile.
  if (product === null) {
    return (
      <Panel className="space-y-2">
        <h2 className="text-base">No product is connected yet.</h2>
        <p className="max-w-2xl text-sm text-ink-2">
          Each product gets a tab here, with who uses it week by week, once its switch is on
          and its source is set up.
        </p>
      </Panel>
    );
  }
  const Tab = TABS[product.id];

  // Only failed runs, and only of the sources that feed what is on the page:
  // the open tab's. A number that is missing or old says so on its own tile.
  // (GitHub's figures and its failures are the Engineering page's.)
  const feeding = new Set<string>(product.sources.map((id) => `source:${id}`));
  const failures =
    data === undefined || now === null
      ? []
      : attentionItems(data.tiles, data.sources, now).filter(
          (item) => item.severity === "error" && feeding.has(item.id),
        );

  return (
    <>
      <ProductNav current={product.id} products={productsOf(company)} />
      {data === undefined || now === null ? (
        <Loading />
      ) : (
        <>
          {failures.length > 0 && <AttentionList items={failures} />}
          <Tab tiles={data.tiles} sources={data.sources} now={now} />
          {/* Engineering has a page of its own. One line leads there, for a
              viewer who has it; anyone else is told nothing of it. */}
          {can("engineering") && (
            <p className="text-sm text-ink-2">
              Pull requests, who owns them and what is stuck are on{" "}
              <GatedLink
                href="/engineering"
                className="rounded-sm font-medium text-brand underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                the Engineering page
              </GatedLink>
              .
            </p>
          )}
        </>
      )}
    </>
  );
}

export default function ProductPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Product health"
        purpose="Who uses each product, week by week."
        aside={<PageFreshness page="product" />}
      />
      <Suspense fallback={<Loading />}>
        <Product />
      </Suspense>
    </div>
  );
}
