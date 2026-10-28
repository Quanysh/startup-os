import {
  convexAuthNextjsMiddleware,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";
import { isPassThroughPath } from "@/lib/os/pass-through-routes";
import { SIGN_IN, safeNext, signInPathFor } from "@/lib/os/sign-in-next";

// Everything except the sign-in page needs a session. This only checks that
// *someone* is signed in; whether they are the owner is decided inside Convex
// on every function call (convex/lib/owner.ts), which is the real gate.
// OAuth's consent page (/oauth/authorize) is sent to sign-in with itself to
// come back to, so a client's request survives signing in
// (src/lib/os/sign-in-next.ts); every other page comes back to "/".
const withSession = convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const authenticated = await convexAuth.isAuthenticated();
  const path = request.nextUrl.pathname;

  if (!authenticated && path !== SIGN_IN) {
    return nextjsMiddlewareRedirect(request, signInPathFor(path, request.nextUrl.search));
  }
  if (authenticated && path === SIGN_IN) {
    return nextjsMiddlewareRedirect(request, safeNext(request.nextUrl.searchParams.get("next")) ?? "/");
  }
});

// The token routes passed through to the deployment (the exact paths in
// src/lib/os/pass-through-routes.ts, and no others) carry a bearer token, not
// a session, and are checked by the endpoint itself. They skip the session
// code whole: no redirect to /signin, no cookie read or refreshed, nothing
// logged about the request.
//
// So does every `/.well-known/` document, including one a client builds by
// inserting the MCP path (`/.well-known/oauth-authorization-server/mcp`) or by
// appending the well-known path to the MCP URL. A redirect here is the
// sign-in page, which is HTML, and a client that expected JSON metadata stops.
function isDiscoveryPath(pathname: string): boolean {
  return pathname === "/.well-known" || pathname.includes("/.well-known/");
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const path = request.nextUrl.pathname;
  if (isPassThroughPath(path) || isDiscoveryPath(path)) return NextResponse.next();
  return withSession(request, event);
}

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
