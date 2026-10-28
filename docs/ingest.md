# Pushing pipelines to the OS

Two boards are mirrored from systems the OS cannot read by itself: investors from Visible.vc
and Kazakhstan sales deals from the CRM. A scheduled Claude routine reads each through its
connector and posts what it found to `POST /ingest/v1`. This page is the contract for those
posts and the prompt each routine runs. Numbers (the CFO workbook) use the same endpoint; they
are described in the README.

Nothing here creates a routine. The owner creates them, with the prompts below.

## The endpoint's two addresses

The token routes can be reached at two addresses, and they are the same endpoint:

| Address | What it is |
|---|---|
| `https://os.example.com/ingest/v1` | The app's own domain. **Give this one to teammates and routines.** It stays the same if the deployment behind it ever changes, and it is the one domain a teammate's organisation has to allow for their Claude. |
| `https://<deployment>.convex.site/ingest/v1` | The Convex deployment's own address, where the endpoint runs. It keeps working, and is what a prompt shows while no public address is configured. |

Until the DNS record for `os.example.com` exists, keep giving out the deployment's address: the
app does the same at `startup-os.example.com`, but that address is not meant to last and the
local scripts refuse it.

The app passes exactly four routes through to the deployment, and nothing else:

| Method | Path |
|---|---|
| `POST` | `/ingest/v1` |
| `GET` | `/standup/v1/open` |
| `POST` | `/standup/v1/tasks` |
| `POST` | `/mcp/v1` |

The fourth is not an ingest route: it is the owner's agent endpoint, where the owner's own
Claude reads the OS and acts in it on the owner's agent token alone (`docs/assistant.md`). It
is listed here because it is passed through by the same code and the same rules. A source's
token and a personal token are refused there, and an agent token (`sosa_…`) is refused at the
three routes above.

The pass-through adds nothing and logs nothing. The method, the `Authorization` and
`Content-Type` headers and the body go on as sent (nothing else does: no cookie, no query
string; for `/mcp/v1` alone, also `Accept` and `MCP-Protocol-Version`, which its protocol
uses); the status and the JSON body come back as the endpoint gave them, with
`Cache-Control: no-store`. The token is checked by the endpoint, exactly as at its own
address, so every reply described on this page is the same through either. Sign-in
(`/api/auth/*` on the deployment) and the Google callback are not passed through.

Three replies are the app's own, in fixed words:

| Reply | Meaning |
|---|---|
| `503 pass_through_not_configured` | The app was built without the deployment's address (`NEXT_PUBLIC_CONVEX_URL`). Nothing was sent anywhere. |
| `502 upstream_unreachable` | The deployment did not answer in 25 seconds, could not be reached, or answered with a redirect (never followed, never handed back). The push may or may not have landed; sending the same batch again is safe. |
| `413 payload_too_large` | The body is over the endpoint's own limit (256 KB for `/ingest/v1`, 64 KB for `/standup/v1/tasks` and for `/mcp/v1`, which is answered in JSON-RPC as that endpoint answers). The endpoint answers the same; here it is said before the body is sent on, without the token being checked or the refusal logged against a source. |

Any other path under `/ingest`, `/standup` or `/mcp` on the app is not passed through: it is a page
that does not exist (the sign-in page, for a caller with no session). A method a route does not
take is answered `405` by the app.

The address a teammate sees on "Connect your Claude" is `NEXT_PUBLIC_OS_URL` + `/ingest/v1`
when that variable is set in the app's build (`https://os.example.com`: https, no path, no query,
no credentials), and the deployment's address when it is not. A value that is not such an
origin shows no address at all, rather than the other one in its place. The local scripts
(`STARTUP_OS_INGEST_URL` in `.env.push`) accept either address: `https://os.example.com/ingest/v1`,
an `https` `*.convex.site` one, or localhost, and refuse everything else.

A new token route in `convex/http.ts` is **not** reachable through the app until it is added
to `src/lib/os/pass-through-routes.ts`, given a body cap in `pass-through.ts` and a `route.ts`
under `src/app/`. That is deliberate: tests fail while the three places disagree.

## Who may push what

