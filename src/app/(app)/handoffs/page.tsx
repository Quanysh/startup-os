import { Suspense } from "react";
import { HandoffsView } from "@/components/handoffs/handoffs-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function HandoffsPage() {
  return (
    // The filters are in the address, which is read under a boundary.
    <Suspense fallback={<Skeleton className="h-48 rounded-card" />}>
      <HandoffsView />
    </Suspense>
  );
}
