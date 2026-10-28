# The Assistant: the owner's Claude in the OS

The owner's own Claude can read Startup OS and, where the owner allows it, act in it. It does so
through one endpoint, `POST /mcp/v1`, that speaks the Model Context Protocol (MCP), with a token
only the owner can make. This page is how to connect it, what it can call, and its limits.

It is the owner's alone. No teammate has a token of this kind, no teammate sees the page, and
nothing a teammate sees changes: a task Claude makes or changes behaves exactly like one the
owner made by hand. Its card says Claude did it, and which bot, when a bot made the card.

The rules a change here must keep are in `CLAUDE.md`, "Assistant (owner's agent)".

## Connecting

Every client is listed under **Connected clients** on Settings › Connections (the Assistant
links there): its name, its kind (a token, or a sign-in), what it may do, when it was made and
last used, and **Revoke**. Revoking one stops it at once and touches no other. Each client has
its own limits (below), and every row of "Recent calls" names the client that made it.

There are two ways in:

- **A token** (`sosa_…`), for a client where a header can be set: Claude Code, a Grok bot on
  xAI's API, a script. Make one under "Create a token for a client": a name, **Read only** or
  **Read and act**, and, for one client at a time, "It runs the chat and the agents on your
  Mac". It is shown once; only its SHA-256 is kept. Up to 20 at once.
- **A sign-in** (OAuth 2.1), for a client that signs in instead: claude.ai and the Grok app.
  Give it the address `https://os.example.com/mcp/v1`; it opens Startup OS's consent page
  (`/oauth/authorize`), where the owner signs in, sees the client's name and where the browser
  goes back to, picks Read only or Read and act, and approves. Teammates are refused there for
  now ("Only the owner of Startup OS can connect a client, for now.").

**The runner's tools are the Mac's client's alone.** `chat_next` and the rest of the six exist
only for the token marked as the Mac's runner (the token of before, with no name, is that one
until it is revoked). Any other client, and every sign-in, is refused them as "There is no tool
of that name." and is never listed them.

### Claude Code

The page shows a ready `.mcp.json` with a new token already in it (while it is on the page):

```json
{
  "mcpServers": {
    "startup-os": {
      "type": "http",
      "url": "https://os.example.com/mcp/v1",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
    }
  }
}
```

Keep the file out of git (or use `"Bearer ${STARTUP_OS_TOKEN}"`). `claude mcp add --scope user
--transport http startup-os https://os.example.com/mcp/v1 --header "Authorization: Bearer
<YOUR_TOKEN>"` does the same; the page shows it with the placeholder only.

### Grok (xAI API)

A bot on xAI's API takes a remote MCP tool with a static header. Make it a token of its own
(read only unless it should change things) and give each request:

```json
{ "tools": [{ "type": "mcp", "server_url": "https://os.example.com/mcp/v1",
  "server_label": "startup-os", "authorization": "Bearer <token>" }] }
```

It sends `Accept: application/json, text/event-stream` and no `MCP-Protocol-Version`, and calls
`initialize`, then `tools/list` and `tools/call`. The endpoint answers each POST with plain JSON,
which the streamable HTTP transport allows: no stream (SSE) is needed, and none is offered.

### Grok app

Grok's own connector settings (grok.com or the app): add a custom MCP connector with the URL
`https://os.example.com/mcp/v1`, connect, and sign in to Startup OS as the owner and approve. If the
connector asks for a client ID and a client secret instead of signing up by itself, use "Add an
OAuth client by hand" on the connection page (a name and the redirect URI it shows): it gives a
client ID and a secret, the secret once. It still signs in with PKCE and your approval.

### One bot, one connector address

