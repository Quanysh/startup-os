# Agents Protocol v1.3

How a project's AI agents are steered from Startup OS. The **agents run inside each project**,
and patient data never leaves it: Startup OS stores configuration and daily totals only. A
project fetches what its agents should run, and reports what they did once a day. A TypeScript
package (`@startup/agents`: v0.3.0 for v1.1, v0.4.0 for v1.2, v0.5.0 for v1.3) implements the project's side; this
is the contract it is built to.

**v1.1** (2026-10-16, additive: a v1 package keeps working) lets the owner manage each agent's
**harness** from the OS: its prompt templates, model parameters, tools and output schema. The
code declares its defaults in the usage report (`agentsKnown[].harness`); the OS keeps
versions (draft → test → publish, every one kept), sends the published one in the config
(`agents[].harness`), and tests a draft through the project: `GET /agents/v1/jobs` hands out
test jobs, `POST /agents/v1/jobs/{id}/results` takes their results. A prompt is a template
(the project fills its `{{variables}}` in); a test case is made-up data, never a real patient.

**v1.2** (2026-10-16, additive: v1.1 shapes stay valid, and a v0.3.0 package keeps working) is
what wiring a real project (Startup Atlas) needed: templates up to **128 KB** and a whole harness
up to **512 KB**; **sections** in templates (`{{#name}}…{{/name}}`, `{{^name}}…{{/name}}`);
**prompt variants** the code picks at call time (`variants`, `default` among them); agents that
send **their own conversation** (`input: "messages"`: only the system prompt is a template);
and **tools built into the provider** (`kind: "provider"`), which test runs skip. A test case
may name a variant, and a messages agent's case carries its conversation.

**v1.3** (2026-10-17, additive: v1.2 shapes stay valid, and a v0.4.0 package keeps working) lets
the owner **create agents from scratch** on `/agents`: a **declarative** agent is defined in
Startup OS entirely (instructions, model, tools from the project's catalogue, other built agents
as sub-agents, an output schema, triggers and limits) and the package's runtime runs it inside
the project from the config, with no code change. The usage report gains the project's **tool
catalogue** (`toolsCatalog`) and **run summaries** (`runs`: ids, states and numbers, no text);
the config carries a published built agent as `kind: "declarative"` with its `definition`; a
test job may test one (its draft definition, its sub-agents, fixtures for their tools). An agent
may also be built to run **in Startup OS itself** (the project `startup-os`; not run yet, below).

