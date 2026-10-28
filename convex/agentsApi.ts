// Agents Protocol v1.1 to v1.3 (docs/agents-protocol.md): how a connected project
// fetches what its agents should run and reports what they did, and (v1.1)
// tests a harness draft. The agents run inside the project, and patient data
// never leaves it: what crosses here is configuration and prompt templates
// one way, and daily totals of ids and numbers, harness defaults and the
// answers to made-up test cases the other.
//
//   GET  /agents/v1/config               200 { project, version, agents, failMode }, or 304
//                                        for `If-None-Match: "<version>"`
//   POST /agents/v1/usage                200 { accepted, configVersion }
//   GET  /agents/v1/jobs                 200 { jobs }, each leased to this poll
//   POST /agents/v1/jobs/{id}/results    200 { accepted }, and the job is closed
//
// Each takes `Authorization: Bearer rap_…`, the project's own token
// (convex/agentProjects.ts), and nothing else: not a source's ingest token,
// a personal one or the owner's agent's. It is checked, by its SHA-256 in
// constant time, before anything else of the request is read, and again
// inside the read or write it leads to. A token writes its own project's
// rows only: no field of a body names a project.
//
// Nothing here logs. Every refusal is an error name and fixed words
// (API_WORDS), and an issue is a path and words written here: nothing the
// sender wrote is quoted back.

import type { z } from "zod";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { catalogKey } from "./lib/agentBuilder";
import { defaultsFromWire, defaultsKey, type HarnessDefaults } from "./lib/agentHarness";
import { JOB_ID_PATTERN, MAX_RESULTS_BYTES, resultsBody, resultsProblems } from "./lib/agentJobs";
import { matchesVersion, API_WORDS, MAX_USAGE_BYTES, isProjectToken } from "./lib/agentProjects";
import { projectPushProblems, projectUsageBody } from "./lib/agentShape";
import { fixedWords } from "./lib/ingestSchema";
import { hashToken } from "./lib/personalRules";

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

type ErrorName = keyof typeof API_WORDS;
type Issue = { path: string; message: string };

const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

const refuse = (status: number, error: ErrorName, issues?: Issue[]) =>
  reply(status, { ok: false, error, message: API_WORDS[error], ...(issues === undefined ? {} : { issues }) });

/** One answer for no token, a wrong one, a rotated one and a disconnected project's. */
const unauthorized = () => refuse(401, "unauthorized");

/** Paths are built from field names declared here and row numbers; capped all the same. */
const MAX_PATH_LENGTH = 100;
const MAX_ISSUES = 50;

/**
 * A path part as it may be said back: a row number, or a name of the shape a
 * field or a variant has. A record's key the sender chose that is not one (a
 * prompt variant's name, v1.2) is said as `*`, never quoted.
 */
const pathPart = (part: PropertyKey): string =>
  typeof part === "number" ? String(part) : typeof part === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(part) ? part : "*";

/** The issues of a body that broke its shape: paths from field names and row numbers, fixed words. */
const shapeIssues = (issues: readonly z.ZodError["issues"][number][]): Issue[] =>
  issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: (issue.path.map(pathPart).join(".") || "body").slice(0, MAX_PATH_LENGTH),
    message: fixedWords(issue),
  }));

/** The token's SHA-256 and the project it admits, or the refusal to send. */
async function admitted(
  ctx: ActionCtx,
  request: Request,
): Promise<{ tokenHash: string } | { refusal: Response }> {
  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // Only a project token is looked up at all: any other is refused by its shape.
  if (!isProjectToken(given)) return { refusal: unauthorized() };
  const tokenHash = await hashToken(given);
  const admit = await ctx.runMutation(internal.agentProjects.admit, { tokenHash, now: Date.now() });
  if (admit.status === "unauthorized") return { refusal: unauthorized() };
  if (admit.status === "limited") return { refusal: refuse(429, "too_many_requests") };
  return { tokenHash };
}

