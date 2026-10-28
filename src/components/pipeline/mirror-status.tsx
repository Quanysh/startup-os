import { Note } from "@/components/finance/notes";

/** One source, as `api.sources.list` returns it. */
export type MirrorSource = {
  configured: boolean;
  missingEnv: readonly string[];
  status: {
    state: string;
    message: string | null;
    lastRunAt: number;
    lastOkAt: number | null;
  } | null;
};

/**
 * What a holder of Settings › Sources is told above a mirrored board that the
 * header cannot say: that its source is not connected yet, is waiting for its
 * first push, or refused the last one and why. When it was read, and whether
 * that is late, is the page header's ("Updated …", src/components/freshness),
 * said once for everyone who has the page: never repeated here.
 */
export function MirrorStatus({
  named,
  source,
}: {
  /** The source inside a sentence: "the Kazakhstan CRM", "Visible". */
  named: string;
  /** undefined while loading. */
  source: MirrorSource | undefined;
}) {
  if (source === undefined) return null;
  const { status } = source;

  let line: { caution?: boolean; text: string } | null = null;
  if (!source.configured) {
    line = {
      text: `Not connected to ${named} yet. Set ${source.missingEnv.join(", ")} on the Convex deployment, then run the routine in docs/ingest.md.`,
    };
  } else if (status === null) {
    line = { text: `Connected. Waiting for the first push from ${named}.` };
  } else if (status.state !== "ok") {
    line = {
      caution: true,
      // A stored reason may or may not end in a full stop; this sentence has one.
      text: `The last push from ${named} was refused: ${(status.message ?? "no reason was recorded").replace(/\.$/, "")}.`,
    };
  }
  if (line === null) return null;

  return (
    <div className="space-y-1 text-xs leading-relaxed text-ink-2">
      <Note caution={line.caution}>{line.text}</Note>
    </div>
  );
}
