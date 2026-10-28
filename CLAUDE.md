# CLAUDE.md

Guidance for Claude Code (and for anyone) working on this repository: a fork of the Startup OS
template. Getting a deployment running from nothing is [`docs/setup.md`](docs/setup.md); what
each page does, for the people who use it, is the guide in [`docs/guide/`](docs/guide/tour.md)
(keep it true when a page changes); this file is the rulebook a change is held to.

## What this is

An operating system for a startup's founder (the **owner**) and the teammates the owner adds,
each with the pages the owner picks for them. It shows the company's numbers (cash, burn and
runway, product health, sales and fundraising pipelines, marketing and go-to-market) against
published benchmarks, and holds the weekly routine that acts on them: goals, a task board,
company memory, approvals, and AI agents that read the numbers and propose changes for the
owner to approve.

It holds bank balances, pay, investor data and other people's mail subjects. **Treat every
change as security-relevant.** Access, what comes in from outside, and what a model may see
are the parts where a careless change does real harm.

Who the OS is for is `convex/lib/identity.ts` (**Identity**, below); what it has switched on is
`convex/lib/features.ts` (**Features**). As shipped it runs for one company, `"us"`, with every
optional feature off.

## Stack

Next.js 16 (App Router, React 19) · Convex (database, functions, crons, HTTP routes) ·
`@convex-dev/auth` (Google sign-in only) · Tailwind CSS v4 (configured in
`src/styles/globals.css`) · shadcn/ui (`radix-nova` style, primitives in `src/components/ui/`) ·
zod 4 · vitest (with `convex-test`) · pnpm.

Path aliases: `@/*` is `src/*`; `@convex/*` is `convex/*`.

## Commands

```bash
pnpm install
pnpm dev:local    # Next.js on :3100 + a local Convex backend with made-up data. No account.
pnpm dev:signin   # a one-time link that signs the browser in:
                  #   [owner|cofounder|sales|engineer|marketing|success] [--company us|kz|both] [--no-open]
pnpm dev:seed     # reset the local backend to the made-up data set
pnpm test         # vitest: pure functions, convex-test suites and components
pnpm typecheck    # the app, convex/ and the tests (three tsconfigs)
pnpm lint
pnpm build
pnpm dev          # Next.js + `convex dev` against your own cloud dev deployment
pnpm gen:agent-docs   # after editing docs/agents/*.md
```

Develop and verify against the local backend. `pnpm dev:local`, `dev:seed` and `dev:signin`
refuse to run against anything but a backend on your own machine (`scripts/dev/guard.ts`);
if a cloud `.env.local` is present, `pnpm dev:local` sets it aside while it runs and puts it
back afterwards. Never add a flag or variable that lets those commands reach a cloud
deployment.

## Identity

Who the OS is lives in one file, `convex/lib/identity.ts` (imported as `@convex/lib/identity`
in the app): the product's name, short name, description and slug, the app's host
(`APP_HOST`, `APP_URL`), the page title, each company's name, market label, legal name,
parent, logo, currency and Telegram hashtags, the HTTP header prefix (`HEADERS`), the token
stem, the Telegram webhook's HMAC label and the launchd label.

- **Never write the product's name, a company's name or legal name, or the host out anywhere
  else.** Read `PRODUCT`, `APP_URL`, `COMPANIES[id].name` or `COMPANY_IDENTITY`.
- The company ids `"us"` and `"kz"` are internal ids, not identity, and stay as they are in
  every fork. `COMPANIES` in `convex/lib/company.ts` is built from the identity entries.
- Where an environment variable names the same thing on a deployment (`SITE_URL` in Convex,
  `NEXT_PUBLIC_OS_URL` in the app), the variable decides there.
