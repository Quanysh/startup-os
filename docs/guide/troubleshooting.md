# When something goes wrong

The common problems in setting Startup OS up, what causes each, and how to fix it. Settings are
named here, never their values. The [setup guide](../setup.md) has every step in order.

- [Signing in](#signing-in)
- [Empty pages](#empty-pages)
- [Missing settings](#missing-settings)
- [A deploy that refuses](#a-deploy-that-refuses)
- [Running it on your laptop](#running-it-on-your-laptop)
- [A source that fails](#a-source-that-fails)

## Signing in

**Nobody can sign in, not even the owner.**
`OWNER_EMAILS` is not set on the Convex deployment, or is empty. With no owner, the app lets
nobody in, on purpose. Set it to the owner's Google address in the Convex dashboard (or
`npx convex env set OWNER_EMAILS …`), for each deployment you sign in to (development and
production). Teammates and their data are untouched while it is empty: it is a lock, never a
delete.

**After choosing a Google account, I land back on the sign-in page.**
That account is not on the access list. The sign-in page says so: *"If you land back on this
page after choosing an account, that account is not on the access list. It has to be a Gmail or
Google Workspace address."* Check, in order:

1. The address is exactly the one in `OWNER_EMAILS`, or a teammate added on Settings › Team.
2. It is a Gmail address or a Google Workspace address. Google must vouch for the address;
   another kind of account cannot sign in.
3. For the owner: an owner address belongs to the first Google account that signed in with it.
   A second Google account that presents the same address is refused.

**I see "This account does not have access".**
You are signed in with a Google account that is not on the team. Sign out and choose the one
the owner added.

**Google shows "redirect_uri_mismatch" (Error 400).**
The Google sign-in client does not know your deployment's address. In the Google Cloud console,
add `https://<deployment>.convex.site/api/auth/callback/google` as an authorised redirect URI,
once for each deployment (development and production). Check that `AUTH_GOOGLE_ID` and
`AUTH_GOOGLE_SECRET` on that deployment are from the same client.

**Sign-in starts but fails, or loops, on production.**
Check `SITE_URL` on the production deployment: it must be the address the app is served from
(for example `https://os.example.com`), and `JWT_PRIVATE_KEY` and `JWKS` must be set
(`npx @convex-dev/auth --prod` sets them).

**I cannot sign in to a preview deployment.**
That is expected. Google has no redirect address for preview deployments, so treat them as
build checks. Check sign-in on your local copy and on production.

**Locally, the "Continue with Google" button does nothing.**
Also expected: a local backend has no Google client. Use `pnpm dev:signin` in a second
terminal. Its link works once and only for two minutes; run it again if it expired.

## Empty pages

**Every page says "Not known yet" or "Not read yet".**
No data has arrived yet. That is correct on a new deployment: a missing number is never shown
as zero. Open **Settings › Sources** to see which sources are connected, then:

- for a pulled source (bank, Linear, Apollo…): set its settings ([setup, section
  6](../setup.md#6-environment-variables)) and press *Run now*;
- for a pushed source (GitHub, Visible, a financial model…): set its `INGEST_TOKEN_<SOURCE>`
  and run its script ([setup, section 8](../setup.md#8-pushing-data));
- for a figure no tool knows (MRR, say): type it in on **Finance › Record a figure**.

**A teammate's page is empty, but mine is full.**
They may be on the other company (with two companies, each person sees only their company's
rows), or the page shows a figure from another section they do not have. For example, a sales
teammate without Finance sees no payment figures on Customers. Check their pages and companies
on Settings › Team.

**A teammate sees "You do not have access to this page".**
The owner has not ticked that page for them. Tick it on Settings › Team. A teammate with no
pages at all sees only this message.

**Engineering is empty.**
It is filled only by `pnpm gather:github --send`, run on a machine with the GitHub command-line
tool signed in, for the organisations listed in `GITHUB_ORGS` in `convex/lib/features.ts`
(empty as shipped).

**Customers is empty.**
As shipped, a customer appears when a deal is marked *won* on Sales. Pushing a whole client
register belongs to the `secondCompany` feature.

**Today's "Your day" is empty.**
Your own mail, calendar and notes appear once you connect them: the owner through Google on
Settings › Connections (it needs `GOOGLE_WORK_CLIENT_ID`, `GOOGLE_WORK_CLIENT_SECRET` and
`TOKEN_ENCRYPTION_KEY`), a teammate through their own token and Claude on the same page.

**I set PostHog or Vercel settings and nothing changed.**
Those two sources belong to the `startupInsights` feature, which is off as shipped. Turn it on in
`convex/lib/features.ts` ([Make it yours](customize.md#turn-features-on)).

## Missing settings

**The build fails with a message about `NEXT_PUBLIC_CONVEX_URL`.**
Locally, `pnpm dev` (or `convex dev`) writes it into `.env.local` the first time. On Vercel, do
**not** set it yourself: the build command in `vercel.json` deploys Convex and injects it. Check
instead that `CONVEX_DEPLOY_KEY` is set.

**Which settings are required?**
On the Convex deployment: `OWNER_EMAILS`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `SITE_URL`,
`JWT_PRIVATE_KEY` and `JWKS`. On Vercel: `CONVEX_DEPLOY_KEY`. Everything else turns on one
source or feature and may stay unset. `.env.example` lists every setting by name and purpose.

**A source says it is not connected, but I set its key.**
Check the name is exact (`MERCURY_API_TOKEN`, not `MERCURY_TOKEN`) and that you set it on the
right deployment: Convex settings, not Vercel's, for every source. An ingest token shorter than
32 characters is ignored; make one with `openssl rand -hex 32`.

## A deploy that refuses

**Vercel's build fails at the Convex step.**

- `CONVEX_DEPLOY_KEY` is missing, or is the wrong kind: production builds need the
  **production** deploy key (scoped to Production only), previews a **preview** deploy key
  (scoped to Preview only).
- The Convex functions do not type-check. Run `pnpm typecheck` locally and fix what it says.

**Convex refuses to deploy because of the schema.**
A change to `convex/schema.ts` does not match the data already stored (a field made required
that old rows lack, for example). Make the field optional, deploy, fill in the old rows, then
make it required. Never delete data on a production deployment to get a deploy through.

**Pushes are refused with 401, 403 or 409.**

- 401 (`unauthorized`): the token is missing or wrong, or the source belongs to a feature that
  is switched off.
- 403 (`source_mismatch`): the envelope names another source than its token's. Each source has
  its own token.
- 409 (`source_is_pulled`): while a source's own API settings are set, the app reads it itself
  and refuses pushes for it. Pick one way.

**A push is refused with 422.**
The envelope does not match the contract. The answer names the field's path; unknown fields are
refused, not ignored. Check the file first with `pnpm push:envelope <file.json>` (it sends
nothing without `--send`). [`docs/ingest.md`](../ingest.md) is the contract.

## Running it on your laptop

**`pnpm dev:local` says "Refusing to run: this command only ever touches a local development
backend."**
A setting points the Convex tool at a deployment that is not on your machine. The message
names it:

- `CONVEX_DEPLOY_KEY`, `CONVEX_DEPLOYMENT_TOKEN` or `CONVEX_SELF_HOSTED_URL` in your shell or
  `.env`: remove it, or open a new terminal without it.
- A cloud `.env.local` is fine: `pnpm dev:local` sets it aside as `.env.local.cloud` while it
  runs and puts it back when it stops.

**It refuses because both `.env.local` and `.env.local.cloud` exist.**
The command was stopped before it could put your file back. Keep the one you want as
`.env.local`, move the other away, and run it again.

**`pnpm dev:signin` or `pnpm dev:seed` says no local backend is set up.**
Start `pnpm dev:local` first and leave it running, then run them in a second terminal.

**The page at `http://localhost:3100` does not load.**
Something else is using port 3100 (or Convex's local port, 3210). Stop it, or stop an older
`pnpm dev:local` that is still running.

## A source that fails

**Settings › Sources shows "Failed".**
The source's last run did not work. The row says why in fixed words, such as *The request
failed with status 503* (the other service was down) or 401 (its key was refused or revoked).
Fix the key, then press *Run now*. A source that returns nothing at all is counted as a
failure, not as a successful run with no data.

**It says "Late" or "Out of date".**
The source has not run as often as expected. A pulled source runs on the schedule in
`convex/crons.ts`; a pushed source depends on your script or scheduled job. Check that job.
