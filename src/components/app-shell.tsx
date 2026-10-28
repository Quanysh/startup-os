"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import {
  ActivityIcon,
  ArrowLeftRightIcon,
  BookMarkedIcon,
  BotIcon,
  Building2Icon,
  CableIcon,
  CalendarDaysIcon,
  ClipboardListIcon,
  GitPullRequestIcon,
  HandCoinsIcon,
  ContactRoundIcon,
  HeartHandshakeIcon,
  HandshakeIcon,
  InboxIcon,
  LandmarkIcon,
  LifeBuoyIcon,
  LogOutIcon,
  MessageCircleIcon,
  PlugIcon,
  ReceiptTextIcon,
  SendIcon,
  SparklesIcon,
  SquareKanbanIcon,
  SunIcon,
  TargetIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { pageOn } from "@convex/lib/featureGates";
import type { Area } from "@convex/lib/roles";
import { InboxCount } from "@/components/approvals/inbox-count";
import { CompanyProvider, setCompany, useCompany } from "@/components/company-provider";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { CompanyLogo } from "@/components/brand-logo";
import { SuggestChange } from "@/components/suggest/suggest-change";
import { ThemeSwitch } from "@/components/theme-provider";
import { COMPANIES, companyIds, pageServes, type CompanyId } from "@/lib/company";
import { useViewer } from "@/hooks/use-viewer";
import { activeHref, pageAreas } from "@/lib/nav";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type NavItem = { title: string; href: string; icon: LucideIcon; areas: readonly Area[] };

/** A page and the areas that open it: an item shows only to a viewer who has one of them. */
const item = (title: string, href: string, icon: LucideIcon): NavItem => ({
  title,
  href,
  icon,
  areas: pageAreas(href),
});

// Only pages that exist. Each phase adds its own entries here, and the page's
// area in PAGE_AREAS (src/lib/nav.ts), with any other that opens it in PAGE_ALSO.
const NAV: { label: string; items: NavItem[] }[] = [
  {
    label: "Operate",
    items: [
      // The start page: what needs you, your day and how the company is doing.
      item("Today", "/", SunIcon),
      // The owner's alone (`personal`): every proposal and paused tool call, in one list.
      item("Approvals", "/approvals", InboxIcon),
      item("Board", "/board", SquareKanbanIcon),
      // What one bot has asked another to take over, and who has not answered.
      item("Handoffs", "/handoffs", ArrowLeftRightIcon),
      item("Goals and targets", "/goals", TargetIcon),
      // Every project's AI agents: their models, cost and quality, and their switches.
      item("Agents", "/agents", BotIcon),
      // The owner's alone: its area is `personal`, which no teammate has.
      item("Assistant", "/assistant", SparklesIcon),
    ],
  },
  {
    label: "Company",
    items: [
      item("Finance", "/finance", LandmarkIcon),
      item("Product", "/product", ActivityIcon),
      item("Engineering", "/engineering", GitPullRequestIcon),
      item("Sales", "/sales", HandshakeIcon),
      item("Fundraising", "/fundraising", HandCoinsIcon),
      item("Partnerships", "/partnerships", HeartHandshakeIcon),
      item("Contacts", "/contacts", ContactRoundIcon),
      item("Customers", "/customers", Building2Icon),
      // Globex's Intercom inbox (`PAGE_COMPANY`): shown on Globex only.
      item("Support", "/support", LifeBuoyIcon),
      item("Compliance", "/compliance", ClipboardListIcon),
      item("Go to market", "/gtm", SendIcon),
      item("LinkedIn", "/linkedin", CalendarDaysIcon),
      item("Memory", "/memory", BookMarkedIcon),
      item("Payroll", "/payroll", WalletIcon),
      item("Costs", "/costs", ReceiptTextIcon),
    ],
  },
  {
    label: "Settings",
    items: [
      item("Sources", "/settings/sources", PlugIcon),
      item("Connections", "/settings/connections", CableIcon),
      item("Team", "/settings/team", UsersIcon),
      item("Telegram", "/settings/telegram", MessageCircleIcon),
    ],
  },
];

const ITEMS = NAV.flatMap((group) => group.items);
const HREFS = ITEMS.map((entry) => entry.href);

type Viewer = { email: string | null; name: string | null };

/** Which company the whole app shows, among the viewer's own. One button each, one pressed. */
function CompanySwitch({
  company,
  companies,
}: {
  company: CompanyId | null;
  companies: readonly CompanyId[];
}) {
  return (
    <div role="group" aria-label="Company" className="flex gap-1 rounded-full bg-page p-1">
      {companies.map((id) => (
        <button
          key={id}
          type="button"
          aria-pressed={id === company}
          onClick={() => setCompany(id)}
          className={cn(
            "inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-xs text-ink-2 outline-none transition hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
            id === company && "bg-panel font-medium text-ink shadow-soft-sm",
          )}
        >
          <span className="truncate">{COMPANIES[id].name}</span>
          <span className="text-[10px] tracking-wide text-ink-3">{COMPANIES[id].marketLabel}</span>
        </button>
      ))}
    </div>
  );
}

/** Shown in place of a page the company in view has nothing on. */
function OtherCompanyPage({ company }: { company: CompanyId }) {
  const other = companyIds().find((id) => id !== company)!;
  return (
    <section className="rounded-card bg-panel p-6 shadow-soft">
      <h1 className="text-xl">Nothing here for {COMPANIES[company].name}</h1>
      <p className="mt-2 max-w-xl text-sm text-ink-2">
        This page is kept for {COMPANIES[other].name} only.
      </p>
      <button
        type="button"
        onClick={() => setCompany(other)}
        className="mt-4 inline-flex h-9 items-center rounded-full bg-surface px-4 text-sm font-medium text-ink outline-none transition hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Switch to {COMPANIES[other].name}
      </button>
    </section>
  );
}

