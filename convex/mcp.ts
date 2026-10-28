// POST /mcp/v1: where the owner's Claude reads the OS and acts in it, over
// the Model Context Protocol ("streamable HTTP" in its smallest conforming
// form: stateless, one JSON-RPC message a request, a JSON answer, no stream,
// no session). The protocol's own rules are convex/lib/mcpProtocol.ts; the
// tools are convex/lib/mcpTools.ts.
//
// The caller is one of the clients the owner connected: it holds one of the
// owner's named agent tokens (`sosa_…`, convex/assistant.ts), and nothing
// else is honoured here: not a source's ingest token, not a teammate's
// personal token. The credential is checked before anything else of the
// request is read, and again inside every read and write: what reaches a
// function is its SHA-256, never the credential. Each client has its own
// scope, its own limits and its own name on the audit; the runner's tools are
// the Mac's client's alone (`toolFor`).
//
// Nothing here logs. An answer never quotes the request: a refusal is a code
// and fixed words (convex/lib/agentRules.ts), and a tool's own refusal is the
// sentence the app shows a person for the same thing. What is kept of a call
// is one audit row with no content (assistant.record).

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  httpAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { AGENT_WORDS, MAX_MCP_BYTES, isAgentToken, type AgentOutcome } from "./lib/agentRules";
import { isAgentId, type AgentId } from "./lib/agents";
import { clientHolder, credentialValidator, type Credential } from "./lib/agentToken";
import { bound } from "./lib/mcpBound";
import {
  RPC,
  SERVER_INFO,
  catalogueVersion,
  serverInstructions,
  isProtocolVersion,
  negotiateVersion,
  readMessage,
  rpcError,
  rpcResult,
  toolError,
  toolRefusal,
  toolResult,
  type RpcId,
} from "./lib/mcpProtocol";
import { companyArgRefusal, describeTool, issueWords, toolFor, toolsFor, toolsOn } from "./lib/mcpTools";
import { AGENT_HEADER, MAC_RUN_ID, OS_AGENT_WORDS, RUN_HEADER } from "./lib/osAgents";
import {
  BOT_WORDS,
  cleanCostUsd,
  auditOfRefusal,
  isExternalOwnerAgent,
  botMayCall,
  botOfPath,
  handoffRefusalOf,
  isBotId,
  proposalRefusalOf,
  type BotRefusal,
} from "./lib/botRules";
import { DUPLICATE_CHECK_TOOLS, type DuplicateLog } from "./lib/duplicates";
import { isAccessToken, siteOrigin, wwwAuthenticate } from "./lib/oauthRules";
import { NOT_ALLOWED } from "./lib/owner";
import { hashToken } from "./lib/personalRules";

/** The tool catalogue's version (`catalogueVersion`), once per deployment. */
const CATALOGUE_VERSION = catalogueVersion(toolsOn().map(describeTool));

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

/**
 * One answer for no credential, a wrong one, a revoked or expired one and one
 * whose holder is no longer the owner. It says where the protected
 * resource's metadata is, so an OAuth client can find how to sign in
 * (RFC 9728, the MCP authorization specification).
 */
const unauthorized = (address: string | null = null) =>
  reply(401, rpcError(null, RPC.unauthorized, AGENT_WORDS.unauthorized), {
    "WWW-Authenticate": wwwAuthenticate(siteOrigin(process.env.SITE_URL), address),
  });
const refused = (status: number, code: number, words: string) =>
  reply(status, rpcError(null, code, words));

/** GET /mcp/v1: this server opens no stream, which the protocol says with a 405. */
export const getV1 = httpAction(async () =>
  reply(405, rpcError(null, RPC.invalidRequest, AGENT_WORDS.getNotAllowed), { Allow: "POST" }),
);

/** The UTC calendar day of a moment, "YYYY-MM-DD". */
const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * One bot's own address, `/mcp/v1/bot/<bot id>` (docs/assistant.md, "Bots"):
 * the same endpoint, and every call made there is that bot's, whatever the
 * client is and whatever it sends. A client that cannot send a name (Grok's
 * connector keeps the tool list it was given) is still the bot. A path that is
 * no bot's shape, or one of the four's, is not there.
 */
export const mcpBotV1 = httpAction(async (ctx, request) => {
  const address = botOfPath(new URL(request.url).pathname);
  if (address === null) return refused(404, RPC.invalidRequest, BOT_WORDS.noBotHere);
  return await serve(ctx, request, address);
});