| Source | Token (Convex env) | Sends | Lands on | Amounts in |
|---|---|---|---|---|
| `visible` | `INGEST_TOKEN_VISIBLE` | `investors`; `contacts` (its investors' people) | `/fundraising`; `/contacts`, Startup | USD |
| `kz_crm` | `INGEST_TOKEN_KZ_CRM` | `deals`; `contacts` (each clinic's staff) | `/sales`, Kazakhstan; `/contacts`, Globex | KZT |

A token fixes its source: the Visible token cannot write deals, and neither can write a number.
Each may also send people for the Contacts book, in an envelope of their own ("Contacts", below);
so may Apollo's, Gmail's, Google Calendar's and Fireflies' tokens, and no other.
The Visible token also reads and acks the OS's queue of investor changes for Visible ("Visible
write-back", below): the second bearer token, after the standup's, that reads company data.
Generate each with `openssl rand -hex 32` and set it with `npx convex env set`. Two sources
must never share a token (the endpoint then accepts neither).

## The envelope

```json
{
  "version": 1,
  "source": "visible",
  "batchId": "visible-2026-10-12",
  "observedAt": "2026-10-12T06:00:00Z",
  "mode": "replace",
  "investors": [
    {
      "externalId": "inv_8f2c",
      "name": "Example Capital",
      "contact": "A. Partner",
      "stage": "Contacted",
      "amount": 250000,
      "currency": "USD",
      "lastActivityAt": "2026-10-09"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `externalId` | yes | The record's id in the source. A later push matches on it, so it must not change. Not a name. |
| `name` | yes | The company, clinic or investment firm. At most 120 characters. |
| `contact` | no | One person there, by name only. |
| `stage` | yes | The stage exactly as the source names it. The OS maps it onto its own stages; a name it does not know shows in an "Unsorted" column and is left out of every number. |
| `amount`, `currency` | no, together | A deal's expected monthly fee, or an investor's cheque. The currency must be the source's (table above), or the push is refused. |
| `lastActivityAt` | no | `YYYY-MM-DD`, the last contact or change the source records. Without it the card cannot be judged quiet. |
| `closedAt` | no | `YYYY-MM-DD`, only on a record that is won, lost, committed or passed. |

`deals` rows have the same fields. There are no others: an email, a phone number, a note or
any other field makes the whole push fail. **Never send anything about a patient.** `batchId`
and `externalId` are stored in the run log and must not contain a name.

`mode` is `"replace"` for both routines: the push is the source's whole list, and a record it
no longer names is archived (taken off the board, its notes kept, restored if it is listed
again). `"upsert"`, the default, writes the rows sent and leaves the rest. An empty list is
refused in either mode: an empty read is far more likely a failed read.

What the owner types in the OS (a card's next step and notes) is never part of a push and is
never changed by one.

## What comes back

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"inserted":2,"updated":1,"unchanged":40,"archived":1}` | Written. |
| 401 | `unauthorized` | Wrong or missing token. Nothing is logged. |
| 403 | `source_mismatch` | The envelope's `source` is not the token's. |
| 413 | `payload_too_large` | Over 256 KB. |
| 422 | `invalid_envelope` | The shape is wrong; `issues` names the row or field by its path (`investors.1`, `deals.0.name`) in fixed words ("has a field the OS does not accept"), never the unknown field's name or a value. |
| 422 | `invalid_rows` | A row could not be true; `issues` names the row and field (`deals.3.currency`), never a value. |

Every refusal after the token is accepted is logged against the source and shows on the board
it feeds and on Settings → Sources. One bad row refuses the whole push.

## Setting up a routine

1. Set the source's token in Convex and give the routine the same value as a network secret.
2. Allow the OS's domain (`os.example.com`) in the routine's environment, or the Convex site
   domain (`<deployment>.convex.site`) if the routine posts there ("The endpoint's two
   addresses", above).
3. Schedule it daily. A board not read for more than three days says it may be behind.
4. Run it once by hand and read the answer. Open the board: any card under "Unsorted" has a
   stage name the OS does not know. Add the name to `ALIASES` in
   `convex/lib/pipelineStages.ts` (lower case, as `stageKey` writes it) and run it again.

## Prompt: investors from Visible.vc

```text
You keep Startup OS's investor board in step with Visible.vc. Do exactly this and nothing else.

1. With the Visible connector, list every investor in the fundraising pipeline named
   "<PIPELINE NAME>". Follow every page until there are no more. If any call fails, or you
   cannot be sure you have the whole list, stop and report the failure. Do not post a partial
   list: the OS archives every investor you leave out.

2. Build one JSON object:
   - "version": 1
   - "source": "visible"
   - "batchId": "visible-" followed by today's date as YYYY-MM-DD
   - "observedAt": the current time in UTC, ISO 8601, ending in Z
   - "mode": "replace"
   - "investors": one entry per investor, with only these fields:
       "externalId": Visible's own id for the investor record (required; never a name)
       "name": the firm's or the angel's name (required)
       "contact": the name of the main contact person, if Visible has one
       "stage": the pipeline stage, spelled exactly as Visible shows it (required)
       "amount" and "currency": the amount Visible records for this investor in US dollars,
          as a plain number, with "currency": "USD". Leave both out if there is none.
       "lastActivityAt": the date of the last recorded contact or update, as YYYY-MM-DD.
          Leave it out if Visible has none.
       "closedAt": only for an investor whose stage means they committed or passed: the
          date that happened, as YYYY-MM-DD. Leave it out otherwise.
   Leave a field out rather than guessing it. Add no other field: no email, no phone
   number, no notes, no website. Any extra field makes the OS refuse the whole push.

3. Send it once:
   POST https://<DEPLOYMENT>.convex.site/ingest/v1
   Content-Type: application/json
   Authorization: Bearer <the INGEST_TOKEN_VISIBLE secret>

4. Report the HTTP status and the response body, and how many investors you sent. If the
   status is not 200, do not retry and do not change the data to make it pass: report the
   "issues" exactly as returned. Never print the token.
```

## Visible write-back

Visible investors are edited on `/fundraising` as well as read from Visible: stage (a drag
included), amount and name, a next step and notes, and new investors made in the OS. Each
change applies in the OS at once and is queued, one row per investor, in `investorSync`
(`convex/lib/investorSync.ts`); the daily connector run writes the queue to Visible with
Visible's own MCP tools before it reads the pipeline (`docs/setup.md`, "Visible").
Visible's contact stays Visible's: the OS refuses a change to a Visible investor's contact.
The Kazakhstan CRM's deals take nothing back and stay as locked as before
(`WRITE_BACK_SOURCES` in `convex/lib/pipelineCards.ts`).

Two routes, beside `POST /ingest/v1`, both on `INGEST_TOKEN_VISIBLE` and refusing every
other token (another source's, the standup's, a personal or an agent token: the same
`401 unauthorized`; `503 ingest_not_configured` while the Visible token is unset). **They are
not passed through the app**: call the deployment's own `https://<deployment>.convex.site`
address, which is what `pnpm visible:outbox` / `visible:ack` refuse anything else for.

### `GET /ingest/v1/visible/outbox`

The pending changes, oldest first, at most 100 (`truncated: true` when more wait):

```json
{
  "ok": true,
  "truncated": false,
  "items": [
    {
      "id": "<row id>",
      "revision": 2,
      "kind": "update",
      "investor": { "externalId": "inv_8f2c", "name": "Example Capital" },
      "fields": { "stage": "meeting", "amount": 250000 },
      "osStage": "meeting",
      "note": "Next step: Send the deck"
    },
    {
      "id": "<row id>",
      "revision": 0,
      "kind": "create",
      "investor": { "name": "Example Angel" },
      "fields": { "stage": "target", "name": "Example Angel", "amount": null },
      "osStage": "target"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `kind` | `update`: an investor Visible has (`investor.externalId` is Visible's id). `create`: one made in the OS; `fields` is the whole card. |
| `fields` | Only what to write: `stage` (an OS stage key: target, contacted, meeting, diligence, committed, passed), `amount` (USD; `null` clears it), `name`. Empty when only a note is queued. |
| `osStage` | The investor's stage in the OS now. |
| `note` | The next step and notes, `Next step: …` / `Notes: …` a line each (`(cleared)` for one cleared), to write as a Visible note. Absent when neither changed. |
| `revision` | Bumped each time a later change merges into the item. Ack with the revision you read. |

A create for an investor archived in the OS is not listed (archiving is local and is never sent
to Visible) until it is restored.

### `POST /ingest/v1/visible/outbox/ack`

```json
{
  "results": [
    { "id": "<row id>", "revision": 2, "ok": true },
    { "id": "<row id>", "revision": 0, "ok": true, "visibleId": "inv_91aa" },
    { "id": "<row id>", "revision": 0, "ok": false, "errorCode": "unmapped_stage" }
  ]
}
```

At most 100 results, each id once; no other key. `visibleId` (letters, digits, `-`, `_`) only
on a written item: for a `create`, the new (or existing, deduplicated) Visible investor's id.
`errorCode` only, and always, on a failed item: snake_case, at most 40 characters, the run's
own code, never Visible's words. The page names these: `unmapped_stage` (no Visible stage
for the OS stage), `not_found` (Visible has no such investor), `archived` (archived in
Visible); the OS itself sets `missing_visible_id` and `already_in_os` (below); any other code
(`visible_error`, `no_single_pipeline`) shows as a plain failure. 64 KB at most.

What the OS does with each, for an item still pending (any other id is counted `unknown` and
nothing changes):

| Result | Effect |
|---|---|
| `ok`, `create`, with `visibleId` | The investor is linked: its `source` becomes `visible` and its `externalId` the Visible id, so the next `replace` pull matches it instead of adding it twice or archiving it. The row is `sent`. |
| `ok`, `create`, no `visibleId` / an id another investor in the OS already has | `failed`, `missing_visible_id` / `already_in_os`. |
| `ok`, `update` | `sent`; confirmed at once when it carried only a note (a pull cannot read notes). |
| not `ok` | `failed` with the code; the card says "Sync failed", and Retry (`investors.retrySync`) puts it back to pending. |
| an older `revision` | `stale`: the item changed after it was read. A create still links; the row stays pending, so the newer values go with the next run. |

`200 {"ok":true,"sent":1,"confirmed":0,"failed":1,"stale":0,"unknown":0}`. A refusal is
`422 invalid_ack` with paths and fixed words (`400 invalid_json`, `413 payload_too_large`,
`500 write_failed`), logged against Visible. Nothing of an item is ever logged.

### What the next pull does

The `replace` push from Visible (above) is applied as before, except for investors with queued
changes:

- a field still **pending** keeps the OS's value, unless Visible already holds the queued
  value, when that field is done (an item left with nothing to send is confirmed);
- an item already **sent** is settled: a field Visible holds as sent is confirmed; one Visible
  holds differently was changed there since, so **Visible's value wins** and the card says
  "changed in Visible" for seven days (`changedInVisibleAt`);
- an investor the owner **archived** in the OS (`archivedBy: "owner"`) stays archived, its
  Visible fields kept current; one the push itself archived comes back when listed again.

Confirmed rows are history (`investors.syncHistory`: times, status, attempts, codes and which
fields, never values) and are pruned after 30 days.

### The two scripts

```bash
pnpm -s visible:outbox                     # the items, as JSON on stdout
pnpm -s visible:outbox /tmp/outbox.json    # written to a file (mode 600); counts on stdout
pnpm -s visible:ack /tmp/ack.json          # check the file; prints counts and codes, sends nothing
pnpm -s visible:ack /tmp/ack.json --send
```

Both read `STARTUP_OS_INGEST_URL` (a `*.convex.site` address or localhost) and
`INGEST_TOKEN_VISIBLE` from `.env.push`. Neither prints the token or follows a redirect.

## Prompt: deals from the Kazakhstan CRM

```text
You keep Startup OS's Kazakhstan sales board in step with the CRM. Do exactly this and nothing
else.

1. With the CRM connector, list every deal in the sales pipeline named "<PIPELINE NAME>"
   that is still open, and every deal that was won or lost in the last 12 months. Follow
   every page until there are no more. If any call fails, or you cannot be sure you have the whole
   list, stop and report the failure. Do not post a partial list: the OS archives every
   deal you leave out.

2. Build one JSON object:
   - "version": 1
   - "source": "kz_crm"
   - "batchId": "kz-crm-" followed by today's date as YYYY-MM-DD
   - "observedAt": the current time in UTC, ISO 8601, ending in Z
   - "mode": "replace"
   - "deals": one entry per deal, with only these fields:
       "externalId": the CRM's own id for the deal (required; never a name)
       "name": the clinic's or company's name (required)
       "contact": the name of the contact person at the clinic, if the deal has one
       "stage": the deal's stage, spelled exactly as the CRM shows it, in the CRM's own
          language (required). Do not translate it.
       "amount" and "currency": the expected MONTHLY fee in tenge as a plain number, with
          "currency": "KZT". If the CRM holds a yearly or one-off amount, or an amount in
          another currency, leave both out; do not convert.
       "lastActivityAt": the date the deal was last changed or contacted, as YYYY-MM-DD
       "closedAt": only for a deal that is won or lost: the date it closed, as YYYY-MM-DD.
          Leave it out for every open deal.
   Leave a field out rather than guessing it. Add no other field: no email, no phone
   number, no comments, no address. The contact is a person at the clinic. Never include
   anything about a patient. Any extra field makes the OS refuse the whole push.

3. Send it once:
   POST https://<DEPLOYMENT>.convex.site/ingest/v1
   Content-Type: application/json
   Authorization: Bearer <the INGEST_TOKEN_KZ_CRM secret>

4. Report the HTTP status and the response body, and how many deals you sent. If the status
   is not 200, do not retry and do not change the data to make it pass: report the "issues"
   exactly as returned. Never print the token.
```

## Trying it by hand

With made-up data, against local dev (`INGEST_TOKEN_VISIBLE` set on the local deployment):

```bash
curl -sS -X POST "$STARTUP_OS_INGEST_URL" \
  -H "Authorization: Bearer $INGEST_TOKEN_VISIBLE" -H "Content-Type: application/json" \
  -d '{"version":1,"source":"visible","batchId":"visible-test","observedAt":"2026-10-12T06:00:00Z",
       "mode":"upsert","investors":[{"externalId":"test-1","name":"Example Capital","stage":"Contacted"}]}'
```

Expected: `{"ok":true,"inserted":1,"updated":0,"unchanged":0,"archived":0}`, and the card on
`/fundraising` under Contacted, with no grip to drag it by.

## Feeding the OS from Claude connectors

Seven sources the OS can read with its own API keys can be fed by a Claude session instead:
the session reads each source through its connector, writes one envelope file per source, and
runs `pnpm push:envelope <file> --send`. No API key per source is needed, only an ingest token.

This section is the whole contract. A session with nothing else to go on should be able to
follow it.

### Setting it up (the owner, once)

| Source | Token (Convex env and `.env.push`) | Sends | Leave unset in Convex |
|---|---|---|---|
| `posthog` | `INGEST_TOKEN_POSTHOG` | `snapshots` | `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` |
| `mercury` | `INGEST_TOKEN_MERCURY` | `snapshots` | `MERCURY_API_TOKEN` |
| `apollo` | `INGEST_TOKEN_APOLLO` | `snapshots`; `records` with a `kind` (its two shared lists); `contacts` | `APOLLO_API_KEY` |
| `gmail` | `INGEST_TOKEN_GMAIL` | `records`; `contacts` | `GOOGLE_WORK_CLIENT_ID`, `GOOGLE_WORK_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` |
| `google_calendar` | `INGEST_TOKEN_GOOGLE_CALENDAR` | `records`; `contacts` | the same three |
| `linear` | `INGEST_TOKEN_LINEAR` | `records` | `LINEAR_API_KEY` |
| `fireflies` | `INGEST_TOKEN_FIREFLIES` | `records`; `contacts` | `FIREFLIES_API_KEY` |

Globex's Intercom inbox (`intercom`) is pushed the same way, on `INGEST_TOKEN_INTERCOM`,
and only that way: Startup OS has no Intercom key to read it with ("Intercom" below).

A source is fed one way at a time. While its own API variables (last column) are all set, the
OS reads it itself and a push is refused with `409 source_is_pulled`. With only the token set,
the OS's own schedule for that source does nothing, and Settings → Sources shows it as "Pushed
by a connector run". Each token is its own value (`openssl rand -hex 32`), set with
`npx convex env set` and again in an untracked `.env.push` beside `package.json`, together with
`STARTUP_OS_INGEST_URL=https://os.example.com/ingest/v1` (or the deployment's own
`https://<deployment>.convex.site/ingest/v1`; it is the same endpoint). Never paste a token into a
chat, and never print one.

### Rules for the session (all seven sources)

1. **Complete reads only.** Follow every page of every connector result. If a call fails, is
   cut short, or says there is more that you could not fetch, send nothing for that source and
   report it. A push replaces what is stored: a partial list deletes the rest, and a partial sum
   is a wrong number.
2. **Compute with code.** Every money and count figure is worked out by a script over the
   complete results (sum in whole cents, count rows). Never estimate, round by eye, summarise or
   copy a figure from a dashboard's headline.
3. **Time is UTC.** A week is Monday 00:00 UTC to the next Monday 00:00 UTC and is named by its
   Monday (`"2026-10-05"`). A month is a UTC calendar month, named by its first day
   (`"2026-10-01"`). A day is a UTC date.
4. **Only what is listed.** A field that is not named below makes the whole push fail. Never
   send a message body or snippet, an event description or location, a meeting link, an issue
   description or comment, a transcript, a transaction, a counterparty, or anything about a
   patient.
5. **One file per source, then the script.** Write the envelope to a file, run
   `pnpm push:envelope <file>` to check it (it prints the source, the kind and counts, never a
   row), then `pnpm push:envelope <file> --send`. Report the status line it prints. If it is not
   `200 ok`, do not retry and do not edit the data to make it pass: report the issues as printed.
6. `batchId` is your own label for the push (`"<source>-<UTC date>"`); `observedAt` is the time
   you finished reading, ISO 8601 ending in `Z`. Neither may contain a name.

Every envelope starts the same way:

```json
{ "version": 1, "source": "<source>", "batchId": "<source>-2026-10-12", "observedAt": "2026-10-12T06:05:00Z" }
```

followed by `snapshots` (numbers) or `records` (a work tool's list, or a shared list with its
`kind`: one of Apollo's two, or GitHub's repositories), never both: each envelope carries one
kind of payload.

### PostHog (`posthog`): Startup Insights by week

Rows are `{ "key", "scope": "startup_insights", "period": "week", "periodStart": <Monday>, "value" }`.
Send the **eight most recent weeks that have ended**, all five keys for each. The week in
progress is refused. Definitions (the same as `convex/connectors/posthogParse.ts`):

| Key | Value for the week |
|---|---|
| `web_visitors` | distinct persons with at least one `$pageview` event |
| `searches` | number of `insights_search` events |
| `weekly_active_users` | distinct persons with at least one `insights_search` event |
| `signups` | persons whose **first ever** `$identify` event falls in the week |
| `signups_activated` | of that week's signups, those with a `insights_search` at or after the moment of that first `$identify` and before seven days after it (a search from before signing up does not count) |

Count by event `timestamp`, cutting weeks in UTC as above, with a query over the whole week
(HogQL, not a sampled insight). If a result says it has more rows than it returned, send
nothing. From the first week in which any of the five shows anything, a week with no events is
sent as `0`; weeks before that are not sent. `signups_activated` can never exceed `signups`, nor
`weekly_active_users` exceed `searches`: if yours do, the query is wrong, so send nothing.

```json
{
  "version": 1, "source": "posthog", "batchId": "posthog-2026-10-12", "observedAt": "2026-10-12T06:05:00Z",
  "snapshots": [
    { "key": "web_visitors", "scope": "startup_insights", "period": "week", "periodStart": "2026-10-05", "value": 412 },
    { "key": "searches", "scope": "startup_insights", "period": "week", "periodStart": "2026-10-05", "value": 96 },
    { "key": "weekly_active_users", "scope": "startup_insights", "period": "week", "periodStart": "2026-10-05", "value": 31 },
    { "key": "signups", "scope": "startup_insights", "period": "week", "periodStart": "2026-10-05", "value": 7 },
    { "key": "signups_activated", "scope": "startup_insights", "period": "week", "periodStart": "2026-10-05", "value": 3 }
  ]
}
```

(and the same five rows for each of the seven weeks before it).

### PostHog: Globex's app is read by Startup OS, not pushed

Globex's app (`app.globex.example.com`, PostHog project 192095) is its own source,
`posthog_globex`, which Startup OS reads itself every morning (`docs/setup.md`,
"PostHog: Globex's app"). Its figures, the weekly `kz_product` ones and the monthly
`ai_token_cost` and `ai_token_clinics`, are that source's in the registry: an envelope
on the `posthog` token that carries one is refused.

`ai_token_cost` and `ai_token_clinics` are Finance's figures: the AI token cost is in the
cost of serving customers (COGS) in unit economics, converted to tenge at the stored rate.
So is the app's weekly AI spend (`ai_cost_total`, and each module's `module_ai_cost_*` and
`module_cost_per_result_*`), and its paying clinics that ran a check (`clinics_paid`, a
count of paying clients, as `clinics_active` is): they are sent only to a viewer with
Finance, and Product › Kazakhstan leaves their tiles and columns out for anyone else.

