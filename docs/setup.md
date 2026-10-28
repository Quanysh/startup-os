# Setting up your own Startup OS

How a fork of this template gets from a fresh clone to a running deployment: locally first,
then on Convex and Vercel with Google sign-in, then with your own name, your data and your
agents. The rules for changing the code are in [`CLAUDE.md`](../CLAUDE.md). What each page
does, and a checklist for the first week with your team, are in [the guide](guide/overview.md);
if a step fails, see [When something goes wrong](guide/troubleshooting.md).

Environment variables are named here with what each is for, never with a value. Make every
secret yourself (`openssl rand -hex 32` where a random token will do) and set it in the
Convex or Vercel dashboard, never in a committed file.

## 1. Clone and run it locally

You need [Node 20.12+](https://nodejs.org) and [pnpm](https://pnpm.io/installation).

```bash
git clone <your fork's URL> startup-os && cd startup-os
pnpm install
pnpm dev:local      # http://localhost:3100, on a Convex backend on this machine, with made-up data
```

In a second terminal:

```bash
pnpm dev:signin                         # a one-time link that signs the browser in as the owner
pnpm dev:signin sales --company us      # or as a teammate: cofounder, sales, engineer, marketing, success
pnpm dev:seed                           # put the made-up data back as it was
```

No account and no secret is needed for any of this. Check that everything passes before you
change anything:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## 2. Make it yours

Two committed files decide who the OS is and what it has. Neither reads the environment.

**`convex/lib/identity.ts`**

- `PRODUCT`: the product's name, short name, one-line description, slug (the MCP server's name
  in Claude's configuration) and logo key.
- `APP_HOST`: the host the app will be served on (for example `os.yourcompany.com`).
- `COMPANY_IDENTITY.us`: your company's name, market label, legal name, logo, **currency** and
  Telegram hashtags.
- `HEADER_PREFIX`, `TOKEN_STEM`, `TELEGRAM_WEBHOOK_LABEL`, `LAUNCHD_LABEL`: pick your own now.
  They are live contracts once a deployment is running (the file's header says why).

Draw your logo in `src/components/startup-logo.tsx` (`LOGOS` in `src/components/brand-logo.tsx`
names it), replace `src/app/icon.svg`, and put your brand colours in `src/styles/globals.css`:
the `brand`, `brand-fill` and `brand-deep` tokens and `--chart-1`, in both the light block and
the `.dark` block. `pnpm test` checks the contrast of every pair in both themes.

**`convex/lib/features.ts`**

- `FEATURES`: the switches, every one off as shipped. Turn one on only once you have what it
  reads. What each takes away is listed in `convex/lib/featureGates.ts`.
- The outside ids (GitHub organisations and name rules, Linear team prefixes, your team's email
  domain, and the rest): put your own in as you connect each source.

Then pin your values in `convex/lib/deployment.test.ts`, the one test that reads them. Every
other test runs as a made-up deployment with every switch on, whatever yours say.

## 3. Convex

1. Create a free account at [convex.dev](https://www.convex.dev).
2. Run `pnpm dev` once. The Convex CLI asks you to log in, creates a project and a development
   deployment, pushes the functions, and writes `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL`
   into `.env.local` (untracked).
3. Set up Convex Auth's signing keys on the deployment: `npx @convex-dev/auth` sets
   `JWT_PRIVATE_KEY`, `JWKS` and `SITE_URL` (use `http://localhost:3100` for development).
4. Create the production deployment in the Convex dashboard (your project, Production), and
   repeat step 3 there with `--prod`, giving the app's public address as `SITE_URL`.

Note your deployment's HTTP address, `https://<deployment>.convex.site`: Google, the push
scripts and webhooks use it.

## 4. Google sign-in

Sign-in is Google only.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an
   **OAuth client ID** of type "Web application".
2. Add the authorised redirect URI `https://<deployment>.convex.site/api/auth/callback/google`,
   once for each deployment you sign in to (development and production).
3. Set the client's id and secret on each deployment as `AUTH_GOOGLE_ID` and
   `AUTH_GOOGLE_SECRET` (`npx convex env set AUTH_GOOGLE_ID …`, or the dashboard).
4. Set **`OWNER_EMAILS`** on each deployment: the Google address (or comma-separated addresses)
   of the owner. Nobody else is let in until the owner adds them on Settings › Team, and with
   `OWNER_EMAILS` unset nobody is let in at all.

Preview deployments cannot be signed into (Google has no redirect URI for them): treat them as
build checks.

## 5. Vercel

1. Import the repository into [Vercel](https://vercel.com/new). `vercel.json` already sets the
   build command, which deploys the Convex functions and then builds the app against them.
2. Set `CONVEX_DEPLOY_KEY` twice: the **production** deploy key (from the Convex dashboard)
   scoped to Production only, and a **preview** deploy key scoped to Preview only. One key for
   both would either break every preview or let a pull request deploy to production.
3. Do not set `NEXT_PUBLIC_CONVEX_URL` in Vercel: the build command injects it.
4. Add your domain in Vercel, then set `SITE_URL` (Convex, production) to it and, once it serves
   the app, `NEXT_PUBLIC_OS_URL` (Vercel, Production) too.
5. Deploy, open the app and sign in with an owner address.

## 6. Environment variables

Every variable the code reads, by where it is set. `.env.example` says the same with more
detail. **Required** ones are needed for the app to run at all; everything else turns on one
source or feature and may be left unset.

### Next.js (`.env.local`, or Vercel)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | **Required.** The Convex deployment the app talks to. Written by `convex dev` locally; injected by the build on Vercel. |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Optional. The deployment's HTTP address, when deriving it from the URL above would be wrong. |
| `NEXT_PUBLIC_OS_URL` | Optional. The app's public origin, so prompts and snippets show it instead of the deployment's address. |
| `CONVEX_DEPLOY_KEY` | **Required on Vercel** (production and preview keys, step 5). |

### Convex (dashboard, or `npx convex env set`)

| Variable | Purpose |
|---|---|
| `OWNER_EMAILS` | **Required.** The owner's Google address(es), comma-separated. |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | **Required.** The Google OAuth client for sign-in. |
| `SITE_URL` | **Required.** Where the app is served; the OAuth issuer and the links in messages. |
| `JWT_PRIVATE_KEY`, `JWKS` | **Required.** Convex Auth's signing keys (`npx @convex-dev/auth`). |
| `TOKEN_ENCRYPTION_KEY` | Optional, with "Connect Google". Seals stored Google grants: 32 random bytes, base64. |
| `GOOGLE_WORK_CLIENT_ID`, `GOOGLE_WORK_CLIENT_SECRET` | Optional. A second Google OAuth client for "Connect Google" (Gmail headers and Calendar events). Its redirect URI is `https://<deployment>.convex.site/google/callback`. |
| `MERCURY_API_TOKEN` | Optional. A read-only bank API token for cash and monthly money in and out. |
| `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` | Optional, with the `startupInsights` switch on (off as shipped). Product analytics (weekly visitors, signups, activation). |
| `POSTHOG_HOST` | Optional. Your PostHog region's address, when not the US cloud. |
| `VERCEL_API_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Optional, with the `startupInsights` switch on (off as shipped). A product's deployments and, with `VERCEL_WEB_ANALYTICS`, its page views. |
| `VERCEL_WEB_ANALYTICS` | Optional. `on` to also read weekly page views. |
| `GSC_CLIENT_EMAIL`, `GSC_PRIVATE_KEY`, `GSC_SITE_URL` | Optional. Google Search Console, through a service account. |
| `APOLLO_API_KEY` | Optional. Outbound email totals from Apollo. |
| `LINEAR_API_KEY` | Optional. The issue board, mirrored. |
| `FIREFLIES_API_KEY` | Optional. Meeting notes, mirrored. |
| `TELEGRAM_BOT_TOKEN` | Optional. The token BotFather gives a new bot; the groups are picked on Settings › Telegram. |
| `GITHUB_ISSUES_TOKEN` | Optional. Lets bots file fix requests as issues on your own repository (`DEV_REPO` in `features.ts`): a fine-grained token with Issues read and write on that repository only. |
| `BOT_EVENTS_WEBHOOK_URL`, `BOT_EVENTS_WEBHOOK_SECRET` | Optional. An https address that is told when a task, handoff or proposal changes for an external bot, and the key each request is signed with. |
| `BOT_EVENTS_WEBHOOK_SECRET_PREVIOUS` | Optional, while rotating that key. |
| `GOOGLE_GENAI_API_KEY` | Optional. Lets the OS run its own agents on Gemini. |
| `OPEN_MODELS_BASE_URL`, `OPEN_MODELS_API_KEY` | Optional. A self-hosted, OpenAI-compatible model server for the same. |
| `INGEST_TOKEN_<SOURCE>` | Optional, one per pushed source (section 8). |
| `VERTICAL_HEALTH_URL`, `VERTICAL_HEALTH_SECRET` | Only with the `verticalStartupProduct` switch on (off as shipped): the health address of a product's tab on the Product page ("Vertical Startup"). Your own product under its own name is a code change (`docs/guide/customize.md`). |
| `VERTICAL_STARTUP_URL`, `VERTICAL_AGENT_CONFIG_SECRET`, `POSTHOG_GLOBEX_PROJECT_ID` | Only with the original company's own products switched on in `features.ts` (`verticalStartupAgents`, `kzProduct`); leave unset. |

`CONVEX_CLOUD_URL` and `CONVEX_SITE_URL` are set by Convex itself.

### On the machine that pushes (`.env.push`, untracked, beside `package.json`)

| Variable | Purpose |
|---|---|
| `STARTUP_OS_INGEST_URL` | The ingest address: `https://<your host>/ingest/v1`, or the deployment's own `https://<deployment>.convex.site/ingest/v1`. |
| `INGEST_TOKEN_<SOURCE>` | The same token as on the deployment, for each source this machine pushes. |
| `STARTUP_OS_MCP_URL`, `STARTUP_OS_AGENT_TOKEN_FILE` | Optional, for the chat's runner only: an MCP address and a mode-600 file holding a token, instead of what Claude Code's configuration holds. Both or neither. |

### Projects that report their agents to the OS

| Variable | Purpose |
|---|---|
| `STARTUP_AGENTS_URL`, `STARTUP_AGENTS_TOKEN` | Set in **the other project**, not here: the OS's address and the project token the Agents page gives it (`docs/agents-protocol.md`). |

## 7. Teammates

On Settings › Team the owner adds a person by Google address, picks the companies they are on
and ticks the pages they may open. A role only ticks a starting set; it grants nothing by
itself. Payroll, Costs and the owner's own settings can never be given to a teammate.

## 8. Pushing data

Some sources are pulled by the OS on a schedule (set their variables in section 6 and they run
from `convex/crons.ts`). Others are **pushed**: a script or a scheduled run on a machine you
control posts an envelope to `POST /ingest/v1`. The contract, with an example of every
envelope, is [`docs/ingest.md`](ingest.md).

1. Pick the source in `convex/connectors/manifest.ts` and note its id (`github`, `apollo`, …).
2. Make a token (`openssl rand -hex 32`) and set it on the deployment as
   `INGEST_TOKEN_<ID IN CAPITALS>`, and in `.env.push` on the pushing machine. Every source has
   its own token: two sources sharing one are both refused.
3. While a source's own API variables are set, the OS reads it itself and refuses a push for it;
   leave them unset for a pushed source.
4. Check an envelope before sending it: `pnpm push:envelope <file.json>` prints what it holds
   (counts, never a row), and `--send` posts it.
5. Its runs, and any refusal, show on Settings › Sources.

### Scheduled runs

A scheduled run is anything that runs on your schedule outside the OS: a cron job, a launchd
agent, or a Claude session started by a scheduled task that reads a connected tool and writes
envelope files for `pnpm push:envelope`. Each sends only aggregates and the fields the contract
names; none prints a token or a row. The ones this repository has scripts for:

#### GitHub

`pnpm gather:github` counts pull requests and build results through the GitHub CLI (`gh`,
signed in on that machine; the script never sees its credential) and, with `--send`, pushes
them as the `github` source. The repositories counted are the organisations in `GITHUB_ORGS`
(`features.ts`).

#### Apollo

A Claude session with Apollo's connector writes the daily envelopes (the numbers, the
sequences, the stage counts and the saved contacts) and pushes each with `pnpm push:envelope`.
Alternatively set `APOLLO_API_KEY` and the OS reads the totals itself.

#### Visible

Investors can be kept in step with Visible: `pnpm visible:outbox` reads the changes the OS has
queued, the session writes them to Visible, and `pnpm visible:ack` acknowledges each
(`INGEST_TOKEN_VISIBLE`, against the deployment's `*.convex.site` address).

#### Standup → tasks

`pnpm standup:open` reads the board's open cards and `pnpm standup:push` adds a standup's new
tasks to the Backlog (`INGEST_TOKEN_STANDUP`, the one token that can read card titles). A
Claude session between the two reads the meeting's summary and decides the tasks, **which
company** each is for, and who it is for.

#### Intercom

Only with the second company's support inbox switched on: `pnpm support:envelope` turns a
day's results from Intercom into the `intercom` source's envelope (ids, times and states,
never a conversation), and `pnpm push:envelope` checks and sends it.

#### Startup OS agents

The OS's own agents (chief of staff, engineering, sales, finance) run on the schedule set on
the Agents page: on your Mac through the chat's runner (`pnpm assistant:runner`, kept running
by `pnpm assistant:runner:install`), or inside the OS on Gemini or a self-hosted model (section
6). Every write an agent proposes waits for the owner's approval.

## 9. Connect Claude (the MCP server)

The OS speaks the Model Context Protocol at `https://<your host>/mcp/v1`
([`docs/assistant.md`](assistant.md)). Only the owner can connect a client.

- **Claude Code, or a script:** on Settings › Connections, create a token for the client (read
  only, or read and act). It is shown once. The page shows the `.mcp.json` entry and the
  `claude mcp add` command, with a placeholder where the token goes; keep the token out of git.
- **claude.ai:** Settings → Connectors → Add custom connector, give it the address above, then
  sign in to the OS and approve on its consent page (OAuth 2.1).

Each client has its own scope and limits, every call is listed under Recent calls, and
revoking one stops it at once.

## 10. A second company

The template runs for one company. To run the OS for a second (a subsidiary or not):

1. Fill in `COMPANY_IDENTITY.kz` in `convex/lib/identity.ts`: its name, market label, legal
   name, logo, currency and hashtags (and `parent: "us"` only if it is the first company's
   subsidiary).
2. Turn on `secondCompany` in `convex/lib/features.ts`. The company switch, the group's figures
   and the second company's pages, sources and filters appear; teammates can be put on either
   company or both.
3. Turn on the switches that belong to it only if they apply (`subsidiaryFunding` if the first
   company funds it; the others as `featureGates.ts` describes), and update
   `convex/lib/deployment.test.ts`.

## 11. Tests

```bash
pnpm test         # every suite, as a made-up deployment with every switch on
pnpm typecheck
pnpm lint
pnpm build
```

The suite needs no account and no network: Convex functions run in `convex-test`, components
in jsdom. Your real values are read only by `convex/lib/deployment.test.ts`. CI runs the same
four commands on every pull request (`.github/workflows/ci.yml`).
