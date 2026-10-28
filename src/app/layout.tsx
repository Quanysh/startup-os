import type { Metadata } from "next";
import { Inter, Poppins } from "next/font/google";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import { PAGE_TITLE, PRODUCT } from "@convex/lib/identity";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_SCRIPT } from "@/lib/theme";
import "@/styles/globals.css";

// The landing page's two faces: Poppins for headings and UI, Inter for
// columns of numbers.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { ...PAGE_TITLE },
  description: `${PRODUCT.description}.`,
  robots: { index: false, follow: false },
};

// No `themeColor` here: the browser's bar is one meta the theme script makes
// and keeps (applyTheme, src/lib/theme.ts), so that React has none to manage.

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ConvexAuthNextjsServerProvider>
      {/* The script below puts `dark` and `color-scheme` on <html> before
          React has seen it, so what the server sent and what is there differ
          by design: hence suppressHydrationWarning, on this element only. */}
      <html lang="en" className={`${poppins.variable} ${inter.variable}`} suppressHydrationWarning>
        <head>
          {/* Before first paint, on every page: the stored theme, or the
              system's. A fixed string (src/lib/theme.ts); the policy that
              lets it run is in next.config.ts. */}
          <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        </head>
        <body className="min-h-dvh antialiased">
          <ThemeProvider>
            <ConvexClientProvider>
              <TooltipProvider delayDuration={150}>{children}</TooltipProvider>
            </ConvexClientProvider>
          </ThemeProvider>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
