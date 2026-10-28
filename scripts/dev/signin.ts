// pnpm dev:signin [owner|cofounder|sales|engineer|marketing|success] [--company us|kz|both] [--no-open]
// (`marketing` and `success` are two roles the made-up owner named, with a focus of their own.)
//
// Sign a browser in to the LOCAL app as a made-up person, to look at a page
// as the owner or as a teammate. (A local backend has no Google client, so
// the sign-in page's button does nothing there.)
//
// It asks the local backend for a user, their place on the team and a session
// (convex/devSession.ts), signs a session token with that backend's own key,
// and serves it once on 127.0.0.1 as cookies for `localhost`, then sends the
// browser to the app. It takes no address, URL or deployment: scripts/dev/
// guard.ts says how it is kept to a local backend, and the token is signed
// only when the backend that answered is itself at a local address.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { isLocalUrl } from "../../convex/lib/devLocal";
import { convex, requireLocalTarget, stop } from "./convexCli";
import {
  APP_URL,
  parseMadeSession,
  parseSigninArgs,
  pemOf,
  sessionCookies,
  signSessionToken,
} from "./session";

/** How long the one-time link waits to be opened. */
const WAIT_MS = 2 * 60_000;

function main() {
  const parsed = parseSigninArgs(process.argv.slice(2));
  if (!parsed.ok) stop(parsed.reason);
  const { role, companies, open } = parsed.args;
  const target = requireLocalTarget();

  const made = convex({ kind: "run", fn: "devSession:create", args: { role, companies } }, target);
  const session = made.ok ? parseMadeSession(made.stdout) : null;
  if (session === null) {
    stop("The local backend did not make a session. Is `pnpm dev:local` set up? Look at the output above.");
  }
  // The backend that answered says where it is. It must be this machine.
  if (!isLocalUrl(session.issuer)) {
    stop("Refusing to sign in: the backend that answered is not a local one.");
  }

  // The key never leaves this process: it is read, used once and dropped.
  const key = convex({ kind: "envGet", name: "JWT_PRIVATE_KEY" }, target, { quiet: true });
  if (!key.ok || key.stdout.trim() === "") {
    stop("The local backend has no signing key yet. Run `pnpm dev:local` once first.");
  }
  const token = signSessionToken({ pem: pemOf(key.stdout.trim()), session, now: Date.now() });
  const cookies = sessionCookies({ token, session });

  const server = createServer((_request, response) => {
    // A cookie belongs to a host, not a port: set here, it signs in the app on :3100.
    response.writeHead(302, { "Set-Cookie": cookies, Location: APP_URL, "Cache-Control": "no-store" });
    response.end();
    server.close();
    console.log("Signed in. This link will not work again.");
    clearTimeout(timer);
  });
  const timer = setTimeout(() => {
    console.error("Nobody opened the link in time. Run the command again.");
    process.exit(1);
  }, WAIT_MS);
  // Port 0: any free one. 127.0.0.1 only, so nothing off this machine can ask.
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    // `localhost`, not 127.0.0.1: the cookies are for the host the app is on.
    const link = `http://localhost:${port}/`;
    console.log(`\nSigning in as ${session.email} (${role}, ${companies}).`);
    console.log(`Open this once, with the app running (pnpm dev:local):\n\n  ${link}\n`);
    if (open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(opener, [link], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    }
  });
}

main();
