import { Suspense } from "react";
import { LinkedinView } from "@/components/linkedin/linkedin-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function LinkedinPage() {
  return (
    // The calendar's view and the filters are in the address, which is read under a boundary.
    <Suspense fallback={<Skeleton className="h-48 rounded-card" />}>
      <LinkedinView />
    </Suspense>
  );
}