/** GET at a bot's address: no stream either. */
export const getBotV1 = httpAction(async (_ctx, request) =>
  botOfPath(new URL(request.url).pathname) === null
    ? refused(404, RPC.invalidRequest, BOT_WORDS.noBotHere)
    : reply(405, rpcError(null, RPC.invalidRequest, AGENT_WORDS.getNotAllowed), { Allow: "POST" }),
);

export const mcpV1 = httpAction(async (ctx, request) => await serve(ctx, request, null));

type ActionCtx = Parameters<Parameters<typeof httpAction>[0]>[0];

/** One request, at the plain address (`address` null) or at a bot's own. */
async function serve(ctx: ActionCtx, request: Request, address: string | null): Promise<Response> {
  const startedAt = Date.now();

  const header = request.headers.get("Authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // Only a named agent token or an OAuth access token is looked up at all: a
  // source's token and a personal one are refused by their shape, before a
  // hash is taken.
  const kind = isAgentToken(given) ? "token" : isAccessToken(given) ? "oauth" : null;
  if (kind === null) return unauthorized(address);
  const credential: Credential = {
    kind,
    hash: await hashToken(given),
    ...(address === null ? null : { address }),
  };
  const who = await ctx.runQuery(internal.assistant.holder, { credential, now: startedAt });
  if (who === null) return unauthorized(address);

  const version = request.headers.get("MCP-Protocol-Version");
  if (version !== null && !isProtocolVersion(version)) {
    return refused(400, RPC.invalidRequest, AGENT_WORDS.version);
  }

  // Refuse on the declared size before reading anything, then measure what
  // was actually read, since Content-Length can be wrong or absent.
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_MCP_BYTES) {
    return refused(413, RPC.invalidRequest, AGENT_WORDS.tooLarge);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_MCP_BYTES) {
    return refused(413, RPC.invalidRequest, AGENT_WORDS.tooLarge);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refused(400, RPC.parse, AGENT_WORDS.parse);
  }

  const message = readMessage(raw);
  switch (message.kind) {
    case "batch":
      return refused(400, RPC.invalidRequest, AGENT_WORDS.batch);
    case "invalid":
      return refused(400, RPC.invalidRequest, AGENT_WORDS.invalidRequest);
    case "notification":
      // `notifications/initialized` and any other: taken, and never answered.
      return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
    case "bad_params":
      return reply(200, rpcError(message.id, RPC.invalidParams, AGENT_WORDS.params));
    case "request":
      break;
  }

  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return reply(
        200,
        rpcResult(id, {
          protocolVersion: negotiateVersion(params?.protocolVersion),
          // `listChanged`: the list moves with each release, and the version says when.
          capabilities: { tools: { listChanged: true } },
          serverInfo: { ...SERVER_INFO, version: CATALOGUE_VERSION },
          instructions: serverInstructions(),
        }),
      );
    case "ping":
      return reply(200, rpcResult(id, {}));
    case "tools/list": {
      // A run of one of the four is listed only that agent's tools; a bot only
      // the tools its profile allows; a name Startup OS does not know, nothing.
      const listed = toolsFor(who.scope);
      const as = address !== null && request.headers.get(AGENT_HEADER) === null ? address : request.headers.get(AGENT_HEADER);
      // At a bot's address, a header naming anyone else lists nothing.
      if (address !== null && as !== address) return reply(200, rpcResult(id, { tools: [] }));
      if (as === null) return reply(200, rpcResult(id, { tools: listed.map(describeTool) }));
      // Chief of staff or engineering named through any client but the Mac runner's is its external profile.
      const externalAgent = isExternalOwnerAgent(as) && (address !== null || !who.runner);
      if (!isAgentId(as) || externalAgent) {
        const permissions = isBotId(as) || externalAgent
          ? await ctx.runQuery(internal.bots.permissionsFor, { credential, now: startedAt, bot: as })
          : null;
        const kept = permissions === null ? [] : listed.filter((tool) => botMayCall(permissions, tool.name, tool.kind));
        return reply(200, rpcResult(id, { tools: kept.map(describeTool) }));
      }
      // A client only bots may use lists the four nothing, unless it is the Mac's runner.
      if (who.botsOnly && !who.runner) return reply(200, rpcResult(id, { tools: [] }));
      const runId = request.headers.get(RUN_HEADER);
      const kept = [];
      for (const tool of listed) {
        const allowed = await ctx.runQuery(internal.osAgents.allowed, {
          tool: tool.name,
          header: as,
          argument: null,
          runId: runId !== null && MAC_RUN_ID.test(runId) ? runId : null,
        });
        if (allowed.ok) kept.push(tool);
      }
      return reply(200, rpcResult(id, { tools: kept.map(describeTool) }));
    }
    case "tools/call":
      break;
    default:
      return reply(200, rpcError(id, RPC.methodNotFound, AGENT_WORDS.method));
  }

  const name = params?.name;
  const sent = params?.arguments ?? {};
  if (typeof name !== "string" || typeof sent !== "object" || sent === null || Array.isArray(sent)) {
    return reply(200, rpcError(id, RPC.invalidParams, AGENT_WORDS.params));
  }
  // What the call says it cost (`costUsd`, Bot Loop v3 J): taken off every call before its
  // tool's schema sees it, and kept only for a bot whose profile matched (`assistant.record`).
  const { costUsd: reportedCost, ...args } = sent as Record<string, unknown>;
  const cost = cleanCostUsd(reportedCost);
  const costOf = cost === null ? null : { costUsd: cost };
  // Which agent it says it is, when that is one of the closed set: a name, never text.
  // Chief of staff or engineering named through a client that is not the Mac
  // runner's is not the Mac's agent but its external profile (Bot Loop v3, A): a bot's path.
  const by = (args as Record<string, unknown>).agent;
  const external = (name: unknown) => isExternalOwnerAgent(name) && !who.runner;
  const argument = isAgentId(by) && !external(by) ? by : null;
  // The Mac's runner names the agent and its run in two headers for every call Claude makes in a run.
  const headerAgent = request.headers.get(AGENT_HEADER);
  const headerRun = request.headers.get(RUN_HEADER);

  // Not one of the four: one of the owner's bots, by the header, the `agent`
  // argument or the `bot` argument (docs/assistant.md, "Bots"). Its `agent`
  // and `bot` are taken off the arguments, since the tool's own `agent` is one
  // of the four's: the tool learns the bot from the clock (`ToolClock.bot`),
  // and only once its profile matched.
  const botArg = (args as Record<string, unknown>).bot;

  // At a bot's own address the bot is the path's: a header or an argument
  // naming anyone else is refused, and the call is that bot's.
  if (address !== null) {
    const notThisAddress: BotRefusal = { code: "not_this_address" };
    const refuse = (words: string, refusal: BotRefusal) => reply(200, rpcResult(id, toolRefusal(words, refusal)));
    if (headerAgent !== null && headerAgent !== address) return refuse(BOT_WORDS.notThisAddress, notThisAddress);
    if (by !== undefined && by !== address) return refuse(BOT_WORDS.notThisAddress, notThisAddress);
    if (botArg !== undefined && botArg !== address) return refuse(BOT_WORDS.notThisAddress, notThisAddress);
    if (headerRun !== null) return refuse(BOT_WORDS.noRun, { code: "wrong_agent" });
    const { agent: _named, bot: _bot, ...rest } = args as Record<string, unknown>;
    return callTool(ctx, { id, name, input: JSON.stringify(rest), credential, startedAt, names: null, bot: address, ...costOf });
  }

  const fourByHeader = headerAgent !== null && isAgentId(headerAgent) && !external(headerAgent);
  const wrongAgent: BotRefusal = { code: "wrong_agent" };
  if (fourByHeader && botArg !== undefined) return reply(200, rpcResult(id, toolRefusal(BOT_WORDS.wrongAgent, wrongAgent)));
  const botName = fourByHeader
    ? null
    : (headerAgent ?? (by === undefined || argument !== null ? null : by) ?? (botArg === undefined ? null : botArg));
  if (botName !== null) {
    const refuse = (words: string) => reply(200, rpcResult(id, toolRefusal(words, wrongAgent)));
    if (headerAgent !== null && by !== undefined && by !== headerAgent) return refuse(BOT_WORDS.wrongAgent);
    if (botArg !== undefined && botArg !== botName) return refuse(BOT_WORDS.wrongAgent);
    if (headerRun !== null) return refuse(BOT_WORDS.noRun);
    const { agent: _named, bot: _bot, ...rest } = args as Record<string, unknown>;
    // A name of no bot's shape matches no profile: admitted (counted, written
    // down as refused) as an unknown bot, and never written itself.
    const bot = isBotId(botName) || (isExternalOwnerAgent(botName) && !who.runner) ? botName : "";
    return callTool(ctx, { id, name, input: JSON.stringify(rest), credential, startedAt, names: null, bot, ...costOf });
  }

  const unknownHeader =
    (headerAgent !== null && !isAgentId(headerAgent)) || (headerRun !== null && !MAC_RUN_ID.test(headerRun));
  const named = headerAgent !== null && isAgentId(headerAgent) ? headerAgent : null;
  return callTool(ctx, {
    id,
    name,
    input: JSON.stringify(args),
    credential,
    startedAt,
    agent: named ?? argument ?? undefined,
    // A call naming one of the four (or a run) may use only that agent's tools.
    names: unknownHeader
      ? "unknown"
      : named !== null || argument !== null || headerRun !== null
        ? { header: named, argument, runId: headerRun }
        : null,
    // For a client only bots may use: a call naming the four (or a run) is the runner's alone.
    four: unknownHeader || named !== null || argument !== null || headerRun !== null,
  });
}

