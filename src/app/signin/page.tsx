"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { Loader2Icon, LockIcon } from "lucide-react";
import { useState } from "react";
import { PRODUCT } from "@convex/lib/identity";
import { ProductLogo } from "@/components/brand-logo";
import { ThemeSwitch } from "@/components/theme-provider";
import { safeNext } from "@/lib/os/sign-in-next";

// Google's own four colours, as its sign-in guidelines require: not ours to
// re-theme (they read on both grounds), so they are the one place outside the
// logo where a colour is written out.
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 18 18" className="size-[18px]" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

export default function SignInPage() {
  const { signIn } = useAuthActions();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const start = async () => {
    setPending(true);
    setFailed(false);
    try {
      // Back to OAuth's consent page, with the client's request, when that is
      // where the visitor came from (src/lib/os/sign-in-next.ts); else Today.
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      await signIn("google", { redirectTo: next ?? "/" });
    } catch {
      setFailed(true);
      setPending(false);
    }
  };

  return (
    <main className="wash-brand relative flex min-h-dvh items-center justify-center px-4 py-10">
      {/* Seen before the shell and its sidebar, so the theme can be chosen here too. */}
      <ThemeSwitch className="absolute top-4 right-4" />
      <div className="w-full max-w-sm rounded-card bg-panel p-8 shadow-soft">
        <ProductLogo />
        <h1 className="mt-8 text-2xl">Sign in</h1>
        <p className="mt-2 text-sm text-ink-2">
          {PRODUCT.description}. Access is limited to the owner and the
          teammates the owner has added.
        </p>

        <button
          type="button"
          onClick={start}
          disabled={pending}
          className="mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-full bg-page text-sm font-medium text-ink shadow-inset outline-none transition hover:bg-surface focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
        >
          {pending ? <Loader2Icon className="size-4 animate-spin" /> : <GoogleGlyph />}
          Continue with Google
        </button>

        {failed && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            Sign-in could not start. Check your connection and try again.
          </p>
        )}

        <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-ink-3">
          <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          If you land back on this page after choosing an account, that account is not
          on the access list. It has to be a Gmail or Google Workspace address.
        </p>
      </div>
    </main>
  );
}