Code: `convex/agentsApi.ts` (the four routes), `convex/agentProjects.ts` (projects, tokens, the
internal half), `convex/lib/agentProjects.ts` (rules and words), `convex/lib/agentShape.ts`
(the report's shape), `convex/agentControl.ts` (launches and changes), `convex/agentHarness.ts`
(harness versions, test cases, runs, jobs, publishing), `convex/lib/agentHarness.ts` (the
harness's shape and rules), `convex/lib/agentTemplate.ts` (templates, v1.2), `convex/lib/agentSchemaCompat.ts` (output schema compatibility),
`convex/lib/agentJobs.ts` (cases, leases, results, the publish gate), and (v1.3)
`convex/agentBuilder.ts` (creating and saving a built agent, its runs, a project's tools),
`convex/lib/agentBuilder.ts` (the catalogue, runs and a definition's rules), `convex/lib/agentCron.ts`
(schedules), `convex/lib/agentBuilt.ts` (what the rules read from the tables) and
`convex/lib/agentStartupOs.ts` / `convex/lib/agentStartupOsTools.ts` (agents that run in Startup OS).
The page is `/agents` (the `agents` area).

## Connecting a project

On `/agents`, **Connect a project** takes a name, an id (the slug: 2 to 40 of `a-z`, `0-9`,
`-`, starting with a letter; `startup-os` is reserved), a region (`US` or `KZ`), whether it
**holds patient data**, and the providers it may use. It shows the project's token **once**,
with the two variables the package reads:

```
STARTUP_AGENTS_URL=https://<deployment>.convex.site
STARTUP_AGENTS_TOKEN=rap_<43 characters>
```

`STARTUP_AGENTS_URL` is this deployment's HTTP origin (`*.convex.site`) and nothing after it:
the package adds the paths below. Set both as the project's secrets, never in git.

- The token is `rap_` and 43 base64url characters (SHA-256 of 32 random bytes drawn by the
  server and 32 by the browser). Only its SHA-256 is stored; it is compared in constant time
  and never returned, logged or shown again.
- **Rotate token** issues a new one and the old one stops at once. **Disconnect** takes the
  token away (the next call is refused, one in flight included); the project's agents, figures
  and changes are kept, and a new token connects it again.
- A project that **holds patient data** fails closed (`failMode: "closed"`) and may only be
  steered to providers for patient data: today `vertex` (`PROVIDER_INFO[…].patientData` in
  `convex/lib/agentControl.ts`; mark another to extend it). `ai_studio` and `astana_gpu` are
  not. A project that does not, fails open and may use any provider it was given. An agent
  the project says handles patient data (`phi: true`) is held to the patient-data providers in
  any project, and the project's card warns if the project is not marked as holding any.

## Authentication, limits and errors

Every route takes `Authorization: Bearer rap_…` and nothing else: a source's ingest token, a
personal token (`sos_…`) and the owner's agent token (`sosa_…`) are refused by their prefix,
before anything is hashed. The token is checked before the body is read, and again inside the
read or write it leads to. **A token reads and writes its own project only**: no field of a
request names a project, and another project's job is answered as one that does not exist.

At most **120 calls in 10 minutes per project**, every route together (a fixed window opened
by the first call; a poll for jobs counts). Each admitted call stamps the project's "last seen".

Every refusal is JSON with an error name and fixed words; nothing the caller sent is quoted (a
path names fields and row numbers; a key the caller chose, such as a variant's name, is said as
`*` unless it has a name's shape, `^[A-Za-z][A-Za-z0-9_]{0,63}$`):

```json
{ "ok": false, "error": "invalid_body", "message": "The body does not follow Agents Protocol v1.1.",
  "issues": [ { "path": "agentUsage.0.errors", "message": "is more than the day's calls." } ] }
```

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | No token, not a `rap_` token, unknown, rotated away, or the project disconnected. One answer for all. |
| 429 | `too_many_requests` | Over the window. Uncounted. |
| 413 | `payload_too_large` | A usage body over 16 MiB, a results body over 14 MiB (declared or read). |
| 400 | `invalid_json` | The body is not JSON. |
| 422 | `invalid_body` | The body breaks a rule below; `issues` holds up to 50, by path. |
| 404 | `not_found` | Results for a job id that is not one of this project's. |
| 409 | `job_closed` | Results for a job already answered, or given up on. |
| 500 | `write_failed` | It could not be stored. Send it again: it is idempotent. |

## GET /agents/v1/config

What the project's agents should run.

```bash
curl -sS "$STARTUP_AGENTS_URL/agents/v1/config" \
  -H "Authorization: Bearer $STARTUP_AGENTS_TOKEN" \
  -H 'If-None-Match: "6"'
```

`200`, with `ETag: "<version>"`:

```json
{
  "project": "startup-atlas",
  "version": 7,
  "agents": [
    {
      "agentId": "search.rank",
      "name": "Search, rank",
      "enabled": true,
      "provider": "ai_studio",
      "model": "gemini-2.5-flash",
      "fallbackProvider": "vertex",
      "fallbackModel": "gemini-2.5-pro",
      "monthlyBudgetUsd": 40,
      "promptVersionPin": "v3+1a2b3c4d",
      "harness": {
        "version": "h7",
        "prompt": { "system": "You rank payer policies…", "user": "Query: {{query}}" },
        "params": { "temperature": 0.2, "maxOutputTokens": 2048, "thinkingBudget": 1024, "timeoutMs": 60000, "retries": 1 },
        "tools": ["web_search"],
        "output": { "schema": { "type": "object", "required": ["ranked"], "properties": { "ranked": { "type": "array" } } } }
      }
    }
  ],
  "failMode": "open"
}
```

- `version` is the project's config version: 0 until anything is launched or changed from Startup
  OS, then one more with each launch or change. `If-None-Match: "<version>"` (or `W/"<version>"`,
  or a list holding it) answers **`304`** with no body while the version is the same.
- `agents` holds every agent launched or changed from Startup OS, in id order; an agent never
  steered from Startup OS is not in it, and the project keeps its own settings for it.
  `fallbackProvider`/`fallbackModel` (together), `monthlyBudgetUsd` and `promptVersionPin` are
  left out when not set. `name` is its launch name, else what the project's catalogue calls it,
  else its id.
- **`kind` and `definition` (v1.3)** are sent only for an agent built in Startup OS and published:
  `kind: "declarative"`, and `definition` as in "Agents built here" below. Such an agent has no
  top-level `harness` (its harness is inside its definition). Every other agent is as before.
- **`harness` (v1.1)** is the agent's **published** harness version, sent only while one is
  published: `version` its name (`h` and its number, `h7`), and only the parts that differ from
  the code's defaults. **A part left out is the code's own.** `prompt` is every variant the
  code declares (v1.2), in the shape the project's code sent its defaults in: `{ variants: {
  "<name>": { system, user? } } }` where its report sent `variants` (a v0.4.0 package), else
  v1.1's `{ system, user }` for the one variant `default` with a user template (a v0.3.0
  package; anything else as `variants`). Templates: `{{name}}` is a variable the project fills
  in, and sections are below. `params` is the whole set and
  **replaces the code's parameters entirely** (not merged key by key; a parameter it leaves out
  is not sent); `tools` is the ids switched on (every other declared tool off); `output.schema`
  is the JSON Schema the model's answer must follow. While a harness version is applied, the
  agent's usage rows carry `version` as their `promptVersion` (`h7`). A publish or rollback is a
  new config version, like any change.
- `failMode` is `"closed"` for a project that holds patient data and `"open"` otherwise: what
  the project does when it cannot reach Startup OS (closed: run nothing; open: keep the last config
  it applied).

## POST /agents/v1/usage

What the agents did, once a day (or more often: it is idempotent).

```bash
curl -sS -X POST "$STARTUP_AGENTS_URL/agents/v1/usage" \
  -H "Authorization: Bearer $STARTUP_AGENTS_TOKEN" \
  -H "Content-Type: application/json" \
  --data @usage.json
```

```json
{
  "batchId": "startup-atlas-2026-10-16",
  "observedAt": "2026-10-16T06:00:00Z",
  "agentUsage": [
    {
      "agentId": "search.rank", "promptVersion": "v1+2e092415",
      "provider": "ai_studio", "model": "gemini-2.5-flash", "day": "2026-10-16",
      "calls": 120, "errors": 1, "schemaFailures": 0, "fallbacks": 0, "refusals": 0,
      "inputTokens": 340000, "outputTokens": 52000, "costUsd": 0.42, "p50Ms": 900, "p95Ms": 2100
    }
  ],
  "providers": [
    { "provider": "ai_studio", "model": "gemini-2.5-flash", "state": "up", "checkedAt": "2026-10-16T05:58:00Z", "lastErrorClass": null }
  ],
  "agentsKnown": [
    {
      "agentId": "search.rank", "name": "Search, rank", "phi": false, "kind": "declarative",
      "harness": {
        "prompt": {
          "version": "v1+2e092415",
          "system": "You rank payer policies…",
          "user": "Query: {{query}}\nPayer: {{payer}}",
          "variables": [ { "name": "query", "required": true }, { "name": "payer", "required": false } ]
        },
        "params": { "temperature": 0.2, "maxOutputTokens": 2048, "thinkingBudget": 1024, "timeoutMs": 60000, "retries": 1 },
        "tools": [ { "id": "web_search", "name": "Web search", "description": "Searches the web.", "phi": false } ],
        "defaultTools": ["web_search"],
        "output": { "schemaVersion": "1", "schema": { "type": "object", "required": ["ranked"], "properties": { "ranked": { "type": "array" } } } }
      }
    }
  ],
  "configApplied": { "version": 7, "appliedAt": "2026-10-16T05:00:00Z" }
}
```

`200`:

```json
{ "accepted": { "agentUsage": 1, "providers": 1, "agentsKnown": 1, "inserted": 2, "updated": 1, "unchanged": 0 },
  "configVersion": 7 }
```

`accepted` counts the rows of each list taken, and how the stored rows moved (usage and provider
rows inserted, updated or unchanged; the applied version counts as updated or unchanged); v1.3
adds `toolsCatalog` and `runs`, the rows of each taken, where they were sent.
`agentsKnown` (v1.3) also lists the declarative agents the project can run now
(`kind: "declarative"`, no `harness`): one built here is kept "Built here", and never launched.
`configVersion` is the project's latest config version: above the one it holds, it should fetch
the config.

**Every key is required** (but `agentsKnown[].harness`, v1.1, and v1.3's `toolsCatalog` and
`runs`); a list may be empty. Every
object is strict: an unknown field anywhere refuses the whole report (so a row cannot carry
`project` or `product`). The body is at most 16 MiB (512 KiB in v1, 4 MiB in v1.1: harness
defaults ride in it, and since v1.2 each may be 512 KB; each changed one is stored by a write of
its own).

| Field | Rule |
|---|---|
| `batchId` | 1 to 100 of letters, digits, `.`, `_`, `:`, `+`, `-`, starting with a letter or digit. |
| `observedAt` | ISO time, not more than five minutes ahead. |
| `agentUsage[]` | At most 1,000 rows. The same rows, with the same rules, as the legacy `vertical_agents` source (`docs/ingest.md`), **without `product`**: `agentId` a dotted slug (lowercase letters, digits, `.`, `-`, `_`, at most 64); `promptVersion` letters, digits, `.`, `+`, `-`, `_`, at most 40 (`v1+2e092415`); `provider` a slug; `model` letters, digits, `.`, `_`, `:`, `/`, `-`, at most 80; `day` a real UTC day, no later than tomorrow in UTC+14 and no older than 400 days; `calls` … `refusals` whole numbers 0 to 10,000,000 with each part at most `calls`; tokens 0 to 10¹²; `costUsd` 0 to 100,000, or null / left out when not priced; `p50Ms` ≤ `p95Ms`, 0 to 3,600,000, or null / left out. A row twice (same agent, prompt, provider, model and day) is refused. |
| `providers[]` | At most 100. `state` `up`, `degraded` or `down`; `checkedAt` ISO, not more than five minutes ahead; `lastErrorClass` `timeout`, `auth`, `rate_limit`, `server`, `network`, `schema` or null, never a message. A provider and model twice is refused. |
| `agentsKnown[]` | At most 200: the agents the project can run. `agentId` as above; `name` 1 to 60 of letters, digits, spaces and `. , : ( ) & ' / + _ -`; `phi` whether it handles patient data; `kind` `code` or `declarative`. An id twice is refused. `harness` (v1.1, optional) below. |
| `agentsKnown[].harness` | The code's harness defaults (v1.1). **Every part is optional**: an agent with no templates leaves out `prompt`, a free-text agent leaves out `output`. Within a part every field is required (but those marked v1.2). **The whole harness, as JSON, is at most 512 KB** (v1.2). `prompt` is v1.1's `{ version, system, user, variables }` or v1.2's `{ version, input?, variables, variants }`, never both: `version` as `promptVersion` above; `input` (v1.2) `text` (left out: `text`) or `messages`; `system` and `user` (v1.1) templates; `variants` (v1.2) 1 to 12 by name (`^[a-z][a-z0-9_]{0,31}$`), `default` among them, each `{ system, user? }`: `user` in every variant of a `text` agent, in none of a `messages` agent's; every template at most 128 KB (UTF-8; 32 KB in v1.1); `variables` at most 30, each `{ name, required }`, `name` a lowercase letter then up to 39 letters, digits and `_` (`^[a-z][a-zA-Z0-9_]{0,39}$`), no name twice. `params`: any of `temperature` 0 to 2, `maxOutputTokens` a whole number 1 to 65,536, `thinkingBudget` 0 to 32,768, `timeoutMs` 1,000 to 600,000, `retries` 0 to 3 (whole numbers), nothing else. `tools`: at most 40, each `{ id, name, description, phi, kind? }`, `id` a lowercase letter then up to 63 of `a-z`, `0-9`, `_`, `.`, `-`, no id twice; `name` as an agent's; `description` at most 500 characters; `phi` whether the tool handles patient data; `kind` (v1.2) `function` (left out: `function`), a tool the code runs, or `provider`, one built into the provider (Gemini's search, say), which test runs skip. `defaultTools`: at most 40 ids, each a declared tool, none twice. `output`: `schemaVersion` as `promptVersion` above, `schema` a JSON Schema object of at most 64 KB. |
| `configApplied` | `{ "version": n, "appliedAt": ISO }`, or `{ "version": 0, "appliedAt": null }` when nothing was ever applied. `appliedAt` not more than five minutes ahead. |
| `toolsCatalog[]` | **v1.3, optional** (left out: the stored catalogue is kept). At most 200: the tools the project can execute. Each `{ id, name, description, phi, kind, inputSchema, effect, approvable }`, strict: `id` `^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$`, no id twice; `name` 1 to 200 characters; `description` at most 4,096; `phi` whether its result is patient data; `kind` `function` or `provider`; `inputSchema` a JSON Schema object of at most 16 KB; `effect` `read` or `write`; `approvable` **`true` for every `function` tool and `false` for a `provider` one** (it runs inside the model call, so nothing can gate it; a provider tool is `read`). Every `write` tool needs a person's approval before each call. Stored only when it changed (a SHA-256 of its canonical JSON), a slice a write, and replaced as a whole: a tool no longer sent is dropped. |
| `runs[]` | **v1.3, optional.** At most 500 run summaries changed since the last report; **no text**. Each `{ runId, agentId, version, trigger, parentRunId?, status, startedAt, durationMs, steps, costUsd, errorClass, toolCalls }`, strict: `runId` `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` (`run_` and 128 random bits), no run twice; `agentId` as above; `version` the definition version it ran (`h3`; letters, digits, `.+_:#-`, at most 64); `trigger` `api`, `schedule`, `subagent`, `chat` or `test` (a run the host started itself for testing; test jobs are not runs); `parentRunId` the caller's run, required for a `subagent` run, never the run itself; `status` `ok`, `error`, `refused`, `awaiting_approval`, `denied` (finished, with at least one call a person denied) or `timeout`; `startedAt` ISO, not more than five minutes ahead; `durationMs` 0 to 30 days, whole; `steps` 0 to 1,000, whole; `costUsd` 0 to 1,000 or null (not priced); `errorClass` null or one of `timeout`, `auth`, `rate_limit`, `server`, `network`, `schema`, `agent_off`, `over_budget`, `phi_not_allowed`, `config_unavailable`, `provider_not_configured`, `max_steps`, `invalid_input`, `depth_exceeded`, `subagent_failed`, `store`; `toolCalls` at most 100, each `{ toolId, status, approval? }` with `status` `ok`, `error`, `denied` or `skipped` and `approval` `approved`, `denied` or `pending`. Upserted by `runId` (a run sent again, say once its approval came, replaces what was kept). Kept **90 days** from `startedAt`: an older one is taken (and counted) but not kept, and a daily purge drops the rest. |

A v1.2 agent's harness, as a v0.4.0 package sends it (an agent declared the v1.1 way arrives
the same, as one variant `default` with `input: "text"`, and every tool carries its `kind`):

```json
{
  "prompt": {
    "version": "v2+0a1b2c3d",
    "input": "text",
    "variables": [ { "name": "query", "required": true }, { "name": "denial", "required": false } ],
    "variants": {
      "default": { "system": "You answer policy questions.{{#denial}}\nDenied: {{denial}}.{{/denial}}", "user": "Query: {{query}}" },
      "retry": { "system": "Answer again, citing the policy.{{^denial}} No denial given.{{/denial}}", "user": "Query: {{query}}" }
    }
  },
  "tools": [
    { "id": "lookup_codes", "name": "Code lookup", "description": "Looks codes up.", "phi": false, "kind": "function" },
    { "id": "google_search", "name": "Google search", "description": "The provider's own search.", "phi": false, "kind": "provider" }
  ],
  "defaultTools": ["lookup_codes", "google_search"]
}
```

An agent that sends its own conversation says `"input": "messages"`, and its variants have a
`system` template only.

**Missing is not zero.** A day with no row is a gap, not zero calls; a null cost is "not
priced", never $0; a null latency is "no timed call". Send only what was measured.

What is stored, all as the token's project's: usage upserted by (project, agent, prompt version,
provider, model, day), so the same report twice changes nothing and a later one for the same day
overwrites it (a figure no longer sent is dropped, not kept stale); a provider row replaced only
by a newer `checkedAt`; the applied version moved forward only; and each known agent added to the
project's catalogue (its name, `phi` and `kind` updated; an agent no longer listed is kept). Its
harness defaults (v1.1) are the latest the project sent: stored again only when they change (by a
SHA-256 of their canonical JSON), and kept as they are by a report that leaves `harness` out. A
v1.1 prompt is stored as it was sent; the OS reads it as the one variant `default`, `text` input.

## Templates (v1.2)

A template is text with four tags, and nothing else:

| Tag | Renders |
|---|---|
| `{{name}}` | The variable's value. |
| `{{#name}}…{{/name}}` | The body, when the variable is a **non-empty string** (whitespace only counts as non-empty). |
| `{{^name}}…{{/name}}` | The body, when the variable is empty or absent. |

- A section's body may hold `{{name}}` tags. **Sections do not nest**, there are no loops, and
  every section is closed by `{{/name}}` of its own name.
- **No whitespace is trimmed** around a section's tags: a tag alone on its line leaves a blank
  line. Rendering is **one pass**: a value is never read for tags.
- Names are variable names (`^[a-z][a-zA-Z0-9_]{0,39}$`), written exactly, with no spaces inside
  the braces. A section's name is a use of its variable.
- The project renders; Startup OS only checks (`parseTemplate` in `convex/lib/agentTemplate.ts`)
  and has no preview. Each problem is placed at its **line and column** (both from 1): a
  `{{…}}` that is not a name, a section opened inside another ("sections do not nest"), a close
  with nothing open or of another name, a section never closed (placed where it opens).

## Harnesses (v1.1, v1.2)

On `/agents`, an agent's **Harness** tab shows what is live (its published version, or "Using
the project's built-in prompt") and the code's defaults ("No prompt template declared",
"Free-text output" where the code declares none). A **draft** starts from the published version
or from the code's defaults; one draft at a time. Its editor holds every part as it would run:
the system and user templates (the declared variables as chips to insert, and a diff against
what is published), one editor a variant with a switcher that counts each one's problems
(v1.2; the system template alone for an agent that sends its own conversation, "This agent
sends its own conversation; only the system prompt is editable"), sections marked behind the
text, every model parameter (published parameters replace the code's whole set),
the declared tools to switch on, and the output schema with its compatibility shown as it is
typed. A part the same as the code's is kept as the code's. Each save that changes a part is a
new **revision**: a test run is of one revision.

A version is checked against these rules before it is tested, published or rolled back to
(`harnessProblems` in `convex/lib/agentHarness.ts`; the same function the page shows):

- **Variants** (v1.2): every variant the code declares, and no other: each may be edited, none
  dropped or renamed (so `default` is always there). A `text` agent's every variant has a user
  template; a `messages` agent's none. (A code that declares no prompt: the one variant
  `default`, with system and user.) The package falls back to its code's text for a variant
  it is not sent, so the OS is the only guard: a draft that breaks this is neither tested nor
  published, nor rolled back to.
- **Templates**: each at most 128 KB; sections as above, each problem with its variant, line
  and column (`prompt.retry.system, line 2, column 13: opens a section inside {{#denial}}:
  sections do not nest.`).
- **Variables**: the templates use only declared variables, and **every required one at least
  once, in any variant** (a section's name counts), as `{{name}}` exactly.
- **Size**: the draft as it would run, as JSON, is at most 512 KB.
- **Tools**: declared ids only, each once, at most 40. A tool that handles patient data
  (`phi: true`) only while the agent runs on providers for patient data (Vertex AI), its
  fallback included; and once published, it holds the agent to them (a model change to another
  provider is refused), as an agent that handles patient data is.
- **Output schema**, against the code's (`convex/lib/agentSchemaCompat.ts`, the package's own
  rules): every property the code requires stays, required, with the same type, recursively
  through objects and arrays; a property optional in the code may be dropped, and where it is
  kept it keeps its type; a property may be added only as optional (a new required one is
  refused); an enum may be widened, never added where the code has none, narrowed or dropped;
  descriptions and every other keyword may change. Each refusal names its path into the output
  (`$.codes[].kind`). **An incompatible schema can be neither tested nor published**: a
  project given one runs the code's schema instead, so a run would test something else.
- **Parameters**: temperature 0 to 2, output tokens 1 to 65,536, thinking 0 to 32,768, timeout
  1 to 600 seconds, retries 0 to 3.
- **The gate**: a draft is published only if its latest finished test run is of the draft as it
  is now (its revision) and every case passed every expectation on every model chosen (a
  result missing is not a pass). The **owner** alone may publish without that, saying why
  (kept with the publish).

**Publishing** makes the version live: the agent's desired state names it (`harnessVersion`), as
a new config version (pending until the project applies it), the version is published and the
one before archived, and the publish is recorded with who, when and the config version.
**Rolling back** publishes an older version that was published before, again, the same way (a
new config version; the rules are asked again, the test gate is not). Every version is kept:
the **Versions** tab lists them with who made and published each and when, a diff against what
is published, and every publish and rollback. The owner and engineers publish and roll back
(below).

## Test jobs (v1.1)

On the **Tests** tab: test cases, each `{ name, variables, variant?, messages?, toolFixtures?,
expect[] }`, saved only when ticked as **made-up data, never a real patient**; at most 50 an
agent, each at most 64 KB (32 KB in v1.1). v1.2: `variant` is one the code declares (left out:
`default`); a `messages` agent's case **must** carry `messages`, its conversation, 1 to 50 of
`{ role: "user" | "assistant", content }` (text only, each at most 32 KB, not blank), and a
`text` agent's case must not; both are refused when the case is saved, and asked again before a
run. A fixture for a provider tool is refused (test runs skip it). A **run** takes the draft as it is now, 1 to 4 models (pairs its project last reported
`up` on a provider it may use, for patient data where the agent or a switched-on tool handles
it) and 1 to 50 cases (each giving every required variable, only declared variables, and
fixtures only for declared tools; v1.2: a declared variant, a conversation exactly where the
agent sends its own, no fixture for a provider tool). It is a **job** the project picks up.

### GET /agents/v1/jobs

```bash
curl -sS "$STARTUP_AGENTS_URL/agents/v1/jobs" -H "Authorization: Bearer $STARTUP_AGENTS_TOKEN"
```

`200` (an empty list when there is none):

```json
{
  "jobs": [
    {
      "id": "k17a…",
      "agentId": "search.rank",
      "harness": {
        "version": "draft-h8.3",
        "prompt": { "system": "…", "user": "Query: {{query}}" },
        "params": { "temperature": 0.7, "maxOutputTokens": 2048 },
        "tools": ["web_search"],
        "output": { "schema": { "type": "object" } }
      },
      "models": [ { "provider": "ai_studio", "model": "gemini-2.5-flash" } ],
      "cases": [
        {
          "id": "j57b…",
          "variables": { "query": "made-up knee brace coverage" },
          "variant": "retry",
          "toolFixtures": { "web_search": { "hits": [] } },
          "expect": [
            { "path": "$.ranked", "exists": true },
            { "path": "$.ranked[0].policyId", "matches": "SAMPLE-\\d+" },
            { "path": "$.ranked[0].policyId", "equals": "SAMPLE-101" },
            { "path": "$.tags", "contains": "brace" }
          ]
        }
      ]
    }
  ]
}
```

- Only this project's jobs, oldest first, **at most 2 a poll**. A job handed out is **leased for
  10 minutes** (marked running) so two pollers do not both run it; once its lease runs out with
  no results it is handed out again, and after its **third** lease runs out it is given up on
  (`expired`).
- `harness` is the draft as it would run: every part the draft or the code has (the draft's
  own, else the code's), `version` `draft-h<number>.<revision>`. A part neither has is left out.
- `toolFixtures` is left out when the case has none; `variant` (v1.2) when it is `default`;
  `messages` (v1.2) for any agent but a `messages` one, whose cases always carry it:
  `"messages": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": "…" } ]`.
- `harness.prompt` is every variant as it would run, in the shape the config uses (above). Each expectation is a `path` into the
  output (`$`, then `.name` or `[n]` parts) and exactly one of `equals` (any JSON), `contains`
  (a value the array holds, or text the string holds), `exists` (`true`/`false`) or `matches`
  (a pattern of at most 200 characters, **anchored**: the whole value must match,
  `^(?:pattern)$`; no backreferences or nested quantifiers such as `(a+)+`, refused when the
  case is saved).

### POST /agents/v1/jobs/{id}/results

```json
{
  "results": [
    {
      "caseId": "j57b…", "provider": "ai_studio", "model": "gemini-2.5-flash",
      "output": { "ranked": [ { "policyId": "SAMPLE-101", "score": 0.92 } ] },
      "schemaValid": true,
      "assertions": [ { "index": 0, "passed": true }, { "index": 1, "passed": true } ],
      "latencyMs": 820, "inputTokens": 1150, "outputTokens": 60, "costUsd": 0.0004,
      "error": null, "skippedTools": ["google_search"]
    }
  ]
}
```

`200 { "accepted": 1 }`, and the job is **closed** (done): one post carries every result. Strict
like the usage report. `results` at most 200 (50 cases × 4 models); each is one of the job's
cases on one of its models, once; `output` any JSON of at most 64 KB, or null where the model
gave none; `assertions` at most 30, each `index` one of the case's expectations, once; `latencyMs`
0 to 3,600,000; tokens whole numbers 0 to 10⁹; `costUsd` 0 to 1,000 or null (not priced);
`error` `timeout`, `auth`, `rate_limit`, `server`, `network`, `schema`, `refused` (the package's
word for a template that would not render, an unknown agent or a provider it cannot call) or
null; `skippedTools` (v1.2, optional, left out when none) the ids of the tools built into the
provider that the run skipped, at most 40, each a tool the job switched on, once (shown with
the result; it does not fail it). A result **passes** with no error, `schemaValid`, and every expectation passed. The body is
at most 14 MiB. An id not of this project's jobs is `404 not_found`; a job already answered or
given up on is `409 job_closed`. An `output` is the model's answer to made-up data, shown folded
on the Tests tab.

### Test jobs for an agent built here (v1.3)

A run of a built agent's draft is a job like any other, with more in it:

- `kind: "declarative"`, and **`definition`**: the draft's definition as the config would carry
  it (below); its `harness` is the job's `harness` (`version` `draft-h3.2`).
- **`subAgents`**: `[ { agentId, definition } ]`, every published built agent the draft calls,
  however deep (at most 20; a run of a draft that calls more is refused when it is made).
- each case may carry **`subAgentFixtures`**: `{ "<sub-agent tool id>": { "<tool id>": answer } }`,
  the answers to that sub-agent's own tools at any depth. A key must be the tool id of a sub-agent
  the agent may call (checked when the case is saved and again before a run). `toolFixtures`
  answers the agent's own tools, and a sub-agent's tool id there answers it without running it.
- **No tool executes in a test**: each call is answered from a fixture, so approvals do not
  apply; a sub-agent runs on the case's model.
- A result may also carry **`steps`** (0 to 1,000: the agent's model turns) and **`toolCalls`**
  (at most 100, `{ toolId, status }`, `status` `ok`, `error` or `skipped`: no fixture), shown
  with the result. A run of an agent built to run in Startup OS is no job: Startup OS runs it itself,
  the same way (every tool from a fixture, sub-agents on the case's model), and records the
  results as a project's would.

## Agents built here (v1.3)

On `/agents`, **Create agent** takes where it runs (a connected project, or "Startup OS (runs
here)"), its id (as an agent's; not one the project already reported, launched, ran or built),
a name (as an agent's), a description (1 to 500 characters), what it takes (variables, or a
conversation) and the model it starts on: **`gemini-3.8-flash` on Google AI Studio**
(`DEFAULT_BUILDER_MODEL`) where the project may use AI Studio, none for a project that holds
patient data. It is a draft (`h1`, revision 1), with an empty prompt, an API endpoint on and
steps 10, a time limit of 2 minutes. Its **Builder** tab (in place of the Harness tab) sets the
rest; it is tested on the Tests tab and published with the gate, as any harness is.

A published built agent goes out in the config as:

```json
{
  "agentId": "triage.requests", "name": "Request triage", "enabled": true,
  "provider": "ai_studio", "model": "gemini-3.8-flash",
  "kind": "declarative",
  "definition": {
    "name": "Request triage",
    "description": "Sorts made-up requests.",
    "input": { "mode": "text", "variables": [ { "name": "request", "required": true } ] },
    "harness": {
      "version": "h3",
      "prompt": { "variants": { "default": { "system": "Sort the request.", "user": "Request: {{request}}" } } },
      "params": { "temperature": 0.2 },
      "tools": ["policy.search", "claim.note", "lookup"],
      "output": { "schema": { "type": "object" } }
    },
    "triggers": {
      "api": true,
      "schedule": { "cron": "0 6 * * 1-5", "variables": { "request": "made-up daily sweep" } },
      "subAgent": { "toolId": "triage", "description": "Sorts a request." },
      "chat": { "enabled": true, "title": "Help", "greeting": "Ask me." }
    },
    "approvals": ["claim.note"],
    "limits": { "maxSteps": 8, "timeoutMs": 60000, "monthlyBudgetUsd": 20 }
  }
}
```

- `harness` is the published version's parts whole, the prompt **always** as `variants`;
  `version` is its name and the definition's version (usage rows and runs carry it). `tools`
  are catalogue ids and other built agents' `subAgent.toolId`s; `output` only where it answers in
  JSON. The model is the agent's own `provider` and `model` beside it; the published version's
  limits' budget is its `monthlyBudgetUsd` too.
- `schedule`, `subAgent` and `chat` are left out when off (`chat` is sent only enabled). The cron
  goes out with single spaces.
- The endpoints are the project's own (the package's handlers, behind the app's sign-in):
  `POST /api/startup-agents/run/{agentId}` and the chat box at `/api/startup-agents/chat/{agentId}`,
  embedded as `<StartupAgentChat agentId="…" />`. Startup OS never calls them.

**The rules** (`declarativeProblems`, one pure function the Builder asks as it is typed and the
server asks before a test run, a publish and a rollback; to test, the model and a trigger are
not needed yet):

- a name, a description; variables at most 30, each a variable's name, none twice;
- instructions: the `default` variant's system prompt written; the harness rules (templates,
  sections, sizes, parameters, the output schema a JSON Schema object), against the agent's own
  variables and variants (any may be added or dropped but `default`); a variables agent's every
  variant has a message template, a conversation agent's none;
- a model, and a fallback (both or neither, not the model itself), each on a provider the project
  may use (for patient data where it holds it). Its id is checked for form only, **not** for
  having been reported up (the Builder says "The project has not reported this model up yet");
- tools: at most 40, none twice, each in the project's catalogue or the tool id of another built
  agent of the project, **published and offered as a sub-agent**;
- **every `write` tool it uses is in `approvals`**; `approvals` only names tools it uses, and
  never a `provider` tool (a sub-agent may be approved);
- a tool for patient data, or a sub-agent that uses one however deep, only where the model and
  its fallback are on providers for patient data (Vertex AI);
- sub-agents: **no cycle and at most 3 deep** over the project's whole graph (this draft, every
  other built agent as published; a triggered run is depth 0, its sub-agent 1); **no sub-agent
  that cannot run** (one of its tools gone from the catalogue, however deep); while others call
  its published tool id, it keeps it;
- a schedule: a valid cron (five fields in UTC: minute, hour, day of the month, month, day of
  the week; `*`, numbers, `a-b`, `*/n`, `a-b/n` and lists; 0 or 7 Sunday; both days set, either
  runs it; it must run some time), **for a variables agent only**, giving only its variables,
  every required one, each at most 2,000 characters. The Builder shows the next three runs in UTC;
- a chat box **for a conversation agent only**, with a title (as a name) and a greeting (at most
  500 characters);
- a sub-agent's tool id not a catalogue tool's nor another agent's, and a description;
- at least one way to start it (API, schedule, sub-agent, chat) to publish;
- limits: steps 1 to 30, the time limit 1 second to 10 minutes (whole milliseconds), a budget as
  an agent's.

Publishing sets the agent's model, fallback, name and budget from the definition (launching it
the first time, as a new config version, pending until applied). Its row changes its switch and
budget; a model change there is refused (it is the definition's: draft, test, publish). A new
draft starts from the agent's live model.

On the agent: a **Runs** tab (the newest 200 of the last 500 runs, by state and trigger, each
with the sub-agent runs it started under it, what waits for approval, a download), and on each
project a **Tools** tab (the catalogue: reads or changes data, patient data, approval, the
agents that use each tool, its input schema).

### Agents that run in Startup OS (`startup-os`)

The same tables, rules and tabs, under the slug `startup-os`, **with no patient data ever**:

- **Tools** are the owner's agent tools (`convex/lib/mcpTools.ts`, the chat runner's own left
  out): a read tool `read`, an act tool `write` (so always approved), none for patient data,
  each with the area a person needs for it (`STARTUP_OS_TOOL_AREAS`).
- **A tool of an owner-only area** (payroll, costs, settings, team, the owner's own: `personal`)
  may be used only by an agent **the owner publishes**, directly or through a sub-agent; such an
  agent's runs are the owner's alone (the Runs query refuses anyone else).
- **Providers** are Startup OS's own: Google AI Studio (`GOOGLE_GENAI_API_KEY`) and the Astana GPU
  (`OPEN_MODELS_BASE_URL`, `OPEN_MODELS_API_KEY`), each shown "not configured" until its Convex
  variables are set (names only). Vertex AI is not offered yet.
- **Startup OS runs them** (since 2026-10-17; `convex/agentRuntime.ts`): with **Run now** on the
  Runs tab (the owner's; recorded as trigger `api`), on their **schedule** (checked each minute,
  each due minute run once), as another Startup OS agent's **sub-agent** (in process, at most 3
  deep), and in **test runs** (every tool answered from the case's fixtures), so the gate works
  as for a project. Tools run as the owner, each tool's page checked. **A `write` tool, or any
  tool in `approvals`, pauses the run**: the owner sees the call and its arguments on
  `/approvals` (the Runs tab says "N waiting → Approvals") and approves (it runs, once) or
  denies with a reason, kept on the call (the model is told only that it was denied). Runs and daily usage are
  the same rows a project reports (cost "Not priced": no price is known); a run's answer is kept
  for 90 days, for whoever may read the agent's runs and holds every page its tools read.
- **No chat box** (refused at save and publish: the chat is the one on `/assistant`) and **no
  API endpoint** yet.
- **The owner's own four** (`chief_of_staff`, `engineering`, `sales`, `finance`; since
  2026-10-17, `convex/lib/osAgents.ts`) are agents of `startup-os` too, seeded once an owner has
  signed in with h1 from their code's defaults (`docs/agents/`), and the owner's alone (read,
  changed, tested and published by nobody else; their ids are reserved). Their switch is the
  Assistant's (`agentSettings`). Each **runs on** `claude_mac` (the default: the Mac's runner,
  through `POST /mcp/v1`, with the runner-only tools `os_agents_due`, `os_agent_start` and
  `os_agent_finish`) or
  `gemini` (this runtime), a control change with its record; the runtime's schedule skips one
  on the Mac and the Mac is never handed one on Gemini. One on the Mac is not tested here (no
  Claude runs in Startup OS): it is published with the owner's override and a reason. Its Mac
  runs are rows of `agentRuns` too (`runner: "mac"`), made of its calls.

## Launching and changing

On `/agents`, **Launch agent** picks a project, then an agent from its catalogue (what its last
report said it can run) or an id its code will report (shown as "Waiting for the project to
report it" until it does), a name, a model and fallback among the provider and model pairs the
project last reported `up` on a provider the OS knows and the project may use, a monthly budget,
a prompt version pin, and its switch. A change to an agent's row (its switch, model, fallback,
budget or pin) is held to the same rules, or keeps the model it has. Each is a new version of
that project's config. It is **pending** until the project's `configApplied.version` reaches it.

## Who may

Everything here is the `agents` area's: viewing, connecting, launching, changing, and an
agent's drafts, test cases and runs, and (v1.3) creating and drafting an agent built here, its
runs and a project's tools. **Publishing and rolling back a harness** go live in a
project, so they are the **owner's and the engineers'**: the owner, or a teammate with both
`agents` and `engineering` (`mayPublish` in `convex/agentHarness.ts`; asked by area, never by
role: the engineer's starting pages hold both, and so do the co-founder's). Publishing without
a passing test run is the owner's alone, with a reason. An agent built to run in Startup OS that
uses a tool of an owner-only area is the owner's alone to publish, and its runs the owner's.

## Vertical Startup, the legacy project

Vertical Startup (`vertical-startup`) still reports on the `vertical_agents` ingest source and is steered by
the signed push to `${VERTICAL_STARTUP_URL}/api/admin/agent-config` (`docs/ingest.md`, "Vertical
Startup's agents"). Both are **legacy**, kept unchanged for its open pull request, and are to be
removed when Vertical Startup moves to the package. Until then:

- its rows land under the project `vertical-startup` (made by its first push: US, holds patient
  data, Vertex AI only). Rows from before projects carry no project and are read as its; run
  `npx convex run agentProjects:adoptLegacyRows` once after the deploy (until it returns
  `{ "stamped": 0 }`) to stamp them. Each legacy push also stamps a batch;
- a change to it is pushed the legacy way while `VERTICAL_STARTUP_URL` and
  `VERTICAL_AGENT_CONFIG_SECRET` are set, or while it has no token. With a token and no legacy
  steering, it fetches its config like any project;
- the legacy push carries no harness: a published harness reaches Vertical Startup only once it
  fetches its config with a token (and runs a v0.3.0 package);
- **Issue a token** on its card connects it the new way, with the same project and history.

## Startup OS's own agents

Startup OS's four agents (`chief_of_staff`, `engineering`, `sales`, `finance`) are the internal
project `startup-os`: never token-connected. They run on the owner's Mac through Claude and are
not priced. Their card is the owner's alone: each one's switch (the Assistant's own) and its
calls in seven days from the record of what the owner's Claude called.