/**
 * The sentence a function refused with (a `ConvexError` whose data is text),
 * or null for anything else thrown. Between two functions the data travels
 * as JSON: a deployed backend decodes it again before the action sees it, and
 * the test backend hands it on as it travelled, so both are read.
 */
function refusalOf(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const coded = codedOf(error.data);
  if (coded !== null) return coded.words;
  if (typeof error.data !== "string") return null;
  try {
    const decoded: unknown = JSON.parse(error.data);
    if (typeof decoded === "string") return decoded;
    const inner = codedOf(decoded);
    if (inner !== null) return inner.words;
  } catch {
    // Not JSON: it is the sentence itself.
  }
  return error.data;
}

type Coded = { words: string; refusal: BotRefusal; log?: DuplicateLog };

/**
 * The codes a function throws with its words (`{words, refusal}`): an
 * attribution mismatch, a possible duplicate, and a withdrawal's (spec §14:
 * not the caller's, not open, a note with a contact detail, a replacement
 * that does not hold). Any other code is the endpoint's own.
 */
// `dev_request` throws its repeat and its day's limit coded too (convex/devRequests.ts).
const CODED_REFUSALS = [
  "attribution_mismatch",
  "possible_duplicate",
  "not_owner",
  "not_open",
  "contact_detail",
  "bad_context",
  "repeat",
  "rate_limited",
  // A comment the bot may start (write on the board or on sales) but not on this subject.
  "not_permitted",
  // `proposal_decide` by a caller that is not the chief of staff.
  "not_chief_of_staff",
] as const;

