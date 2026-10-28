// Posts an envelope to the ingest endpoint and reports the outcome. Used by
// pushes that carry client names, so it prints only what it recognises in a
// reply: counts, a plain error code, and issues that look like a path plus a
// sentence. Anything else in the reply is not printed.

export type PostDeps = {
  fetch: typeof fetch;
  print: (line: string) => void;
  printError: (line: string) => void;
};

const COUNTS = ["inserted", "updated", "unchanged", "archived"] as const;
const ERROR_CODE = /^[a-z_]{1,40}$/;
const ISSUE_PATH = /^[A-Za-z0-9_.]{1,80}$/;
const MAX_ISSUES = 20;
const MAX_MESSAGE = 200;
/** Long enough for a cold start; short enough that a hung push ends. */
const DEADLINE_MS = 30_000;

/** A plain error code such as ENOTFOUND, or null: never free text. */
function plainCode(error: unknown): string | null {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") return "timed out";
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

/** An issue's words made safe for a terminal: no control characters. */
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

type Read = { confirmed: boolean; head: string; lines: string[] };

function read(text: string): Read {
  const nothing = { confirmed: false, head: "", lines: [] };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return nothing;
  }
  if (typeof body !== "object" || body === null) return nothing;
  const reply = body as Record<string, unknown>;
  if (reply.ok === true) {
    const counts = COUNTS.flatMap((key) =>
      typeof reply[key] === "number" ? [`${key} ${reply[key]}`] : [],
    );
    return { confirmed: true, head: `ok: ${counts.join(", ")}`, lines: [] };
  }
  const head = typeof reply.error === "string" && ERROR_CODE.test(reply.error) ? reply.error : "";
  const lines: string[] = [];
  if (Array.isArray(reply.issues)) {
    for (const issue of reply.issues.slice(0, MAX_ISSUES) as { path?: unknown; message?: unknown }[]) {
      if (
        typeof issue?.path === "string" &&
        ISSUE_PATH.test(issue.path) &&
        typeof issue.message === "string" &&
        issue.message.length <= MAX_MESSAGE
      ) {
        lines.push(`${issue.path}: ${printable(issue.message)}`);
      }
    }
  }
  return { confirmed: false, head, lines };
}

/** Returns the process exit code. The caller has already vetted `url` and `token`. */
export async function postEnvelope(
  url: string,
  token: string,
  envelope: unknown,
  deps: PostDeps,
): Promise<number> {
  const { print, printError } = deps;
  print(`Sending to ${new URL(url).host}.`);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      // A redirect would carry the token, and the names, to wherever it points.
      redirect: "manual",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
  } catch (error) {
    // Not the error's own message: a rejected header is quoted in it.
    printError(`The push could not reach the endpoint (${plainCode(error) ?? "unknown error"}).`);
    return 1;
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    printError("The endpoint redirected the request. Nothing was followed and nothing was sent on.");
    return 1;
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    printError("The endpoint's reply could not be read.");
    return 1;
  }
  const reply = read(text);
  const line = [String(response.status), reply.head].filter(Boolean).join(" ");
  if (response.ok && reply.confirmed) {
    print(line);
    return 0;
  }
  printError(line);
  for (const issue of reply.lines) printError(issue);
  if (response.ok) printError("That is not an ingest confirmation, so the push is not confirmed.");
  return 1;
}
