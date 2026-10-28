# Questions

## About the product

**Who is Startup OS for?**
A founder running a small company with a handful of teammates, who wants the numbers, the
pipelines and the week's work in one place, and wants AI help without letting AI change things
on its own. The owner can add up to 50 teammates.

**Is it a finished product I can sign up for?**
No. It is a template: source code you copy, run on your own Convex and Vercel accounts, and
change. There is no hosted version and no support contract.

**What does it cost to run?**
The code is free (AGPL-3.0). You pay for what you run it on: Convex and Vercel both have free
plans (check their pricing pages for your size), and you pay for any AI model you choose to
use for the agents.

**Does it replace my accounting software, CRM or bank?**
No. It reads totals from them and shows them together. Startup OS stores aggregates (money in and
out per month, not each transaction), and Sales and Fundraising are light pipelines, not a full
CRM. Payroll is a record of what you pay; *"It is not tax advice."*

**Can it run for two companies?**
Yes: a parent and a subsidiary, or two companies the same founder runs. Turn on
`secondCompany` ([Make it yours](customize.md#add-a-second-company)). The second company can
keep its money in another currency.

**Which currencies does it support?**
US dollars and Kazakhstani tenge. Other currencies are not available yet
([details](customize.md#change-the-currency)).

**Is there a weekly review page?**
Not yet: `/review` only leads back to Today. [How it works](overview.md#a-weekly-rhythm)
suggests a weekly routine with the pages that exist.

**Is there a mobile app?**
No. The web app works in a phone's browser, and the Telegram bot tells people about tasks
assigned to them.

## About access and safety

**Who can see salaries?**
Only the owner. Payroll and Costs can never be given to anyone else, whatever their role, and
no token, agent or bot can read payroll.

**Can a teammate see my email?**
No. Each person's mail, calendar and meeting notes are theirs alone. The owner never sees a
teammate's, and no teammate sees the owner's or another teammate's.

**Can an AI agent change things without me?**
Not unless you allow it. Agents and bots *propose*; the change waits on Approvals until you
approve it. Two exceptions you control: a bot you give *write* permission on a page may make
direct edits there (move a task, update a deal), and *earned autonomy* lets one simple kind of
proposal through after ten clean approvals, until you take it back. Drafts are never sent
anywhere.

**What data leaves to an AI model?**
Only what the AI client you connected asks for through the MCP server, within that client's
scope and pages. Payroll, people's own mail, tokens and the team's settings are never given to
any token. The built-in agents send what they read to the model they run on: through Claude
Code on the owner's Mac, or to Google's Gemini if you choose that.

**Why Google sign-in only?**
The access list relies on Google vouching for each email address. There is no password,
magic link or anonymous sign-in, on purpose.

**What happens if I remove a teammate?**
They are signed out at once. Their personal token and their own mail, calendar and notes in the
app are deleted.

**How do I report a security problem?**
Privately, through the repository's security advisories. See [`SECURITY.md`](../../SECURITY.md).

## About data

**Why does a page say "Not known yet" instead of zero?**
Because the number has not arrived, and zero would be a lie. A missing number is never shown as
zero, and a total missing a part says which part.

**Can I import a spreadsheet?**
Not directly. Turn the rows into an *envelope* and push it to `POST /ingest/v1`
([Make it yours](customize.md#add-a-data-source)). Some figures can be typed in on Finance ›
*Record a figure*.

**Can I export my data?**
Tables have a CSV download, which holds exactly what you are shown and nothing more. Contacts
has none, on purpose: it holds real people's details.

**Where are the benchmarks from?**
Each band cites its published source and year, in `src/lib/metrics/benchmarks.ts`. A rate gets
no verdict until there is enough data behind it.

## About developing

**Do I need to know how to code?**
To try it and use it: no. To set it up for real: you follow [the setup guide](../setup.md) and
edit a few values in two files; comfort with a terminal helps. To add pages or data sources:
yes, or with Claude Code, which reads [`CLAUDE.md`](../../CLAUDE.md) by itself.

**How do I keep my copy up to date with this template?**
Add this repository as a second remote and merge its `main` into yours. Updates to the template
are ordinary commits on `main`, so a merge works; expect conflicts in files you changed, such
as `identity.ts` and `features.ts`.

**Can I contribute back?**
Yes. Read [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