/** Shown in place of a page the viewer's areas, or their companies, do not include. */
function NoAccessPage({ first }: { first: NavItem | undefined }) {
  return (
    <section className="rounded-card bg-panel p-6 shadow-soft">
      <h1 className="text-xl">You do not have access to this page</h1>
      <p className="mt-2 max-w-xl text-sm text-ink-2">
        The owner decides which pages each teammate sees.
      </p>
      {first && (
        <Link
          href={first.href}
          className="mt-4 inline-flex h-9 items-center rounded-full bg-surface px-4 text-sm font-medium text-ink outline-none transition hover:text-brand focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Go to {first.title}
        </Link>
      )}
    </section>
  );
}

// What is shown and hidden here follows the viewer's areas and companies. It is
// presentation only: every Convex function checks the caller itself. But a
// refused query throws and breaks the page, so a page the viewer lacks is
// never rendered, and so never asks.
export function AppShell(props: { viewer: Viewer; children: ReactNode }) {
  const { companies } = useViewer();
  return (
    <CompanyProvider allowed={companies}>
      <Shell {...props} />
    </CompanyProvider>
  );
}

function Shell({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  const pathname = usePathname();
  const active = activeHref(pathname, HREFS);
  const router = useRouter();
  const { signOut } = useAuthActions();
  const company = useCompany();
  const { can, companies, areas } = useViewer();

  // The pages this viewer has: their areas', among the company in view's.
  const shown = (entry: NavItem) => pageOn(entry.href) && entry.areas.some(can) && pageServes(company, entry.href);
  const first = ITEMS.find(shown);
  const current = ITEMS.find((entry) => entry.href === active);
  const refused = current !== undefined && !current.areas.some(can);
  // A page kept for the other company. Someone on both can switch to it;
  // someone who is not on that company has no such page.
  const elsewhere = current !== undefined && !refused && !pageServes(company, current.href);
  const canSwitch = companies.length > 1;

  // Today is where "/" and the logo lead. A viewer with neither the scorecard
  // nor `today` is taken to the first page they do have (the board, for an engineer).
  const sendTo = refused && pathname === "/" && first !== undefined ? first.href : null;
  useEffect(() => {
    if (sendTo !== null) router.replace(sendTo);
  }, [sendTo, router]);

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="gap-4 px-4 pt-5 pb-2">
          <Link
            href={first?.href ?? "/"}
            className="w-fit rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <CompanyLogo company={company} />
          </Link>
          {/* Someone on one company has nothing to switch between. */}
          {canSwitch && <CompanySwitch company={company} companies={companies} />}
          {/* On the left, above the pages, where it is seen on every visit.
              For every member with a page: someone with none is refused
              every function, the bell's included. */}
          {areas.length > 0 && <NotificationBell place="side" />}
        </SidebarHeader>

        <SidebarContent>
          {NAV.map((group) => ({ ...group, items: group.items.filter(shown) }))
            // A group with nothing in it for this viewer has no heading either.
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel className="text-ink-3">{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((entry) => (
                      <SidebarMenuItem key={entry.href}>
                        <SidebarMenuButton
                          asChild
                          isActive={entry.href === active}
                          className="h-9 rounded-full px-3 data-[active=true]:font-medium data-[active=true]:shadow-soft-sm"
                        >
                          <Link href={entry.href}>
                            <entry.icon aria-hidden />
                            <span>{entry.title}</span>
                          </Link>
                        </SidebarMenuButton>
                        {/* The owner's alone: what waits to be approved, counted once (the inbox's
                            length, both companies). The item is shown only to someone with its area
                            (`personal`), which is the owner; a teammate has no such item, and the
                            count is never asked for them. */}
                        {entry.href === "/approvals" && <InboxCount />}
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
        </SidebarContent>

        <SidebarFooter className="gap-2 p-4">
          {/* For every member, whatever their pages. Someone with no page at
              all is refused by every function, this one's included, so they
              are not offered it. */}
          {areas.length > 0 && <SuggestChange />}
          {/* Light, dark or the system's: this browser's own, like the company. */}
          <ThemeSwitch />
          <p className="truncate text-xs text-ink-2" title={viewer.email ?? undefined}>
            {viewer.name ?? viewer.email}
          </p>
          <button
            type="button"
            onClick={async () => {
              await signOut();
              router.replace("/signin");
            }}
            className="inline-flex w-fit items-center gap-1.5 rounded-full text-xs text-ink-2 outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <LogOutIcon aria-hidden className="size-3.5" />
            Sign out
          </button>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0 bg-page">
        {/* The top bar, on small screens only: the sidebar is off-canvas there,
            so this opens it and holds a second bell. From md up the bell is
            in the sidebar. */}
        <div data-slot="top-bar" className="border-b border-line md:hidden">
          <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-2 px-4 sm:px-6 lg:px-8">
            <SidebarTrigger aria-label="Open navigation" className="md:hidden" />
            <span className="md:hidden">
              <CompanyLogo company={company} />
            </span>
            {/* For every member with a page. Someone with none is refused
                every function, the bell's included. */}
            {areas.length > 0 && (
              <div className="ml-auto">
                <NotificationBell />
              </div>
            )}
          </div>
        </div>
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:pb-10">
          {sendTo !== null ? null : refused || (elsewhere && !canSwitch) ? (
            <NoAccessPage first={first} />
          ) : elsewhere && company !== null ? (
            // Reached by an old link or a switch made while on the page.
            <OtherCompanyPage company={company} />
          ) : (
            children
          )}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