/**
 * A refusal thrown with its code (`{words, refusal}`, `CODED_REFUSALS`): the
 * server's own words and details, never the call's.
 */
function codedOf(data: unknown): Coded | null {
  if (typeof data === "string") {
    try {
      return codedOf(JSON.parse(data));
    } catch {
      return null;
    }
  }
  if (typeof data !== "object" || data === null) return null;
  const { words, refusal, log } = data as Record<string, unknown>;
  if (typeof words !== "string" || typeof refusal !== "object" || refusal === null) return null;
  const code = (refusal as { code?: unknown }).code;
  if (!(CODED_REFUSALS as readonly unknown[]).includes(code)) return null;
  const logged =
    typeof log === "object" &&
    log !== null &&
    (DUPLICATE_CHECK_TOOLS as readonly unknown[]).includes((log as DuplicateLog).tool) &&
    typeof (log as DuplicateLog).sim === "number" &&
    typeof (log as DuplicateLog).threshold === "number"
      ? (log as DuplicateLog)
      : undefined;
  return { words, refusal: refusal as BotRefusal, ...(logged === undefined ? null : { log: logged }) };
}

/** One `tools/call`: admitted against the limits, run, and written down. */
async function callTool(
  ctx: ActionCtx,
  call: {
    id: RpcId;
    name: string;
    input: string;
    credential: Credential;
    startedAt: number;
    agent?: AgentId;
    /** What the call names of Startup OS's own four: their header and argument, and the Mac's run; "unknown" for a header that names none. */
    names: { header: AgentId | null; argument: AgentId | null; runId: string | null } | "unknown" | null;
    /** The owner's bot the call names: admitted against that bot's profile and limits. */
    bot?: string;
    /** Whether it names one of the four or a run (`admit` refuses that on a bots-only client but the runner's). */
    four?: boolean;
    /** What a bot said the call cost, cleaned (0 to 100): written only once `admit` matched the bot. */
    costUsd?: number;
  },
): Promise<Response> {
  const { id, name, credential, startedAt } = call;
  const admitted = await ctx.runMutation(internal.assistant.admit, {
    credential,
    name,
    now: startedAt,
    ...(call.bot === undefined ? null : { bot: call.bot }),
    ...(call.four === true ? { four: true } : null),
  });
  const address = credential.address ?? null;
  if (admitted.status === "unauthorized") return unauthorized(address);

  // The run a call was made in, once the server has checked it is that agent's run on the Mac.
  let runId: string | null = null;
  const note = (outcome: AgentOutcome, refusal?: BotRefusal) =>
    ctx.runMutation(internal.assistant.record, {
      userId: admitted.userId,
      name,
      at: startedAt,
      outcome,
      durationMs: Date.now() - startedAt,
      ...(call.agent === undefined ? null : { agent: call.agent }),
      ...(runId === null ? null : { runId }),
      client: admitted.client,
      clientName: admitted.clientName,
      runner: admitted.runner,
      ...("bot" in admitted && admitted.bot !== undefined ? { bot: admitted.bot } : null),
      ...(refusal === undefined ? null : { refusal: auditOfRefusal(refusal) }),
      ...(call.costUsd === undefined || !("bot" in admitted) || admitted.bot === undefined ? null : { costUsd: call.costUsd }),
    });

  switch (admitted.status) {
    case "limited":
    case "acts_limited":
    case "runner_limited": {
      if (admitted.note) await note("refused");
      const words = {
        limited: AGENT_WORDS.limited,
        acts_limited: AGENT_WORDS.actsLimited,
        runner_limited: AGENT_WORDS.runnerLimited,
      }[admitted.status];
      return reply(200, rpcError(id, RPC.limited, words));
    }
    // A bot's limit is a tool error a model reads, with its code and when it resets.
    case "bot_limited":
      if (admitted.note) await note("refused", admitted.refusal);
      return reply(200, rpcResult(id, toolRefusal(admitted.words, admitted.refusal)));
    case "bot_refused":
      // `whoami` and `bot_rules` refused in a loop are written once a window.
      if (!("note" in admitted) || admitted.note) await note("refused", admitted.refusal);
      return reply(200, rpcResult(id, toolRefusal(admitted.words, admitted.refusal)));
    case "unknown_tool":
      await note("invalid");
      return reply(200, rpcError(id, RPC.invalidParams, AGENT_WORDS.unknownTool));
    case "read_only": {
      // A bot is told it in code too; a client's own call as before.
      const readOnly: BotRefusal | undefined = call.bot === undefined ? undefined : { code: "read_only" };
      await note("refused", readOnly);
      return reply(
        200,
        rpcResult(id, readOnly === undefined ? toolError(AGENT_WORDS.readOnly) : toolRefusal(AGENT_WORDS.readOnly, readOnly)),
      );
    }
    case "ok":
      break;
  }

  // A call naming one of the four may use only that agent's tools (its run's version, else its
  // published one, else its code's defaults). A call naming none keeps what the token may do.
  if (call.names === "unknown") {
    await note("invalid");
    return reply(200, rpcResult(id, toolError(OS_AGENT_WORDS.unknownAgent)));
  }
  if (call.names !== null) {
    const allowed = await ctx.runQuery(internal.osAgents.allowed, { tool: name, ...call.names });
    runId = allowed.runId;
    if (!allowed.ok) {
      await note("refused");
      return reply(200, rpcResult(id, toolError(allowed.words)));
    }
  }

  const run = {
    credential,
    name,
    input: call.input,
    now: startedAt,
    today: utcDay(startedAt),
    ...(call.agent === undefined ? null : { agent: call.agent }),
    // The bot, only as `admit` matched it to a profile this client may use.
    ...("bot" in admitted && admitted.bot !== undefined ? { bot: admitted.bot } : null),
  };
  let ran;
  try {
    ran =
      admitted.kind === "read"
        ? await ctx.runQuery(internal.mcp.read, run)
        : await ctx.runMutation(internal.mcp.act, run);
  } catch (error) {
    // The app's own refusal, in the words it shows a person (a mirrored deal,
    // a person a task cannot be given to, a task that is gone): the model can
    // act on those. Anything else is reduced to fixed words. Either way a
    // mutation that threw changed nothing.
    const said = refusalOf(error);
    // A refusal thrown with its code (attribution, a possible duplicate) carries it to any caller;
    // a bot's proposal refused for what it says carries its code too (a repeat, no `why`…),
    // and so does a handoff to someone who is no person of that company, or over the day's limit.
    const thrown = error instanceof ConvexError ? codedOf(error.data) : null;
    if (thrown?.log !== undefined) {
      // The refused near-duplicate check, logged after its transaction rolled back: numbers only.
      await ctx.runMutation(internal.duplicates.logRefused, { at: startedAt, ...thrown.log });
    }
    const coded =
      thrown?.refusal ??
      (said === null || run.bot === undefined ? null : (proposalRefusalOf(said) ?? handoffRefusalOf(said, startedAt)));
    await note(said === null ? "error" : "refused", coded ?? undefined);
    const words =
      said === null ? AGENT_WORDS.failed : said === NOT_ALLOWED ? AGENT_WORDS.notAllowed : said;
    return reply(200, rpcResult(id, coded === null ? toolError(words) : toolRefusal(words, coded)));
  }
  if (ran.status === "unauthorized") return unauthorized(address);
  if (ran.status === "invalid") {
    await note("invalid");
    return reply(200, rpcResult(id, toolError(ran.message)));
  }
  // The runner's check-ins that found nothing and its progress reports are
  // not written down: several a second would bury everything else.
  // Nor are `whoami` and `bot_rules` past the first answered one of their window.
  if (!ran.quiet && !("quiet" in admitted && admitted.quiet)) await note("ok");
  return reply(200, rpcResult(id, toolResult(ran.text)));
}