Each bot has its own address, `https://os.example.com/mcp/v1/bot/<bot id>` (Agents › Bots shows it
on the bot's card, with Copy). It is the same endpoint, and **every call made there is that
bot's**, whatever the client sends: the bot is the path's, so a client that never sends a name
(Grok's connector keeps the tool list it was given when it connected, so a new `agent` field never
reaches it) is still the bot. A call there that names anyone else (an `agent` or `bot` argument,
or `X-Startup-Agent`) is refused ("This connector address is one bot's, and the call names
another…"), `X-Startup-Run` is refused as for any bot, and `tools/list` lists that bot's tools. A
call there is always bots-only for that bot; `/mcp/v1` keeps its behaviour.

In Grok: open the bot's own chat, add a custom connector with the bot's address, sign in to Startup
OS and approve, and turn the connector on in that chat only. Adding it inside the existing chat
keeps the chat's instructions and memory. Then ask the bot to call `whoami`.

A sign-in made at a bot's address is for that bot alone: its grant stores `onlyBot` and its tokens
are bound to that address (RFC 8707), so they are refused (401) at another bot's address and at
plain `/mcp/v1`; a grant made at `/mcp/v1` is refused at every bot's address. A named token made
for one bot ("Make a token for this bot", `onlyBot`) works at its bot's address too, and is
refused ("That token is for another bot.") at another's. Any other token used at a bot's address
is that bot, as if it had sent `agent: <id>`.

### claude.ai (web, phone, routines)

Settings → Connectors → **Add custom connector** → URL `https://os.example.com/mcp/v1` → Connect →
sign in to Startup OS and approve. It then appears in the list as a sign-in.

### How the sign-in works

| What | Where | Notes |
|---|---|---|
| Protected resource metadata (RFC 9728) | `GET /.well-known/oauth-protected-resource` and `…/oauth-protected-resource/mcp/v1` | Names `https://os.example.com` as the authorization server; a 401 from `/mcp/v1` carries `WWW-Authenticate: Bearer resource_metadata="…/mcp/v1"` |
| A bot's address as a resource | `GET /.well-known/oauth-protected-resource/mcp/v1/bot/<bot id>` | `resource` is `https://os.example.com/mcp/v1/bot/<bot id>`; a 401 (or a GET with no token) at that address points here. Authorize and token take that resource; the grant is that bot's alone (`onlyBot`) |
| Authorization server metadata (RFC 8414) | `GET /.well-known/oauth-authorization-server` | Complete on its own, for a client that reads nothing else |
| Registration (RFC 7591) | `POST /oauth/register` | Open. Any https redirect URI (http only on localhost). `token_endpoint_auth_method: "none"` is a public client; any other (or none given) gets a secret, shown once |
| Consent | `/oauth/authorize` (the app's page) | The owner only. Code + PKCE S256 only: no implicit flow, no password grant |
| Token | `POST /oauth/token` | `authorization_code` (code used once, within 2 minutes; the redirect URI must be the code's, character for character) and `refresh_token` (rotated; an old one used again revokes the grant). `client_secret_post` or `client_secret_basic` for a confidential client |
| Revocation (RFC 7009) | `POST /oauth/revoke` | A client ends its own grant |

Access tokens (`soso_…`) last an hour and are bound to the resource `https://os.example.com/mcp/v1`
(RFC 8707; a client that leaves `resource` out gets that one). Codes, tokens and secrets are kept
as SHA-256 only. All of it lives in Convex (`convex/oauth.ts`): the app passes the six routes
through unchanged, as it does `/mcp/v1`, so every secret is made and checked in one place; the
consent page is the app's because it needs the owner's session. The issuer is `SITE_URL`.

## The address

Each bot's own address, `/mcp/v1/bot/<bot id>`, is passed through the same way (a pattern route
one bot id wide, `BOT_ID`'s shape; anything else is not passed on). A GET there with no token is
a 401 that names that address's resource metadata; with one, 405.

The endpoint has the two addresses every token route has (`docs/ingest.md`, "The endpoint's
two addresses"): the app's own, `https://os.example.com/mcp/v1`, which is the one to use, and the
deployment's, `https://<deployment>.convex.site/mcp/v1`. The app passes the request through,
adding nothing and logging nothing. For this route alone it also sends on `Accept` and
`MCP-Protocol-Version`, which the protocol uses.

## What it speaks

MCP over "streamable HTTP" in its smallest form: one JSON-RPC 2.0 message in each `POST`, one
JSON answer (`Content-Type: application/json`). No stream, no session, nothing kept between
requests.

| Method | Answer |
|---|---|
| `initialize` | The protocol version (the client's, if it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`; else the newest), `capabilities: { tools: {} }`, the server's name and a few lines of instructions |
| `notifications/initialized`, any other notification | `202`, no body |
| `ping` | `{}` |
| `tools/list` | The tools the token may call: a read-only token is listed the read tools only |
| `tools/call` | The tool's answer as compact JSON text, and the same as `structuredContent` |
| `GET /mcp/v1` | `405`: there is no stream to open |

Refusals are fixed words, and never quote what was sent:

| Reply | When |
|---|---|
| `401`, code `-32001` | No token, a wrong one, a revoked one, a token that is not an agent token (a source's, a teammate's `sos_…`), or one whose holder is no longer the owner |
| `400`, code `-32700` | The body is not JSON |
| `400`, code `-32600` | Not a JSON-RPC 2.0 request; a batch (an array: send one request at a time); an `MCP-Protocol-Version` header naming a version not in the list |
| `413`, code `-32600` | A body over 64 KB |
| `200`, code `-32601` | A method it does not have (resources, prompts, …) |
| `200`, code `-32602` | `params` that are not an object; a call with no tool name; a tool that does not exist |
| `200`, code `-32000` | The call limit (below) |
| `200`, a tool result with `isError: true` | The arguments do not fit the tool (each field by its path and what is wrong with it); a read-only token asked to change something; the OS's own refusal, in the words it shows a person ("That person cannot be given this task.", "This deal is mirrored from …") |

## The tools

**Start with `whoami`.** `initialize`'s instructions tell every client to call it first and to
follow the rules it returns. `whoami` and `bot_rules` are every caller's: on no area, allowed to
every bot whatever its profile (`CALLER_TOOLS`, `botMayCall`), and counted against neither the
client's nor the bot's calls but in a window of their own: 300 in 10 minutes per (client, bot),
a call with no name or a refused one in the client's own bucket, refused past it (`rate_limited`,
limit `caller_calls`). A bot's profile is still asked; a bots-only client answers `whoami` with
no name too, saying it named no bot. Recent calls keeps at most one answered call and one refusal
of theirs a window, so a bot calling `whoami` in a loop cannot push other rows out.

| Tool | What it returns |
|---|---|
| `whoami` | `bot` (id, name, role; null when the call named none or its profile is not one this client may use), `agent` (one of the four, when named), `client` (name, `token` or `oauth`, scope, bots-only), `address` (the bot's connector address), `permissions` (each area and level; write reads as read through a read-only client), `limits` (calls and changes this 10-minute window, proposals today, its proposals still open (`proposalsOpen`, Approvals v2's bucket), the client's ceiling for its bots: `max`, `used`, `remaining`, `resetsAt`; for a call naming no bot, the client's own 120 / 30), `autoApproved` (the kinds the owner granted it under earned autonomy, below; null when no bot), `rules` (below) and a `note` |
| `bot_rules` | The rules as last published: `version` (0 before the first), `publishedAt`, `text` for every bot and the bot's own `note` |

**The rules for the bots** are the owner's, on Agents › Bots: one text every bot follows and a
note for each bot. "Publish as version N" stores them as the next version (`bots.publishRules`,
`botRuleVersions`, the newest 50 kept); every bot gets it on its next `whoami` or `bot_rules`, so
nobody confirms a change in a chat. At most 20,000 characters, and 4,000 a note.

Every read takes an optional `company` (`"us"` is Startup, `"kz"` is Globex; left out, both).
Every answer carries `truncated`: `true` means it was cut to fit its limits.

| Tool | What it returns | At most |
|---|---|---|
| `overview` | The company's attention list (on Today, among "Needs you"), worst first: failed sources, stale or missing figures, pull requests waiting, a failing main branch, deals, investors and partners gone quiet, clinics at risk, obligations overdue or due. Counts only. Takes `today` (your own calendar day) | 100 rows, 60 KB |
| `metrics` | The scorecard's figures: label, unit, the latest value with its period, currency, source and when it was read, and the last six periods. A figure never reported is `latest: null, missing: true`, never zero. Takes `keys` | 250 rows, 150 KB |
| `tasks` | The task board by column, with each card's id | 300 rows, 200 KB |
| `deals` | The sales board of each market by stage. Takes `market` | 300 rows, 200 KB |
| `investors` | The fundraising board by stage (Startup only) | 300 rows, 200 KB |
| `partners` | The partnerships board of each company by stage (identified, contacted, in_talks, agreement, live, paused, lost): each partner's id, name, type, owner, contact and role (never an address or number), expected value with what it counts, next step and its day, last activity, links and `editedBy` (the client that last changed it). Takes `company` | 300 rows, 200 KB |
| `contacts` | Business contacts of each company (never a patient): name, emails, phone, LinkedIn, organisation, title, category, linked investor/partner/deal records (a record's name only with that record's page), how you met, who introduced them, who they can introduce you to, last contact, interaction count, owner and notes. Search `query` over name, email or organisation. Filters `company`, `category`, `owner`, `linkedType` + `linkedId`. `cursor` and `limit` page the list. **A bot without write on `contacts` is sent no `emails`, `phone` or `linkedin`** (the keys are left out, `withheld` names them, and `query` does not match an address) | 50 rows, 80 KB |
| `contact_intro_paths` | Who can introduce you to a contact id, an organisation name or a tag: contacts whose canIntroTo matches, and contacts who introduced someone at that organisation, ranked by last contact. The same contacts as `contacts`, withheld the same way | 50 rows, 80 KB |
| `customers` | The client register, and when it was last pushed; also the clinics won on the sales board that the register does not carry yet (`fromSales`), and each clinic's `dealId` | 400 rows, 200 KB |
| `pull_requests` | GitHub's pull requests: metadata only | 300 rows, 200 KB |
| `repositories` | GitHub's tracked repositories and their main branch's build | 200 rows, 100 KB |
| `obligations` | Compliance and corporate dates, with whether each date is confirmed | 300 rows, 150 KB |
| `compliance_evidence` | `/compliance`'s working records beside the dates: security questionnaires, the answer bank (approved answers to draft from), vendor agreements (with `state` and `days` against the caller's day) and HIPAA / SOC 2 controls with their evidence (`effectiveStatus` reads `expired` once the valid-until day has passed) and a per-framework `coverage` tally. Filters: `section`, `framework`, `status`, `query`, `expiringWithinDays`, `company`; takes `today`. Links only. A tally of records, never a statement that the company is compliant | 300 rows, 150 KB |
| `sources` | Each data source's state and when it last ran. Nothing else of it | 100 rows, 40 KB |
| `people` | Who a task can be given to: a name and an address (to a bot without write on the board, names only) | 100 rows, 20 KB |
| `goals` | A quarter's goals. Takes `quarter` (`"2026-Q4"`) | 100 rows, 40 KB |
| `costs` | Planned costs for a month: per company, the run-rate and cash due per category and currency, the count of lines and estimates, and the lines that are not archived (no note, no "paid by"). Takes `month` (`"2026-10"`) | 650 rows, 180 KB |
| `decisions` | The company's decisions from `/memory`: title, decision, context, owner's address, decided on, status, revisit on, tags, the meeting. Each text cut to 500 characters | 300 rows, 180 KB |
| `meetings` | The company's meeting notes from `/memory`: kind, held on, title, notes cut to 500 characters, action items (and whether each is on the board), the titles of decisions recorded from it. **No attendee**, teammate or outside. Never the owner's own Fireflies rows | 300 rows, 180 KB |
| `handoffs` | Handoffs from one bot to another or to a person, open first (oldest first), then the latest finished: id, company, `from`, `to` (a bot's id or a person's address), `fromRef` / `toRef` (`{type: "bot", id}` or `{type: "person", email}`; a bot without write on the board is sent `{type: "person"}` and "a person" instead of the address), title, summary (≤ 1,500 characters), links (task, deal or decision ids), status (`open`, `accepted`, `done`, `declined`, `closed`), the reason when declined or closed, and the history of every status change with who made it. Filters `to`, `from`, `status`, `company`; `you` in the answer is the name your calls are attributed to (a bot's profile id, once the endpoint matched it). A handoff open a day with no taker is on Today's Needs you | 300 rows, 200 KB |
| `my_inbox` | **A bot's own** (it refuses a call naming no bot): `handoffs` addressed to it that are open; `handoffs_completed`, its handoffs to people that the person marked done since `since` (`[{id, note, by}]`: the person's note or null, and their address); `decided`, its proposals the owner decided since `since` (kind, status, the owner's reason; one it withdrew itself has status `withdrawn` with `withdrawReason`, `withdrawNote` and `replacedBy`); `permissions`, its permission requests decided since then (area, level, status, reason); `dev_requests`, its requests for a fix whose state changed since then (`[{id, title, status, decision, prUrl?, issueUrl?}]`, below, "Asking for a fix"); and `cursor`, to pass as `since` next time. Without `since`, the last 7 days | 200 rows, 120 KB |
| `outcomes` | What came of the bots' plays (the `outcomes` area): id, company, `by` (the bot or agent that logged it), subject (`deal`, `customer`, `investor` or `partner` and its id), play, channel, result (`worked`, `failed`, `pending`), signal, evidence, actedOn, observedOn, proposalId, newest first; and `plays`, a tally per play over every row the filters keep: worked, failed, pending and `winRate` (worked of worked and failed; null when none is decided). Filters `company`, `by`, `play`, `result`, `since` (a day) | 300 rows, 200 KB |
| `linkedin_posts` | The LinkedIn content calendar from `/linkedin`: company, account (`page` or `person`, with the person's name), status (idea, draft, scheduled, published, dropped), hook, draft cut to 500 characters, pillar, owner's address, planned and published times, link, which client added it, the latest figures (impressions, reactions, comments, reposts, clicks, followers gained: a figure nobody gave is `null`, unknown, never 0) and the last 6 snapshots. Optional `status` and `since` | 200 rows, 200 KB |

With a token that may act:

| Tool | What it does |
|---|---|
| `task_create` | Adds a card to the task board (Backlog unless told otherwise). Whoever it is given to is told in the app and in the company's Telegram group, as when the owner does it |
| `task_update` | Changes a card's title, kind, notes, due date, assignee, company or column. `null` clears notes, the date or the assignee |
| `task_move` | Moves a card to a column and a place in it |
| `deal_update` | Changes a deal's next step and notes; for a deal made in the OS, also its name, contact, amount and stage. A mirrored deal (Kazakhstan's, from the CRM) takes only the first two: anything else is refused and nothing is changed. **Winning a deal adds it to Customers**: moved to `won`, the clinic is put on `/customers` linked to the deal (a clinic the client register already carries is linked, never added twice), and moved out of `won`, the row it added is archived (`convex/lib/wonCustomers.ts`) |
| `investor_update` | Changes an investor's next step and notes (`null` clears one); for an investor made in the OS, also its stage (one of the investor stages; the card moves as on the board), amount and contact. A mirrored investor (from Visible) takes only the first two: anything else is refused and nothing is changed. Startup's alone, through the board's own function. Read `investors` first for the id. A contact is a name and role: an email address or phone number is refused (`contact_detail`). Needs write on `fundraising` for a bot; no approval |
| `investor_create` | Adds an investor to the fundraising board (Startup's alone), through the same function the page's "Add an investor" runs. `name` is required. `partner` is the person there (name and role), stored as the card's contact. `checkSize` is the cheque in US dollars, stored as the amount. `source` is where the introduction came from, stored as `referralSource` (the card's own `source` stays `manual`). `stage` is target (the default), contacted, meeting, diligence, committed or passed. `notes` and `nextStep` are the card's own. A firm already here under the same name (any capitals or spacing, punctuation ignored, a trailing LLC or Inc dropped; archived and mirrored rows included) is not added again: the answer is that investor's id and `created: false`, and nothing on it changes. A new one answers with its id and `created: true`, and the row records the bot that added it (`createdBy`). An email address or phone number in `partner` or `source` is refused (`contact_detail`) and nothing is added. Needs write on `fundraising` for a bot; no approval. The `investors` read includes `createdBy` and `referralSource` |
| `customer_update` | Sets a clinic's `note` and `nextTouch` (`"YYYY-MM-DD"`, a real day; `null` clears one), both markets, through the page's own function (`setCustomerOwnerFields`), a clinic of a company the caller is on. Nothing else about a clinic can be sent: the client register owns it. An email address or phone number in the note is refused (`contact_detail`). Needs write on `customers` for a bot; no approval |
| `partner_upsert` | Adds a partner to a company's partnerships board, or changes one: by `id`, else the company's partner of the same name (any capitals), else a new one (needs `company`, `name`, `type`). Through the page's own function and limits: no email address or phone number, a real due day, up to 5 `https://` links, a value that says whether it counts referrals or revenue. The partner then says this client changed it. Answers with the id and whether it was created |
| `partner_move` | Moves a partner to a stage of its board, to the bottom or to `index`. A new stage counts as activity and the partner says this client moved it |
| `contact_upsert` | Adds a business contact or changes one: by `id`, else by any email address of that company, else by the same normalized name and organisation. Email addresses are united and stored in lower case. A new contact needs `company` and `name`. Never a patient. Needs write on `contacts` for a bot; no approval |
| `contact_link` | Links or unlinks a contact and an investor, partner or deal of the same company (`linked` true or false). Needs the record's page as well (`fundraising` for an investor, Startup's alone; `partnerships` for a partner; `sales` for a deal): without it, refused whatever the id. A record that is gone and another company's are the same refusal ("That record is gone."). Nothing on that record's own contact field changes |
| `contact_merge` | Merges `mergeId` into `keepId` (union of emails, links and introduction tags; earliest createdAt; introducedBy pointers move to the one kept), or with `dryRun` true lists duplicate candidates by a shared email or the same normalized name and writes nothing |
| `note_create` | Adds a company meeting's notes to `/memory` (kind, day held, title, notes, action items) through the page's own function and limits (10,000 characters of notes, 30 items). No attendees; an action item stays a note and makes no card. Answers with the new id |
| `questionnaire_upsert` | Adds a security questionnaire (no `id`: requester and company needed) or changes one (`id`); only what is sent changes, `null` clears a day, the owner, the link or the notes. Written directly through the page's own function and checks, so the same rules hold: an https document link only, real days, the caller's companies. The row says which client changed it last (`changedBy`) |
| `answer_bank_upsert` | Adds an approved answer (question, answer up to 5,000 characters, up to 10 tags, company or both, last-reviewed day) or changes one. Everything in the bank is treated as approved: it is what questionnaires are drafted from. Same direct write and attribution |
| `vendor_agreement_upsert` | Adds a vendor agreement (vendor, type BAA/DPA/MSA/NDA/subscription, company; signed and expiry days, status, link, notes) or changes one. An expiry before the signed day is refused. An active one ending within 60 days is on Today under Needs you (and in `overview`), counted and never named |
| `evidence_upsert` | Records evidence for a control: names the control by framework (hipaa, soc2) and id, adds it when `controlTitle` is given, and with `item` adds or changes an evidence item (title, https link, owner, collected and valid-until days, status). A link and no status is collected. Same direct write and attribution |
| `decision_create` | Adds a decision to `/memory` (title, decision, context, status, decided and revisit days, tags) through the page's own function and limits (decision 1,000 characters, context 2,000, 8 tags). Status defaults to `decided`, the day to today. Answers with the new id |
| `handoff_create` | Hands work to another bot or a person, as the bot you are: `to`, `title`, `summary`, optional `links` (≤ 5 ids of tasks, deals or decisions of the same company). `to` is a bot's id (a plain string with no "@", or `{type: "bot", id}`) or a person (an address, or `{type: "person", email}`). Starts `open`. At most 150 open per company; a bot cannot hand to itself. **To a person:** only a bot whose profile writes the board (any other caller is refused, `not_permitted` on the board), at most 20 a UTC day per bot (`rate_limited`, `limit: "person_handoffs"`), and the address must be one of that company's people who hold the board (the owner, or a teammate on that company with it), else `unknown_person`. The person is told in the app and in the company's Telegram group (title, the start of the summary, the bot's id, a link to /handoffs; never an address) and answers on /handoffs. A bare `engineering`, `chief_of_staff` or `finance`, and `bot:<id>`, are stored as `bot:<id>`; a bare id answers with `warning` because that slug is also the Mac agent's (address the Mac agent as `mac:<id>`). An id that matches more than one bot is refused (`ambiguous_addressee`) and stored nowhere. Answers with the new id |
| `handoff_update` | Accepts, declines or completes a handoff **addressed to you** (`action`: `accept`, `decline`, `done`; a decline needs a `note`). Any other bot is refused, and a finished handoff does not change; a handoff to a person is the person's alone, answered on /handoffs. Answers with the new status |
| `linkedin_post_upsert` | Adds a post to `/linkedin`, or changes one (its `id`: only the fields given change, `null` clears the draft, pillar, owner, planned time and link) through the page's own function and limits (hook 200 characters, draft 3,000; scheduled needs a planned time, published a publish time; only a published post has a link, an https address on linkedin.com or lnkd.in; a person's profile names the person, never an address). The row says which client wrote it. **Publishes nothing to LinkedIn.** Answers with the id and whether it was created |
| `permission_request` | **A bot's own**: asks the owner to give the bot calling `level` (`read` or `write`) on `area`, with a `reason`. It stores a `bot_permission` proposal for `/approvals` and changes nothing until he approves it. A locked area (payroll, costs, settings, the team, Today, the owner's own) is refused; so is a level the bot already holds, and a repeat. Answers with the proposal's id |
| `dev_request` | **A bot's own**: asks Startup OS's developers for a fix: `title` (120 characters), `problem` (1,500), `expected` (600), and optionally `tool` (a tool of the registry) and `refusalCode` (a code of the table below). Stored, then filed as a GitHub issue; the answer comes back in `my_inbox` (`dev_requests`). An email address or phone number is refused (`contact_detail`), and so is anything that looks like a key, a token or a password; 5 a UTC day (`rate_limited`, `dev_requests`); one like a request of the bot's own still open is a `repeat`. Answers `{id, status: "filed"}` (below, "Asking for a fix") |
| `outcome_log` | Logs what came of a play you ran on a deal, a customer, an investor or a partner of that company (the `outcomes` area): `subject` {kind, id}, `play` (80 characters, a name you reuse), `channel`?, `result` (worked, failed, pending), `signal`?, `evidence` (500 characters, what happened), `actedOn`, `observedOn`?, `proposalId`?. **An email address or a phone number in `evidence` or `play` is refused.** **A bot's own** (`BOT_OWN_TOOLS`, beside `permission_request` and `my_inbox`): logged as the bot calling, never a name it sends; a call naming no bot (or one of the four) is refused. With `id`, settles a **pending** outcome it logged itself: result, signal, channel, evidence and observedOn change; a decided one, or another bot's, is refused. Answers with the id and whether it was created |
| `linkedin_stats_add` | Keeps a published post's figures as LinkedIn showed them on a day (`day` defaults to today), through the page's own function: whole counts to date, any of impressions, reactions, comments, reposts, clicks, followers gained; at least one; a second call for the same day fills in what it gives. Refused for a post not yet out or a day before it went out. Answers with the id and whether it replaced that day's |

