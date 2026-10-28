"use client";

import { PATIENT_DATA_NOTE, type ProviderState } from "@convex/lib/agentControl";
import { agoWords } from "@/lib/source-freshness";
import { providerGroups, providerReading } from "@/lib/agents/view";
import { PatientDataTag, StateChip } from "./parts";

type ProviderRow = {
  provider: string;
  model: string;
  state: ProviderState;
  checkedAt: number;
  lastErrorClass: string | null;
};

const ERROR_WORDS: Record<string, string> = {
  timeout: "timed out",
  auth: "refused the credentials",
  rate_limit: "rate limited",
  server: "server error",
  network: "network error",
  schema: "answer not in the expected shape",
};

/**
 * The providers a project's agents run on: the three the OS knows always,
 * "Not connected" until the project reports one, and any other it reports.
 * Each model's state in the page header's own states and words.
 */
export function ProvidersPanel({
  rows,
  now,
  note = true,
}: {
  rows: readonly ProviderRow[];
  now: number;
  /** Say which providers are for patient data (once a page). */
  note?: boolean;
}) {
  return (
    <div className="space-y-4">
      {note && <p className="max-w-3xl text-xs text-ink-2">{PATIENT_DATA_NOTE}</p>}
      <ul className="grid gap-3 md:grid-cols-3">
        {providerGroups(rows).map((group) => (
          <li key={group.provider} className="min-w-0 rounded-inner border border-line p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 text-sm font-medium text-ink">{group.label}</p>
              {group.models.length === 0 && <StateChip state="never">Not connected</StateChip>}
            </div>
            <div className="mt-2">
              {group.known ? (
                <PatientDataTag allowed={group.patientData} />
              ) : (
                <p className="text-xs text-ink-2">Not a provider the OS knows: it cannot be chosen here.</p>
              )}
            </div>
            {group.models.length > 0 && (
              <ul className="mt-3 space-y-2">
                {group.models.map((row) => {
                  const reading = providerReading(row, now);
                  return (
                    <li key={row.model} className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-ink">{row.model}</p>
                        <p className="text-xs text-ink-2">
                          {`Checked ${agoWords(now, row.checkedAt)}`}
                          {row.lastErrorClass !== null && `, last error: ${ERROR_WORDS[row.lastErrorClass] ?? "other"}`}
                        </p>
                      </div>
                      <StateChip state={reading.state}>{reading.words}</StateChip>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
