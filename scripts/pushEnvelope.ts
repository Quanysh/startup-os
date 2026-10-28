// The logic of `pnpm push:envelope`: check an envelope file with the
// endpoint's own rules, say what it holds, and post it only with --send.
// Everything it touches is passed in, so it is tested without a file system
// or a network. push-envelope.ts is the thin wrapper that supplies the real ones.
//
// The file may hold mirrored records (a sender's name, a subject, a meeting's
// summary) or pipeline rows (a company, a person). So nothing here prints a
// row: the summary is the source, the kinds, counts and metric keys, and an
// issue is a path and fixed words.
//
// It may instead hold the financial model's plan, which names nobody. That is
// summarised without a row or a value too: the model's version, a count, and
// the scenarios, years and figures the plan covers.

import { resolve } from "node:path";
import { SOURCES, ingestTokenEnv, type SourceDef } from "../convex/connectors/manifest";
import { agentPushProblems } from "../convex/lib/agentShape";
import { CONTACT_PUSH_WORDS, isContactPushSource, parseContactPush } from "../convex/lib/contactPush";
import {
  isAgentsEnvelope,
  isContactsEnvelope,
  isCustomersEnvelope,
  isPlanEnvelope,
  isRecordsEnvelope,
  parseIngestEnvelope,
  type IngestEnvelope,
  type IngestIssue,
} from "../convex/lib/ingestSchema";
import {
  MIRROR_SOURCES,
  SHARED_SOURCES,
  type MirrorSource,
  type SharedSource,
} from "../convex/lib/mirrorRules";
import { checkPipelineRows, ownsAPipeline } from "../convex/lib/pipelineRules";
import { planProblems } from "../convex/lib/planRules";
import { PLAN_KEYS, PLAN_SCENARIOS } from "../convex/lib/planShape";
import { pushedSnapshotProblems } from "../convex/lib/pushRules";
import { parsePushedRecords } from "../convex/lib/recordRows";
import { parseSharedRecords } from "../convex/lib/sharedRecords";
import { validateSnapshots } from "../convex/lib/snapshotRules";
import { SUPPORT_ORIGINS } from "../convex/lib/support";
import { parseSupportPush } from "../convex/lib/supportRecords";
import { ingestTokenProblem, ingestUrlProblem } from "./ingestUrl";
import { postEnvelope } from "./postEnvelope";

export const USAGE = "Usage: pnpm push:envelope <file.json> [--send]";

export type PushDeps = {
  readFile: (path: string) => string;
  fetch: typeof fetch;
  print: (line: string) => void;
  printError: (line: string) => void;
  now: () => Date;
};

const MAX_ISSUES = 20;
/** An issue's words made safe for a terminal: no control characters, and not long. */
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200);

/** The same words the endpoint uses where a snapshot's own message could quote a name. */
const SNAPSHOT_REFUSED = "Is refused. Send the snapshots on their own to read why.";

type Checked =
  | { ok: true; summary: string[] }
  | { ok: false; issues: IngestIssue[]; problem?: undefined }
  | { ok: false; problem: string; issues?: undefined };

/**
 * The endpoint's rules for this envelope, applied here first, and what to say
 * about it. What the endpoint cannot know from the file alone (whether the
 * source is switched off, or read by the OS itself) is left to its reply.
 */