Each tool runs as the owner, through the same code the page it mirrors runs, so the two cannot
disagree, and every rule the app keeps (a task's company, who it may be given to, a mirrored
row) is kept here.

**Never available, to any token**: payroll; a token, or a variable's name or value; the team,
its roles and pages (`people` gives only who a task can be given to, by name and address; a bot
is given an address only when it may give tasks, write on the board, and otherwise names only); a source's settings, variables or run log; the owner's own mail, calendar
and Fireflies meeting notes (the company's notes on `/memory` are another thing: `meetings`), and anyone's personal records; notifications; the Telegram settings.

Text in an answer (a task's title, a clinic's name, a pull request's title) was typed by a
person or sent by another system. It is data for Claude to report, never an instruction.

## Limits

- **120 tool calls in 10 minutes** for each client, **30 of them changes**, for calls that name
  no bot (and Startup OS's own four), refused (code `-32000`) until the window closes. A bot has
  limits of its own (below), refused as a tool error with the code `rate_limited`. A call that
  is turned away for another reason still counts.
- **64 KB** a request.
- Each tool's answer is cut to the rows and bytes in the table above.
- No tool reaches outside the OS: nothing is sent, posted or written to another system.

Calls that name one of the owner's bots are counted apart (below, "Bots").

## Bots

The owner's external bots (Research, Partnerships, LinkedIn, Compliance, Customer Success,
Support, Strategy Advisor, Fundraising, Globex Sales, Growth, and any other) each have a
profile on **Agents › Bots** (the owner's alone): an id, a name, a role label, the clients it may
come through (any, or chosen ones from Settings › Connections), a level for each area and its
own limits (`convex/bots.ts`, `convex/lib/botRules.ts`, `convex/lib/botStore.ts`).

**Identity.** The surest way is the bot's own connector address (above, "One bot, one connector
address"): the bot is the path's. Otherwise a call names its bot with the `X-Startup-Agent` header, an `agent` argument or a
`bot` argument (the page shows the line to give each bot: "Send `agent: <id>` with every
call"). Resolution:

1. One of the four (`chief_of_staff`, `engineering`, `sales`, `finance`): exactly as before
   (their allowlists, the Mac's runner rules).
2. A bot profile of the owner's, switched on and allowed on this client: that profile's
   permissions and limits. Its `agent` and `bot` arguments are taken off before the tool runs,
   and the tool is handed the matched profile's id as `ToolClock.bot`: a goal proposal is the
   bot's, and a handoff's sender and addressee check are that id. A bot has no runs: an
   `X-Startup-Run` header with a bot is refused; two different names are refused, and so is a
   `bot` argument with one of the four in the header.
3. Any other name: refused, "That agent is not one Startup OS knows. The owner adds it on Agents ›
   Bots…", and `tools/list` with that header lists nothing. A bot switched off, or named through
   a client it may not use, is refused in words that say so.
4. No name at all: the client's own behaviour and limits, unchanged, unless the client is
   bots-only (below).

**Only bots may use this client.** Each client on Settings › Connections (a named token or an
OAuth sign-in) has this setting, shown on its row and changed in one click on an outlined button,
"Allow bots only" or "Let anyone" (`assistant.setBotsOnly`, the owner's alone); beside it, "Allow
changes" or "Hold to reading" changes the client's scope. A sign-in's row gives the name the
client registered with and where it signed in from together ("Cursor · via grok.com"), so a
Grok connector that calls itself Cursor is still recognisable. When it is on, a call that names no bot is refused
("This client is for bots: send `agent: <bot id>`…"), and so is one naming one of the four (by
header, argument or a run), unless the client is the Mac runner's token, whose runner tools
need no name either. So a bot holding the credential cannot step outside its profile by leaving
its name off or claiming to be the chief of staff. A refusal counts against the client's 120
calls. The default: on for a sign-in approved from 2026-10-18 on and for every named token that
is not the runner's (`tokenBotsOnly`, `grantBotsOnly` in `convex/lib/agentToken.ts`); off for the
runner's token, the one unnamed token of before, and a sign-in approved before. `tools/list`
with one of the four in the header lists nothing on a bots-only client but the runner's; without
a header it lists the client's tools as before (a bot naming itself by argument still needs the
list), and the call itself is refused.

**Bots sharing one client can claim each other's names.** Startup OS knows a bot only by the name
its call sends, so any bot holding a client's credential can send another bot's id and get that
bot's profile. Real separation needs separate credentials: on Agents › Bots, "Make a token for
this bot" (`bots.makeToken`) makes a named token for one bot, bots-only and made for that bot
alone (`onlyBot`: any other bot naming itself through it is refused, "That token is for another
bot."), and makes it that bot's only client. Making one revokes the bot's previous tokens made
for it alone (`revoked` in the answer; the tab says "Its previous token no longer works."), so a
bot has one live token of its own and a leaked one is ended by making another; its OAuth
sign-ins are left as they are. A token or sign-in made for one bot is bots-only
whatever its setting says: a call through it naming no bot, or one of the four, is refused
(`bots_only`). Removing a bot revokes its autonomy grants, forgets its earned trust (an external chief of staff
or engineering profile's is `bot:<id>`'s: the Mac agent of that id keeps its own) and deletes
the tokens and sign-ins made for it alone: the same id made again starts clean, and its old
credentials are refused. A bot whose id or name is another bot's written
another way (`botKey`: "Growth Bot", "growth-bot", "growth_bot") is refused on create and update,
and so is an id that is one of the four's written another way, so two bots one key apart cannot
be taken for each other in a handoff.

**Permissions.** Each area a bot may hold is none, read or write. A tool's area is
`STARTUP_OS_TOOL_AREAS`; a read tool needs read or write, an act tool write; a tool with no area is
no bot's. A read its page opens with any of several areas lists the others in `STARTUP_OS_READ_ALSO`
and needs read on any one of them (`toolAreasOf`): `goals` is read with `scorecard` or `board`, as
`goals.list` is, while `goal_create` / `goal_update` still need write on `review`. A refusal of
such a read names `area` and the alternatives in `or`. Write still follows each tool's own rules: `task_create` adds the card at once, as it
does for any client. And the client's scope holds: through a read-only client a bot never acts.
**Locked** (`LOCKED_BOT_AREAS`): payroll, costs, settings, team, the owner's own (`personal`,
`admin`) and Today can never be given to a bot, at any level: shown as "Never for a bot" on the
page, not held by the schema's validator, refused by `bots.create` / `update`. So `overview`,
`sources`, `costs`, the brief and `propose` (all `personal` or sensitive) are no bot's. **A bot
is told what its own areas open, never what the owner behind its client holds.** A read tool that
shapes its answer by the caller's areas computes it, for a bot's call, for a teammate (not the
owner) holding exactly the bot's areas at read or write, never a locked one, `marketing` following
`gtm` (`memberAsBot`, applied by `asCaller` in convex/lib/mcpTools.ts): `metrics` sends only the
figures whose section (or `alsoFor`) the bot holds, as the scorecard does a teammate (read on
`scorecard` alone opens the tool and no figure; finance figures need `finance`); `goals` sends a
target only to a bot holding `scorecard` or `finance`; `budget` tells a bot the plan, cash, burn
and runway (its own `finance` figures), never the cost register's run-rate, categories or cash
due, nor a typed cost or pay cell. A call naming no bot (the owner's own clients, the Mac runner's
four, Startup OS's own agents) is computed for the owner, as before. The other read tools are one
area's throughout (the area that opens them is the whole gate), or already ask the bot's level
(`people`, `handoffs`: addresses only with write on the board). `contacts` and
`contact_intro_paths` are computed for the bot (a linked investor's, partner's or deal's name only
with that page) and send a contact's email addresses, phone number and LinkedIn **only to a bot
with write on `contacts`**: a bot that may only read them is told who the person is (name,
organisation, title, category, owner, links, last contact) and never how to reach them, the three
keys left out and named in `withheld`, and its `query` never matches an address. A call naming no
bot is sent them, as the page shows them to whoever holds Contacts. `agents` still sends `bots` (the
registry) by `isOwner` of the client's holder, not by area: a bot holding `agents` is sent it.

A new bot reads every area a bot may hold but `contacts` and writes none: real people's addresses
are ticked for a bot by name, as for a teammate (`BOT_DEFAULT_AREAS`; the suggested ten and the
external owner-agent profiles start without it too). The suggested ten (added once, marked
"Suggested" until the owner edits them) write: Fundraising fundraising and board; Research memory
and board; Partnerships partnerships and board (and reads sales, nothing else); LinkedIn and Growth gtm and board; Compliance
compliance and board; Customer Success board (reads customers and support); Support board
(reads support); Strategy Advisor review (proposing goals), memory and board; Globex Sales sales and
board. Fundraising, compliance, gtm and review have no tool that changes something yet, so a write
there does nothing until one exists. **Outcomes** (Bot Loop v3): Growth, Globex Sales, Customer
Success, Fundraising, Partnerships and LinkedIn also write `outcomes` (`outcome_log`); every other
bot reads it (Support's read list holds it too), the external chief of staff and engineering
profiles included (`externalPermissions`). A bot made before the area holds nothing on it
until `npx convex run outcomes:grantDefaults` runs once (it keeps any level the owner set; it
reads every `bots` row, the external profiles too).

**The Bots tab's "Plays"**: on an open bot's Plays tab, a table of the plays it logged outcomes of in
the last 30 days (`outcomes.playsByBot`, the owner's), with worked, failed, pending and the win
rate. Nothing for a bot with none.

**Limits**, each bot's own, counted per (client, bot) in `botUsage`, so one bot never uses
another's: by default 600 calls and 120 changes in 10 minutes and 200 proposals a day (at most
2,000, 600 and 1,000). The bots of one client together stop at 2,000 calls and 600 changes in 10
minutes. A refusal names the limit and when it resets ("This bot has used its 600 calls for this
10-minute window. It resets at 14:30 UTC."). Each audit row carries the bot, and Recent calls
shows its name.

**Refusals a bot can act on.** Every refusal a bot meets is a tool error (`isError: true`) whose
text is the sentence above and whose `structuredContent` is its code and details, so a bot can
branch on it instead of reading English (`BOT_REFUSAL_CODES`, `convex/lib/botRules.ts`):

| Code | Details | When |
|---|---|---|
| `not_permitted` | `tool`, `area` (as the owner grants it: `gtm` for marketing), `need` (`read` / `write`), `locked: true` when no permission can open it | A tool the bot's profile does not allow |
| `rate_limited` | `limit` (`calls`, `changes`, `proposals`, `client_calls`, `client_changes`, `person_handoffs`: 20 handoffs to people a UTC day, `dev_requests`: 5 requests for a fix a UTC day), `max`, `resetsAt` (ISO, UTC) | Over one of its limits or its client's ceiling. A bot's limit is a tool error, not the JSON-RPC `-32000` a client's own is |
| `unknown_bot` | none | A name no profile has |
| `bot_off` | none | The owner switched it off |
| `wrong_client` | none | A client it may not use, or a token made for another bot |
| `bots_only` | none | A call naming no bot (or one of the four) on a bots-only client |
| `read_only` | none | A change through a read-only client |
| `wrong_agent` | none | Two different names, a `bot` argument beside one of the four in the header, or a run header |
| `not_this_address` | none | A call at one bot's connector address (`/mcp/v1/bot/<id>`) that names another bot or one of the four |
| `repeat` | none | A proposal whose `dedupeKey` is open, or was decided or expired lately; a `dev_request` like one of the bot's own still open: stop, do not rephrase |
| `missing_why` | none | A proposal (or `permission_request`) with no `why` |
| `bad_context` | none | A proposal's `urgency`, `goalId` or `source` that does not hold for that company; a withdrawal's `replacedBy` of another company, or the withdrawn proposal itself |
| `too_many_open` | none | The bot already has as many proposals open as it may |
| `attribution_mismatch` | `expected` (the caller), `got` (the id the key names) | A `propose`, `goal_create`, `goal_update` or `permission_request` whose `dedupeKey` begins with another known bot or agent (below, "Attribution") |
| `possible_duplicate` | `matches`: the top 3 `{type, id, title, sim}` (`type` task, proposal, handoff or deal); `id` and `title` only where the bot may read that type (a proposal never; a task or handoff with read on the board; a deal with read on sales), else `{type, sim}`; on a proposal, `withdrawHint`: the matched open proposals that are the caller's own (left out when none) | Something open is near it (below, "Near-duplicates"), or a `deal_create` whose name is a deal's already on that market's board: stop if it is the same, or call again with `force: true` and `forceReason` |
| `unknown_person` | none | `handoff_create` to an address that is not one of that company's people who hold the board |
| `ambiguous_addressee` | none | `handoff_create`, or a reassignment, whose bot id matches more than one profile. A bare `engineering`, `chief_of_staff` or `finance` is not this: it is stored as `bot:<id>` and the answer carries `warning` |
| `contact_detail` | none | `handoff_create` to a person whose title or summary holds an email address or a phone number (`looksLikeContactDetail`): both are posted in the company's Telegram group; a `proposal_withdraw` note that holds one; an `investor_update` contact, an `investor_create` partner or source, or a `customer_update` note that holds one; a `dev_request` that holds one |
| `not_owner` | none | `proposal_withdraw` of a proposal the caller did not file, or an id that is no proposal (the same answer), or a `replacedBy` that is not its own |
| `not_open` | none | `proposal_withdraw` of a proposal the owner decided, that expired or that was withdrawn already |
| `not_chief_of_staff` | none | `proposal_decide` by a caller Startup OS did not authenticate as the chief of staff. Naming `chief_of_staff` in an argument does not |

The audit row keeps the code (and a not-permitted call's area and level) as `refusal`: closed
sets, never a word the call sent.

**Asking for a permission.** `permission_request` (`area`, `level`, `reason`) is every known,
switched-on bot's, whatever its permissions (with `my_inbox` and `proposals_feedback`:
`EVERY_BOT_TOOLS`), but only through a client that may act. It stores a `bot_permission`
proposal, filed under the chief of staff's switch and counted against the bot's proposals a day;
it lands on `/approvals` ("Let the bot partnerships read and change Sales", before → after the
area's level). **Approving it is the owner's alone** and runs `setBotLevel`, the same change the
Bots tab's Grant makes (never a locked area); the bot holds the level from its next call.
Rejecting it with a reason returns the reason through `my_inbox` (`permissions`) and
`proposals_feedback`, which hands a bot its own proposals only. `propose` cannot make a
`bot_permission`, and a request is always for the bot calling: its id is the endpoint's matched
profile, never an argument.

**The bot's inbox.** `my_inbox` gives the bot calling its open handoffs, its handoffs to people
that the person marked done (`handoffs_completed: [{id, note, by}]`), its proposals and
permission requests decided since a cursor it passes back (or the last 7 days), and the next
cursor. A call naming no bot is refused.

**Asking for a fix** (`dev_request`; `convex/devRequests.ts`, `convex/lib/devRequests.ts`).
Every known, switched-on bot's (`EVERY_BOT_TOOLS`, `BOT_OWN_TOOLS`), through a client that may
act; refused to a call naming no bot, to the four agents on the Mac and to the chat
(`CHAT_DENIED_TOOLS`). A bot uses it when Startup OS lacks something it needs or a tool behaves
wrongly, describing the problem, not the solution. The loop:

1. The tool stores a `devRequests` row for the bot calling (its id from `ToolClock.bot`, the
   client's key), status `filed`, and, when `GITHUB_ISSUES_TOKEN` is set, schedules
   `devRequests.file`.
2. `file` opens an issue in **your-org/your-os** (`POST /repos/your-org/your-os/issues`,
   the repository fixed in code) labelled `bot-request`. Its body starts with the exact line
   `<!-- startup-os bot-request -->`, then Bot, What it tried (tool, refusal code), Problem and
   Expected; the bot's text is in fenced blocks (a fence longer than any backtick run in it),
   every `@` made full-width and every `<!--` / `-->` broken, so it can neither ping anyone nor
   forge a marker. Status `issue_open`, `issueNumber` stored. A refusal GitHub will repeat
   (400, 404, 410, 422) is `failed`; anything else leaves it `filed` for the next run. A filing
   holds the row for five minutes (`lastCheckedAt`), so the scheduled filing and the cron
   never both open an issue.
3. A Claude routine outside this repository, triggered by the issue, comments with a decision
   marker as the first line: `<!-- claude-decision: fix -->` (it opened a pull request; a
   plain paragraph for the bot and the PR's link), `<!-- claude-decision: owner -->` (the
   owner decides; label `needs-owner`) or `<!-- claude-decision: answer -->` (the bot was
   wrong; the issue closed not planned).
4. Every 10 minutes the cron `check bot dev requests` runs `devRequests.check`: it files up to
   five requests still `filed` (so one made while the token was unset is filed once it is
   set), then reads back at most 20 in `issue_open`, `fix_proposed` or `needs_owner`, longest
   unchecked first: the issue, its comments (the first 100) and, for a proposed fix, its pull
   request. **Only a comment by the repository's people (`OWNER`, `MEMBER`, `COLLABORATOR`) or
   an app (`user.type` `Bot`) counts**; the newest one whose first line is a marker sets the
   status (`fix` → `fix_proposed` and `prUrl`, `owner` → `needs_owner`, `answer` →
   `answered`). Its first paragraph after the marker becomes `decisionText`: links as their
   text, one line, emails and phone numbers taken out, at most 1,000 characters. A pull
   request is taken only as `https://github.com/your-org/your-os/pull/<n>` and stored
   rebuilt from the number. An issue closed as completed, or a merged fix, is `shipped`;
   closed any other way, `answered`; an issue that is gone (404, 410), `failed`. **Nothing of
   a comment is stored but `decisionText`.**
5. Each change moves `updatedAt`, and the bot's next `my_inbox` lists it under
   `dev_requests` (`{id, title, status, decision, prUrl?, issueUrl?}`), the requests whose
   `updatedAt` is at or after its `since`: once per change, as `handoffs_completed` does.

Statuses: `filed` (waiting for an issue), `issue_open`, `fix_proposed`, `needs_owner`,
`answered`, `shipped`, `failed`; the first four are open. **The owner's view**: on an open
bot's **Requests** tab (Agents › Bots), its requests, newest first, each with its state as a
chip, title, the answer and links to the issue and the pull request (only the repository's
own URLs are linked; `devRequests.forBot`, the owner's alone), and "Open requests" in the
strip over the table (`devRequests.openCount`, the owner's alone).

**`GITHUB_ISSUES_TOKEN`** (Convex env, production; optional): a fine-grained personal access
token with Issues read and write on your-org/your-os alone (and Pull requests read, for
"merged"; without it a fix ships when its issue closes as completed). Read inside the two
actions only: never stored, returned, logged or thrown, and no response body is kept or
logged. Unset, nothing is scheduled and the cron does nothing: requests wait as `filed` and
are filed once it is set.

**Handoffs to people.** A bot with write on the board may hand work to a person of that company
(`handoff_create` with an address, at most 20 a day). The person is told the way a task's
assignee is: a row in their notifications ("support handed you …", with the start of the
summary, leading to /handoffs) and a message in the company's Telegram group (title, summary,
the bot; never an address, and nothing when the bot is off). On /handoffs it reads "You" and
opens with Accept, Mark done (a note optional) and Decline (a reason required); nobody else
answers it, not the owner and not a bot (the owner can still reassign or close it). On /handoffs the owner, or a teammate with the board, can also tag a person (closing one is the owner's alone: `handoffs.close` is an `ownerMutation`) on any open handoff, a bot's to a bot included: "Hand it to" lists that company's people who hold the board and the bots, and the person is told the same way. Done reaches
the bot's `my_inbox`. A person's address (in `to`, in the history's `by`, in
`handoffs_completed`) reaches only a bot that may give them work, write on the board, as `people`
decides; any other caller reads "a person", and its `to` / `from` filter by an address is left out,
so it cannot ask who holds a handoff. Open a day with nothing done, it is a line of the person's Needs you
("N handoffs to you wait for an answer") and stays in the owner's "no taker" count.

**The Bots tab** shows, on an open bot's Activity tab, its last 10 calls (tool, outcome, when, a refusal's
code), its calls and refusals today, and today's refusals grouped by code ("6× Not permitted on
Sales (write)"). A not-permitted refusal seen twice or more today has **Grant** beside it: one
click gives that level on that area (`bots.grant`, the owner's alone, with the checks approving a
`permission_request` makes: never a locked area, the bot switched on, a level it does not hold already). A
bot refused more than 5 times in the last hour is a line of the owner's Today › Needs you
(`bots.refusedLately`, asked with the page's clock), leading to the tab.

### The bots' week, cost and budget (Bot Loop v3, J, 2026-10-19)

The `agents` read ends with `bots`: one row a bot profile on Agents › Bots, the external chief of
staff and engineering included (spec §13; `botRegistry` in `convex/lib/botTelemetry.ts`). It is
listed only when the caller is the owner (every MCP call and every Startup OS run is; otherwise
`null`). Each row: `botId`, `name`, `provider` (`external_grok` when its newest call came through a
client named or signed in from Grok, else `external`: Startup OS calls no model for a bot), `owner`
(the word "owner", never an address: bots read this), `company` (us, kz, both, or null until the
owner sets it), `monthlyBudgetUsd` (null: none), `enabled`, and over the last seven UTC days
`calls7d`, `errorRate7d` (outcome `error`), `schemaFailureRate7d` (outcome `invalid`), `p95Ms7d`,
`lastSeenDay`, `idle7d`, `approvalRate` (approved of its proposals approved or rejected in those
days, from `proposerStats` keyed `bot:<id>`), and `costMonthUsd` with `costWhy`. **A figure nothing
was reported for is null, never 0**; a month with no reported cost is `costWhy:
"external_not_reported"`.

**A bot's company is enforced only on fundraising.** `investors`, `investor_update` and `investor_create` hold a
bot to Startup as the page holds a person (`memberQuery("fundraising", "us")`): the caller must be
on Startup, and a bot must work for it (`company` us, both, or none set: `botServes`); a bot
working for Globex is refused in the page's words ("That is not allowed."), and asked for
`company: "kz"` is sent the empty board as before. Every other tool ignores a bot's `company`:
it reads both companies' rows its areas open (a known gap, not yet a rule).

**Where the week comes from.** `agentCalls` keeps only its newest 500 rows, so a busy day would
shorten a week read from it. Each audit row written for a matched bot (`assistant.record`) also adds
to that bot's day in `botCallDays` (`noteBotCall`): calls, errors, invalid, refused, a duration
histogram (`DURATION_BUCKETS_MS`; the p95 is the upper edge of the bucket it falls in, never above
the slowest call), the cost it reported and the client's provider word. Counts and closed words
only, never an argument, a name or text. One bounded read a bot (its newest 40 days up to the
caller's `today`; no clock is read). Kept `BOT_CALL_DAYS_KEPT` (40) days by the daily
`assistant.prune`. Calls the audit does not write (`whoami` and `bot_rules` past the first of their
window) are not counted.

**`costUsd` on any call.** A call may carry `costUsd`, what it cost the caller in USD, a number from
0 to 100 (`cleanCostUsd`, `convex/lib/botRules.ts`). The endpoint takes it off the arguments of
every call before the tool's schema sees it (so no tool takes it and it is never `invalid`), and the
audit keeps it, on the call's row and in its day, **only for a bot whose profile matched**: a call
naming no bot, one of the four or an unknown name keeps nothing. A value out of range or not a
number is dropped; the call still runs. The month's cost is the sum of this UTC month's reports.

**On the Bots tab** (`bots.telemetry`, the owner's, asked with the page's UTC day): the table of
every bot holds each one's calls, approval, errors, bad arguments, p95, last day seen and this
month's cost against its budget ("$1.20 of $50.00", or "Not reported"), with an **Idle 7 days**
flag for a bot with no call in seven days (and the open bot's Week tab the same figures, for a
phone that drops columns). Each bot's form (its Permissions tab) edits its company and its monthly budget
(0 to 10,000 USD; empty takes it away; `bots.update`, refused in `BOT_WORDS.badBudget`). Changing
either, like the switch, leaves a suggested bot marked suggested.

**Retiring `sales` and `finance` is not automatic.** The owner switches one off with the existing
switch (`agentSettings`, `assistant.setAgent`) once nothing still runs it. A switched-off agent is
then refused **every** call it names (a read as much as a write: `allowlistFor` returns `AGENT_OFF`
after its tool list), so no `agentCalls` row ever records an answered call of it.

### Attribution (Bot Loop v3, 2026-10-19)

A `dedupeKey` is `<proposer>:<kind>:<subject>`. Its first part is the caller: `<id>` or
`bot-<id>`, both accepted for the caller itself. When it names a known proposer other than the
caller (one of the four, or a bot the owner keeps a profile of), `propose`, `goal_create`,
`goal_update` and `permission_request` refuse it as `attribution_mismatch {expected, got}`, for a
bot and for one of the four alike (`refuseMisattributed` in `convex/lib/proposals.ts`). A first part
that names no one Startup OS knows (`q4:…`) is left alone. Both ids are the server's: the caller as
the endpoint matched it, and the key's only once it matched a known proposer.

The proposals filed before this under one of the four (the shared Grok client sent their ids) are
re-attributed once by `migrations:reattributeOpenProposals` (an internal mutation the owner runs
by hand, `npx convex run migrations:reattributeOpenProposals`): an open proposal whose key names a
bot with a profile gets `bot` set to it, `agent` kept; a second run changes nothing; it returns
`{changed, read}`. Approval rates per bot are worked out at read time, so they follow at once.
A decided proposal is left as it was, with no `bot`. `proposals_feedback` (and the repeat check)
still reads it as that proposer's (`legacyProposer`): the key's first part when it names one of
the four or a bot profile, otherwise the agent it was filed under. A dismissal there counts in
that proposer's `rejectedKinds`. The four's own proposals never carry `bot`, and are read the
same way when the external profile of that id asks.

### The external chief of staff (and engineering, and finance)

`chief_of_staff`, `engineering` and `finance` (`EXTERNAL_OWNER_AGENTS`; spec §13, Grok bots use
the ids `engineering` and `finance` too) each have an external profile on the same rules, written
below for the chief of staff; the others' addresses are `/mcp/v1/bot/engineering` and
`/mcp/v1/bot/finance`, and their defaults are the same. A Mac agent switched off leaves its
external profile working (the switch is the Mac agent's alone). `sales` has none: Mac only (a
bots-only client still refuses it, `bots_only`).

`chief_of_staff` is one of the four. Through the **Mac runner's token** it keeps their rules
exactly (its allowlist, its runs). Named through **any other client** (header, `agent` or `bot`),
or at its own address `/mcp/v1/bot/chief_of_staff` (the one of the four with an address), it is
the **external chief of staff**: a profile kept in `bots` under the id `chief_of_staff`
(`EXTERNAL_CHIEF` in `convex/lib/botRules.ts`), made by **Set up the external chief of staff**
(or engineering agent) on the Bots tab (`bots.addExternalProfile`, switched on), and edited there
like any bot's. Named before that, its first call makes it with its defaults **switched off**
(`ensureExternalProfile`) and is refused `bot_off` in words that say the owner must switch it on
(`BOT_WORDS.externalOff`): a credential that reaches `/mcp/v1` never gets a profile that writes
before the owner has seen it. That call is made only after the one-bot token's check (a token made
for another bot is refused `wrong_client` and makes nothing), and `tools/list` lists nothing for
it until the profile exists and is on. Removing the profile on the Bots tab and naming it again
makes it again switched off. Its defaults: read on every area a bot may read but `contacts` (`outcomes` included, as for
every bot that runs no plays, so `outcome_log` is refused `not_permitted` until the owner gives it
write there), write on the board (tasks, handoffs, **handoffs to people** too: that needs board
write) and memory (notes, decisions); payroll, costs, settings and every other locked area stay
locked. `outcomes:grantDefaults` treats it as any bot: read on outcomes if it holds nothing there. It is admitted on the bot path, so its limits, audit rows (`bot: "chief_of_staff"`) and
counters are its own, per (client, `chief_of_staff`), apart from the Mac's; its handoffs are its
own too: it is `bot:chief_of_staff` in them (`callerName`, `handoffKey` in
`convex/lib/handoffs.ts`), the name its handoffs are from, `you` in `handoffs` and `my_inbox`, and
the address another bot gives to reach it. A bare `chief_of_staff`, `engineering` or `finance`
(any spelling `botKey` folds, or `{type: "bot", id: "<id>"}`) is stored as `bot:<id>` too, and
`handoff_create` answers with `warning` because that slug is also the Mac agent's id; the Mac
agent is addressed as `mac:<id>`. `my_inbox` and `handoff_update` share that resolution: the
matched profile answers `bot:<id>` and a row still stored under the bare id, and the Mac agent
answers only `mac:<id>`. An id that matches two bot profiles is refused (`ambiguous_addressee`)
and stored nowhere. Open rows still under the bare id are rewritten by
`migrations:repairOpenHandoffAddressees` (internal, idempotent, `{changed, read}` only). The
key `bot:<id>` is the name itself, which no bot's or client's name can become (`botKey` turns
":" into "_", and only a call the endpoint matched to the profile is given it); its proposals are
stored with `bot: "chief_of_staff"`, counted for trust as `bot:chief_of_staff` (`externalProposerOf`) (never the Mac's
streak or grant), and **never auto-approved**. On a bots-only client it is accepted as this
profile (it is no longer `bots_only`). A token made for another bot refuses it (`wrong_client`).

### Near-duplicates

Before a new card reaches the owner, `propose` (every kind but a bot's own permission request),
`goal_create`, `goal_update`, `task_create` and `handoff_create` compare it with what is open
(`convex/lib/duplicates.ts`):

- **Candidates**: open tasks (backlog, this week, doing), open proposals and unfinished handoffs,
  of the same company plus shared ones, made in the last 60 days, each list bounded. A proposed
  new deal (`deal_create`) is also compared with its market's deals (archived and mirrored ones,
  any age) by normalised name (`dealNameKey`): the same name scores 1, as does an open
  `deal_create` of that name; a deal is matched by its name only, never by title similarity.
- **Score**: the titles word by word (stop words and words under three letters dropped, a light
  stem), each word matched to its nearest by trigram Dice; the mean of overlap and Dice (Dice alone
  for a one-word title); plus 0.15 when both point at the same deal, task, goal or customer; at most
  1. No model and no embedding.
- **Threshold**: the owner's, on the Bots tab (`duplicates.setThreshold`, 0.5 to 1), 0.82 until set.
- At or above it the call is refused as `possible_duplicate` with the top three matches and
  nothing is written. Every candidate is scored for every caller, so whether a call is refused
  never depends on who asks; what the refusal says of each match does (`duplicateViewFor`,
  `shownMatches`): a bot is told a match's title and id only where it may read that type (an
  open proposal never, since proposals are the owner's own; a task or handoff with read on the
  board; a deal with read on sales), and otherwise `{type, sim}` alone. The owner's own clients
  and the four agents are told every match. A forced item's answer (`duplicateOf`) is held to
  the same rule; the stored row keeps every id for the owner's card. A proposal's refusal also
  names, as `withdrawHint`, the matched open proposals the caller filed itself (only its own,
  `filedBy`; left out when none), so it may withdraw the older one and propose again ("Withdrawing a
  proposal", below). Called again with `force: true` and `forceReason` (one line, at most 200
  characters), it is made, and proposals and tasks store `duplicateOf` (the matches' ids) and
  `forceReason`; the `/approvals` card shows "Possible duplicate of …" and the reason.
- **People are warned, never refused** (`nearTasks`, `personDuplicates` in `convex/tasks.ts`;
  2026-10-20). Every way a person makes a card consults the same check, open tasks only (the
  same company and shared ones, as the person may see them: `canSee`), and nothing is logged to
  `duplicateChecks` (its tools are a closed set for bots and agents). The board's add form and
  card editor, and Memory's "Add to board", send `duplicates: "warn"`: a near open card stops
  the add with a coded warning (`ConvexError({words: TASK_DUPLICATE_WORDS.possible, refusal:
  {code: "possible_duplicate", matches: [{id, title}]}})`), the page says "Possible duplicate
  of “…”" with **Add anyway** (sent again as `"confirmed"`) and **Don't add**
  (`src/components/tasks/duplicate-warning.tsx`, `src/lib/tasks/duplicates.ts`). Telegram has no
  second step: the task is added and the reply adds "Possible duplicate of: <title>" (only a
  card of the group's company or a shared one; a group never hears another company's card). A
  suggestion is added silently (its sender may not read the board). Whatever a person added past
  a near card stores `duplicateOf` and a fixed `forceReason` (`PERSON_DUPLICATE_REASONS`, one per
  way in). The standup import skips a near one as it skips an exact one, counted apart
  (`nearDuplicate` in its answer and `pnpm standup:push`'s line).
- **Logged**: every check is a `duplicateChecks` row `{tool, sim, threshold, decision}` (`clear`,
  `refused`, `forced`): numbers and closed words, never a title or an id. A refused check's row is
  written by the endpoint after the refusing transaction rolled back. Kept 30 days (the daily
  sweep).
- **For other builders**: `findDuplicates(ctx, {company, title, links?, kinds?, dealName?, now, exclude?})`
  returns `{matches, best, threshold}` and writes nothing (a query may call it);
  `checkDuplicates(ctx, {tool, …, force?, forceReason?})` is the mutation side that refuses, marks
  and logs.

## Waking an external bot

A bot that lives outside Startup OS can be woken when something is given to it,
instead of polling on a schedule. After the mutation commits, Startup OS
schedules one POST (`botEvents.deliver`). If `BOT_EVENTS_WEBHOOK_URL` is
unset, nothing is scheduled and the mutation does not fail.

The body is one JSON object:

| Field | When |
|---|---|
| `deliveryId` | One id a delivery, the same on every retry of it |
| `event` | `task.assigned`, `handoff.assigned` or `proposal.decided` |
| `company` | `us` or `kz` |
| `agent` | The profile id of the bot the task or handoff was given to (`chief_of_staff` for `bot:chief_of_staff`). For `proposal.decided`, the bot that filed it |
| `id` | The task, handoff or proposal id |
| `title` | One short line, at most 140 characters |
| `at` | When it happened, milliseconds since 1970 UTC |
| `decision` | Only on `proposal.decided`: `approved`, `dismissed` or `auto_approved` |

`task.assigned` is a task created with a bot assignee, or reassigned to one.
`handoff.assigned` is a handoff created for a bot, or reassigned to a different
bot. `proposal.decided` is an approval or a dismissal of a **bot's** proposal,
from the approvals page or from `proposal_decide`, including an automatic
approval; a proposal of one of the four (the Mac agents) is never sent.

Nothing else is sent. A note, a handoff summary, a proposal's reason and a
dismissal reason stay in Startup OS. A shared task has no company, so it is not
sent. A handoff to a person, to a Mac agent (`mac:`), or to a bare one of the
four (a row from before profiles were spelled `bot:<id>`) is not sent.

**Who is woken.** Only a profile of the owner's (`bots`, by the owner's user
and the bot's id) that is switched on, reads or writes the board, and works for
the event's company (none set, or "both", is either). Checked when the event is
scheduled and again just before it is sent: a bot switched off, taken off the
board or moved to the other company in between is not woken. At most 60 events
a bot an hour; past that they are counted on the bot's `botEventStatus` row and
not sent (the bot finds them with `my_inbox`, `tasks` and `proposals_feedback`).

**Who may give a task to a bot.** Only the owner, by hand on the board (or
through one of his own clients, a call that names no bot), and an approved
proposal (carried out as the owner). A bot never may: `task_create` and
`task_update` from a bot with a bot assignee are refused, and so is a bot's
`propose` of a `task_create` or `task_change` naming one; a teammate is refused
on the board. Every such refusal is the same sentence an unknown id gets, so it
never says whether a bot of that id exists. An assignee is a bot's id
(`growth`), or `bot:<id>` for an external profile (`bot:engineering`), as
handoffs spell it; a bare `chief_of_staff`, `engineering`, `sales` or `finance`
is never a bot assignee. On the board the owner sees the bot's name and anyone
else sees "a bot". A person who loses a task to a bot is told in the app, as
for any reassignment.

**One receiver for every bot.** The owner sets one URL. The receiver must route
each request on `agent` and must never hand one bot's events to another bot.
Startup OS sends a bot only what its profile covers (above).

**Signed requests.** Each request carries:

- `X-Startup-Timestamp`: seconds since 1970 UTC, as a decimal string.
- `X-Startup-Signature`: the hex HMAC-SHA256 of `` `${timestamp}.${body}` ``
  (the timestamp, a dot, then the raw request body exactly as received),
  keyed with `BOT_EVENTS_WEBHOOK_SECRET`.
- `X-Startup-Signature-Previous`: the same, keyed with
  `BOT_EVENTS_WEBHOOK_SECRET_PREVIOUS`, only while that is set (rotation).

The receiver must: compute the HMAC over the raw body and compare it with a
constant-time comparison against either signature header it holds a key for;
reject a request whose timestamp is more than 5 minutes from its own clock;
and keep the `deliveryId`s it has acted on for at least that long, dropping a
repeat (a retry after a lost answer arrives with the same id). There is no
other auth header. With no secret, or one under 32 characters, nothing is sent
(`openssl rand -hex 32` makes one). To rotate: set the previous variable to
the old key and the secret to a new one, give the receiver the new key, then
unset the previous one.

**The URL** is https to a public host. A literal private, loopback, link-local
or metadata address (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8,
100.64/10, `::1`, `fc00::/7`, `fe80::/10`, an IPv4-mapped one of those),
`localhost` and `metadata.google.internal` are refused; http (or https) to
this machine's loopback is accepted only on a local development deployment
(`refusalHere`, convex/lib/devLocal.ts). A name is not resolved here: keep the
receiver on a public name. A URL with a user name or password is refused. A
redirect is not followed.

**Failures.** A non-2xx answer or a network error is tried again after 1s, 5s
and 30s with the same `deliveryId`, then given up. A bad URL or secret, or the
last failed try, is written to the bot's `botEventStatus` row as `lastFailure`
in fixed words (`unusable`, `network` or `http N`) with its time; a delivery
that goes through sets `lastSentAt` and clears it. Nothing is logged. No
secret, URL, title or body is kept. The original save never fails because a
delivery failed.

Set them on the production deployment, then `npx convex deploy -y`.

## What is kept of a call

One row: the tool's name, whether it reads or changes, when, how it ended (`ok`, `refused`,
`invalid`, `error`) and how long it took, and for a matched bot the cost it reported (`costUsd`, a
number). **Never an argument, a title, a name or any text**: a
call of a tool that does not exist is written as "unknown", not as what was sent. A matched bot's
call also counts in its day (`botCallDays`, above). The
Assistant page lists the latest 50. The newest 500 are kept, for 30 days.

## Trying it by hand

With a token made on `/assistant` of a **local** deployment (`pnpm dev:local`, then
`pnpm dev:signin owner`), in `$AGENT_TOKEN`. The token goes into a header file only you can
read and curl reads the file: a token written after `-H` on a command line is shown to every
process listing on the machine and kept in the shell's history.

```bash
dir=$(mktemp -d) && chmod 700 "$dir"
( umask 077; printf 'Authorization: Bearer %s\n' "$AGENT_TOKEN" > "$dir/header" )
call() { curl -sS -X POST http://localhost:3100/mcp/v1 \
  -H @"$dir/header" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d "$1"; echo; }

call '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
call '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"overview","arguments":{}}}'
call '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"task_create","arguments":{"title":"Made-up task from curl"}}}'
rm -rf "$dir"
```

Expected: the server's name and version; the tool list; the attention list; and, with a token
that may act, `{"id":"…","created":true,"truncated":false}`, the card in Backlog on `/board`
wearing a "Claude" tag, and four rows under Recent calls on `/assistant`. With a read-only
token the last call answers `isError: true` and "This client is read only. …".

## Notes, comments, archive, reassign and the sweep

`notes` and `note_write` (`memory`) keep a note that is not a meeting's, on /memory's Notes
tab. `comments` and `comment_create` comment on a task, a deal or a handoff: write on the
board covers a task or a handoff, write on sales covers a deal. `task_archive` (`board`) takes
a task off the board without deleting it. `handoff_reassign` (`board`) hands an open handoff
to another bot or a person.

A bot that may write the area calls the tool. A bot that may only propose uses `propose` with
kind `memory_note`, `comment`, `task_archive` or `handoff_reassign`, and the owner approves it
on /approvals. None of those four kinds is ever done under autonomy.

`proposal_sweep` is not a proposal. It withdraws older open proposals that share a dedupeKey
(duplicate) or the same company, kind and subject (superseded), logs each with that reason and
no title, and keeps the newest. A bot sweeps only what it filed. The chief of staff sweeps
every proposer's. The owner's unnamed client is refused until it names an agent.

## Adding a tool

In `convex/lib/mcpTools.ts`: write `read({...})` or `act({...})` and put it in `TOOLS`.

- Its input is a `z.strictObject`; a read takes the optional `company`.
- Its handler takes the owner's `Member` and calls a function the app already calls (or one
  extracted from the app's own handler in the same change). It never reads a table itself.
- It declares its caps, and its description is written for a model: what comes back, when to
  use it, its limits.
- A tool that changes something says who did it with `agentOf(member)` wherever the app
  records an actor, and its text goes through the app's own cleaners.
- Add its name to the pinned list in `convex/mcpTools.test.ts`, a test that its answer is the
  app's for the same data, and, if it imports a module the registry did not import before, the
  module and the reason to `convex/mcpToolsImports.test.ts`.

The agents' tools below were added this way, each with a table of its own, written through a
function of its own module.

## The agents: the brief, approvals and Ask

Four agents (chief of staff, engineering manager, sales and pipeline, finance and compliance),
each managed on `/agents` (project Startup OS) since 2026-10-17: their instructions (by default
the procedures in `docs/agents/`), tools and schedule are published there, and each runs where
the owner chose, by default at 11:20 in Almaty. **On the Mac** (the default) the chat's runner
runs it with Claude Code through this endpoint (`docs/setup.md`, "Startup OS agents"),
and every call is held to that agent's published tools. **On Gemini** Startup OS's runtime runs it
and each write waits for the owner's approval on `/approvals` (the agent's Runs tab links there;
`docs/agents-protocol.md`, "Agents that run in Startup OS"). What follows appears only after a run.

### What they call

| Tool | Kind | What it does | At most |
|---|---|---|---|
| `brief_latest` | read | Each company's latest brief, so a run sees what was already said | 20 rows, 20 KB |
| `proposals_open` | read | What waits for the owner, with ids and payloads | 100 rows, 150 KB |
| `proposals_feedback` | read | The last 30 the owner decided: kind, key, `decision` (approved, rejected, expired, auto_approved, withdrawn), `rejectCode` and `rejectReason`, `edits` (fields changed before approval), `decisionMs`, `urgency`, `goal`, `createdId` (the id of the task, deal, decision or goal approving made; null for another kind), and for a rejection `rejection` (kind, code, reason); `rejectedKinds` counts rejections by kind; a withdrawn row carries `withdrawReason`, `withdrawNote` and `replacedBy` (null on any other) and `withdrawnKinds` counts them. A decision made in chat through `proposal_decide` also has `decidedBy` (`owner`), `via` (`chief_of_staff`) and, on an approval, `decisionReason`; a click in the app leaves the three null. No payload. **Any bot may call it and is given its own rows only**; the four and the owner's own Claude read every proposer's | 30 rows, 40 KB |
| `brief_write` | act | Writes one company's brief for a day, replacing the one it had | 8 bullets of 240 characters |
| `propose` | act | Puts one proposal in front of the owner, with `why` (required), and optionally `urgency`, `goalId` and `source`. Nothing happens until he approves it | 20 open an agent, 40 a day |
| `goal_create` | act | Proposes a goal for a quarter (`quarter` "2026-Q4", `title`, `status`?, `ownerEmail`?, `ownerBot`?, `target`?, `dueOn`?): a `goal_create` proposal. Writes no goal | as `propose` |
| `proposal_withdraw` | act | Takes back proposals you filed that are still open (below, "Withdrawing a proposal"): `id` or `ids` (up to 50), `reason`, `note`?, `replacedBy`? | one act a call |
| `proposal_decide` | act | The chief of staff approves or dismisses for the owner (below, "Deciding a proposal"): `ids` (up to 50), `decision` (`approve` or `dismiss`), `reason`?, `editedPayload`? (one approval). Anyone else is refused `not_chief_of_staff` | one act a call |
| `goal_update` | act | Proposes renaming (`title`), re-rating (`status`) or changing the owner, bot, target or due day of a goal (`goalId` from `goals`; null clears one of the last four): a `goal_update` proposal. Writes no goal | as `propose` |

**Goals are proposed, never written** (decided 2026-10-18). A quarter's goals are the owner's
plan, and the goals module has no direct write by an agent to follow: `goals.create` and
`goals.update` are a person's, on the `review` area. So the two goal tools only store a
proposal, through the function `propose` runs (the same repeats and limits; a `dedupeKey`
is made from the quarter and title, or the goal, when none is given), and approving it runs
`createGoal` / `updateGoal` (`convex/goals.ts`), the functions the page's own mutations run,
with their validation. **A goal may carry an owner, a bot, a target and a due day** (spec §5,
2026-10-19): `ownerEmail` (a person in `people`, on the goal's company; anyone the caller
knows for a goal of both), `ownerBot` (a bot profile's id that exists), `target` (free text,
one cleaned line of at most 120 characters: "v2 live at 3 pilot clinics"; not the scorecard's targets, which
stay the owner's) and `dueOn` ("YYYY-MM-DD"). Both tools and both `propose` kinds take them;
they are checked when proposed and again on approval by the one function the Goals page runs
(`checkGoalDetails`), refused in `GOAL_WORDS`, and shown on the card as fields (Owner, Bot,
Target, Due; before → after for an update). The `goals` read returns `owner` ({email, name},
only to a reader who shares a company with them), `ownerBot`, `target` and `dueOn`. There is
still no metric field. `propose` takes the two kinds too.

**A bot may propose a goal.** The two tools take `agent` (one of the four) or `bot` (an
owner-managed bot profile's id); the endpoint admits the bot against its profile first (write
on `review` needed; each goal proposal counts against its proposals a day) and hands the tool
the matched id (`ToolClock.bot`), the only bot the tool reads. A bot's proposal is stored with `bot`, filed under the chief of staff (only its
switch: with the chief of staff off, no bot proposes either), and shown in the inbox, its filter
and `proposals_feedback` as the bot's. **A bot's proposals are counted in a bucket of their
own**, never the chief of staff's: 20 open a bot (`MAX_OPEN_PER_BOT`) and its profile's
proposals a day, across all its clients; the four's 20 open and 40 a day count none of a bot's.
A `dedupeKey` is a repeat only for the proposer that used it (that bot, or that one of the
four), so a bot cannot block an internal agent by proposing its key first.
The two tools are on the `review` area (the Goals page's editing area), so a bot given write
there may call them; `propose` stays `personal`. Both tools are among an agent on the Mac's act tools
(`MAC_ACT_TOOLS`), since they change nothing at once; the chief of staff has them by default.

Each of the three that write takes `agent` (`chief_of_staff`, `engineering`, `sales` or
`finance`) and is refused for one the owner switched off. `task_create` takes it too,
optionally, and the card then says which agent made it. **A call that names an agent** (that
argument, or the runner's `X-Startup-Agent` header) **may use only that agent's published
tools**: anything else is refused in fixed words. The audit row of a call carries the agent's
name and the Mac's run it was made in, and, as before, nothing of what was written.

### What every proposal carries (Approvals v2, 2026-10-19)

The owner's spec (`~/Downloads/startup-os-approvals-v2-spec.md`): he clears the queue in under
ten minutes a day. So every proposal, from `propose`, `goal_create` or `goal_update`, carries:

| Field | Who sets it | Rule |
|---|---|---|
| `why` | the proposer | One sentence. **Required**: a proposal without one is refused (`PROPOSAL_WORDS.why`) and nothing is stored. The old argument name `reason` is still read; the row keeps it as `reason` |
| `effect` | **the server**, never the proposer | Worked out at read time from the payload and the live rows (`effectOf` in `convex/lib/proposals.ts`): before → after for a change (a task, a deal's next step, a goal), every field it would set for something new (a task, a goal, a decision), and a draft's full title and body. No tool takes an `effect`: a strict input refuses one, at the top or in the payload |
| `urgency` | the proposer | `critical`, `high`, `normal` (the default, and every row from before) or `low` |
| `goalId` | the proposer | Optional: the goal it serves, one of that company's or both companies' (else `PROPOSAL_WORDS.goalLink`). `goal_update` serves the goal it changes. The card says "No goal" in grey without one |
| `source` | the proposer | Optional evidence `{kind, id}`: a deal of that market, a meeting's notes (`meeting` or `note`), a task of that board or shared, a decision of that company, or a metric key the registry declares; else `PROPOSAL_WORDS.sourceGone`. The card links to its page (`/sales`, `/memory`, `/board`, `/`), built from the kind, never from text |

**A rejection needs a reason** (`assistant.dismiss`): a quick one (`code`: `wrong_timing`,
`wrong_data`, `not_a_priority`, `rewrite_tone`, `duplicate`), typed words (`reason`, 200 characters), or
both; neither is refused (`PROPOSAL_WORDS.rejectReason`). Stored as `rejectCode` and
`rejectReason` (rows from before keep `dismissReason`, read as the reason).

**The one approve path** is `approveProposal(ctx, member, id, { now, edit?, decision? })` in
`convex/lib/proposals.ts`: the owner's click (`assistant.approve`), `decideMany` and the
earned-autonomy work all call it. It checks the payload live, carries it out as the owner and
stores `edits` (each field the owner changed: as proposed, as approved) with
`editedBeforeApprove`. `decision: "auto_approved"` (status `auto_approved`) is for a kind a
bot was granted; it runs exactly the same path.

**Expiry** reuses the daily sweep (`assistant.sweep`, the native cron "sweep agent work",
04:10 UTC): an open proposal older than 7 days is marked `expired`, `proposals_feedback` says
`decision: "expired"`, and its key is blocked for 30 days as a rejection's is
(`PROPOSAL_WORDS.repeatExpired`).

**The Bots tab** shows each proposer's week (`bots.weeklyStats({ since })`, the owner's; the
page passes a week before its clock, to the hour): decided, approval rate (approved of
approved and rejected: an expiry is nobody's decision, a withdrawal the proposer's own), expiries,
what the proposer withdrew itself (`withdrawn`, not counted as decided), the median time to the
owner's decision, and the three commonest rejection reasons by code (`typed` for words alone;
never the words themselves).

### Withdrawing a proposal (spec §14, 2026-10-19)

A proposer takes back its own open proposal instead of leaving a duplicate, a superseded, a stale
or a wrong one for the owner to dismiss: `proposal_withdraw` (`convex/lib/mcpTools.ts`, written
through `withdrawProposals` / `withdrawOne` in `convex/lib/proposals.ts`).

- **Input**: `id` or `ids` (at most `MAX_WITHDRAW_IDS`, 50; exactly one of the two, else
  `WITHDRAW_WORDS.oneOf`), `reason` (`WITHDRAW_REASONS`: duplicate, superseded, stale, wrong,
  other), `note`? (one cleaned line, 300 characters; an email address or a phone number is refused
  `contact_detail`) and `replacedBy`? (a proposal of the caller's own, of the same company; another's
  or none is `not_owner`, another company's or the withdrawn one itself `bad_context`). `agent` names
  one of the four; a bot's name is taken off the call by the endpoint as for every tool.
- **Who**: a bot only rows it filed (`row.bot` is the profile the endpoint matched: the external
  chief of staff's rows are `bot: "chief_of_staff"`, never the Mac agent's, and the other way round);
  one of the four only rows with its `agent` and no `bot` (a bot's rows filed under the chief of
  staff are not the chief of staff's); the owner's own client, naming neither, any (a bots-only
  client refuses a call naming no bot before the tool runs). `filedBy` in `convex/lib/agents.ts`.
  Anything else, and an id that is no proposal, is `not_owner` in the same words, so nothing can be
  probed; one no longer open is `not_open`. A bot needs write on some area, as for `propose`
  (`botMayCall`); the call counts as one act whatever the number of ids.
- **Answer**: with `id`, `{id, withdrawn: true}` or a tool error with its code in
  `structuredContent`; with `ids`, `{withdrawn, results: [{id, ok, code?}]}`, each item on its own.
- **Effect**: status `withdrawn` (`PROPOSAL_STATUSES`; not `dismissed`, not `expired`) with
  `withdrawReason`, `withdrawNote`, `replacedBy`, `withdrawnAt`, `decidedAt` and `withdrawnBy`
  (`bot:<id>`, one of the four, or `owner`). It is no longer open, so it leaves `/approvals`, its
  count and Today's Needs you at once (one reactive query), and the expiry sweep and the 09:00 digest,
  which read open rows only, never see it. The audit row is the call's own; a dismissal writes no
  activity of its own, so neither does this, and the owner is not notified.
- **The key**: released at once; a reason of `wrong` holds it for `WRONG_WITHDRAW_BLOCKS_DAYS` (7),
  refused `PROPOSAL_WORDS.repeatWithdrawnWrong` (code `repeat`).
- **Not the owner's decision**: no trust is noted (`noteDecision` is not called: no streak is added
  to or started again), `proposerStats` counts it as `withdrawn` apart from `decided`, outside every
  approval rate (the Bots tab's week line says "N withdrawn by the proposer"; the registry's
  `approvalRate` follows). `proposals_feedback` (`decision: "withdrawn"`) and `my_inbox`'s `decided`
  return it with its reason, note and replacement, so a bot can count its own clean-up. The owner's
  decided list on `/assistant` shows "Withdrawn" and the proposer's reason and note (`withdrawnLine`).
- **`withdrawHint`**: a `possible_duplicate` on a proposal (`propose`, a `deal_create` with it,
  `goal_*`) also carries the ids of the matched open proposals the caller itself filed (only its
  own: never another proposer's, which a bot is never shown), left out when there are none, so the
  bot can withdraw the older one (`superseded`) and propose again.

### Deciding a proposal (`proposal_decide`, 2026-10-21)

The owner approves or dismisses in chat with the chief of staff, and it takes effect as the
Approve and Dismiss buttons on `/approvals`. `proposal_decide` (`convex/lib/mcpTools.ts`) calls
`approveProposal` and `dismiss` (`convex/lib/proposals.ts`), the functions `assistant.approve`
and `assistant.dismiss` run. There is no second writer.

- **Input**: `ids` (1 to `MAX_DECIDE_IDS`, 50), `decision` (`approve` or `dismiss`), `reason`?
  (one cleaned line, 200 characters; a dismissal needs one, the same sentence as the button)
  and `editedPayload`? (the whole payload of that proposal's kind, on an approval of a single
  id). An edit on a dismissal, or on more than one id, refuses the call before anything changes
  (`DECIDE_WORDS`).
- **Who**: the caller Startup OS authenticated. A matched bot profile (`ToolClock.bot`) must be
  `chief_of_staff`; otherwise one of the four (`ToolClock.agent`) must be `chief_of_staff`.
  The `agent` argument is ignored. Any other caller is a tool error `not_chief_of_staff`
  (`DECIDE_WORDS.notChief`) and nothing is read. The tool is not on the Mac agents' lists and
  not among `MAC_ACT_TOOLS`: the morning run on the Mac cannot carry a proposal out with nobody
  in the conversation. The external chief of staff profile can. The answering Claude on
  `/assistant` is denied the tool and only proposes.
- **Effect**: approve runs the button's path, so a task, deal, decision or goal is created.
  A task records the proposing bot, the same as the button.
  A `draft` is text for the owner to send himself: approving it returns `{kept: true}` and
  sends nothing. Dismiss runs the button's path. A proposal that is already decided returns
  its current state (`already: true`) and is not written again, so a second approve creates
  nothing. A batch answers each id (`{decided, results}`); one that no longer exists is
  `PROPOSAL_WORDS.gone` and the rest go on.
- **The log**: the row gains `decidedBy: "owner"` and `decidedVia: "chief_of_staff"`. An
  approval's words are `decisionReason`; a dismissal's stay `rejectReason`. `proposals_feedback`
  returns them as `decidedBy`, `via` and `decisionReason` (null when the owner clicked in the
  app). Edits are the same `edits` the button stores.

### A new deal (`deal_create`, Bot Loop v3, 2026-10-19)

`propose` with `kind: "deal_create"` and the payload `{name (120), stage? (lead, qualified, demo,
proposal; lead by default), contact? (a name and role only, 120), amount?, nextStep? (300),
sources? (12 titles); US only: region? (40), physicians?, locations?, priority? (high, medium,
low), intel? {summary (300), fit (0 to 100), ehr, billingModel (in-house, outsourced, hybrid),
ownership, angle, nextBestAction, signals (3 at most: date, kind, text)}}`, the deal's company the
proposal's own `company`. Both companies: a Kazakhstan deal is made here and not mirrored, so the
Kazakhstan CRM never hears of it (owner's decision of 2026-10-19). Refused when proposed:

- an email address or a phone number anywhere in it (`NO_CONTACT_DETAILS`);
- US-only fields on a Kazakhstan deal (`DEAL_CREATE_WORDS.usOnly`);
- **a possible duplicate**, by the shared near-duplicate check (above, "Near-duplicates"), logged
  as `deal_create`'s: a deal of that market already has the name (archived and mirrored deals
  included), a new deal of that name is proposed and open, or anything open is near it as for any
  proposal. Names are compared by `dealNameKey`: capitals, spaces, punctuation, "&" and a trailing
  legal form (LLC, Inc, PC, ТОО…) do not count. A bot gets `possible_duplicate` with `matches:
  [{type: "deal" | "proposal" | …, id, title, sim}]` and should update that deal instead; for a
  different practice of the same name it calls again with `force` and `forceReason`, and the
  proposal stores `duplicateOf` and `forceReason` like any other.

At the click the name is asked again (`refuseDuplicateDeal`): a deal of that name made since it
was proposed is refused (`DEAL_CREATE_WORDS.duplicateDeal`), so two approvals never make one deal
twice; a deal it was forced past (in its `duplicateOf`) does not stop it.

It is never autonomy-eligible (`NEVER_AUTONOMOUS`) and its area is `sales` (`KIND_AREA`). The
inbox labels it "New deal" under the type "Deal stage".

### What the owner sees on `/assistant`

- **Brief**: the company in view's latest, a sentence a bullet with the agent it is from and
  a link to the page it is about, and "Written by Claude at 11:20 from the OS's figures." One
  older than 36 hours is not shown ("No brief today yet. The next run is at about 11:20.").
  Today's is on the owner's Today after "Needs you" (compact, folded with a press, with "Open in Assistant"), and on
  nobody else's; the Assistant holds the **Brief archive**: today and the seven days before.
- **What waits**: one line, "N waiting → Approvals". Since 2026-10-20 nothing is decided on
  this page: `/approvals` is the one place (below), and its item in the navigation carries the
  one count. A proposal the chat makes is shown under its answer as the `/approvals` row (who,
  urgency, goal, a possible duplicate, what changes) with the same Edit then approve, Approve
  (Keep for a draft) and Reject; once decided, as a row of its "Decided" tab.
- **Ask**: a field, and the questions with their answers. It is answered at the next run; for
  a live answer, ask Claude directly with the connector.
- **This week**: briefs written, proposals made and tasks agents made (`assistant.measure`, since
  Monday). What the owner approved and rejected is each proposer's week on Agents › Bots
  (`bots.weeklyStats`, the last seven days), so it is not counted twice. ARR per person in the OS (Startup only) moved to Finance, for the owner,
  beside published figures that are marked as not verified at their source.
- **Agents**: a switch for each.

### What approving does

| Kind | Approving it |
|---|---|
| `task_create` | Adds the task to that company's board, as the owner, marked as that agent's. Whoever it is given to is told in the app and in the company's Telegram group, exactly as when the owner adds it by hand |
| `task_change` | Changes the task's assignee, due date or column (`null` clears the first two). With only a column it is a move; otherwise one save, so whoever it concerns is told once |
| `deal_next_step` | Sets the deal's next step. A mirrored deal takes it too, as on the board |
| `draft` | Marks it kept. **Nothing is sent, made or changed**: it is text to copy |
| `decision_record` | Records the decision on `/memory` with status `decided`, decided today, through the function the page's own save runs (the owner must be someone a task of that company can be given to; the meeting must be that company's), marked as that agent's. The meeting it names cannot be edited |
| `goal_create` | Adds the goal to that company's quarter, last, on track unless the proposal rated it, through `createGoal` (what `goals.create` runs). The title may be edited first; the quarter cannot |
| `goal_update` | Renames or re-rates the goal through `updateGoal` (what `goals.update` runs). A goal of both companies may be changed from either; one company's only from its own; the goal it names cannot be edited |
| `bot_permission` | Gives the bot that asked that level on that area, through `setBotLevel` (what the Bots tab's Grant runs). Refused if the bot is gone or switched off, already holds the level, or the area is locked. Nothing of it can be edited |
| `deal_create` | Adds the deal to the proposal's company's sales board through `createDeal` (what the Sales page's `deals.create` runs) at its stage (lead unless given), with `createdBy` the proposer and its intel through the intel editor's own write. **A Kazakhstan deal is made here** (`mirrored: false`) and never synced back to the Kazakhstan CRM. The name and next step may be edited first (on the card and with Edit then approve); the rest stays as proposed. Refused at the click too if a deal of that name is now on the board. `proposals_feedback` returns the new deal's id as `createdId` |

The payload is checked against the live data when it is proposed and again at the click: a
task that is gone or now on the other company's board, a person who can no longer be given
it, a deal no longer on the board, a goal that is gone or the other company's. One that no
longer applies is refused with a sentence and stays open. The one automatic approval is a
grant the owner gave (below, "Earned autonomy"), and it runs this same path.

### The approvals inbox (`/approvals`)

**The one place proposals and tool calls are decided** (2026-10-20). One screen, under
Operate after Today, the owner's alone (`personal`), with two tabs (`?tab=decided`).

**Waiting**: everything that waits for his click: every open proposal of every agent and bot
(drafts included), and every tool call a Startup OS run on Gemini paused on (`agentApprovals`,
Startup OS's own project only, which belong to no company and are always listed), both companies
(the Company filter narrows it). **The order**
(`sortInbox`): critical first, then what serves a goal at risk or off track, then oldest
first. **"Cash and runway"** is pinned above the rest: the server's `cash` flag
(`convex/lib/cashGroup.ts`, `cashReader`, which the 09:00 digest counts with too): a goal tagged cash (`goals.cash`, one press on `/goals` for whoever
holds `review`), a goal whose title is about cash, runway, a raise, collections or invoices, a
proposal of the finance agent or of a bot that writes fundraising or finance, a draft to an
investor, or a finance metric as its evidence. **Filters**, all in the
address: company, agent or bot, goal (or "No goal"), type, which groups the kinds: task,
deal stage, goal, outbound message (a draft), data edit (the rest, tool calls included), and
urgency; `?kind=` is still read. A proposal made with `force` past the near-duplicate check
shows "Possible duplicate of …" and the proposer's reason; below `md` the kind is a tag on the
card. Each card shows without a click: who proposed it, what approving does,
the urgency (a chip unless normal), its age (amber after 24 hours, red after 72, by the page's
clock), **Why**, the server's **effect**, the **goal** or a grey "No goal", and a **source**
link. **One count of what waits**: `assistant.inbox` with no company, read by the page, its
navigation count (`useWaitingCount`), Today's "Needs you", the Bots tab's "Waiting on
Approvals" and the Assistant's line, so they agree; the 09:00 digest counts the same rows
(`convex/lib/toolCallApprovals.ts` for the tool calls). Each row of Needs you links to its row
here (`/approvals?id=…`, which puts the cursor on it and brings it into view).

**Edit then approve** is on every row of a kind with something to change: a new task (title,
notes, assignee, due date, column), a change to a task (only what it set out to change, the
assignee included), a deal's next step, a new deal (name and next step), a draft (title and
text), a decision (title, decision, context, owner, revisit date), a goal (its title). It sends
the whole payload of the same kind through `assistant.approve`, which checks it as it checks a
proposal; the task, deal, goal or meeting it names, what a draft is about and a deal's other
fields stay as proposed. A bot's permission is approved or rejected as asked.

Select many (a box a row, or every row shown) and **Approve selected** or **Reject
selected**. **Approving many never approves a row that needs a click of its own**
(`oneClickOnly`): a possible duplicate (a forced near-duplicate's badge) or a kind never done
without the owner (`NEVER_AUTONOMOUS`: a new deal, a draft, an investor's included, a goal, a
bot's permission). It stays selected with why beside it ("Own click" on the row), and its own
**Approve** button approves it. A rejection needs a reason, for a proposal and a tool call alike
(`agentRuntime.decide` refuses a denial without one): a quick-reason chip, words for all or, ticked, words
for each (200 characters); Reject stays off until every item has one. **Nothing has a path of its own**: each item is decided in turn through the
existing call (`assistant.approve` / `assistant.dismiss`, or `agentRuntime.decide` for a tool
call), so a refusal leaves that item open with the server's words beside it and the rest go
on. A proposal's reason is its `rejectCode` and `rejectReason`, which `proposals_feedback`
returns (and as `rejection`); a tool call's words are the typed reason or the chip's label; a tool call's is kept on its row (`denyReason`) and is not sent to the model.
Keys: `j` / `k` move, `x` selects, `a` approves the selected (or the row under the cursor),
leaving a row that needs its own click as the bulk button does, `r` rejects them.

**Decided** (`assistant.decided`, from 30 days back by the page's clock, newest decision first):
approved (with what it made and what the owner changed first), dismissed (the quick reason and
the words), expired, approved automatically (each with **Flag and revoke**, and the grants in
force each revoked in one click), withdrawn by its proposer (the reason and note), and tool calls
approved or denied (the denial's words), with the same filters and one of its own, how it ended.

### Earned autonomy

Startup OS keeps, for each proposer (a bot by its profile's id, or one of the four) and each kind,
how far the owner trusts it (`botTrust`, `convex/lib/trust.ts`): approvals in a row with no edit
(the streak), totals of clean, edited, dismissed and automatic approvals, and when the streak
last started again. A dismissal or an edit starts it again. A proposal its proposer withdrew (`proposal_withdraw`) is no decision of the owner's: it neither adds to the streak nor starts it again.

- **Edit then approve.** Every inbox row of a kind with something to change has **Edit then
  approve** (above, "The approvals inbox"), sent as the whole payload through
  `assistant.approve`. The proposal is approved, and what changed is the proposal's own `edits` (each field, before → after) with
  `editedBeforeApprove` set, as for any approval with an edit (`approveProposal`); the trust row
  only points at that proposal (`lastEditedProposal`).
- **The offer.** After 10 clean approvals in a row of an eligible kind, `/approvals` shows "Let
  Growth do `deal_next_step` without approval?" with **Yes** (`trust.grant`) and **Not yet**
  (`trust.notYet`: asked again after 10 more). A grant before it is earned is refused.
- **A grant** (`autonomyGrants`, the owner's alone): a proposal of that proposer and kind is
  approved the moment it is made, through `approveProposal` itself with `decision:
  "auto_approved"` (checked against the live data,
  carried out as the owner by the app's own function), with status `auto_approved`. It is not in
  the inbox; it is on `/approvals`' **Decided** tab as approved automatically (`assistant.decided`), and its key is a
  repeat like an approved one's. Grants are listed on the bot's card on Agents › Bots (the four's
  over the Decided tab), each revoked in one click (`trust.revoke`).
- **Only a credential bound to the bot.** A bot's grant holds only for a proposal made through a
  token or sign-in made for that bot (`onlyBot`, "Make a token for this bot") or at that bot's own
  connector address (`boundToBot`, `grantCovers`). Bots sharing a client can claim each other's
  names, so a bot named on a shared client is never auto-approved: its proposal stays open for the
  owner, attributed to the bot as usual. Nor while the bot lacks write on the kind's area
  (`KIND_AREA`) now: a bot demoted below write keeps its grant but it is paused, shown on its card
  as "paused: needs write on Board" (`grantPausedOn`, `trust.grants`' `paused`), and `whoami`
  leaves the kind out of `autoApproved` until write is back.
- **Flag.** Flagging an item approved automatically on the Decided tab (`trust.flag`, with an optional reason and quick reason
  `code`) revokes that grant and starts the streak again; the reason reaches the proposer through
  `proposals_feedback` (`rejectReason` / `rejectCode` on a row whose `decision` is
  `auto_approved`). What was done is not undone.
- **Never eligible, on the server.** Only `task_create`, `task_change`, `deal_next_step` and
  `decision_record` (`AUTONOMY_ELIGIBLE`), and only while the kind's area (`KIND_AREA`) is no locked
  area. Drafts and outbound messages, goals, new deals (`deal_create`), deal stage changes, money,
  legal and compliance items and bot permissions are not on the list, and a kind added later is not either until it is put
  there. Eligibility is checked again when a proposal arrives, so a grant row written any other way
  does nothing.

### The daily digest

At 09:00 Almaty (04:00 UTC) a cron checks for open proposals and paused tool calls (Startup OS's own runs, as `/approvals` lists them, so its total is the inbox's count). If there are any (or a handoff to a person has been open over 24 hours with nothing done), the owner gets a notification in the app and a message in their own Telegram chat (not the company group): the total, the counts by urgency (critical, high, normal, low; a proposal without an urgency is normal, and a paused tool call counts as normal), how many open proposals are pinned in "Cash and runway" (the page's own rule and reader, `cashReader` in `convex/lib/cashGroup.ts`, so the count is the group `/approvals` pins: a cash goal, or a goal or proposer about fundraising, finance or collections), how many handoffs to people are open over 24 hours, the three oldest items by kind, bot or agent name and age, and a link to `https://os.example.com/approvals`. The two new counts are lines only when not zero. It never carries a title, reason, name or tool argument. The owner's chat is their Telegram user id, saved when the bot first sees their username in a picked group; if it is not linked, or the bot is off, nothing goes to Telegram and the notification says so. It goes once a day, and not at all when nothing waits.

### When a proposal is refused

| Refused | When |
|---|---|
| "A proposal needs `why`…" | No `why` (or `reason`), or one of only spaces |
| "That goal is not one of this company's goals…" / "That source does not exist…" | A `goalId` or `source` that is not this company's, or not there |
| "This is a repeat…" | The same `dedupeKey` is open, was rejected or expired in the last 30 days, approved in the last 14, or withdrawn by its proposer as `wrong` in the last 7 (any other withdrawal frees it at once) |
| "That agent already has 20 proposals open…" | 20 open for that agent |
| "This bot already has 20 proposals open…" / "This bot may make N proposals a day…" | A bot's own bucket (its 20 open, its profile's proposals a day) |
| "At most 40 proposals a day…" | 40 made that UTC day, by all agents together |
| "That agent is switched off…" | The owner switched it off |
| The payload, by field | A field of another kind, a missing one, text over its limit |
| A sentence about the target | The task or deal is gone or the other company's; the person cannot be given a task of that company; what a draft is about is gone |

A key is `agent:kind:subject-id`, lower case. An open proposal nobody decides is marked
expired after 7 days, and an expired one blocks its key as a rejection does (30 days).

### What a model writes is data

A bullet, a reason, a draft and an answer are cleaned of invisible and control characters,
refused when over their limit, stored as plain text and shown as text: markup in one appears
as the characters it is. A bullet's link is one of nine of the app's own pages, never an
address the bullet gives. The tools' descriptions tell the model to write "not read yet" for
a missing figure and to state nothing a tool did not return in that run; the server cannot
check a sentence against a figure, so that part is the prompt's to keep.

### Trying it by hand

With the `call` function from "Trying it by hand" above and a token that may act:

```bash
call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"brief_write","arguments":{"agent":"chief_of_staff","company":"us","bullets":[{"agent":"engineering","text":"Made-up: two pull requests waited.","page":"/engineering"}]}}}'
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose","arguments":{"agent":"sales","company":"us","kind":"draft","reason":"Made-up reason.","dedupeKey":"sales:draft:made-up-1","payload":{"title":"Made-up follow-up","body":"Hello,\n\nA made-up line."}}}}'
```

The brief and the proposal then show on `/assistant`, and sending the second call again
answers "This is a repeat: a proposal with that dedupeKey is already open."

## The chat

The **Ask** section of `/assistant` is a chat: the owner asks, and the answer arrives on the
page as it is written. **It is answered by Claude Code on the owner's Mac, on the Claude
subscription that Mac is signed in to. There is no model key on the server and the server
calls no model** (the owner's decision of 2026-10-13: "reuse this Claude, not an API key").
It is the one place to ask: the owner's Today has an "Ask Claude" link here, and no other
page has a field.

### What runs where

1. **The OS** stores the question with a queued answer beside it (`convex/chat.ts`,
   `convex/lib/chat.ts`). Nothing else happens on the server.
2. **The runner** (`pnpm assistant:runner`, on the Mac) checks in with the OS every few
   seconds through `POST /mcp/v1`. For a waiting question it starts Claude Code headless, with
   the OS's server and no other, the chat's instructions (`docs/agents/chat.md`), what was
   said before and the question.
3. **Claude Code** reads the OS through the same endpoint with the read tools, writes the
   answer, and for a change the owner asked for calls `propose`. The runner sends the answer
   back as it grows.
4. **The page** shows it through Convex's live queries: the text, what Claude read as small
   chips, and any proposal under the answer as the `/approvals` row, with its actions.
   Nothing changes without the click.

**What passes through Claude**: the question, the last messages of the conversation, and
what the tools return to answer it. That can include task titles, deal and clinic names,
pull-request titles and metric values. **Never payroll, tokens, mail, calendar or meeting
notes**: the endpoint offers them to no token.

### Setting it up

Connect Claude first (above), **for your user rather than one project**, with a token that
may **read and act**: `claude mcp add --scope user --transport http startup-os …`, or the
`startup-os` entry under `mcpServers` in `~/.claude.json`. The runner reads the address and the
token from that entry and nowhere else, so there is one token in one place. It never prints
it. Then, in the repository on the Mac:

```bash
pnpm assistant:runner            # answers until you press Ctrl-C
pnpm assistant:runner:install    # writes the launchd agent, and prints the command to load it
```

`assistant:runner:install` writes `~/Library/LaunchAgents/ai.startup.os.assistant.plist`
(start at login, keep running, log to `~/Library/Logs/startup-os-assistant.log`) and prints two
`launchctl` commands, to load and to unload it. It runs neither. `pnpm assistant:runner:uninstall`
removes the file. After moving the repository or changing Node, run the install again: the
file holds absolute paths.

The runner prints a line when it starts and one line an answer: the time, how long it took,
how many tools were read and how it ended. Never a question, an answer or the token.

It refuses to start, in fixed words, when Claude Code has no `startup-os` entry, when the entry
points anywhere but `https://os.example.com/mcp/v1` (a localhost address is taken only with
`--local`), when the header is not a `sosa_` bearer token, or when Claude Code is not found
(`--claude <path>` names it). For a local backend or a test, `STARTUP_OS_MCP_URL` and
`STARTUP_OS_AGENT_TOKEN_FILE` (a file only you can read, mode 600) replace Claude's
configuration.

### How Claude Code is started

```
claude -p --output-format stream-json --verbose --include-partial-messages --max-turns 12
  --strict-mcp-config --mcp-config <temp file> --setting-sources "" --tools ""
  --allowedTools <the read tools and propose> --disallowedTools <everything else>
  --disable-slash-commands --no-session-persistence --no-chrome
```

- The prompt goes in on **stdin**, never on the command line.
- The temp file holds the one server and the token, is mode 600, and is deleted when the
  answer ends, whatever happened.
- It runs in an empty temporary directory, not the repository, with `PATH`, `HOME` and a few
  other variables and **no API key**: so no project file, `CLAUDE.md`, other MCP server, hook
  or setting of the Mac's is picked up, and it uses the Mac's own Claude sign-in.
- **Allowed**: every read tool and `propose`. **Denied by name**: every built-in tool (shell,
  files, web), `task_create`, `task_update`, `task_move`, `deal_update`, `investor_update`, `investor_create`, `customer_update`, `partner_upsert`, `partner_move`, `contact_upsert`, `contact_link`, `contact_merge`,
  `note_create`, `decision_create`, `handoff_create`, `handoff_update`, `questionnaire_upsert`, `answer_bank_upsert`,
  `vendor_agreement_upsert`, `evidence_upsert`, `linkedin_post_upsert`, `linkedin_stats_add`, `brief_write`, `goal_create`, `goal_update` and the runner's own six.
  `convex/chat.test.ts` fails if the two lists
  are not the whole registry.
- One answer has 12 turns and 120 seconds. One question at a time.

### The runner's tools

Six tools of the same endpoint, for the runner program and no model: the chat's three, and
three for Startup OS's own four agents that run on the Mac. They are not in `tools/list`, are named
in no prompt, and need a token that may act.

| Tool | What it does |
|---|---|
| `chat_next` | The check-in: records that the Mac is there, and hands over the oldest waiting question with the conversation's last 20 messages (8 KB at most), or `{ none: true }`. The question is then the runner's for 3 minutes |
| `chat_progress` | Replaces the answer so far (6,000 characters at most) and its steps, and extends the claim. Refused once the answer was stopped or taken: the runner then drops it |
| `chat_finish` | The answer, or `failed` with one of a closed list of reasons |
| `os_agents_due` | Once a minute between questions: each of the four due on the Mac now (switched on, on the Mac, not running, its time within the last six hours and not handed out), chief of staff last, with its published instructions, user turn, tools and limits (the code's defaults where none can be read), or `{ none: true }`. Each is recorded as handed out; one never started within the hour is ended as timed out |
| `os_agent_start` | Just before Claude Code: starts a run it was handed, once. The run's clock (and its 20-minute stuck limit) starts here, so the last of a check's runs, run one after another, is not timed out waiting |
| `os_agent_finish` | How a run ended: `done`, or one of the chat's closed list of reasons. Its summary goes to the agent's Runs tab, made of the run's own calls. Tried again only when the OS cannot be reached (three times at most, as `chat_finish`), never after a refusal |

Every call Claude makes in an agent's run carries `X-Startup-Agent` and `X-Startup-Run` (written in
the run's MCP configuration, beside the token): the endpoint refuses any tool not in that
agent's published list, lists only those in `tools/list`, and stamps the audit row with the
agent and the run. The run's Claude Code is shut in as the chat's is, with that agent's tools
allowed by name and every other tool of the server denied by name, its own turns (at most 30)
and time (at most ten minutes). The first three agents' final answers are handed to the chief
of staff when it runs in the same check; nothing of a run is printed.

They are counted in a window of their own, **1,200 calls in 10 minutes**, apart from the 120
a model has: the runner checks in every 3 seconds (15 after two minutes idle, 60 after an
hour), which is at most 200, and reports an answer at most every 700 ms. A check-in that
found nothing and a progress report leave no audit row; a claim and a finish leave one each.

`propose` takes an optional `chatMessageId`: the proposal then shows under that answer. It is
refused unless that answer is being written, and one answer holds at most 10.

### Limits

2,000 characters a question; 200 questions a day; one answer at a time in a conversation
(another conversation is not held up); 200 messages a conversation; a conversation nobody
adds to for 90 days is deleted. A claim that runs out is taken once more, then the answer is
marked failed.

### When there is no answer

| The page says | What happened | What to do |
|---|---|---|
| "Your Mac has not checked in since …" | The runner is not running, or the Mac is asleep or offline. Questions wait | Wake the Mac; run `pnpm assistant:runner`, or load the launchd agent |
| "Waiting for your Mac to pick this up." for long | The runner is idle and checks every minute, or is answering another conversation | Wait a minute; **Stop** frees the conversation |
| "Claude is not signed in on this Mac." | Claude Code on the Mac is signed out | Run `claude` once in a terminal and sign in |
| "Claude's usage limit was reached." | The subscription's limit | Wait for it to reset |
| "Claude could not be started." | The `claude` program was not found or would not start | Install Claude Code, or pass `--claude <path>` |
| "It took too long." | Over 120 seconds or 12 turns | Ask something narrower |
| "Your Mac stopped answering part-way." | The runner went away twice during the answer | Ask again |
| "Something went wrong." | Anything else. Nothing Claude Code or the network said is kept or shown | Ask again; look at the runner's log for the count |
| The runner stops with "Startup OS refused the token" | The token was replaced or revoked | Connect Claude again from `/assistant` |

The queued "Ask at the next run" was removed in the 2026-10 dedupe, with `questions_open`
and `question_answer`: the chat is the one place to ask.
