import Link from "next/link";
import { PRODUCTS, productHref, type ProductId } from "@/lib/metrics/products";
import { cn } from "@/lib/utils";

/** One link per product. Links, not buttons: each tab has its own address. */
export function ProductNav({
  current,
  products = PRODUCTS,
}: {
  current: ProductId;
  /** The tabs to offer: every product, or the company in view's. */
  products?: readonly (typeof PRODUCTS)[number][];
}) {
  // One product needs no tabs.
  if (products.length < 2) return null;
  return (
    <nav aria-label="Products" className="flex w-fit max-w-full flex-wrap gap-1 rounded-full bg-surface p-1">
      {products.map((product) => (
        <Link
          key={product.id}
          href={productHref(product.id)}
          aria-current={product.id === current ? "page" : undefined}
          className={cn(
            "inline-flex h-9 items-center rounded-full px-4 text-sm text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
            product.id === current && "bg-panel font-medium text-ink shadow-soft-sm",
          )}
        >
          {product.label}
        </Link>
      ))}
    </nav>
  );
}
