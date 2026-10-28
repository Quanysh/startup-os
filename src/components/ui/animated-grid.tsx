import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// A slow drifting grid with a soft brand glow, behind a page's opening.
// Adapted from 21st.dev's "Animated Grid" (rmahammad): gradients and two
// keyframes in src/styles/globals.css ("Animated grid"), no canvas and no
// script; still under `prefers-reduced-motion`, a plain grid under forced
// colours. It fills its positioned parent and fades toward the edges.
export function AnimatedGrid({ className, ...props }: ComponentProps<"div">) {
  return (
    <div aria-hidden="true" className={cn("animated-grid pointer-events-none absolute inset-0 overflow-hidden", className)} {...props}>
      <span className="animated-grid-glow" />
    </div>
  );
}