- Some values are live contracts (the header prefix, the token stem, the webhook label, the
  slug, a company's hashtags): the file's header says which. Changing one on a running
  deployment breaks tokens, bots or webhooks already out there.
- The logo artwork is in the components `LOGOS` names (`src/components/brand-logo.tsx`), the
  app icon is `src/app/icon.svg`, and the palette is in `src/styles/globals.css`.
- `convex/lib/identity.test.ts` holds the shape every fork keeps; your own values are pinned in
  `convex/lib/deployment.test.ts`, the one test that reads them.
  `convex/lib/identityRebrand.test.ts` swaps in a made-up identity and checks that the bot's
  replies, the agents' words, every MCP tool's description and the dev seed follow it.

## Features

`convex/lib/features.ts` holds **the switches** (`FEATURES`, every one off as the template
ships) and **the ids of the outside accounts** a deployment talks to (GitHub organisations,
Linear team prefixes, hosts, the team's email domain, and so on: placeholders until you connect
each one). Plain constants, committed, no environment.

- **What a switch takes away is in `convex/lib/featureGates.ts`** (its pages, areas, sources,
  MCP tools and products), and code asks only through it: `featureOn`, `pageOn`, `areaOn`,
  `sourceOn`, `toolOn`, `productOn`, `requireFeature` (a Convex function's refusal). Never read
  `FEATURES` directly.
- Gates sit at the boundary: a route's `layout.tsx` calls `notFound()`, the nav hides the page,
  the area drops out of everyone's areas (so every `memberQuery` of it refuses), the MCP tool
  disappears, the connector's cron does nothing, and ingest refuses the source's token.
- Text a model is given marks a feature's part with `<!-- feature:<id> -->` … `<!-- /feature -->`
  and `withFeatures` strips it while the switch is off: `docs/agents/*.md` (then
  `pnpm gen:agent-docs`), tool descriptions and source descriptions.
- A new optional feature gets a switch in `features.ts`, its things listed in `featureGates.ts`,
  and a test in `convex/lib/features.test.ts`.

**One-company mode** is the `secondCompany` switch off, as shipped. The companies in use are
`companyIds()` in `convex/lib/company.ts`; `ALL_COMPANY_IDS` is every id the code knows, for
types and validators only. So iterate `companyIds()`, and gate any "both companies" UI on
`manyCompanies()`. With the switch off, `requireCompany` refuses a `"kz"` read or write with
`COMPANY_NOT_IN_USE`, the tools' schemas drop `"kz"`, and the switches that belong to the second
company (`PART_OF` in `featureGates.ts`) are off with it. New text that speaks of a second
company gets a `secondCompany` marker. To run a second company, fill in its entry in
`identity.ts` and turn the switch on (`docs/setup.md`, "A second company").

## Tests run as a made-up deployment

Every test runs with `convex/test.deployment.ts` as a vitest setup file: every switch on and the
made-up ids of `convex/lib/deployment.kit.ts`, whatever `features.ts` says. So:

- A test never depends on your deployment's real ids. Need a GitHub organisation, a host or a
  counterparty in a test? Use the kit's.
- The whole suite tests all the code, including features you have switched off.
- A test about a switch mocks `features.ts` itself and spreads `MADE_UP_DEPLOYMENT` into its
  factory.
- Your real values are read by one test alone, `convex/lib/deployment.test.ts`. A new id in
  `features.ts` needs its made-up twin in the kit (that test fails until it has one).

## Access

- **Every function the browser can call is built with one of four builders** from
  `convex/lib/owner.ts`: `memberQuery(area)` / `memberMutation(area)` for what a teammate with
  that area may use, and `ownerQuery` / `ownerMutation` for what only the owner may. ESLint bans
  importing raw `query` / `mutation` / `action` anywhere else; do not disable that rule.
  (`internalQuery` and friends are not callable from the browser and are fine.)
- **The owner** is any address in the `OWNER_EMAILS` Convex variable: always every area and
  every company, and never a row. With no owner configured nobody is let in. **A teammate** is
  a row in `members` (role, companies, areas), written only by `convex/team.ts`.
- **Areas** are listed in `convex/lib/roles.ts` (`AREAS`). Each page belongs to one
  (`PAGE_AREAS` in `src/lib/nav.ts`). `personal` and `admin` are the owner's alone and can never
  be a teammate's; so are `payroll` and `costs` (`OWNER_ONLY_AREAS`): `effectiveAreas` drops
  them for every non-owner whatever a row says. `settings` and `team` are **sensitive**
  (`SENSITIVE_AREAS`): given only by name, in no role's starting set, and only the owner can
  give or take one.
- **A role is a label, a starting set of areas and a focus. It never grants anything by
  itself.** Never ask what a caller may do by their role: the gate puts their areas on
  `ctx.member.areas`, and `may(ctx.member, area)` is the one way to ask. A focus only orders
  the blocks on the start page.
- **The gate knows the area, not the rows.** A handler that reads or writes anything split by
  company must keep to `ctx.member.companies`: filter what it returns, and refuse a write to
  another company's row with `requireCompany`. A read that must not work as a probe answers as
  it would for something that does not exist.
- **Gating a new function:** pick its area (`memberQuery("sales")`), or `ownerQuery` if no
  teammate should have it; pass a company as the second argument when the whole function is one
  company's (`memberQuery("fundraising", "us")`); filter or refuse by company in the handler; ask
  `may(ctx.member, area)` for anything that depends on another area; then add its line to
  `SURFACE` in `convex/access.test.ts`, which fails until it is there.
- **A figure on another section's page needs that section's area too**, and the page leaves it
  out otherwise: never a tile saying the figure has not arrived.
- **A new area** goes in `AREAS`, gets a name in `AREA_PAGES`
  (`src/components/team/page-checks.tsx`, which does not compile until it has one) and a page in
  `PAGE_AREAS`. If it opens salaries, access itself, or a way to change what others see, make it
  sensitive instead of putting it in a role's starting set.
- A block on the start page whose area the viewer lacks is not mounted at all (never an empty
  shell or a "no access" box), and each block also refuses for itself on the server.

## Data

- **Every stored number is declared in `convex/lib/metricRegistry.ts`**: key, unit, grain, the
  scopes it exists for and each scope's one authoritative source. `validateSnapshots` rejects a
  write from any other source, a bucket in the future, and a value outside the metric's
  `min` / `max` / `integer` limits. Give a new metric limits when a wrong value would be
  believable.
- Snapshots are keyed by a canonical UTC bucket (`convex/lib/periods.ts`), so a re-run
  overwrites. All writes go through `upsertSnapshots`. A sync deletes nothing, and an empty
  result from a source is an error, not a successful run with zero rows.
- **A missing number is not a zero.** A total across scopes marks a bucket incomplete and names
  what is missing instead of adding what it has; growth is never computed from a partial total;
  a month or week still in progress is never a complete one. The one exception is a metric
  declared `sparse` (an event, where no row means none happened); never make a level sparse.
- Staleness is judged by the period a figure describes, never by when the row was written.
- Derived numbers (growth, burn, runway, rates) are computed at read time from the stored ones,
  never written as snapshots, by pure functions that take "now" (the current week or month) as
  an argument.
- **Queries never call `Date.now()`.** A query's result is cached until its inputs change, so a
  clock read inside one freezes. Return timestamps and decide freshness on the client
  (`src/hooks/use-now.ts`), or have the caller pass `now` in.
- Store aggregates, not raw records: no bank transactions, no free text from a source as a row
  field. A parser's schema names only the fields it stores, and rows are built from literals,
  numbers and dates computed here.
- Every benchmark band cites a source URL and year (`src/lib/metrics/benchmarks.ts`). Do not add
  a figure that was not confirmed on a primary page. A rate gets a verdict only above a minimum
  denominator; below it the tile shows the number and says why there is no verdict.

## Ingest (data pushed to the OS)

`POST /ingest/v1` (`convex/ingest.ts`) takes data a script or a scheduled run pushes. The
contract, with examples, is `docs/ingest.md`; how to set a source up is `docs/setup.md`,
"Pushing data".

- One bearer token per source, `INGEST_TOKEN_<SOURCE>` in the Convex environment; the token
  fixes the source. Which sources exist, how each is fed and how often it is expected are in
  `convex/connectors/manifest.ts`.
- The envelope is a zod `strictObject`: unknown fields are refused, not ignored. Authenticated
  failures are logged against the source so they show on the sources page.
- A request that carries names (customers, deals, investors, contacts, records) is answered and
  logged in paths and fixed words only (`FIXED_WORDS` in `convex/lib/ingestSchema.ts`), never a
  key or a value, since any of them may be a person's name.
- Tokens are stored as SHA-256 only, returned once, and never logged, thrown or passed to a
  function. Any example that shows a token puts it in a mode-600 header file read with
  `curl -H @header`, never on a command line.
- The app's own origin passes an exact list of routes through to the deployment
  (`src/lib/os/pass-through-routes.ts`, enforced in `src/proxy.ts`). A new token route is not
  reachable through the app until it is added there deliberately. Never widen it to a prefix,
  and never pass `/api/auth/*` through.

## The MCP server and the agents

- **`POST /mcp/v1`** (`convex/mcp.ts`, `convex/lib/mcpProtocol.ts`, tools in
  `convex/lib/mcpTools.ts`) is the Model Context Protocol in its smallest form: stateless,
  one JSON-RPC message per request, no session, no stream. It is how the owner's own Claude
  (Claude Code, claude.ai, a script) reads the OS and acts in it. `docs/assistant.md` is its
  full description.
- Clients connect with a named agent token (made on the Assistant page, scope read or act,
  stored as SHA-256 only) or by OAuth 2.1 sign-in (`convex/oauth.ts`, consent at
  `/oauth/authorize`, PKCE required). **Only the owner** can make a token or approve a sign-in,
  and a token is honoured only while its holder is still the owner, checked on every call.
- **A tool runs as the owner's `Member`, through the same function the app's own query or
  mutation calls.** The registry never reads or writes a table itself (a test fails if it
  does), so what an agent is told and what a page shows cannot drift, and every check the app
  makes holds. A tool never reads the clock: the endpoint does, and hands `now` in.
- Every refusal is a code and fixed words (`AGENT_WORDS` in `convex/lib/agentRules.ts`) and
  never quotes the request.
- **What a model writes is data, never an instruction**, and what an agent wants to change
  waits for the owner's approval unless the tool is a direct edit on an area the agent may
  write. A titled thing from outside (a pull request's title, a person's name) is cleaned on
  the way in, rendered as text, and never put in a log or a thrown error.
- The agents' instructions are `docs/agents/*.md`, generated into
  `convex/lib/osAgentDocs.ts` by `pnpm gen:agent-docs`.
- Adding a tool: `docs/assistant.md`, "Adding a tool".

## Connectors (data the OS pulls)

A connector is a source the OS reads itself on a schedule. Each one:

1. `convex/connectors/<source>Parse.ts`: pure functions from the API's responses to rows, with
   made-up fixtures in `<source>.fixtures.ts` and a test.
2. `convex/connectors/<source>.ts`: an `internalAction` that fetches and hands the work to
   `runConnector` (`convex/connectors/run.ts`), which logs the run, records the source's state
   and treats an empty result as a failure.
3. An entry in `convex/connectors/manifest.ts`, with a `cadence` that matches its cron line.
4. One line in `convex/crons.ts` (native crons only, never the `@convex-dev/crons` component).
5. An entry in `SYNC_ACTIONS` (`convex/sources.ts`), so "Run now" can start it.

Every request goes through `requestJson` (`convex/connectors/http.ts`: a deadline, one retry,
no redirects) and every answer through `expectShape` (`convex/connectors/shape.ts`). An
upstream failure is reported by its status code only, never a response body, and a token never
appears in a message, a log line or an error. A value from the environment that goes into a URL
is checked against a pattern first and never echoed. A connector never asks a source for more
than it stores.

## The UI

- **Convex bundles only `convex/`** and cannot import from `src/`. Code both sides need lives
  under `convex/lib/` and is imported in the UI through `@convex/*`.
- **The UI may import only `@convex/_generated/*`, `@convex/lib/*` and
  `@convex/connectors/manifest`** (ESLint enforces it). Importing a file that defines Convex
  functions, even for one constant, pulls server code into the browser bundle: put shared
  constants in `convex/lib/limits.ts`. Some `convex/lib/` modules are server-only as well; the
  ESLint config lists them.
- Convex does not bundle files with two dots in the name (`*.test.ts`, `*.kit.ts`,
  `*.fixtures.ts`), which is why fixtures and kits are named that way.
- **Tailwind scans only `src/`**: `@import "tailwindcss" source(none); @source "../";` in
  `globals.css`. The default scans the whole project, including the local backend's database
  in `.convex/`, which is rewritten constantly and sends the dev server into a rebuild loop.
- `convex/_generated/` is committed (CI typechecks against it) and never edited by hand.
- `turbopack.root` is pinned in `next.config.ts`; without it Next can pick a stray lockfile in a
  parent directory as the workspace root.

## Theme and colour

- **Tokens only.** A component never writes a colour: no hex, no `rgb()`, no `text-white`, no
  Tailwind palette class, no named colour in an SVG attribute. It wears a token (`bg-panel`,
  `text-ink-2`, `var(--chart-1)`) that has a value in each theme. `src/styles/colours.test.ts`
  fails on anything else; its short allow-list (the logo mark, Google's "G", the browser-bar
  colours) needs a reason for each entry.
- **Both themes in one file.** Light values are the `@theme` block and `:root`; the dark theme is
  the single `.dark` block, which gives every colour a second value. Do not use a `dark:`
  variant for a colour in a component: if something must differ, it needs a token.
- **To add a colour:** name it with its light value, give it a dark value (the test fails until
  you do), and if text sits on it, add the pair to `src/styles/contrast.test.ts`, which works
  the WCAG ratio out for both themes: body and secondary text 4.5:1 on every ground, marks 3:1.
- The brand has three tokens: `brand` (words, links, icons, marks), `brand-fill` with
  `on-brand` (a filled button and its words) and `brand-deep` (its hover). A filled button is
  `bg-brand-fill text-on-brand hover:bg-brand-deep`. The template ships a neutral slate; put
  your own brand colours in those tokens and in `--chart-1`, then run the tests.
- Chart series are `--chart-1` to `--chart-4`, validated together for colour-blind separation in
  both themes. Re-validate if you change one. Text wears ink tokens, never a series or status
  colour, and a status colour (`good` / `watch` / `weak`) always comes with an icon and a label.
- The theme is chosen before first paint by one inline script, `THEME_SCRIPT`
  (`src/lib/theme.ts`), which must do exactly what `applyTheme` does (`src/lib/theme.test.ts`
  compares them). Its CSP hash, `THEME_SCRIPT_SHA256` (`src/lib/theme-hash.ts`), is worked out
  from the text, so it never needs a manual update. Do **not** add that hash to `script-src` on
  its own: a browser ignores `'unsafe-inline'` once a hash is listed, and every Next.js inline
  script would stop.

## Charts and tiles

- Tabular figures (`font-num`) only in columns; big standalone values use default figures.
- **Every table downloads as CSV** (`src/components/ui/table-download.tsx`): the file is read
  from the rendered table in the browser, never from a new query, so it can never hold more
  than the viewer is shown. Do not "improve" a download by fetching rows.
- A sortable table's header is a button with `aria-sort`, and the view (filters, sort) lives in
  the address (`readView` / `writeView`), not in component state.
- A derived tile (a number worked out at read time) starts from a state table: first matching
  row wins, each row's words given exactly, a pure function that returns a reason for every
  "no value" instead of a guess, and a test per row.

## Local development and the seed

- `devSeed.run` empties the tables and `devSession.create` makes a session without Google. Both
  are internal and throw unless the backend itself is local and `OWNER_EMAILS` is exactly the
  made-up local owner. Keep that check the first line of any function added beside them.
- Every row of the seed (`convex/lib/devSeedData.ts`) is invented and reads as invented:
  "Example", "Sample", addresses on `.test`, links on `example.com`. Never copy a real name,
  figure or rate into it. A new table or metric a page reads gets seeded, so the page is not
  empty locally.
- Preview deployments cannot be signed into (Google has no callback for them): treat them as
  build checks, and verify sign-in on local dev and production.

## Workflow

- **Test first:** write the failing test, watch it fail, then implement. Component behaviour is
  tested with Testing Library (`// @vitest-environment jsdom` at the top of a `*.test.tsx`,
  Convex hooks stubbed with `src/test-support/convex.ts`). An expected-error test asserts the
  message, never a bare `rejects.toThrow()`.
- Check a page in the browser on the local backend, as the role it is for (`pnpm dev:signin`)
  and as one that should not have it.
- Before pushing: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- **Secrets** are set in the Convex and Vercel dashboards (or `npx convex env set`), never in a
  file but an untracked `.env.local` / `.env.push`, and never pasted into code, a chat or a pull
  request. `.env.example` lists every variable by name and purpose; `docs/setup.md` says which
  are optional.
