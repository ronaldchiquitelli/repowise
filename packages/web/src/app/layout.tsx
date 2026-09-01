import type { Metadata } from "next";
import { Suspense } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Lora } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { TooltipProvider } from "@repowise-dev/ui/ui/tooltip";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { ThemedToaster } from "@/components/layout/themed-toaster";
import { Sidebar } from "@/components/layout/sidebar";
import { AppShellSkeleton } from "@/components/layout/app-shell-skeleton";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CommandPalette } from "@/components/search/command-palette";
import { ContextDrawerShell } from "@/components/layout/context-drawer-provider";
import { SWRProvider } from "@/components/layout/swr-provider";
import { ReposProvider } from "@/components/layout/repos-context";
import { UpgradeBanner } from "@/components/layout/upgrade-banner";
import "@/styles/globals.css";

// Serif display face for the docs/wiki reading surfaces (--font-serif token).
const lora = Lora({ subsets: ["latin"], variable: "--font-lora", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "repowise",
    template: "%s — repowise",
  },
  description: "Open-source codebase documentation engine",
};

/**
 * Root layout — now fully client-driven for repos + workspace.
 *
 * Previously this was an async server component that fetched repos and workspace
 * data during SSR. That broke navigation: every time the user navigated to a
 * different route (e.g. /settings), Next.js re-rendered the server component,
 * which had no access to the API key stored in localStorage, returning an empty
 * sidebar with "Can't reach the API".
 *
 * This version wraps the shell in <ReposProvider>, which uses client-side SWR to
 * load repos + workspace once and keep them alive across all route transitions.
 * No server-side fetch, no lost auth keys, no disappearing sidebar.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${lora.variable}`}
    >
      <body className="bg-[var(--color-bg-root)] text-[var(--color-text-primary)] antialiased">
        <ThemeProvider>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-[var(--color-bg-elevated)] focus:px-3 focus:py-2 focus:text-sm focus:text-[var(--color-text-primary)] focus:outline focus:outline-2 focus:outline-[var(--color-accent-primary)]"
        >
          Skip to content
        </a>
        <NuqsAdapter>
        <SWRProvider>
        <ReposProvider>
        <TooltipProvider delayDuration={300}>
          <Suspense fallback={<AppShellSkeleton />}>
            <ContextDrawerShell>
              <div className="flex h-screen flex-col overflow-hidden">
                <UpgradeBanner />
                <div className="flex flex-1 overflow-hidden">
                <Sidebar />
                <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
                  <MobileNav />
                  {/* A flex column, so anything a route layout stacks above
                      the page (repo breadcrumb, reindex hint, active-job
                      banner) is subtracted from the page's own height rather
                      than added to it. `PageTransition` used to take `h-full`
                      = 100% of this element, which ignored those bands: the
                      page then overflowed by exactly their combined height and
                      `main` scrolled. Invisible on a document page, but a
                      full-bleed canvas pushed its bottom-anchored chrome — the
                      graph legend, the zoom controls — below the fold, where
                      it could not be clicked. */}
                  <main
                    id="main-content"
                    className="flex flex-1 flex-col overflow-auto min-w-0"
                  >
                    {children}
                  </main>
                </div>
                </div>
              </div>
              <CommandPalette />
            </ContextDrawerShell>
          </Suspense>
        </TooltipProvider>
        </ReposProvider>
        </SWRProvider>
        </NuqsAdapter>
        <ThemedToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
