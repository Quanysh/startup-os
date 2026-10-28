"use client";

import { useParams } from "next/navigation";
import { idFromParam } from "@/lib/route-id";
import { DealPage } from "@/components/sales/deal-intel/deal-page";

// One US deal: what research found about it, and its editor. Under /sales, so
// it opens to whoever has Sales (src/lib/nav.ts); the deal's id is in the
// address, never its name.
export default function SalesDealPage() {
  const { id } = useParams<{ id: string }>();
  return <DealPage dealId={idFromParam(id)} />;
}