### Mercury (`mercury`): US cash, money in and out by month, and what went to the subsidiary

Rows are `{ "key", "scope": "us", "period", "periodStart", "value", "currency": "USD" }`, in
dollars with cents. Definitions (the same as `convex/connectors/mercuryParse.ts`):

- **`cash`**, `"period": "day"`, `periodStart` today's UTC date: the current balance of every
  Mercury account of the company that is open (type `mercury`, status `active`), plus the
  current balance of every Treasury account. Not a linked outside bank, not a recipient, not a
  closed or pending account. If no open account comes back, send nothing.
- **`cash_in`** and **`cash_out`**, `"period": "month"`: from the transactions of every own
  account that is open **or closed (archived)**, counting
  - **posted transactions only** (status `sent`); pending, failed and cancelled ones are left out;
  - **not** transfers between the company's own accounts (kinds `internalTransfer` and
    `treasuryTransfer`): they are neither income nor spending;
  - each transaction once (by its id), in the UTC month of the time it **posted** (`postedAt`;
    the time it was created only if it has no posted time);
  - an amount of zero or more into `cash_in`; a negative amount into `cash_out`, as a
    **positive** number.
- **`cash_to_subsidiary`**, `"period": "month"`: of `cash_out`, the negative amounts whose
  counterparty is the subsidiary, Globex (the name the bank gives it, `SUBSIDIARY_COUNTERPARTY`
  in `convex/lib/features.ts`, matched in any capitals inside the counterparty's name, as
  `isSubsidiaryCounterparty` in `convex/lib/company.ts` does),
  counted by the same rules, as a **positive** number. It stays inside `cash_out`, which is
  the bank's total. Send it for exactly the months `cash_out` is sent, `0` where nothing went
  to the subsidiary: a month with `cash_out` and no `cash_to_subsidiary` is "not known", not
  zero. Never send the counterparty's name, in any row or field.

  Send **the month in progress and the two months before it**, every time. The month in
  progress is sent as it stands: the OS knows from its date that it is unfinished. The two
  before it must be sent in full on every push, because the OS treats a month as complete once
  a push has succeeded after that month ended. Read transactions starting 60 days before the
  first of those three months (a payment can post weeks after it was created). From the first
  month with any transaction, a month with none is `0` for all three keys; months before the
  account's first transaction are not sent. If not one transaction comes back, send nothing.

Add up in whole cents and divide by 100 at the end.

```json
{
  "version": 1, "source": "mercury", "batchId": "mercury-2026-10-12", "observedAt": "2026-10-12T06:05:00Z",
  "snapshots": [
    { "key": "cash", "scope": "us", "period": "day", "periodStart": "2026-10-12", "value": 412345.67, "currency": "USD" },
    { "key": "cash_in", "scope": "us", "period": "month", "periodStart": "2026-08-01", "value": 18250.00, "currency": "USD" },
    { "key": "cash_out", "scope": "us", "period": "month", "periodStart": "2026-08-01", "value": 61480.12, "currency": "USD" },
    { "key": "cash_in", "scope": "us", "period": "month", "periodStart": "2026-09-01", "value": 20100.00, "currency": "USD" },
    { "key": "cash_out", "scope": "us", "period": "month", "periodStart": "2026-09-01", "value": 58900.40, "currency": "USD" },
    { "key": "cash_in", "scope": "us", "period": "month", "periodStart": "2026-10-01", "value": 4000.00, "currency": "USD" },
    { "key": "cash_out", "scope": "us", "period": "month", "periodStart": "2026-10-01", "value": 17320.55, "currency": "USD" },
    { "key": "cash_to_subsidiary", "scope": "us", "period": "month", "periodStart": "2026-08-01", "value": 41000.00, "currency": "USD" },
    { "key": "cash_to_subsidiary", "scope": "us", "period": "month", "periodStart": "2026-09-01", "value": 37500.00, "currency": "USD" },
    { "key": "cash_to_subsidiary", "scope": "us", "period": "month", "periodStart": "2026-10-01", "value": 0, "currency": "USD" }
  ]
}
```

### Apollo (`apollo`): outbound, prospects, tasks and calls

Apollo's token carries three envelopes, each on its own: its numbers (`snapshots`), its
sequences (`records` with `"kind": "sequence"`) and its contacts and accounts by stage
(`records` with `"kind": "stage_count"`). The exact tool calls, and how to read Apollo's
analytics report by script, are in `docs/setup.md` ("Apollo"), with a complete
example of each file. Nothing in any of the three names a person: no field for one exists.

**Numbers.** Rows are `{ "key", "scope": "us", "period": "week", "periodStart", "value" }`,
whole numbers, never negative. There are two sorts, told apart by which week they go under.

Levels and totals to date go under **the Monday of the UTC week you are reading in** (the one
week that is sent while in progress: each push overwrites it). Any other week is refused,
with a day of grace after Monday for a read made just before it:

| Key | Value | At most |
|---|---|---|
| `outbound_delivered` | unique delivered, summed over every sequence, archived ones included | |
| `outbound_opened` | unique opened, summed the same way | |
| `outbound_replied` | unique replied, summed the same way | |
| `apollo_contacts` | contacts in the team's Apollo, all time | 10,000,000 |
| `apollo_accounts` | accounts, all time | 10,000,000 |
| `apollo_tasks_open` | tasks scheduled and not yet completed or skipped | 1,000,000 |
| `apollo_tasks_overdue` | of those, the ones past their due date | 1,000,000 |

For the three outbound totals the OS works out a week's own figure from two weeks' totals
(`convex/connectors/apolloParse.ts`). Send none of the three if you list fewer sequences than
Apollo says there are, if any sequence comes back without its statistics, or if there are no
sequences. A level is stale four days after its week ends.

A week's own count goes under **each finished week** (Monday to Sunday as Apollo labels it,
named by its Monday), as many past weeks as the report covers, zeros included. **The week in
progress is refused** (`This week has not ended. Only finished weeks are stored.`), as it is
for PostHog's weeks: a part-week would be charted as a quiet week. These are stale ten days
after the newest week sent ends:

| Key | Value | At most |
|---|---|---|
| `apollo_contacts_added` | contacts created in that week | 1,000,000 |
| `apollo_calls` | calls logged in that week | 100,000 |

```json
{
  "version": 1, "source": "apollo", "batchId": "apollo-2026-10-12", "observedAt": "2026-10-12T06:05:00Z",
  "snapshots": [
    { "key": "outbound_delivered", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 1840 },
    { "key": "outbound_opened", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 702 },
    { "key": "outbound_replied", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 41 },
    { "key": "apollo_contacts", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 3120 },
    { "key": "apollo_accounts", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 1275 },
    { "key": "apollo_tasks_open", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 14 },
    { "key": "apollo_tasks_overdue", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 3 },
    { "key": "apollo_contacts_added", "scope": "us", "period": "week", "periodStart": "2026-10-05", "value": 85 },
    { "key": "apollo_calls", "scope": "us", "period": "week", "periodStart": "2026-10-05", "value": 0 }
  ]
}
```

