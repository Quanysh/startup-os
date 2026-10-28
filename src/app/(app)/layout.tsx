"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { ShieldXIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { api } from "@convex/_generated/api";
import { PRODUCT } from "@convex/lib/identity";
import { AppShell } from "@/components/app-shell";
import { ProductLogo } from "@/components/brand-logo";
import { Skeleton } from "@/components/ui/skeleton";
import { ViewerProvider } from "@/components/viewer-provider";
import { SpotlightTracker } from "@/components/ui/spotlight";

// Chooses the screen from who is looking. This is presentation only: someone
// not let in who bypassed it would still get nothing, because every Convex
// function re-checks the caller itself.
export default function AppLayout({ children }: { children: ReactNode }) {
  const viewer = useQuery(api.viewer.me);
  const router = useRouter();

  useEffect(() => {
    // The session ended in another tab, or expired.
    if (viewer === null) router.replace("/signin");
  }, [viewer, router]);

  if (viewer === undefined || viewer === null) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6 px-6 py-10" aria-busy>
        <Skeleton className="h-8 w-48 rounded-full" />
        <Skeleton className="h-56 w-full rounded-card" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-44 rounded-card" />
          <Skeleton className="h-44 rounded-card" />
          <Skeleton className="h-44 rounded-card" />
        </div>
      </div>
    );
  }

  if (!viewer.isMember) return <NotAllowed />;

  // The owner or a teammate. Their role, companies and areas go down through
  // useViewer(), for what to show; what they may be sent is Convex's to say.
  return (
    <ViewerProvider viewer={viewer}>
      {/* The light that follows the pointer across every panel. */}
      <SpotlightTracker />
      <AppShell viewer={viewer}>{children}</AppShell>
    </ViewerProvider>
  );
}

function NotAllowed() {
  const { signOut } = useAuthActions();
  const router = useRouter();
  return (
    <main className="wash-brand flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-card bg-panel p-8 shadow-soft">
        <ProductLogo />
        <ShieldXIcon aria-hidden className="mt-8 size-6 text-weak" />
        <h1 className="mt-3 text-xl">This account does not have access</h1>
        <p className="mt-2 text-sm text-ink-2">
          {PRODUCT.name} is limited to the owner and the teammates the owner has added. Sign out
          and choose the Google account that was added to continue.
        </p>
        <button
          type="button"
          onClick={async () => {
            await signOut();
            router.replace("/signin");
          }}
          className="mt-6 inline-flex h-10 items-center rounded-full bg-brand-fill px-5 text-sm font-medium text-on-brand outline-none transition hover:bg-brand-deep focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
