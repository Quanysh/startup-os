// An access token for one read. It lives in the calling action's memory and
// nowhere else: never stored, never logged, never in a thrown message.

import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { open } from "../lib/tokenCrypto";
import { ConnectorError } from "./errors";
import { GOOGLE_TOKEN_PURPOSE, GOOGLE_TOKEN_URL, parseAccess } from "./googleParse";
import { CONNECT_GOOGLE_MESSAGE, GOOGLE_REMOVED_MESSAGE } from "../mirror";
import { NotConnected } from "./mirror";
import { ask } from "./request";

export async function googleAccessToken(ctx: ActionCtx): Promise<string> {
  const sealed = await ctx.runQuery(internal.google.sealedToken, {});
  if (sealed === null) throw new NotConnected(CONNECT_GOOGLE_MESSAGE);
  const refreshToken = await open(sealed, GOOGLE_TOKEN_PURPOSE);
  const { status, json } = await ask({
    who: "Google",
    what: "an access token",
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_WORK_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_WORK_CLIENT_SECRET ?? "",
    }).toString(),
  });
  const access = parseAccess(status, json);
  if (access.kind === "revoked") {
    // The owner removed access in their Google Account, or the grant expired.
    // What was read with it goes too, exactly as "Disconnect" would have it;
    // there is nothing left at Google to revoke. Handing back the sealed value
    // lets the mutation leave a newer grant (a reconnect just now) alone.
    await ctx.runMutation(internal.google.forgetDeadGrant, { sealed });
    throw new NotConnected(GOOGLE_REMOVED_MESSAGE);
  }
  if (access.kind !== "ok") throw new ConnectorError(`Google answered ${status} for an access token.`);
  return access.token;
}