**Sequences** (`"kind": "sequence"`): the whole list, at most 200. A sequence the push does not
name is removed. Fields, and there are no others:

| Field | Required | Meaning |
|---|---|---|
| `sequenceId` | yes | Apollo's id for the sequence. No spaces, at most 64 characters. The key a later push matches on. |
| `name` | no | The team's own label for the sequence. Cleaned like other record text and cut to 200 characters; over 5,000 is refused. |
| `active`, `archived` | yes | Booleans, as Apollo gives them. |
| `steps` | yes | Number of steps, 0 to 100. |
| `createdAt` | yes | The UTC day it was made, `YYYY-MM-DD`. Not in the future. |
| `lastUsedAt` | no | The UTC day it was last used. Left out for one never used. |
| `delivered`, `opened`, `replied`, `bounced`, `unsubscribed` | yes | Unique counts to date, whole numbers from 0 to 10,000,000. `opened` and `replied` may not be more than `delivered`. |
| `clicked` | no | The same; left out where clicks are not tracked (unknown, not zero). |

The people in a sequence, its steps' text and its templates have no field. A push that carries
one is refused, not trimmed.

**Stage counts** (`"kind": "stage_count"`): contacts' and accounts' stages together, the whole
list, at most 100 rows. Fields:

| Field | Required | Meaning |
|---|---|---|
| `entity` | yes | `"contact"` or `"account"`. |
| `stage` | yes | The stage's name as the team set it up. Cleaned and cut to 100 characters; may not be empty. One row per entity and name, whatever the case. |
| `count` | yes | How many stand at it, a whole number from 0 to 10,000,000. |

For both lists **an empty list is refused, with or without `"empty": true`**. Apollo's report
drops its whole table when a metric and a grouping do not go together, so "nothing" is what a
failed read looks like; the page keeps the last list and says how old it is.

These two lists are the team's, not a person's. They are stored with no owner and read only
by the go-to-market page (the `gtm` area, on Startup). They are not work-tool records: no
personal token can write them, Apollo's token cannot write mail, calendar, issues or meeting
notes, and there is no off switch for them. Their refusals are logged against `apollo` in
paths and fixed words, without the sender's `batchId`.

| Token | Envelope | Outcome |
|---|---|---|
| Apollo's | `snapshots` of Apollo's own metrics | written |
| Apollo's | `records` with `kind` `sequence` or `stage_count` | written, whole-list replace of that kind only |
| Apollo's | `records` with no `kind`, or an unknown one | `422 invalid_envelope` (path `kind`) |
| Apollo's | `records` beside `snapshots`, or `kind` without `records` | `422 invalid_envelope` |
| Apollo's | rows of the other list, a work tool's rows, or a row with an extra field | `422 invalid_records`, by row |
| Apollo's | an empty list | `422 invalid_envelope` without `empty`, `422 invalid_records` with it |
| Apollo's | `"source"` set to a work tool, or any other source | `403 source_mismatch` |
| Apollo's | `deals` or `investors`, `customers`, `plan` | `422 invalid_rows`, `customers_not_accepted`, `plan_not_accepted` |
| Apollo's, while `APOLLO_API_KEY` is set | anything | `409 source_is_pulled` |
| a work tool's | `"source": "apollo"` | `403 source_mismatch` |
| a work tool's | its own records with a `kind` | `422 invalid_envelope` (path `kind`) |
| a personal token | `"source": "apollo"` with a `kind` | `422 records_not_accepted` |
| a personal token | `"source": "apollo"` without one, or its own tool with one | `422 invalid_envelope` |
| a personal token | Apollo's numbers | `422 records_only` |

### GitHub (`github`): engineering signals

Not fed by a Claude session: `pnpm gather:github` (`scripts/gather-github.ts`) reads GitHub
through the GitHub CLI, builds the three envelopes below itself, checks them with the same code
as `pnpm push:envelope`, and posts them with `--send`. The procedure and what to do when it
fails are in `docs/setup.md` ("GitHub"). This is the contract for what it sends.

| Source | Token (Convex env and `.env.push`) | Sends | Serves |
|---|---|---|---|
| `github` | `INGEST_TOKEN_GITHUB` | `snapshots`; `records` with `"kind": "repo"`; `records` with `"kind": "pull_request"` | both companies |

GitHub has no connector here and no API variables: it is a pushed source only. **Metadata
only.** Nothing in any envelope is code, a diff, a description, a comment, a file list, a
branch or a commit message, and nothing is counted per person. The numbers and the
repository list name nobody. The third envelope, which the owner asked for, carries each
listed pull request's title, its author and its requested reviewers. Pull requests opened by
bots are in no count and no list.

**Numbers.** Rows are `{ "key", "scope", "period": "week", "periodStart", "value" }`, whole
numbers, never negative. `scope` is the company: `"us"` (Startup) or `"kz"` (Globex), each
summed over the repositories tracked for it. Like Apollo's, there are two sorts.

A week's own count goes under **each finished week** (Monday to Monday, UTC, named by its
Monday); the script sends the last 13, zeros included. **The week in progress is refused**
(`This week has not ended. Only finished weeks are stored.`). Stale ten days after the newest
week sent ends:

| Key | Value | At most |
|---|---|---|
| `prs_merged` | pull requests merged in that week, by `mergedAt` | 10,000 |
| `prs_opened` | pull requests opened in that week, by `createdAt`, whatever became of them | 10,000 |

Levels go under **the Monday of the UTC week they are read in** and are overwritten daily. Any
other week is refused (`A level belongs to the week it is read in.`), with a day of grace
after Monday. Stale four days after that week ends:

| Key | Value | At most |
|---|---|---|
| `prs_open` | pull requests open now, drafts included | 100,000 |
| `prs_stuck` | open, not a draft, and more than 3 full days since it was opened or last reviewed, whichever is later | 100,000 |
| `repos_failing` | tracked repositories whose default branch's latest build failed or errored | 300 |
| `repos_tracked` | repositories pushed to in the last 90 days: what the counts cover | 300 |

A company with no tracked repository is sent no row at all: its figures are then unknown,
not zero.

```json
{
  "version": 1, "source": "github", "batchId": "github-2026-10-12", "observedAt": "2026-10-12T06:05:00.000Z",
  "snapshots": [
    { "key": "prs_merged", "scope": "us", "period": "week", "periodStart": "2026-10-05", "value": 12 },
    { "key": "prs_opened", "scope": "us", "period": "week", "periodStart": "2026-10-05", "value": 14 },
    { "key": "prs_open", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 5 },
    { "key": "prs_stuck", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 1 },
    { "key": "repos_failing", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 0 },
    { "key": "repos_tracked", "scope": "us", "period": "week", "periodStart": "2026-10-12", "value": 7 }
  ]
}
```

**Repositories** (`"kind": "repo"`): the whole list of tracked repositories, both companies',
at most 300. A repository the push does not name is removed. Fields, and there are no others:

| Field | Required | Meaning |
|---|---|---|
| `repoId` | yes | `"<org>/<name>"`, exactly the two fields below. The key a later push matches on, whatever its case. |
| `org` | yes | The organisation. ASCII letters, digits, `.`, `-`, `_`; at most 39 characters. |
| `name` | yes | The repository's name. The same characters; at most 100. |
| `company` | yes | `"us"` or `"kz"`: whose it is, as `scripts/githubRepos.ts` decides. |
| `mergedLastWeek` | yes | Pull requests merged in the last finished week. 0 to 100,000. |
| `open` | yes | Open now, drafts included. 0 to 100,000. |
| `stuck` | yes | Of those, waiting more than 3 days. Not more than `open`. |
| `main` | yes | `"passing"`, `"failing"`, `"pending"` or `"none"`: the default branch's latest build. |
| `pushedAt` | yes | The UTC day code last landed, `YYYY-MM-DD`. Not in the future. |

A pull request's title, its author, a reviewer, a branch, a commit and a size have no field
in a repository's row. A push that carries one is refused, not trimmed. **An empty list is
refused, with or without `"empty": true`**: nothing there is what a failed read looks like.

The list is the team's, stored with no owner under the source `github` and read only by
`workTools.engineering` (the `engineering` area), which sends a caller the repositories of the
companies they are on and no others. It is not a work-tool record: no personal token can
write it, and there is no off switch for it. Its refusals are logged against `github` in
paths and fixed words, without the sender's `batchId`.

