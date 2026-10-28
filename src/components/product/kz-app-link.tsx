"use client";

import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Panel, fieldClass, primaryButtonClass, quietButtonClass } from "@/components/panel";
import {
  DataBody,
  DataCell,
  DataHead,
  DataHeader,
  DataRow,
  DataRowHeader,
  DataTable,
} from "@/components/ui/data-table";
import { StatusChip } from "@/components/ui/status-chip";
import { useViewer } from "@/hooks/use-viewer";
import { COMPANIES } from "@/lib/company";
import { messageOf } from "@/lib/errors";

const count = (n: number) => n.toLocaleString("en-US");
type AppClinic = {
  org: string;
  customerId: string | null;
  weeks: number;
  actions: number;
  doctors: number;
  lastActiveOn: string | null;
};
const describe = (c: AppClinic) =>
  `${c.org} · ${count(c.actions)} actions, ${count(c.doctors)} doctors last week${c.lastActiveOn ? ` · last ${c.lastActiveOn}` : ""}`;

/**
 * Which clinic in Globex's app this clinic is, for its usage and doctors.
 * The PostHog run links a clinic whose name matches once; this is how one it
 * could not match is linked by hand, by the app's id for it. Changing it is
 * the Customers page's, for a clinic in Kazakhstan.
 */
export function AppLink({ customerId }: { customerId: string }) {
  const id = useId();
  const { can } = useViewer();
  const clinics = useQuery(api.kzProduct.appClinics, {});
  const link = useMutation(api.customers.setAppClinic);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (clinics === undefined) return null;
  const mine = clinics.find((c) => c.customerId === customerId) ?? null;
  const free = clinics.filter((c) => c.customerId === null);
  const save = async (org: string | null) => {
    setBusy(true);
    setFailure(null);
    try {
      await link({ id: customerId as Id<"customers">, org });
      setChoice("");
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel aria-label={`${COMPANIES.kz.name} app link`} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium text-ink">In {COMPANIES.kz.name}&apos;s app</h2>
        {mine ? <StatusChip tone="success">Linked</StatusChip> : <StatusChip tone="warning">Not linked</StatusChip>}
      </div>
      {mine ? (
        <p className="text-sm text-ink-2">
          Its usage and doctors come from the app&apos;s clinic <span className="font-num">{mine.org}</span>, read from
          PostHog each morning.{" "}
          {can("customers") && (
            <button type="button" disabled={busy} onClick={() => void save(null)} className={quietButtonClass}>
              Unlink
            </button>
          )}
        </p>
      ) : (
        <>
          <p className="text-sm text-ink-2">
            Its name did not match a clinic in the app, so no usage or doctors are shown for it yet.
            {free.length === 0 ? " Every clinic in the app is linked to another." : " Pick the app's clinic it is."}
          </p>
          {can("customers") && free.length > 0 && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (choice !== "") void save(choice);
              }}
            >
              <label htmlFor={id} className="sr-only">
                The app&apos;s clinic
              </label>
              <select id={id} value={choice} onChange={(e) => setChoice(e.target.value)} className={`${fieldClass} h-10 max-w-full`}>
                <option value="">Choose a clinic in the app…</option>
                {free.map((c) => (
                  <option key={c.org} value={c.org}>
                    {describe(c)}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={busy || choice === ""} className={primaryButtonClass}>
                Link
              </button>
            </form>
          )}
        </>
      )}
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </Panel>
  );
}

/**
 * The app's clinics not linked to Customers yet, by their id there: their
 * usage counts in every total, but no clinic page shows it until linked.
 */
export function UnlinkedAppClinics() {
  const clinics = useQuery(api.kzProduct.appClinics, {});
  if (clinics === undefined) return null;
  const free = clinics.filter((c) => c.customerId === null);
  if (free.length === 0) return null;
  return (
    <Panel aria-label="Not linked to Customers" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-medium text-ink">In the app, not linked to Customers</h2>
        <StatusChip tone="warning">{count(free.length)}</StatusChip>
      </div>
      <p className="text-sm text-ink-2">
        Their name in the app matched no clinic in the client register. They count in every total; link one on its clinic&apos;s
        page to see its usage and doctors there.
      </p>
      <DataTable label="App clinics not linked" bleed={false}>
        <DataHead>
          <DataHeader>Id in the app</DataHeader>
          <DataHeader numeric>Actions last week</DataHeader>
          <DataHeader numeric>Doctors</DataHeader>
          <DataHeader>Last action</DataHeader>
        </DataHead>
        <DataBody>
          {free.map((c) => (
            <DataRow key={c.org}>
              <DataRowHeader className="font-num font-normal">{c.org}</DataRowHeader>
              <DataCell numeric>{count(c.actions)}</DataCell>
              <DataCell numeric>{count(c.doctors)}</DataCell>
              <DataCell>{c.lastActiveOn ?? "—"}</DataCell>
            </DataRow>
          ))}
        </DataBody>
      </DataTable>
    </Panel>
  );
}
