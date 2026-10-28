"use client";

import { useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useId, useMemo, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { COMPANIES, marketsOf, type CompanyId } from "@convex/lib/company";
import { SCOPE_CURRENCY } from "@convex/lib/metricRegistry";
import type { PartnerCard } from "@convex/lib/partnerStages";
import { useCompany } from "@/components/company-provider";
import { PageHeader } from "@/components/page-header";
import { PartnerBoard } from "@/components/partnerships/partner-board";
import { PartnerEditor, type PartnerChange } from "@/components/partnerships/partner-editor";
import { PartnerTable } from "@/components/partnerships/partner-table";
import { PartnerTiles } from "@/components/partnerships/partner-tiles";
import { LayoutSwitch } from "@/components/sales/sales-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { useViewer } from "@/hooks/use-viewer";
import { moveOnBoard } from "@/lib/board";
import { localIsoDate } from "@/lib/dates";
import { readLayout, writeLayout } from "@/lib/partnerships/view";
import { LinkedContacts } from "@/components/contacts/linked-contacts";
import { OutcomesTimeline } from "@/components/outcomes/outcomes-timeline";

export default function PartnershipsPage() {
  const { companies } = useViewer();
  const now = useNow();
  // The companies in view that the viewer is on: Convex refuses the other's partners.
  const company = useCompany();
  const shown = marketsOf(company).filter((one) => companies.includes(one));
  return (
    <div className="space-y-10">
      <PageHeader
        title="Partnerships"
        purpose="Channel, integration, referral, strategic and design partners, from first contact to live. Open one to set its next step and date; a partner in conversation with no activity for two weeks is marked quiet."
      />
      {/* The layout is in the address, which suspends while the page is prerendered. */}
      <Suspense fallback={<Skeleton className="h-64 rounded-card" />}>
        {shown.map((one) => (
          <CompanySection key={one} company={one} named={shown.length > 1} now={now} />
        ))}
      </Suspense>
    </div>
  );
}

function CompanySection({
  company,
  named,
  now,
}: {
  company: CompanyId;
  named: boolean;
  now: number | null;
}) {
  const headingId = useId();
  const board = useQuery(api.partnerships.board, { company });
  const create = useMutation(api.partnerships.create);
  const update = useMutation(api.partnerships.update);
  const remove = useMutation(api.partnerships.remove);
  // Show the card where it was dropped at once; the server's answer replaces this a moment later.
  const move = useMutation(api.partnerships.move).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.partnerships.board, { company });
    if (!current || !(args.stage in current)) return;
    store.setQuery(
      api.partnerships.board,
      { company },
      moveOnBoard<PartnerCard, typeof current>(current, args.id, args.stage, args.index, (partner) => ({
        ...partner,
        stage: args.stage as PartnerCard["stage"],
        lastActivityAt: partner.stage === args.stage ? partner.lastActivityAt : Date.now(),
      })),
    );
  });

  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const query = params.toString();
  const layout = useMemo(() => readLayout(new URLSearchParams(query)), [query]);
  const setLayout = (next: typeof layout) => {
    const written = writeLayout(next);
    router.replace(written === "" ? pathname : `${pathname}?${written}`, { scroll: false });
  };
  const [editingId, setEditingId] = useState<string | null>(null);

  const currency = SCOPE_CURRENCY[company]!;
  const today = now === null ? null : localIsoDate(now);
  const partners = useMemo(() => (board === undefined ? [] : Object.values(board).flat()), [board]);

  const save = (id: string, change: PartnerChange) => update({ id: id as Id<"partners">, ...change });
  const editing =
    editingId === null ? undefined : (partners.find((partner) => partner.id === editingId) ?? null);

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className={named ? "text-xl" : "sr-only"}>
          {COMPANIES[company].name}
        </h2>
        <LayoutSwitch layout={layout} onLayout={setLayout} />
      </div>

      {board === undefined || now === null || today === null ? (
        <div className="space-y-4" aria-busy>
          <Skeleton className="h-10 rounded-card" />
          <Skeleton className="h-64 rounded-card" />
        </div>
      ) : (
        <>
          <PartnerTiles partners={partners} now={now} today={today} />
          {layout === "board" ? (
            <PartnerBoard
              board={board}
              now={now}
              today={today}
              currency={currency}
              onMove={(id, stage, index) => move({ id: id as Id<"partners">, stage, index })}
              onCreate={(stage, name) =>
                create({ company, name, stage, type: "channel" }) as Promise<string>
              }
              onSave={save}
              onDelete={(id) => remove({ id: id as Id<"partners"> })}
              editorBelow={(partner) => (
                <LinkedContacts company={company} type="partner" recordId={partner.id} />
              )}
            />
          ) : (
            <>
              <PartnerTable
                partners={partners}
                company={COMPANIES[company].name}
                now={now}
                today={today}
                onOpen={setEditingId}
              />
              {editing !== undefined && (
                <PartnerEditor
                  key={editingId}
                  partner={editing}
                  currency={currency}
                  onSave={(change) => save(editingId!, change)}
                  onDelete={() => remove({ id: editingId as Id<"partners"> })}
                  onClose={() => setEditingId(null)}
                  outcomes={<OutcomesTimeline kind="partner" id={editingId!} />}
                  below={
                    editing ? (
                      <LinkedContacts company={company} type="partner" recordId={editing.id} />
                    ) : undefined
                  }
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