**Pull requests** (`"kind": "pull_request"`): every open pull request of a tracked
repository, and each one merged or closed in the last 14 days, both companies', **at most
600** (and the request's 256 KiB). The whole list: one the push does not name is removed, and
a push of this list leaves the repository list alone, and the other way round. Fields, and
there are no others:

| Field | Required | Meaning |
|---|---|---|
| `repoId` | yes | `"<org>/<name>"` of its repository: ASCII letters, digits, `.`, `-`, `_` each side of one `/`. |
| `number` | yes | Its number in that repository. 1 to 10,000,000. With `repoId`, the key a later push matches on. |
| `company` | yes | `"us"` or `"kz"`, from the repository map. Every pull request of one repository in a push has the same one. |
| `title` | yes | At most 300 characters. Cleaned as all remote text is (control and invisible characters removed, one line); one with nothing left reads `(no title)`. Shown as text only. |
| `url` | yes | Exactly `https://github.com/<repoId>/pull/<number>` for this row. Anything else (another host, scheme, path, a query, a fragment) is refused. The only link the page renders. |
| `authorLogin` | no | `[A-Za-z0-9-]`, 1 to 39 characters. Absent for a deleted account. |
| `authorName` | no | At most 100 characters, cleaned; absent where GitHub has none. |
| `draft` | yes | `true` or `false`. |
| `state` | yes | `"open"`, `"merged"` or `"closed"` (closed without merging). |
| `createdAt`, `updatedAt` | yes | Instants with an offset (`2026-10-12T06:05:00Z`). Not more than a day ahead; `updatedAt` not before `createdAt`. |
| `mergedAt` | for `merged` | An instant. Refused on a row that is not merged. |
| `closedAt` | for `closed` | An instant; a merged row may carry it too. Refused on an open row. |
| `reviewDecision` | yes | `"approved"`, `"changes_requested"`, `"review_required"` or `"none"`. |
| `lastReviewAt` | no | When its newest submitted review was submitted. Not before `createdAt`. |
| `reviewersRequested` | yes | How many reviewers are asked, people and teams together. 0 to 100. |
| `reviewers` | yes | The logins of the people asked, at most 5, and not more than `reviewersRequested`. May be empty. |
| `checks` | yes | `"passing"`, `"failing"`, `"pending"` or `"none"`: the head commit's checks. |

```json
{
  "version": 1, "source": "github", "batchId": "github-2026-10-12", "observedAt": "2026-10-12T06:05:00.000Z",
  "kind": "pull_request",
  "records": [
    {
      "repoId": "Example-Org/example-app", "number": 412, "company": "us",
      "title": "Example: paginate the long list",
      "url": "https://github.com/Example-Org/example-app/pull/412",
      "authorLogin": "example-ada", "authorName": "Ada Example",
      "draft": false, "state": "open",
      "createdAt": "2026-10-06T09:12:00.000Z", "updatedAt": "2026-10-11T16:40:00.000Z",
      "reviewDecision": "review_required", "lastReviewAt": "2026-10-08T11:00:00.000Z",
      "reviewersRequested": 2, "reviewers": ["example-ben"], "checks": "passing"
    }
  ]
}
```

A description, a comment, a review's text, a file, a branch, a commit message, a size, an
email address and a picture have no field: a push that carries one is refused whole, in paths
and fixed words (`records.3: has a field the OS does not accept`). The same pull request
twice is refused (`records.7.number: repeats an earlier pull request`), and so is an empty
list, with or without `"empty": true`. A title, a login or a name is never in a reply, the
run log or the source's status.

Stored with no owner under the source `github`, times as instants, and read only by
`workTools.pullRequests` (the `engineering` area), which sends a caller the pull requests of
the companies they are on and no others: a teammate on Globex alone is never sent a Startup
pull request. No stage and no "stuck" is stored: the page works them out from these facts
and the time of reading.

| Token | Envelope | Outcome |
|---|---|---|
| GitHub's | `snapshots` of GitHub's own metrics, scope `us` or `kz` | written |
| GitHub's | `records` with `kind` `repo` | written, whole-list replace |
| GitHub's | `records` with `kind` `pull_request` | written, whole-list replace of the pull requests only |
| GitHub's | pull requests as `kind` `repo`, repositories as `kind` `pull_request`, more than 600, a row with an extra field, or a `url` that is not that row's own on GitHub | `422 invalid_records`, by row |
| GitHub's | `records` with `kind` `pull_request` and `"source"` set to Apollo or a work tool | `422 invalid_envelope` (path `kind`) |
| Apollo's, a work tool's | `records` with `kind` `pull_request` under its own name | `422 invalid_envelope` (path `kind`) |
| any other source's | `records` with `kind` `pull_request` and `"source": "github"` | `403 source_mismatch` |
| a personal token | `"source": "github"` with `kind` `pull_request` | `422 records_not_accepted` |
| GitHub's | `records` with no `kind`, an unknown one, or Apollo's (`sequence`, `stage_count`) | `422 invalid_envelope` (path `kind`) |
| GitHub's | `records` beside `snapshots`, or `kind` without `records` | `422 invalid_envelope` |
| GitHub's | Apollo's rows or a work tool's rows as `repo`, or a row with an extra field | `422 invalid_records`, by row |
| GitHub's | an empty list | `422 invalid_envelope` without `empty`, `422 invalid_records` with it |
| GitHub's | a week's count for the week in progress, a level under another week, another source's metric, a scope that is not a company | `422 invalid_snapshots` |
| GitHub's | `"source"` set to Apollo, a work tool, or any other source | `403 source_mismatch` |
| GitHub's | `deals` or `investors`, `customers`, `plan` | `422 invalid_rows`, `customers_not_accepted`, `plan_not_accepted` |
| Apollo's | `records` with `kind` `repo` | `422 invalid_envelope` (path `kind`) |
| any other source's | `"source": "github"` | `403 source_mismatch` |
| any other source's | GitHub's metrics under its own name | `422 invalid_snapshots` (`records_only` from a work tool's) |
| a work tool's | its own records with `kind` `repo` | `422 invalid_envelope` (path `kind`) |
| a personal token | `"source": "github"` with `kind` `repo` | `422 records_not_accepted` |
| a personal token | `"source": "github"` without a `kind`, or its own tool with one | `422 invalid_envelope` |
| a personal token | GitHub's numbers | `422 records_only` |

### Intercom (`intercom`): Globex's support inbox

Pushed once a day by the Intercom task on the owner's Mac (`docs/setup.md`,
"Intercom"), which builds the file with `pnpm support:envelope`. One envelope, `records` and
`appIdCode` (the workspace's id code, for links into its inbox) and nothing else; no `kind`.
At most 500 conversations; an empty inbox is `"records": [], "empty": true`. The push is the
whole set (every open chat and every chat updated in the last 90 days): a stored chat it
does not hold goes if it is open or was updated in those 90 days; closed chats updated
before are kept until 180 days. A push that would remove more than half of the chats stored
for those 90 days (an empty one over stored chats included) is refused, `422
support_shrank`, and changes nothing, unless it carries `"allowShrink": true` (the register's
precedent); `allowShrink` is refused on any other records push. Each record is a strict object of exactly these fields (any
other refuses the push, in fixed words that quote nothing):

| Field | Meaning |
|---|---|
| `id` | Intercom's id, digits |
| `createdAt`, `updatedAt` | ISO 8601 in UTC; not in the future |
| `state`, `open`, `priority` | `open` / `closed` / `snoozed`; booleans |
| `waitingSince`, `humanRepliedAt`, `lastCustomerReplyAt`, `lastHumanReplyAt` | ISO 8601 or null |
| `origin` | `customer` (app.globex.example.com), `test` (localhost, staging, Intercom's previews), `other` (any other host), `unknown` (no page) |
| `pageArea` | a customer's chat only: `dashboard`, or one or two plain lower-case words under /dashboard joined by `/` (no id, URL or query); else null |
| `finParticipated`, `finOutcome` | whether Fin answered; `assumed_resolution`, `confirmed_resolution`, `escalated`, `negative_feedback` or null (null unless Fin answered) |
| `timeToHumanReply` | seconds to a person's first reply, or null |
| `assignee` | `{ "id", "name" }` (name at most 60 characters, or null), or null |
| `parts`, `reopens`, `rating` | counts, and a rating's score 1–5, or null |
| `articles` | the titles of the help-center articles Fin used, from Globex's own workspace (at most 10, 120 characters each) |

Never a message, a subject, a contact, a customer's name, address or phone, a company, a tag
(tags often hold a name) or a URL: none has a field.

### Records: what is common to the four work tools

`records` is the source's **whole current list**. For Gmail, Calendar and Linear a stored
record that the push does not name is removed; Fireflies notes only accumulate (and drop off 90
days after the meeting). One bad row refuses the whole push and leaves what is stored
untouched. Times are ISO 8601 with `Z` or an offset. Text is cleaned on arrival (control and
direction-override characters removed, cut to the stored length); text over 5,000 characters,
more than 1,000 rows, or a body over 256 KB is refused. An id must be the source's own id, with
no spaces.

An empty list is refused as a failed read. Where "nothing" is the real answer, say so with
`"records": [], "empty": true`:

| Source | `"empty": true` | Why |
|---|---|---|
| `gmail` | accepted | an inbox with nothing waiting is a real state; it clears the list |
| `google_calendar` | accepted | so is a week with no meetings |
| `linear` | refused | a workspace with no issue at all is a failed read |
| `fireflies` | refused | notes accumulate, so there is never nothing to say |

Only send `"empty": true` after a read that succeeded and found nothing.

### Gmail (`gmail`): threads waiting on you

Look at the 50 newest threads in the inbox. For each, take its **last message** (the newest).
The thread is **waiting on you** unless any of these is true of that last message
(`convex/connectors/gmailParse.ts`):

- it carries the label `SENT`, `DRAFT`, `SPAM`, `TRASH`, `CATEGORY_PROMOTIONS`,
  `CATEGORY_SOCIAL`, `CATEGORY_UPDATES` or `CATEGORY_FORUMS` (so a thread you answered last is
  not waiting);
- it has a `List-Unsubscribe` or `List-Id` header; or `Precedence` is `bulk`, `list` or `junk`;
  or `Auto-Submitted` is anything but `no`;
- its `From` has no usable address, or is the owner's own address;
- the part of the address before `@` is `noreply`, `no-reply`, `donotreply`, `do-not-reply`,
  `notification(s)`, `mailer-daemon`, `postmaster` or `bounce(s)`, alone or followed by `+`,
  `.`, `_` or `-` and more.

Decide from labels and headers only. **Never open, read or send a body or a snippet**, not even
to decide. Send one row per waiting thread:

| Field | Required | From |
|---|---|---|
| `threadId` | yes | Gmail's thread id (hexadecimal) |
| `fromAddress` | yes | the address in the last message's `From` |
| `fromName` | no | the display name in that `From`, if any |
| `subject` | no | that message's `Subject` |
| `lastMessageAt` | yes | when that message arrived |

```json
{
  "version": 1, "source": "gmail", "batchId": "gmail-2026-10-12", "observedAt": "2026-10-12T06:05:00Z",
  "records": [
    {
      "threadId": "18c2f0a1b2c3d4e5",
      "fromName": "Ada Example",
      "fromAddress": "ada@example-fund.test",
      "subject": "Made-up subject",
      "lastMessageAt": "2026-10-11T15:04:05Z"
    }
  ]
}
```

### Google Calendar (`google_calendar`): meetings

The primary calendar, from 24 hours ago to nine days ahead, with recurring events expanded into
their single occurrences. Leave out an event that is cancelled, one that is not an ordinary
event (focus time, out of office, working location), and one the owner declined
(`convex/connectors/calendarParse.ts`).

| Field | Required | From |
|---|---|---|
| `eventId` | yes | the event's id (the occurrence's id for a recurring one) |
| `title` | no | the event's title |
| `startsAt`, `endsAt` | a timed event | its start and end |
| `startDate`, `endDate` | an all-day event | its dates, `YYYY-MM-DD`; the end is the day after the last day, as Google gives it |
| `attendees` | no | the **other** guests: `{ "name", "address" }` each, not the owner and not a room or resource; at most 30 |
| `attendeeCount` | no | how many other guests there are in all, when more than you listed |
| `hasMeetingLink` | no | `true` if the event has a video or phone link. Never the link itself |
| `private` | no | `true` for an event whose visibility is private or confidential |

**Private events are "Busy".** For an event marked private or confidential send only `eventId`,
`"private": true` and its times: no title, no attendees. The OS stores it as "Busy"; a private
row that carries a title or guests is refused.

```json
{
  "version": 1, "source": "google_calendar", "batchId": "google_calendar-2026-10-12", "observedAt": "2026-10-12T06:05:00Z",
  "records": [
    {
      "eventId": "evt_made_up_1",
      "title": "Made-up meeting",
      "startsAt": "2026-10-13T09:00:00Z",
      "endsAt": "2026-10-13T09:30:00Z",
      "attendees": [{ "name": "Ada Example", "address": "ada@example-fund.test" }],
      "hasMeetingLink": true
    },
    { "eventId": "evt_made_up_2", "title": "Made-up offsite", "startDate": "2026-10-14", "endDate": "2026-10-16" },
    { "eventId": "evt_made_up_3", "private": true, "startsAt": "2026-10-13T12:00:00Z", "endsAt": "2026-10-13T13:00:00Z" }
  ]
}
```

### Linear (`linear`): the board

Every issue whose state type is `backlog`, `unstarted` or `started`, and every `completed` one
finished in the last 14 days. Not triage, not cancelled. All of them, across every page (at
most 1,000).

| Field | Required | From |
|---|---|---|
| `issueId` | yes | Linear's id for the issue (the UUID) |
| `identifier` | yes | e.g. `ENG-101` |
| `title` | no | the issue's title |
| `url` | no | the issue's own link; must begin `https://linear.app/` |
| `stateType` | yes | `backlog`, `unstarted`, `started` or `completed` |
| `stateName` | no | the state's name, e.g. `In Progress` |
| `teamKey`, `teamName` | no | the team |
| `assigneeName` | no | the assignee's name |
| `mine` | yes | `true` if the issue is assigned to the owner |
| `priority` | no | 0 to 4, as Linear numbers it |
| `dueDate` | no | `YYYY-MM-DD` |
| `updatedAt` | yes | when the issue last changed |

```json
{
  "version": 1, "source": "linear", "batchId": "linear-2026-10-12", "observedAt": "2026-10-12T06:05:00Z",
  "records": [
    {
      "issueId": "0a1b2c3d-0000-4000-8000-000000000001",
      "identifier": "ENG-101",
      "title": "Made-up issue title",
      "url": "https://linear.app/example/issue/ENG-101/made-up-issue-title",
      "stateType": "started",
      "stateName": "In Progress",
      "teamKey": "ENG",
      "teamName": "Engineering",
      "assigneeName": "Ada Example",
      "mine": true,
      "priority": 2,
      "dueDate": "2026-10-20",
      "updatedAt": "2026-10-12T05:00:00Z"
    }
  ]
}
```

### Fireflies (`fireflies`): meeting notes

The 20 most recent meetings, leaving out any held more than 90 days ago (it would be refused).
The summary and action items only: **never the transcript**.

| Field | Required | From |
|---|---|---|
| `meetingId` | yes | Fireflies' id for the meeting |
| `title` | no | the meeting's title |
| `heldAt` | yes | when it was held |
| `durationMinutes` | no | its length in minutes, 0 to 1440 |
| `participants` | no | `{ "name", "address" }` each, at most 30 |
| `overview` | no | Fireflies' short summary (its longer overview if there is no short one); cut at 1,200 characters |
| `actionItems` | no | one string per action item, at most 20 |

```json
{
  "version": 1, "source": "fireflies", "batchId": "fireflies-2026-10-12", "observedAt": "2026-10-12T06:05:00Z",
  "records": [
    {
      "meetingId": "ff_made_up_1",
      "title": "Made-up call",
      "heldAt": "2026-10-10T16:00:00Z",
      "durationMinutes": 30,
      "participants": [{ "name": "Ada Example", "address": "ada@example-fund.test" }],
      "overview": "A made-up summary of the call.",
      "actionItems": ["A made-up action item"]
    }
  ]
}
```

### What comes back from a connector push

As in "What comes back" above, plus:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"inserted":1,"updated":0,"unchanged":4}` | Written. For records, what the push did not name was removed (not counted here). |
| 409 | `source_is_pulled` | The source's own API variables are set in Convex, so the OS reads it itself. |
| 409 | `source_turned_off` | The owner switched this work tool off under Settings → Work tools. Nothing is stored. |
| 422 | `invalid_records` | A row broke a rule; `issues` gives its path (`records.3.fromAddress`) and fixed words, never the row's text. |
| 422 | `records_not_accepted`, `records_only` | Records from a token that carries none, or numbers from a work tool's token. |
| 422 | `invalid_snapshots` | A number the registry refuses, a PostHog week that has not ended, Apollo totals or a GitHub level filed under another week, or an Apollo or GitHub weekly count for the week in progress. |

A work tool's refusals are logged against the source without the sender's `batchId`. What was
pushed is read only by the owner, pruned like a pulled source's (30 days without a good push;
meeting notes 90 days after the meeting), and removed by "Turn off and delete".

## Contacts: people for the Contacts book

Six tokens may send people for `/contacts` (the Contacts book, `convex/contacts.ts`), each in
an envelope of its own: `contacts` and nothing else beside the header. The rules of each token
are fixed in the OS (`CONTACT_PUSH_SCOPES` in `convex/lib/contactPush.ts`), not by the request.

```json
{
  "version": 1, "source": "visible", "batchId": "visible-contacts-2026-10-28", "observedAt": "2026-10-28T06:05:00Z",
  "contacts": [
    { "externalId": "vc_8f2c01", "name": "Jane Example", "emails": ["jane@fund-example.test"],
      "title": "Partner", "linkedExternalId": "inv_8f2c" }
  ]
}
```

`mode` may be left out or be `"upsert"`: **a contacts push only ever adds and updates.** A
person the source no longer lists stays in the book (remove one by hand on `/contacts`, or
merge it). `"replace"` is refused. An empty list is refused as a failed read.

### What each token may send

Every row has `externalId` (the source's own id for the person: no spaces, at most 100
characters, never a name), `name` (the person's own, as words) and `emails` (at most 8, may be
`[]` where shown). The other fields are each token's, and a field a token may not send refuses
the push:

| Token | Lands as | Fields beside the three | Linked to | Phone |
|---|---|---|---|---|
| `visible` | Startup, `investor` | `title`, `org`, `linkedin`, `lastContactAt`, `linkedExternalId` | the investor whose Visible id is `linkedExternalId` | refused |
| `apollo` | Startup, `customer` | `title`, `org`, `linkedin`, `lastContactAt` | nothing (no Apollo deal or account is in the OS) | refused |
| `gmail` | see below, `other` | `lastContactAt`, `interactionCount` (needed), `company` | nothing | refused |
| `google_calendar` | see below, `other` | the same | nothing | refused |
| `fireflies` | see below, `other` | the same | nothing | refused |
| `kz_crm` | Globex, `kz_clinic` | `title` (the role), `org`, `phone`, `lastContactAt`, `linkedExternalId` | the deal whose CRM id is `linkedExternalId` | taken |

- `lastContactAt` is `YYYY-MM-DD`, a real day, not in the future. `interactionCount` is a whole
  number: exchanges (Gmail) or meetings (Calendar, Fireflies) in the twelve months read.
- `linkedin` is an `https://…linkedin.com/…` address or a bare handle. `title` and `org` are
  words: one that looks like an email address or a phone number is refused, and so is a name.
- A linked id that names no record of the OS is not an error: the person is stored unlinked
  and linked by a later push once the record is there.
- **Mail and meetings** (`gmail`, `google_calendar`, `fireflies`): a person needs at least one
  address and a count. Left out, and counted as `excluded` (never refused): an address no
  person answers from (no-reply, do-not-reply, notifications, mailer-daemon, postmaster,
  bounces, newsletter and the like, by the part before the @), an address at the companies' own
  domains (`OWN_EMAIL_DOMAINS` in `convex/lib/features.ts`: example.com, globex.example.com and their
  subdomains), each teammate's and owner's own address and the domain of a teammate's address
  that is not a public provider's (checked by the OS against `members`), and a person with
  fewer than two exchanges (Gmail) or one meeting (Calendar, Fireflies). A person left with no
  address is left out.
- **Which company, for mail and meetings:** Globex's when any of the person's addresses is in
  `.kz`; otherwise the `company` the run sends (`"kz"` when it matched the address's domain to a
  Globex customer or deal), else Startup's. In one-company mode always Startup's, and
  `"company": "kz"` is refused.
- **The Kazakhstan CRM's staff are never patients.** A row that looks like a patient's record (a
  field named for a national id, a birth date, a diagnosis or a policy; or the words patient,
  пациент, науқас, diagnosis, diagnoses, date of birth, ИИН in any text; or twelve digits in a
  row, the length of a national id) is dropped and counted as `dropped`, never stored and never
  quoted. With the second company switched off, the CRM's token is not taken at all.
- At most 2,000 rows a push, and the body's 256 KB: a longer list goes in several envelopes
  (500 rows each keeps well inside), each checked whole. Two rows with the same `externalId`
  or the same address refuse the push.

### How a person is matched, and what a push changes

1. The person this source sent before, by `externalId` (`source` and `externalId` are stored on
   the contact: set by the first push that made or claimed it);
2. else the contact of that company holding any of the addresses;
3. else the contact with the same name (lower case, accents, punctuation and Dr/MD dropped) at
   the same organisation.

Addresses are always united, never replaced (at most 8). On the source's own row its name,
title, organisation, LinkedIn, phone and count are the source's; on any other contact the push
only fills what is empty, takes the later last contact and the larger count, and claims the row
for itself when no source holds it. **What a person typed is never changed by a push:** notes,
owner, how you met, who introduced them, whom they can introduce, and the category. A row whose
addresses are on two contacts, or that matches two contacts by name, or that would go past
2,000 contacts in a company, is left out and counted as `skipped`.

### What comes back

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"inserted":2,"updated":1,"unchanged":40,"linked":1,"skipped":0,"excluded":3,"dropped":0}` | Written. |
| 409 | `source_turned_off` | Gmail, Calendar or Fireflies is switched off under Settings › Work tools: nothing is stored. |
| 422 | `invalid_envelope` | The shape is wrong (`mode: "replace"`, another payload beside `contacts`, an empty list). |
| 422 | `invalid_contacts` | A row broke a rule; `issues` gives its path (`contacts.3.emails.0`) and fixed words, never a value. |
| 422 | `contacts_not_accepted` | The token is not one of the six. |

Every push, good or refused, is logged under its own source on Settings › Sources (`visible_contacts`,
`apollo_contacts`, `gmail_contacts`, `google_calendar_contacts`, `fireflies_contacts`,
`kz_crm_contacts`: each carried on its source's token and having none of its own), with counts
and fixed words only: never a name, an address, a phone number, an id or the sender's `batchId`.
The three from the owner's mail and meetings are shown only with the `personal` area, as the
tools are. A contacts push is taken even while the OS reads its source itself with its API
variables (`source_is_pulled` does not apply to it): the OS's own read brings no people.
`pnpm push:envelope` checks a contacts file with the same rules and prints the kind and counts.

## Personal tokens: a teammate's own Claude

A teammate the owner has given the **Today** page can connect their own Claude: it reads
their own Gmail, Google Calendar, Fireflies and Linear through its connectors, once a day,
and posts a short list from each here. The teammate makes a token on Settings › Connections (`/settings/connections`), which
also shows the whole prompt to paste into a Claude scheduled task (built by
`convex/lib/connectPrompt.ts` from the validator, so it cannot drift from this page).
Nothing in this section needs the repository or `pnpm push:envelope`.

**Only that person is sent what they push.** Not the owner, not another teammate, through any
query. The owner's own records, and the shared Linear board, are untouched by it.

### What a personal token is

- `sos_` followed by 43 URL-safe characters (256 bits). It is shown once, when it is made.
  Only its SHA-256 is stored, so it cannot be shown again or rebuilt: a lost token is replaced.
- One per person. Making a new one, or revoking, stops the old one at once, a push in flight
  included.
- It names a person, not a source. The envelope's `source` says which tool the records are from.
- It is honoured only while its person is a teammate with the Today page. Removing them from
  the team, or unticking Today, deletes the token and everything they held, in one step.
- The owner has none. The owner's records are the deployment's own (the per-source tokens
  above, or the OS's own reads), and a personal push as the owner would replace the Linear
  board the whole team reads.

### What it may write

A `records` envelope, exactly as in "Records: what is common to the four work tools" above
and each tool's section, for `gmail`, `google_calendar`, `linear` or `fireflies`. The rows pass
the same validation and cleaning. The differences:

| | A source's own token | A personal token |
|---|---|---|
| Whose rows | the deployment owner's (no `owner`) | that teammate's (`owner` = their address) |
| A push replaces | the source's list (Gmail, Calendar, Linear) | that person's list of that tool, and no other row |
| Fireflies | accumulates, 90 days | accumulates for that person, 90 days |
| Linear | the shared board | the person's own assigned issues; the board is unchanged |
| Held at most | 1,000 rows a push | 200 threads, 200 events, 500 issues, 300 meeting notes per person |
| Pushes | not limited | 10 per tool per hour, then `429` |
| The owner's "Turn off" switch | refuses the push (`409`) | does not apply |
| "Pulled or pushed" (`409 source_is_pulled`) | applies | does not apply |
| Run log and Settings → Sources | every push and refusal | nothing: said on the person's own Connect page only |
| Removed after | 30 days without a good push | the same, per person; and at once when they leave the team |

### What comes back to a personal token

First match wins. Every reply is an error name, paths and fixed words: never the token, an
address, the sender's `source`, `batchId` or anything a record holds.

| Case | Status | Body |
|---|---|---|
| Unknown, revoked or replaced token; its person removed, without Today, or an owner; anything after `sos_` that is not a token | 401 | `{"ok":false,"error":"unauthorized"}`, the same bytes a wrong source token gets, before the body is read |
| Body over 256 KB | 413 | `payload_too_large` |
| Not JSON | 400 | `invalid_json` |
| Envelope shape wrong, or an unknown field | 422 | `invalid_envelope`, with paths and fixed words |
| Not a records push (`snapshots`, `deals`, `investors`, `customers`, `plan`) | 422 | `records_only`: "This token carries records and nothing else." |
| `source` is not one of the four work tools | 422 | `records_not_accepted`: "A personal token carries records for gmail, google_calendar, linear or fireflies only." |
| Token revoked, or its person removed, since the request arrived | 401 | `unauthorized` |
| More than 10 pushes of this tool in the hour | 429 | `too_many_pushes`: "At most 10 pushes an hour for each tool. Try again later." Nothing changes. |
| A row breaks a rule; an empty list without `"empty": true`; `"empty": true` for Linear or Fireflies | 422 | `invalid_records`, with the row's path and fixed words |
| More rows than one person may hold of the tool | 422 | `too_many_records`: "At most N records of this tool are held for one person." |
| More bytes than one person may hold of the tool (in practice meeting notes, which add up over 90 days) | 422 | `too_much_data`: "At most N KB of this tool's records are held for one person." |
| The write failed | 500 | `write_failed` |
| Stored | 200 | `{"ok":true,"inserted":1,"updated":0,"unchanged":4}` |

A refused or missing push deletes nothing: what the person held stays, with the time it was
last received. Refused pushes count toward the hourly limit, and a new token does not reset
it. From `invalid_records` down, the refusal is noted on the person's own status (the panels
on their Today then say the last read failed).

### Trying it by hand

With a token made on Settings › Connections (`/settings/connections`) of a local deployment, in `$PERSONAL_TOKEN`. The token goes
into a header file only you can read, as the generated prompt does it, and curl reads the
file: a token written after `-H` on curl's command line is shown to every process listing on
the machine.

```bash
dir=$(mktemp -d) && chmod 700 "$dir"
( umask 077; printf 'Authorization: Bearer %s\n' "$PERSONAL_TOKEN" > "$dir/header" )
curl -sS -X POST "$STARTUP_OS_INGEST_URL" \
  -H @"$dir/header" -H "Content-Type: application/json" \
  -d '{"version":1,"source":"gmail","batchId":"gmail-test","observedAt":"2026-10-12T06:00:00Z",
       "records":[{"threadId":"18c2f0a1","fromAddress":"ada@example-fund.test",
                   "subject":"Made-up subject","lastMessageAt":"2026-10-11T15:04:05Z"}]}'