function check(envelope: IngestEnvelope, source: SourceDef, now: number): Checked {
  const mirror = (MIRROR_SOURCES as readonly string[]).includes(source.id)
    ? (source.id as MirrorSource)
    : null;

  if (isContactsEnvelope(envelope)) {
    // People for the Contacts book, on one of the six tokens that carry them:
    // checked with the endpoint's own rules, summarised by counts. Never a
    // name, an address, a phone number or an id. Who is the team's is the
    // endpoint's to know, so it may leave out more than this says.
    if (!isContactPushSource(source.id)) {
      return { ok: false, issues: [{ path: "contacts", message: CONTACT_PUSH_WORDS.notAccepted }] };
    }
    const read = parseContactPush(source.id, envelope.contacts, now);
    if (!read.ok) return { ok: false, issues: read.issues };
    return {
      ok: true,
      summary: [
        "Kind: contacts",
        `Contacts: ${read.rows.length}`,
        ...(read.excluded > 0 ? [`Left out (no-reply, the companies' own, too few exchanges): ${read.excluded}`] : []),
        ...(read.dropped > 0 ? [`Dropped (looked like a patient's record): ${read.dropped}`] : []),
        "Mode: upsert",
      ],
    };
  }

  if (isCustomersEnvelope(envelope)) {
    // Its own script reads the register and guards against a short list.
    return { ok: false, problem: "The client register has its own script: pnpm push:customers." };
  }

  if (isRecordsEnvelope(envelope)) {
    // Globex's Intercom conversations: checked with the endpoint's own
    // rules; the summary is counts by where they began, never a name, a title or an id.
    if (source.support === true) {
      const read = parseSupportPush(envelope.records, envelope.appIdCode, now);
      if (!read.ok) return { ok: false, issues: read.issues };
      const began = SUPPORT_ORIGINS.map((origin) => `${origin} ${read.rows.filter((row) => row.origin === origin).length}`);
      return {
        ok: true,
        summary: [
          "Kind: records (Intercom conversations)",
          read.rows.length === 0
            ? "Records: 0 (an explicit empty push: an inbox with nothing open or lately updated)"
            : `Records: ${read.rows.length}`,
          `Began: ${began.join(", ")}`,
          ...(envelope.allowShrink === true
            ? ["Shrink: allowed (it may remove more than half of the chats stored)"]
            : []),
        ],
      };
    }
    // One of Apollo's shared lists: the envelope's schema asked for `kind`
    // because the source is a shared one. Checked with the endpoint's own
    // rules for that list; the summary names the list (one of this codebase's
    // two words) and a count, never a sequence's or a stage's name.
    if ((SHARED_SOURCES as readonly string[]).includes(source.id) && envelope.kind !== undefined) {
      const read = parseSharedRecords(source.id as SharedSource, envelope.kind, envelope.records, {
        empty: envelope.empty === true,
        now,
      });
      if (!read.ok) return { ok: false, issues: read.issues };
      return {
        ok: true,
        summary: [`Kind: records (${envelope.kind})`, `Records: ${read.rows.length}`],
      };
    }
    if (mirror === null) {
      return { ok: false, issues: [{ path: "records", message: "This source does not carry records." }] };
    }
    const read = parsePushedRecords(mirror, envelope.records, {
      empty: envelope.empty === true,
      now,
    });
    if (!read.ok) return { ok: false, issues: read.issues };
    return {
      ok: true,
      summary: [
        "Kind: records",
        read.rows.length === 0
          ? "Records: 0 (an explicit empty push: what is stored will be removed)"
          : `Records: ${read.rows.length}`,
      ],
    };
  }

  if (isAgentsEnvelope(envelope)) {
    if (!source.agents) {
      return { ok: false, issues: [{ path: "agentUsage", message: "This source does not carry agent usage." }] };
    }
    const problems = agentPushProblems(envelope, now);
    if (problems.length > 0) return { ok: false, issues: problems };
    // Counts only: ids and numbers are safe, but a count says all a check needs.
    return {
      ok: true,
      summary: [
        "Kind: agents",
        `Usage rows: ${envelope.agentUsage?.length ?? 0}`,
        `Provider rows: ${envelope.providers?.length ?? 0}`,
        `Applied config: ${envelope.agentConfigApplied === undefined ? "not said" : "said"}`,
      ],
    };
  }
  if (source.agents === true) {
    return {
      ok: false,
      issues: [{ path: "envelope", message: "This token carries agent usage and nothing else." }],
    };
  }

  if (isPlanEnvelope(envelope)) {
    if (!source.plan) {
      return { ok: false, issues: [{ path: "plan", message: "This source does not carry the plan." }] };
    }
    const { modelVersion, rows } = envelope.plan;
    // Whole or refused, since a push replaces the plan. Each issue is a path
    // and words written here.
    const problems = planProblems(rows);
    if (problems.length > 0) return { ok: false, issues: problems };

    // What the rows cover, in this codebase's own words and its own order,
    // whatever order the file has them in. Never a value.
    const scenarios = PLAN_SCENARIOS.filter((s) => rows.some((row) => row.scenario === s));
    const figures = PLAN_KEYS.filter((key) => rows.some((row) => row.key === key));
    const years = rows.map((row) => row.year);
    const first = Math.min(...years);
    const last = Math.max(...years);
    return {
      ok: true,
      summary: [
        "Kind: plan",
        // The version passed the schema's hex pattern (it is the model's own
        // hash), so it is safe to print.
        `Model version: ${modelVersion}`,
        `Rows: ${rows.length}`,
        `Scenarios: ${scenarios.join(", ")}`,
        // The first year to the last, with an en dash; one year on its own.
        `Years: ${first === last ? first : `${first}–${last}`}`,
        `Figures: ${figures.join(", ")}`,
      ],
    };
  }
  // The model's token carries the plan and nothing else: no number, no pipeline.
  if (source.plan === true) {
    return {
      ok: false,
      issues: [{ path: "envelope", message: "This token carries the plan and nothing else." }],
    };
  }
  if (mirror !== null || source.support === true) {
    return {
      ok: false,
      issues: [{ path: "envelope", message: "This token carries records and nothing else." }],
    };
  }

  const snapshots = envelope.snapshots ?? [];
  const carriesNames =
    ownsAPipeline(source.id) || envelope.deals !== undefined || envelope.investors !== undefined;
  const registry = validateSnapshots(source.id, snapshots, undefined, { now });
  const snapshotIssues = registry.length > 0 ? registry : pushedSnapshotProblems(source.id, snapshots, now);
  if (snapshotIssues.length > 0) {
    return {
      ok: false,
      issues: snapshotIssues.map((issue) => ({
        path: `snapshots.${issue.index}.${issue.field}`,
        message: carriesNames ? SNAPSHOT_REFUSED : issue.message,
      })),
    };
  }
  const rowIssues = [
    ...(envelope.deals ? checkPipelineRows("deals", source.id, envelope.deals, now).issues : []),
    ...(envelope.investors
      ? checkPipelineRows("investors", source.id, envelope.investors, now).issues
      : []),
  ];
  if (rowIssues.length > 0) return { ok: false, issues: rowIssues };

  const kinds: string[] = [];
  const lines: string[] = [];
  if (envelope.snapshots) {
    kinds.push("snapshots");
    lines.push(`Snapshots: ${snapshots.length}`);
    // Each key passed the registry above, so it is one of this codebase's own.
    lines.push(`Metric keys: ${[...new Set(snapshots.map((row) => row.key))].sort().join(", ")}`);
  }
  if (envelope.deals) {
    kinds.push("deals");
    lines.push(`Deals: ${envelope.deals.length}`);
  }
  if (envelope.investors) {
    kinds.push("investors");
    lines.push(`Investors: ${envelope.investors.length}`);
  }
  if (envelope.deals || envelope.investors) lines.push(`Mode: ${envelope.mode ?? "upsert"}`);
  return { ok: true, summary: [`Kind: ${kinds.join(", ")}`, ...lines] };
}

