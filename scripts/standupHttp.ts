// What `pnpm standup:open` and `pnpm standup:push` share: where the two
// standup routes are, the token they are asked with, and one request that
// never follows a redirect and never prints what it must not.
//
// Nothing here prints the token, and of a reply it prints only what it
// recognises: a plain error code and issues that are a path and a sentence.

import { ingestTokenProblem, ingestUrlProblem } from "./ingestUrl";

export const STANDUP_TOKEN_ENV = "INGEST_TOKEN_STANDUP";

export type HttpDeps = {
  fetch: typeof fetch;
  print: (line: string) => void;
  printError: (line: string) => void;
};

/**
 * The two standup routes, on the host `STARTUP_OS_INGEST_URL` names. Call only
 * with a URL `ingestUrlProblem` has passed; nothing but its origin is kept.
 */
export function standupUrls(ingestUrl: string): { open: string; tasks: string } {
  const { origin } = new URL(ingestUrl);
  return { open: `${origin}/standup/v1/open`, tasks: `${origin}/standup/v1/tasks` };
}

/**
 * The routes and the token from the environment (.env.push), checked as the
 * other push scripts check theirs; null, with the reason printed in fixed
 * words, when either is missing or unfit to send.
 */
export function settings(
  env: Record<string, string | undefined>,
  deps: Pick<HttpDeps, "printError">,
): { open: string; tasks: string; token: string } | null {
  const url = env.STARTUP_OS_INGEST_URL;
  const token = env[STANDUP_TOKEN_ENV];
  if (!url || !token) {
    deps.printError(
      `Set STARTUP_OS_INGEST_URL and ${STANDUP_TOKEN_ENV} in .env.push or the environment.`,
    );
    return null;
  }
  const problem = ingestUrlProblem(url) ?? ingestTokenProblem(token, STANDUP_TOKEN_ENV);
  if (problem !== null) {
    deps.printError(problem);
    return null;
  }
  return { ...standupUrls(url), token };
}

const ERROR_CODE = /^[a-z_]{1,40}$/;
const ISSUE_PATH = /^[A-Za-z0-9_.]{1,80}$/;
const MAX_ISSUES = 20;
const MAX_MESSAGE = 200;
/** Long enough for a cold start; short enough that a hung request ends. */
const DEADLINE_MS = 30_000;

/** A plain error code such as ENOTFOUND, or null: never free text. */
function plainCode(error: unknown): string | null {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") return "timed out";
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

/** Words made safe for a terminal: no control characters. */
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

export type Answer = { status: number; ok: boolean; body: unknown };

/**
 * One request with the standup's token. Null, with the reason printed, when
 * no answer was read. A redirect is never followed: it would carry the token,
 * and the tasks, to wherever it points.
 */
export async function ask(
  url: string,
  token: string,
  body: unknown | undefined,
  deps: HttpDeps,
): Promise<Answer | null> {
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        ...(body === undefined ? null : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? null : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch (error) {
    // Not the error's own message: a rejected header is quoted in it.
    deps.printError(
      `The request could not reach the endpoint (${plainCode(error) ?? "unknown error"}).`,
    );
    return null;
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    deps.printError(
      "The endpoint redirected the request. Nothing was followed and nothing was sent on.",
    );
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    // Not JSON, or unreadable: nothing of it is used.
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

/** Print a refusal: the status with the reply's error code, then its issues. Nothing else of it. */
export function printRefusal(answer: Answer, deps: Pick<HttpDeps, "printError">): void {
  const reply =
    typeof answer.body === "object" && answer.body !== null
      ? (answer.body as Record<string, unknown>)
      : {};
  const code = typeof reply.error === "string" && ERROR_CODE.test(reply.error) ? reply.error : "";
  deps.printError([String(answer.status), code].filter(Boolean).join(" "));
  if (!Array.isArray(reply.issues)) return;
  for (const issue of reply.issues.slice(0, MAX_ISSUES) as { path?: unknown; message?: unknown }[]) {
    if (
      typeof issue?.path === "string" &&
      ISSUE_PATH.test(issue.path) &&
      typeof issue.message === "string" &&
      issue.message.length <= MAX_MESSAGE
    ) {
      deps.printError(`${issue.path}: ${printable(issue.message)}`);
    }
  }
}