const runArgs = {
  credential: credentialValidator,
  name: v.string(),
  /** The call's `arguments`, as JSON: checked against the tool's schema before anything runs. */
  input: v.string(),
  now: v.number(),
  today: v.string(),
  /** The agent a run names in its header, when it is one of the owner's four. */
  agent: v.optional(v.string()),
  /** The owner's bot making the call: a profile's id that `admit` matched, never a name as sent. */
  bot: v.optional(v.string()),
};

type Run = {
  credential: Credential;
  name: string;
  input: string;
  now: number;
  today: string;
  agent?: string | undefined;
  bot?: string | undefined;
};
type Ran =
  | { status: "unauthorized" }
  | { status: "invalid"; message: string }
  /** The tool's answer, cut to its caps, as compact JSON. */
  | { status: "ok"; text: string; quiet: boolean };

/**
 * Run one tool of one kind as the owner behind the token. The token is asked
 * again here, in the transaction that reads or writes, so one revoked or
 * whose holder is no longer the owner does nothing. A refusal by the app's
 * own rules is thrown by the function the tool calls, and a mutation that
 * throws writes nothing.
 */
async function runTool(ctx: QueryCtx | MutationCtx, kind: "read" | "act", run: Run): Promise<Ran> {
  const known = await clientHolder(ctx, run.credential, run.now);
  if (known === null) return { status: "unauthorized" };
  const tool = toolFor(run.name, known.runner);
  // `admit` has already turned these away; held to here as well.
  if (tool === undefined || tool.kind !== kind) {
    return { status: "invalid", message: AGENT_WORDS.unknownTool };
  }
  if (tool.kind === "act" && known.scope !== "act") {
    return { status: "invalid", message: AGENT_WORDS.readOnly };
  }
  const parsed = tool.input.safeParse(JSON.parse(run.input));
  if (!parsed.success) return { status: "invalid", message: issueWords(parsed.error) };
  // A company this OS is not run for (one-company mode) is refused before the tool runs.
  const refusal = companyArgRefusal(parsed.data);
  if (refusal !== null) return { status: "invalid", message: refusal };
  const clock = {
    now: run.now,
    today: run.today,
    agent: run.agent,
    clientName: known.name,
    bot: run.bot,
    caller: {
      client: known.client,
      name: known.name,
      scope: known.scope,
      botsOnly: known.botsOnly,
      onlyBot: known.onlyBot,
      address: run.credential.address ?? null,
    },
  };
  const output =
    tool.kind === "read"
      ? await tool.run(ctx, known.member, parsed.data, clock)
      : await tool.run(ctx as MutationCtx, known.member, parsed.data, clock);
  return {
    status: "ok",
    text: JSON.stringify(bound(output, tool.caps)),
    quiet: tool.quiet?.(output) === true,
  };
}

/** A read tool. `now` and `today` come from the endpoint: a query never reads the clock. */
export const read = internalQuery({
  args: runArgs,
  handler: (ctx, run): Promise<Ran> => runTool(ctx, "read", run),
});

/** An act tool, in one transaction. */
export const act = internalMutation({
  args: runArgs,
  handler: (ctx, run): Promise<Ran> => runTool(ctx, "act", run),
});
