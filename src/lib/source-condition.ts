// What a source's card on the sources page says. Kept out of the page so each
// branch can be tested.

export type SourceCondition = "unconfigured" | "ready" | "waiting" | "ok" | "failed";

/**
 * - unconfigured: a variable it needs is not set.
 * - ready: typed-in numbers, which have no runs.
 * - waiting: configured, but nothing has run since. The daily cron logs
 *   "not configured" every day until the token is set, so that entry is
 *   older than the configuration and says nothing about it.
 * - ok / failed: the last run, once there is one that counts.
 */
export function sourceCondition(source: {
  kind: "manual" | "ingest" | "api";
  configured: boolean;
  status: { state: string } | null;
}): SourceCondition {
  if (!source.configured) return "unconfigured";
  if (source.kind === "manual") return "ready";
  if (source.status === null || source.status.state === "not_configured") return "waiting";
  return source.status.state === "ok" ? "ok" : "failed";
}

const KIND_LABEL = { manual: "Manual", ingest: "Pushed", api: "Synced" } as const;

/**
 * The badge on a source's card: which way it is fed. A pulled source whose
 * ingest token is set instead of its API variables is fed by a connector run
 * (docs/ingest.md), and the card says so rather than "Synced".
 */
export function feedLabel(source: {
  kind: "manual" | "ingest" | "api";
  fedBy: "manual" | "push" | "pull" | null;
}): string {
  if (source.kind === "api" && source.fedBy === "push") return "Pushed by a connector run";
  return KIND_LABEL[source.kind];
}
