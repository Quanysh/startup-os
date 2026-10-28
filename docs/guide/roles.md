# Roles: who sees what

Startup OS has one **owner** and any number of **teammates** (up to 50). What a teammate may open
is the list of pages the owner ticks for them on **Settings › Team**. A **role** only ticks a
starting set of pages and orders their Today page. It never grants anything by itself: you can
tick or untick any page after choosing a role, and the role stays as a label.

Three roles are built in: **co-founder**, **sales** and **engineer**. The owner can also name
more on the *Roles* card of the Team page (for example "Marketing" or "Customer success"),
each with a focus and its usual pages.

## At a glance

| Page | Owner | Co-founder | Sales | Engineer |
|---|:-:|:-:|:-:|:-:|
| Today: the company's numbers (*scorecard*) | ✓ | ✓ | ✓ | |
| Today: your own day (*today*) | ✓ | ticked per person | ticked per person | ticked per person |
| Board and Handoffs | ✓ | ✓ | ✓ | ✓ |
| Goals (read) | ✓ | ✓ | ✓ | ✓ (with the board) |
| Editing goals | ✓ | ✓ | | |
| Targets (set) | ✓ | sensitive | sensitive | sensitive |
| Finance | ✓ | ✓ | | |
| Product | ✓ | ✓ | | ✓ |
| Engineering | ✓ | ✓ | | ✓ |
| Agents | ✓ | ✓ | | ✓ |
| Sales, Customers | ✓ | ✓ | ✓ | |
| Go to market (with marketing) and LinkedIn | ✓ | ✓ | ✓ | |
| Fundraising, Partnerships, Compliance, Memory | ✓ | ✓ | | |
| Outcomes (on deals, customers and partners) | ✓ | ✓ | | |
| Contacts | ✓ | ticked per person | ticked per person | ticked per person |
| Settings › Sources and Telegram | ✓ | sensitive | sensitive | sensitive |
| Settings › Team | ✓ | sensitive | sensitive | sensitive |
| Approvals, Assistant | ✓ | never | never | never |
| Payroll, Costs | ✓ | never | never | never |

- **✓** the role starts with it.
- **ticked per person:** in no role's starting set. The owner (or a manager) ticks it for one
  person by name. *Today* is a person's own mail and calendar; *Contacts* holds real people's
  details.
- **sensitive:** only the owner can give it, one person at a time, and choosing a role unticks
  it again. *Settings* lets the person change figures on the dashboard, set targets, run
  sources and change where the bot posts (never see a token). *Team* lets them add and remove
  people and choose their ordinary pages.
- **never:** the owner's alone, whatever is ticked.

A ticked page does not lift a company rule: with two companies, a teammate on one company sees
only that company's rows, and Fundraising and Go to market belong to the first company.

## The owner

The owner is the address (or addresses) in the server's `OWNER_EMAILS` setting. Not a row on
the Team page, and never removable from the app.

**Sees:** every page, every company.

**Can change:** everything, and some things only the owner can: approve or reject proposals,
give the sensitive pages, name roles, add bots and decide what each may do, make tokens for AI
clients, connect Google, set a person's Telegram and GitHub usernames, close a handoff.

**A daily routine (15 minutes):**

1. Open **Today**. Read the brief and the opening line.
2. Work down **Needs you**, top to bottom: failed sources and overdue dates first.
3. Clear **Approvals**. Reject with a reason when a proposal is wrong: the agent learns from it.
4. Glance at **Finance** if anything about cash moved.

**A weekly routine (45 minutes, Monday):**

1. **Goals and targets:** is each goal still on track? Change the status honestly.
2. **Board:** agree with the team what goes into *This week*.
3. **Settings › Sources:** anything late, out of date or failed?
4. **Memory:** record last week's decisions, with the reason and a date to look again.
5. Once a month: **Payroll** (mark the month as paid) and **Costs**.

## Co-founder

**Starts with:** every ordinary page: the scorecard, Finance, Product, Engineering, Sales,
Customers, Compliance, Fundraising, Partnerships, Outcomes, Go to market (and marketing),
the Board, Editing goals, Memory and Agents. Not Today's own day, Contacts or the sensitive
pages unless the owner ticks them. Never Payroll, Costs, Approvals or the Assistant.
Today is arranged for the founder: what needs attention, then money.

**Can change:** tasks, goals, deals, investors, partners, compliance records, decisions and
notes, LinkedIn posts, and a customer's note and next touch.

**Daily:** Today, then the Board. Move your cards; pick up anything in *Needs you*.

**Weekly:** Goals and targets with the owner. Sales and Fundraising: update the stage and next
step of each deal and investor you own. Record decisions in Memory.

## Sales

**Starts with:** the scorecard, Sales, Customers, Go to market (with marketing) and the Board.
Today is arranged for sales: your tasks, then the deals.

**Can change:** deals (stage, priority, next step, intelligence), a customer's note and next
touch, LinkedIn posts, and tasks on the board.

**Daily:**

1. Today: your tasks, then deals that have gone quiet.
2. **Sales:** set a next step and a date on every open deal you own.
3. **Board:** move your cards.

**Weekly:**

1. **Sales:** move deals between stages; archive the dead ones.
2. **Go to market:** how did outbound do last week, and how many meetings were booked?
3. **Customers:** anyone *At risk*? Note why and when you will get in touch.

## Engineer

**Starts with:** Product, Engineering, the Board and Agents. Today is arranged for
engineering: your tasks, then pull requests and product health. (Without the scorecard or
the today page, an engineer starts on the Board.)

**Can change:** tasks on the board. With both Agents and Engineering: publish or roll back a
connected project's agent instructions.

**Daily:**

1. **Engineering:** review requests waiting on you, and anything *stuck*.
2. **Board:** move your cards; flag a *Problem* when something is broken.

**Weekly:**

1. **Product:** did weekly users, signups or activation move? Why?
2. **Agents:** any agent with a rising error rate or cost?

## Named roles

The owner names a role on Settings › Team › *Roles*: a name, a focus (which orders Today) and
its usual pages. Ordinary pages only: never a sensitive page, Today's own day, Contacts,
Payroll or Costs. Changing a named role's pages changes nobody's access; it only changes what
the form ticks next time. A role people still hold cannot be deleted.

The form suggests names to start from: Product, Marketing, Customer success, Operations,
Finance, Designer, Doctor/Clinical and Advisor. The made-up data of `pnpm dev:local` has two of
them, so you can try them: `pnpm dev:signin marketing` and `pnpm dev:signin success`.

## Try each role locally

```bash
pnpm dev:signin owner
pnpm dev:signin cofounder
pnpm dev:signin sales
pnpm dev:signin engineer
```

Each signs your browser in as a made-up person with that role's pages, so you can see exactly
what they would see.