export type CheckedEnvelope =
  | { ok: true; source: SourceDef; envelope: IngestEnvelope; summary: string[] }
  | { ok: false; issues: IngestIssue[]; problem?: undefined }
  | { ok: false; problem: string; issues?: undefined };

/**
 * One envelope against everything the endpoint would hold it to, before it is
 * sent: the schema, that its source takes pushes, and that source's own rules.
 * What `pnpm push:envelope` applies to a file, and what a script that builds
 * its own envelopes (`pnpm gather:github`) applies to each. An issue is a
 * path and fixed words; the summary is kinds, counts and metric keys.
 */
export function checkEnvelope(raw: unknown, now: number): CheckedEnvelope {
  // The same schema the endpoint parses with. Fixed words for every issue,
  // whatever the envelope holds: this cannot know yet whose it is.
  const parsed = parseIngestEnvelope(raw, { carriesNames: true });
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const { envelope } = parsed;

  // The source is looked up, never echoed: from here on its name is the
  // manifest's own spelling, and so is the name of its token variable.
  const source = SOURCES.find((s) => s.id === envelope.source);
  // A source carried on another's token (the Contacts book's) is not one a file names.
  if (
    source === undefined ||
    source.carriedBy !== undefined ||
    !(source.kind === "ingest" || source.pushable === true)
  ) {
    return { ok: false, problem: "source: is not a source the OS takes pushes from." };
  }
  const checked = check(envelope, source, now);
  if (!checked.ok) return checked;
  return { ok: true, source, envelope, summary: checked.summary };
}

/** Returns the process exit code. Nothing here prints a row of the file. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: PushDeps,
): Promise<number> {
  const { print, printError } = deps;

  // Sending is the explicit act: a lost, misspelled or swallowed flag must end
  // in a printout, never a push. --dry-run is the long way to say the default.
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const paths = argv.filter((arg) => !arg.startsWith("-"));
  const send = flags.includes("--send");
  const known = flags.every((flag) => flag === "--send" || flag === "--dry-run");
  if (!known || paths.length !== 1 || (send && flags.includes("--dry-run"))) {
    printError(USAGE);
    return 1;
  }

  const path = resolve(paths[0]!);
  let raw: unknown;
  try {
    raw = JSON.parse(deps.readFile(path));
  } catch (error) {
    // Never the parser's own message: it quotes the file.
    printError(
      error instanceof SyntaxError ? `${path} is not valid JSON.` : `Could not read ${path}.`,
    );
    return 1;
  }

  const printIssues = (issues: readonly IngestIssue[]) => {
    for (const issue of issues.slice(0, MAX_ISSUES)) {
      printError(`${plain(issue.path)}: ${plain(issue.message)}`);
    }
    if (issues.length > MAX_ISSUES) printError(`${issues.length - MAX_ISSUES} more issues not shown.`);
  };

  const checked = checkEnvelope(raw, deps.now().getTime());
  if (!checked.ok) {
    if (checked.issues) printIssues(checked.issues);
    else printError(checked.problem);
    return 1;
  }
  const { envelope, source } = checked;

  const tokenEnv = ingestTokenEnv(source.id);
  let url = "";
  let token = "";
  if (send) {
    if (!env.STARTUP_OS_INGEST_URL || !env[tokenEnv]) {
      printError(`Set STARTUP_OS_INGEST_URL and ${tokenEnv} in .env.push or the environment.`);
      return 1;
    }
    url = env.STARTUP_OS_INGEST_URL;
    token = env[tokenEnv];
    const problem = ingestUrlProblem(url) ?? ingestTokenProblem(token, tokenEnv);
    if (problem !== null) {
      printError(problem);
      return 1;
    }
  }

  print(`Source: ${source.id}`);
  for (const line of checked.summary) print(line);
  if (!send) {
    // On stderr, as the other push scripts say it.
    printError("Nothing was sent. Add --send to push it.");
    return 0;
  }
  return postEnvelope(url, token, envelope, deps);
}