/** GET /agents/v1/config: what the project's agents should run. */
export const configV1 = httpAction(async (ctx, request) => {
  const gate = await admitted(ctx, request);
  if ("refusal" in gate) return gate.refusal;
  const config = await ctx.runQuery(internal.agentProjects.configOf, { tokenHash: gate.tokenHash });
  if (config === null) return unauthorized();
  const etag = `"${config.version}"`;
  if (matchesVersion(request.headers.get("If-None-Match"), config.version)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
  }
  return new Response(config.body, { status: 200, headers: { ...HEADERS, ETag: etag } });
});

/** POST /agents/v1/usage: the project's daily totals, providers, agents and applied version. */
export const usageV1 = httpAction(async (ctx, request) => {
  const gate = await admitted(ctx, request);
  if ("refusal" in gate) return gate.refusal;

  // Refuse on the declared size before reading anything, then measure what
  // was actually read, since Content-Length can be wrong or absent.
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_USAGE_BYTES) return refuse(413, "payload_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_USAGE_BYTES) return refuse(413, "payload_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(400, "invalid_json");
  }

  const parsed = projectUsageBody.safeParse(raw);
  if (!parsed.success) return refuse(422, "invalid_body", shapeIssues(parsed.error.issues));
  const body = parsed.data;
  const problems = projectPushProblems(body, Date.now());
  if (problems.length > 0) return refuse(422, "invalid_body", problems.slice(0, MAX_ISSUES));

  // v1.1: each agent's harness defaults are stored with their schema as JSON
  // text, keyed by a SHA-256 of their canonical form so an unchanged one is
  // not rewritten. v1.2: a harness may be 512 KB, so the report carries only
  // the keys, and each changed harness is stored by a write of its own.
  const agentsKnown = [];
  const harnesses = new Map<string, { harness: HarnessDefaults; harnessKey: string }>();
  for (const { harness, ...known } of body.agentsKnown) {
    if (harness === undefined) {
      agentsKnown.push(known);
      continue;
    }
    const defaults = defaultsFromWire(harness);
    const harnessKey = await hashToken(defaultsKey(defaults));
    harnesses.set(known.agentId, { harness: defaults, harnessKey });
    agentsKnown.push({ ...known, harnessKey });
  }

  // v1.3: the catalogue is keyed like a harness, and stored only when it changed.
  const toolsKey = body.toolsCatalog === undefined ? undefined : await hashToken(catalogKey(body.toolsCatalog));

  let result;
  try {
    result = await ctx.runMutation(internal.agentProjects.report, {
      tokenHash: gate.tokenHash,
      usage: body.agentUsage,
      providers: body.providers,
      agentsKnown,
      applied: body.configApplied,
      ...(toolsKey === undefined ? {} : { toolsKey }),
    });
  } catch {
    return refuse(500, "write_failed");
  }
  if (result === null) return unauthorized();
  const { harnessWanted, toolsWanted, ...answer } = result;
  try {
    for (const agentId of harnessWanted) {
      const wanted = harnesses.get(agentId);
      if (wanted === undefined) continue;
      const stored = await ctx.runMutation(internal.agentProjects.storeDefaults, {
        tokenHash: gate.tokenHash,
        agentId,
        ...wanted,
      });
      if (stored === null) return unauthorized();
    }
  } catch {
    // The report is stored; its harness keys were not, so sending it again stores them.
    return refuse(500, "write_failed");
  }

  // v1.3: the tool catalogue (a slice a write: schemas may be 16 KB each), then the run summaries.
  const accepted: Record<string, number> = { ...answer.accepted };
  try {
    if (toolsWanted && body.toolsCatalog !== undefined && toolsKey !== undefined) {
      const tools = body.toolsCatalog.map((tool) => ({ ...tool, inputSchema: JSON.stringify(tool.inputSchema) }));
      for (let start = 0; start < tools.length; start += TOOLS_PER_WRITE) {
        const stored = await ctx.runMutation(internal.agentProjects.storeTools, {
          tokenHash: gate.tokenHash,
          tools: tools.slice(start, start + TOOLS_PER_WRITE),
        });
        if (stored === null) return unauthorized();
      }
      const finished = await ctx.runMutation(internal.agentProjects.finishTools, {
        tokenHash: gate.tokenHash,
        ids: tools.map((tool) => tool.id),
        toolsKey,
      });
      if (finished === null) return unauthorized();
    }
    if (body.toolsCatalog !== undefined) accepted.toolsCatalog = body.toolsCatalog.length;
    if (body.runs !== undefined) {
      for (let start = 0; start < body.runs.length; start += RUNS_PER_WRITE) {
        const stored = await ctx.runMutation(internal.agentProjects.storeRuns, {
          tokenHash: gate.tokenHash,
          runs: body.runs.slice(start, start + RUNS_PER_WRITE),
        });
        if (stored === null) return unauthorized();
      }
      accepted.runs = body.runs.length;
    }
  } catch {
    // Both are upserts: sending the report again stores them.
    return refuse(500, "write_failed");
  }
  return reply(200, { ...answer, accepted });
});


