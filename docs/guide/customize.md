# Make it yours

How to change the name, logo, colours and currency, turn features on, add a second company, a
page, a data source and a bot. Each section names the exact files. The first four need no
programming beyond editing a few values; the rest are developer work.

After any change to the code, run the checks before you deploy:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

[`CLAUDE.md`](../../CLAUDE.md) is the rulebook for changing the code, by hand or with
Claude Code. Read it before adding a page, a source or a server function.

- [Change the name](#change-the-name)
- [Change the logo](#change-the-logo)
- [Change the colours](#change-the-colours)
- [Change the currency](#change-the-currency)
- [Turn features on](#turn-features-on)
- [Add a second company](#add-a-second-company)
- [Add a page](#add-a-page)
- [Add a data source](#add-a-data-source)
- [Add a bot](#add-a-bot)

## Change the name

**File:** `convex/lib/identity.ts`. Everything else reads its names from here; never write the
product's or the company's name anywhere else.

| Value | What it is | Example |
|---|---|---|
| `PRODUCT` | the product's name, short name, one-line description, slug and logo | "Northwind OS" |
| `APP_HOST` | where the app is served | `os.northwind.example` |
| `COMPANY_IDENTITY.us` | your company's name, market label, legal name, logo, currency and Telegram hashtags | "Northwind", "US", "Northwind Inc" |
| `HEADER_PREFIX`, `TOKEN_STEM`, `TELEGRAM_WEBHOOK_LABEL`, `LAUNCHD_LABEL` | technical names that tokens and webhooks carry | pick your own now |

The last row are *live contracts*: once a deployment runs, changing one breaks tokens, bots or
webhooks already out there. Pick them before you go live.

Then put your values in `convex/lib/deployment.test.ts`, the one test that reads them, and run
`pnpm test`.

## Change the logo

| File | What |
|---|---|
| `src/components/startup-logo.tsx` | the logo in the sidebar, drawn as SVG in a React component |
| `src/components/brand-logo.tsx` | `LOGOS`: which component draws which logo id |
| `src/app/icon.svg` | the browser tab's icon |

If you rename the logo's id (`startup`), change it in `LogoId` and `COMPANY_IDENTITY` in
`identity.ts` too. A logo may keep its own colours; everything else in the app wears colour
tokens.

## Change the colours

**File:** `src/styles/globals.css`. The template ships a neutral slate grey. Your brand goes
in three tokens and the first chart colour, each in **both** the light block and the `.dark`
block:

| Token | Used for |
|---|---|
| `brand` | words, links, icons and marks |
| `brand-fill` (with `on-brand` for the words on it) | filled buttons |
| `brand-deep` | a filled button's hover |
| `--chart-1` | the first series in every chart |

`pnpm test` checks the contrast of every pair of text and background in both themes
(`src/styles/contrast.test.ts`) and fails if your colour is too light to read. Components never
write a colour themselves; `src/styles/colours.test.ts` fails if one does.

## Change the currency

**File:** `convex/lib/identity.ts`, the `currency` of your company.

Today the app knows **two currencies only**: US dollars (`"USD"`) and Kazakhstani tenge
(`"KZT"`). Every figure, cost, pay line and budget is kept in the company's currency, and a
second company in the other currency is converted at a stored rate. **Another currency (euros,
pounds…) is not available yet:** it needs code changes in the metric registry
(`CURRENCIES` in `convex/lib/metricRegistry.ts`) and the places that format and convert money.

## Turn features on

**File:** `convex/lib/features.ts`, the `FEATURES` object. Every switch is off as shipped.
What each one adds or removes (its pages, data sources, AI tools and product tabs) is listed in
`convex/lib/featureGates.ts`.

| Switch | Turns on |
|---|---|
| `secondCompany` | a second company: the company switch, the group view on Finance, and its own sources ([below](#add-a-second-company)) |
| `subsidiaryFunding` | the second company is the first's subsidiary, funded from the first's bank (needs `secondCompany`) |
| `kzProduct` | the second company's app on Product, and a page per customer of it (needs `secondCompany`) |
| `supportInbox` | the second company's Intercom inbox on `/support` (needs `secondCompany`) |
| `startupInsights` | a search product's tab on Product, read from PostHog and Vercel |
| `verticalStartupProduct` | a product's tab on Product, read from a health address it serves |
| `verticalStartupAgents` | an older way for a product's agents to report to the Agents page |
| `kztCurrency` | amounts typed in tenge (only while a company keeps its money in tenge) |

Turn a switch on only when you have what it reads: its sources' keys, its outside ids (also in
`features.ts`: GitHub organisations, Linear team prefixes, hosts). Then update the pinned values
in `convex/lib/deployment.test.ts` and run `pnpm test`. Nothing else is needed: the code asks
the switches, never the other way round.

To see everything with made-up data, turn every switch on in a local copy and run
`pnpm dev:local` and `pnpm dev:seed`. That is how the pictures in this guide were made.

## Add a second company

1. In `convex/lib/identity.ts`, fill in `COMPANY_IDENTITY.kz`: its name, market label, legal
   name, logo, currency and hashtags. Keep `parent: "us"` only if it is the first company's
   subsidiary. (The ids `"us"` and `"kz"` are internal and stay as they are, whatever the
   companies are called.)
2. In `convex/lib/features.ts`, set `secondCompany: true`.
3. Turn on the switches that belong to it only if they apply (`subsidiaryFunding`,
   `kzProduct`, `supportInbox`).
4. Update `convex/lib/deployment.test.ts`, run the checks, deploy.
5. On Settings › Team, put each teammate on one company or both.

The [setup guide, section 10](../setup.md#10-a-second-company) says the same in short.

## Add a page

1. **The page:** `src/app/(app)/<name>/page.tsx`.
2. **Who may open it:** add its path to `PAGE_AREAS` in `src/lib/nav.ts`, with the area it
   belongs to. A new area goes in `AREAS` in `convex/lib/roles.ts`, with a name in
   `AREA_NAMES` (same file) and in `AREA_PAGES` (`src/components/team/page-checks.tsx`); it
   then gets a box on the Team page. Decide which roles start with it (`ROLE_AREAS`).
3. **The sidebar:** its entry in `NAV` in `src/components/app-shell.tsx`.
4. **Its data:** every server function the page calls is built with `memberQuery("<area>")` or
   `memberMutation("<area>")` from `convex/lib/owner.ts` (or `ownerQuery` for the owner alone),
   and gets a line in `SURFACE` in `convex/access.test.ts`. The test fails until it has one.
5. **Tests:** `src/components/app-shell.test.tsx` lists what each role sees in the sidebar.
6. **Seed it:** give it made-up rows in `convex/devSeed.ts` so it is not empty locally.

The page only shows and hides. What a person may read is decided inside the server function,
on every call.

## Add a data source

Decide first how the data arrives:

- **Pushed** (simplest): a script or scheduled job you run sends an *envelope* to
  `POST /ingest/v1`. No code in the app reads the outside tool.
- **Pulled:** the app reads the tool's API itself on a schedule (a *connector*).

**A pushed source of numbers:**

1. `convex/lib/metricRegistry.ts`: add the source's id to `SOURCE_IDS`, and declare each
   number it writes in the registry: its key, unit, grain (day, week or month), the scope it
   is for, and that this source is the one allowed to write it. Give it `min` and `max` when a
   wrong value would look believable.
2. `convex/connectors/manifest.ts`: an entry in `SOURCES` with `kind: "ingest"`, a label, a
   description, `requiredEnv: [ingestTokenEnv("<id>")]` and how often it is expected.
3. Seed it in `convex/lib/devSeedData.ts`, and show it on the page it belongs to.
4. Make a token (`openssl rand -hex 32`, at least 32 characters) and set it as
   `INGEST_TOKEN_<ID>` on the Convex deployment and in `.env.push` on the machine that pushes.
5. Write the envelope and check it, then send it:

   ```bash
   pnpm push:envelope weekly-signups.json          # prints what it holds; sends nothing
   pnpm push:envelope weekly-signups.json --send
   ```

   An envelope for a made-up `signups` source looks like this:

   ```json
   {
     "version": 1,
     "source": "signups",
     "batchId": "2026-10-26-weekly",
     "observedAt": "2026-10-26T09:00:00Z",
     "snapshots": [
       { "key": "signups_weekly", "scope": "us", "period": "week", "periodStart": "2026-10-19", "value": 42 }
     ]
   }
   ```

6. Its runs, and any refusal, appear on Settings › Sources.

The full contract (every field, the limits, the answers) is [`docs/ingest.md`](../ingest.md).
An unknown field makes the whole envelope fail, on purpose.

**A pulled connector** has five parts: a parser with made-up fixtures and a test
(`convex/connectors/<source>Parse.ts`), the action that fetches
(`convex/connectors/<source>.ts`), the manifest entry, one line in `convex/crons.ts` and an entry
in `SYNC_ACTIONS` (`convex/sources.ts`) so *Run now* works. `CLAUDE.md`, "Connectors", has the
rules each must follow.

## Add a bot

A bot is any AI tool you connect to Startup OS through the MCP server: a Claude project, a
scheduled Claude task, a script. No code is needed.

1. On **Agents › Bots**, choose **Add a bot**: an id (`research`), a name ("Research"), a role
   label, and, page by page, whether it may read, write or neither. A new bot reads every page
   a bot may, except Contacts, and writes none. Payroll, Costs, Settings, Team, the owner's own records and
   *Today* are locked for every bot.
2. Open the bot and choose **Make a token for this bot**. The token is shown once and works for
   that bot alone. Keep it out of any file you commit.
3. Connect the AI tool to the bot's own address, `https://<your host>/mcp/v1/bot/<id>`, with
   that token. ([`docs/assistant.md`](../assistant.md), "Connecting", shows the configuration
   for Claude Code and other clients.)
4. Write the bot's rules under *Settings for every bot* (rules all bots read) and its own note.
   The bot reads them with the `whoami` tool on every task.
5. Watch its first days on the bot's *Activity* tab, and on **Approvals**: what it wants to
   change waits there. A bot can also ask for more access (*permission request*); that waits on
   Approvals too.

The first time the owner opens the Bots tab, it adds ten suggested bots to start from
(Research, Partnerships, LinkedIn, Compliance and others), each marked *Suggested*. They do
nothing until a tool connects as one of them; change or remove any of them.