rm -rf "$dir"
```

Expected: `{"ok":true,"inserted":1,"updated":0,"unchanged":0}`, the thread on that teammate's
Today (`/`), and nothing on the owner's Today or under Settings → Sources.

## Standup tasks

After the daily standup a Claude session reads the meeting's summary in Fireflies, decides
what the team took on, and adds the tasks the board does not hold yet to the OS's own
**Tasks** board, in Backlog. The procedure it follows is in `docs/setup.md`,
"Standup → tasks". This section is the contract for the two routes it uses.

They are apart from `POST /ingest/v1`: there is no envelope, no `source` field and no
`batchId`. Nothing is written to Linear, and nothing is written to Fireflies.

### The token

`INGEST_TOKEN_STANDUP`, in the Convex environment and in `.env.push` beside
`STARTUP_OS_INGEST_URL` (the two routes are on the same host as `/ingest/v1`; the scripts work
them out). Made like every other: `openssl rand -hex 32`, its own value. A token another
source shares authenticates neither.

It is checked as the per-source tokens are: in constant time, before anything of the request
but its `Authorization` header is read, with one answer for every way of being wrong.

**It is the only bearer token that can read company data.** Whoever holds it can read the
titles of the board's cards and of Linear's open issues (below), and can add cards to
Backlog. It can read nothing else and change no existing card. Keep it where the other
tokens are kept, and replace it if a machine that held it is lost.

The source shows on Settings → Sources as **Standup tasks**: configured or not, and when it
last ran. Sent to `POST /ingest/v1`, the token writes nothing: the source owns no metric, no
pipeline, no register, no plan and no records.

### `GET /standup/v1/open`: what is already there

So the session can tell what is missing. No body, no parameters.

```json
{
  "ok": true,
  "open":   [{ "title": "Send the pilot contract", "company": "us", "column": "backlog" }],
  "done":   [{ "title": "Renew the domain", "company": null }],
  "linear": [{ "title": "Export fails for large clinics", "company": "kz" }],
  "truncated": false
}
```

| Field | Holds |
|---|---|
| `open` | Every card not in Done: its title, its company (`"us"`, `"kz"`, or `null` for a shared card) and its column (`backlog`, `this_week`, `doing`). At most 500. |
| `done` | Cards finished in the last 14 days, newest first: title and company. At most 200. |
| `linear` | Open issues of the shared Linear mirror (backlog, unstarted, started), newest first: title, and the company of the issue's team (`null` for a team both share). At most 1000 rows read. |
| `truncated` | `true` when any list was cut at its cap. Then a task that cannot be ruled out is treated as already there. |

That is all of it, on purpose: no note, no assignee, no due date, no id, no link, no person.
A teammate's own Linear issues (pushed with a personal token) are never in `linear`. A read
is not a run: it is logged nowhere.

| Status | Body | Meaning |
|---|---|---|
| 200 | as above | |
| 401 | `{"ok":false,"error":"unauthorized"}` | No token, a wrong one, another source's, a personal token, or one two sources share. |
| 503 | `{"ok":false,"error":"ingest_not_configured"}` | `INGEST_TOKEN_STANDUP` is unset, or shorter than 32 characters. |
| 500 | `{"ok":false,"error":"read_failed"}` | The read failed here. |

### `POST /standup/v1/tasks`: the missing tasks

JSON, at most 64 KB.

```json
{
  "version": 1,
  "meetingId": "01KABCDEF0123456789",
  "meetingDate": "2026-10-13",
  "tasks": [
    {
      "key": "a1",
      "title": "Send the pilot contract",
      "company": "us",
      "assignee": "ada@example.test",
      "due": "2026-10-16",
      "kind": "task",
      "context": "Agreed at the standup."
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | `1`. |
| `meetingId` | yes | The meeting's id in Fireflies: 1 to 100 letters, digits, `-` or `_`. Never its title. |
| `meetingDate` | yes | The day it was held, `YYYY-MM-DD`. Not later than tomorrow (UTC). |
| `tasks` | yes | At most 30. An empty list is accepted: the standup was read and nothing was missing. |
| `tasks[].key` | yes | The item's own id within the meeting, stable from one send to the next (`a1`, `a2`, …): 1 to 40 letters, digits, `-` or `_`. Used once per push. |
| `tasks[].title` | yes | At most 200 characters, as every card's. |
| `tasks[].company` | yes | `"us"` (Startup), `"kz"` (Globex), `"shared"` for a card that is both companies' by decision, or `null` when unclear: the OS places it (below). |
| `tasks[].assignee` | no | A work email. See below. |
| `tasks[].named` | no | The name of the person the item names as doing it ("Lena will…"), as it was said: at most 80 characters, never an address. Matched to `people`, kept nowhere. |
| `tasks[].speaker` | no | The name of who said the item, sent only when they took it on themselves ("I will…"). Same rules as `named`. |
| `tasks[].due` | no | `YYYY-MM-DD`. |
| `tasks[].kind` | no | `"task"` (the default) or `"issue"`. |
| `tasks[].context` | no | One short sentence, at most 200 characters. It becomes the card's note. |

There are no other fields: an unknown one, on the push or on a task, refuses the whole push.
Titles and contexts are cleaned as mirrored text is (control characters, direction overrides
and invisible characters taken out, one line); one that is then empty or too long is refused,
never shortened. One bad row refuses the whole push, and every bad row is named.

What the OS does with each task, in order:

1. **Known.** A task is its `meetingId` and `key`. One the OS has taken before, added or
   not, is skipped and counted as `known`. So a push can be sent again safely, and a card
   the team deleted is **not** made again.
2. **Duplicate.** If its title equals that of an open card, or of one finished in the last 14
   days, it is skipped and counted as `duplicate`. Titles are compared without regard to
   letter case, spacing or punctuation (a trailing period among it), and only between cards
   of the same company or where either is shared: Startup's card is no duplicate of Globex
   AI's. This is the backstop for the session's own check, which goes by meaning.
Before the duplicate check, an unclear card (`company: null`) is **placed**: the company its
title and context name (a clinic in `customers`, a deal, a GitHub repository, or the
companies' own words such as "tenge" or "CPT"; a name counts twice a word, and an even split
is no answer), else the one company of the person it is for. A card nothing places stays
shared and is flagged (`needsCompany`): it is listed under "Needs owner" on /board until
someone picks a company on it. `"shared"` is never placed or flagged.

3. **Added** to the bottom of Backlog, where a card typed in lands: with its company, kind
   and due date, the note "From the standup of Oct 13: …" and its origin (the standup, its
   date and meeting id), which the board shows as a "Standup · Oct 13" tag.

Who it is for: `assignee` if it is the owner's or a current teammate's address, else the person
`named` matches, else the `speaker`'s match. A name matches a teammate by the name they signed
in with, its first word or their address's own part, in Latin or Cyrillic letters: exactly
first, then at a similarity of 0.9 or more (Jaro-Winkler), and never when two people fit
equally (`convex/lib/standupMapping.ts`). The person is kept only if they are on the task's
company (any teammate, for a shared card). Otherwise the task is still added, with nobody on
it, and counted in `unassigned` when an address or a name was sent. A push is never refused for a
person the OS does not know, and the address is never sent back or logged.

At most 60 tasks a day (UTC) are taken from this source, added and duplicate together. A push
that would pass that is refused whole; a `known` task never counts.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true,"added":2,"known":0,"duplicate":1,"unassigned":0}` | Done. `unassigned` counts added tasks sent with an `assignee`, `named` or `speaker` that kept nobody. |
| 401 | `{"ok":false,"error":"unauthorized"}` | As for the read. Nothing is logged. |
| 503 | `{"ok":false,"error":"ingest_not_configured"}` | As for the read. |
| 413 | `payload_too_large` | Over 64 KB. |
| 400 | `invalid_json` | The body is not JSON. |
| 422 | `invalid_push` | The shape or a row is wrong. `issues` names each by path in fixed words. |
| 429 | `too_many_tasks` | The day's 60 are taken. `issues`: `tasks`, "At most 60 tasks a day are taken from the standup. Try again tomorrow." |
| 500 | `write_failed` | The write failed here. Nothing was added. |

Every refusal from 413 down has the body `{"ok":false,"error":"…","issues":[…]}`, is logged
against the source and shows on Settings → Sources.

The words an issue can carry, with the paths they appear at:

| Path | Words |
|---|---|
| `push`, `tasks.N` | has a field the OS does not accept |
| any field | is missing or of the wrong type |
| `version`, `tasks.N.company`, `tasks.N.kind` | is not one of the allowed values (said for a missing `version` or `company` too) |
| `meetingId`, `tasks.N.key` | is not in the expected form |
| `tasks` (more than 30), any text far over its length | is too long or too large |
| `tasks.N.title` | is empty |
| `tasks.N.title`, `tasks.N.context` | is too long (200 characters at most) |
| `tasks.N.due`, `meetingDate` | is not a date (YYYY-MM-DD) |
| `meetingDate` | is in the future |
| `tasks.N.key` | repeats an earlier key |

No reply, log line or run-log row ever holds a title, a context, a name or an address: a
success is four counts, and a refusal is an error name, paths and the words above.

### The two scripts

```bash
pnpm -s standup:open                  # the read, as JSON on stdout
pnpm -s standup:push <file.json>      # check the file; prints counts, sends nothing
pnpm -s standup:push <file.json> --send
```

`standup:open` prints titles, which is company data: for a local terminal and the session
reading it, not for a log or a chat. `standup:push` checks the file with the same schema the
endpoint uses (`convex/lib/standup.ts`) and prints the meeting's date and counts, never a
task. Neither prints the token, and neither follows a redirect.

## Vertical Startup's agents (`vertical_agents`)

> **Legacy.** Every project's agents now connect on Agents Protocol v1
> (`docs/agents-protocol.md`): a project token, `GET /agents/v1/config` and
> `POST /agents/v1/usage`. This source and the signed push below are kept, unchanged, for
> Vertical Startup until it moves to the package, and are then removed. What arrives here is
> stored as the project `vertical-startup`.

Vertical Startup's customer-facing AI agents report here once a day, from Vertical Startup's own cron,
and are steered from the Agents page (`/agents`, the `agents` area). **No patient data ever
reaches the OS**: what arrives is daily totals of ids and numbers, and what goes back is
configuration. The source is not split by company: the agents are a product's.

### The token

`INGEST_TOKEN_VERTICAL_AGENTS` in the Convex env, and the same value as Vertical Startup's own variable
for its cron. It carries the three keys below and nothing else: with `snapshots`, `deals`,
`customers`, `records` or a `plan` it is refused (`agents_only`), and no other source's token
may send them (`agents_not_accepted`). Every refusal is a path and fixed words, never a field's
name or a value.

### The envelope

```json
{
  "version": 1,
  "source": "vertical_agents",
  "batchId": "vertical-agents-2026-10-16",
  "observedAt": "2026-10-16T06:00:00Z",
  "agentUsage": [
    {
      "product": "vertical_startup", "agentId": "note-coding.select", "promptVersion": "v1+2e092415",
      "provider": "ai_studio", "model": "gemini-2.5-pro", "day": "2026-10-16",
      "calls": 12, "errors": 0, "schemaFailures": 0, "fallbacks": 0, "refusals": 0,
      "inputTokens": 34000, "outputTokens": 5200, "costUsd": 0.12, "p50Ms": 4100, "p95Ms": 9800
    }
  ],
  "providers": [
    { "provider": "astana_gpu", "model": "made-up-open-72b", "state": "up", "checkedAt": "2026-10-16T05:58:00Z", "lastErrorClass": null }
  ],
  "agentConfigApplied": { "version": 7, "appliedAt": "2026-10-16T05:00:00Z" }
}
```

Any of the three keys, together or alone. An empty list beside something else is fine; a push
with nothing in any of them is refused (an empty read is a failed read).

| Field | Rule |
|---|---|
| `product` | `vertical_startup`, the only product this token speaks for. |
| `agentId` | A dotted slug: lowercase letters, digits, `.`, `-`, `_`, at most 64 (`note-coding.select`, `icd.select`, `draft.appeal`). Not a fixed list. |
| `promptVersion` | Letters, digits, `.`, `+`, `-`, `_`, at most 40 (`v1+2e092415`). |
| `provider` | A slug (`[a-z][a-z0-9_]*`, at most 32). `ai_studio`, `vertex` and `astana_gpu` are the providers the OS knows; **another slug is stored and shown, and cannot be chosen in a change**, so Vertical Startup can add one before the OS is told. |
| `model` | Letters, digits, `.`, `_`, `:`, `/`, `-`, at most 80. |
| `day` | A real UTC calendar day, no later than tomorrow in UTC+14 and no older than 400 days. |
| `calls` … `refusals` | Whole numbers, 0 to 10,000,000; `errors`, `schemaFailures`, `fallbacks` and `refusals` at most `calls`. |
| `inputTokens`, `outputTokens` | Whole numbers, 0 to 10¹². |
| `costUsd` | 0 to 100,000, or null / left out for a model with no price (self-hosted). **Not known, never $0**: a total with an unpriced row is "Not priced". |
| `p50Ms`, `p95Ms` | 0 to 3,600,000 ms, `p50Ms` at most `p95Ms`, or null / left out on a day with no timed call. |
| `providers[].state` | `up`, `degraded` or `down` (Vertical Startup sends `up` and `down`). |
| `providers[].checkedAt` | ISO time, not more than five minutes ahead. |
| `providers[].lastErrorClass` | `timeout`, `auth`, `rate_limit`, `server`, `network`, `schema`, or null. Never a message. |
| `agentConfigApplied` | `{ "version": n, "appliedAt": ISO }`; `{ "version": 0, "appliedAt": null }` when nothing was ever applied. |

Every row is a strict object: an unknown field anywhere refuses the whole push. A row twice
(the same product, agent, prompt version, provider, model and day; or the same provider and
model) is refused.

What is stored: usage is upserted by its six-part key, so the same push twice changes nothing
and a later push for the same day overwrites it (a figure no longer sent is dropped, not kept
stale). A provider row is replaced only by a newer `checkedAt`. The applied version only moves
forward. One `syncRuns` row and the source's status, as for any push. The answer is
`{"ok":true,"inserted":…,"updated":…,"unchanged":…}`.

### Steering: what the OS sends back

A change on the Agents page (an agent switched on or off, its model, its fallback, its monthly
budget) is a new config version. The whole config, every agent changed from the OS, is posted
to Vertical Startup, signed:

```
POST ${VERTICAL_STARTUP_URL}/api/admin/agent-config
x-startup-timestamp: <unix seconds>
x-startup-signature: sha256=<hex HMAC-SHA256(VERTICAL_AGENT_CONFIG_SECRET, timestamp + "." + rawBody)>

{ "version": 8, "agents": [ { "agentId": "note-coding.select", "enabled": true, "provider": "vertex",
  "model": "gemini-2.5-pro", "fallbackProvider": "ai_studio", "fallbackModel": "gemini-2.5-flash",
  "monthlyBudgetUsd": 40 } ] }
```

`fallbackProvider`/`fallbackModel` and `monthlyBudgetUsd` are left out when not set. An agent
never changed from the OS is not in the body, and Vertical Startup keeps its own settings for it.
`VERTICAL_STARTUP_URL` must be an https origin with nothing after it; the request follows no
redirect. The secret is a Convex env variable only: never in a table, a reply or a log.
Unset, the page says steering is not connected and names the variables; a change is still
recorded, as "Not sent".

A change is **pending** until Vertical Startup says it applied that version or a later one, in the
answer or in `agentConfigApplied` of its next push. Vertical Startup's answers, each a key on the
change (never its words):

| Answer | Shown as |
|---|---|
| 200 `{"appliedVersion": n}` | Sent; applied once `n` is at least the change's version. |
| 200 `{"appliedVersion": n, "stale": true}`, `n` above ours | Not sent: Vertical Startup holds a newer version. "Send the latest config again" sends it as a version above `n`. |
| 200 with `stale` at exactly our version | Applied before: a repeat. |
| 400 | Rejected: an agent or provider it does not know, or a malformed body. |
| 401 | The signature or its time was not accepted. |
| 413 | Too large (over 64 KiB). |
| 502 | Vertical Startup could not store it. |
| 503 | Steering is not set up on Vertical Startup's side. |
| anything else, or no answer | Refused, or could not be reached. |

A model may be chosen only among the provider and model pairs Vertical Startup last reported `up`, on
a provider the OS knows, or the one the agent already has. Only Vertex AI is for real patient
data; Google AI Studio and the Kazakhstan GPU are not, and the page says so beside each.

`pnpm push:envelope <file.json>` checks an agents file with the endpoint's rules and prints
counts only.