/** GET /agents/v1/jobs (v1.1): the test jobs waiting for this project, each leased to this poll. */
export const jobsV1 = httpAction(async (ctx, request) => {
  const gate = await admitted(ctx, request);
  if ("refusal" in gate) return gate.refusal;
  const found = await ctx.runMutation(internal.agentHarness.jobsFor, { tokenHash: gate.tokenHash, now: Date.now() });
  if (found === null) return unauthorized();
  return new Response(found.body, { status: 200, headers: HEADERS });
});

/** How many catalogue tools one write stores (each schema up to 16 KB). */
const TOOLS_PER_WRITE = 25;
/** How many run summaries one write stores. */
const RUNS_PER_WRITE = 100;

/** How many results one write stores: a slice stays well under a transaction's limits. */
const RESULTS_PER_WRITE = 25;

/** POST /agents/v1/jobs/{id}/results (v1.1): a job's results, which close it. */
export const resultsV1 = httpAction(async (ctx, request) => {
  const gate = await admitted(ctx, request);
  if ("refusal" in gate) return gate.refusal;

  const match = /^\/agents\/v1\/jobs\/([^/]+)\/results$/.exec(new URL(request.url).pathname);
  const jobId = match?.[1] ?? "";
  if (!JOB_ID_PATTERN.test(jobId)) return refuse(404, "not_found");

  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_RESULTS_BYTES) return refuse(413, "payload_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_RESULTS_BYTES) return refuse(413, "payload_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(400, "invalid_json");
  }
  const parsed = resultsBody.safeParse(raw);
  if (!parsed.success) return refuse(422, "invalid_body", shapeIssues(parsed.error.issues));

  const shape = await ctx.runQuery(internal.agentHarness.jobShape, { tokenHash: gate.tokenHash, jobId });
  if (shape.status !== "open") {
    if (shape.status === "unauthorized") return unauthorized();
    return shape.status === "not_found" ? refuse(404, "not_found") : refuse(409, "job_closed");
  }
  const problems = resultsProblems(parsed.data, {
    cases: new Map(shape.cases.map((c) => [c.caseId, c.expected])),
    models: shape.models,
    tools: shape.tools,
  });
  if (problems.length > 0) return refuse(422, "invalid_body", problems.slice(0, MAX_ISSUES));

  const rows = parsed.data.results.map((row) => ({
    ...row,
    output: row.output === null ? null : JSON.stringify(row.output),
  }));
  try {
    for (let start = 0; start === 0 || start < rows.length; start += RESULTS_PER_WRITE) {
      const slice = rows.slice(start, start + RESULTS_PER_WRITE);
      const final = start + RESULTS_PER_WRITE >= rows.length;
      const stored = await ctx.runMutation(internal.agentHarness.recordResults, {
        tokenHash: gate.tokenHash,
        jobId,
        results: slice,
        final,
      });
      if (stored.status === "unauthorized") return unauthorized();
      if (stored.status === "not_found") return refuse(404, "not_found");
      if (stored.status === "closed") return refuse(409, "job_closed");
    }
  } catch {
    return refuse(500, "write_failed");
  }
  return reply(200, { accepted: rows.length });
});
