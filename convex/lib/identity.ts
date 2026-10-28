// Who this OS is: the product, its address, the companies it is run for and
// how they look. Everything else reads its names, domain and legal names from
// here.
//
// **Make it yours:** the values below are placeholders ("Startup OS", the company
// "Startup", the address os.example.com). Put your product's name and slug, your
// app's host, your company's name, legal name and currency in, and draw your
// logo in src/components/startup-logo.tsx (`LOGOS` in brand-logo.tsx names it).
// The second company ("kz", "Globex") is there for the types only: the
// `secondCompany` switch in convex/lib/features.ts is off, so it is never
// shown. Then update the pinned values in convex/lib/deployment.test.ts.
//
// Pure constants. Imported by Convex functions, the Next.js app (as
// `@convex/lib/identity`) and the scripts alike, so it reads no environment
// and imports nothing at run time. Where an environment variable names the
// same thing on a deployment (SITE_URL in Convex, NEXT_PUBLIC_OS_URL in the
// app), that variable still decides there; what is here is the fixed value
// the code holds itself.
//
// Colours are not here: the palette is in src/styles/globals.css (the brand
// colours, a neutral slate as shipped: `--color-brand`, `--color-brand-fill`,
// `--color-brand-deep`, and `--chart-1`), and the logo artwork in
// the components `LOGOS` names (src/components/brand-logo.tsx). The app icon
// is src/app/icon.svg, where Next.js looks for it.
//
// **Some values here are live contracts.** Changing them on a running
// deployment breaks what is already out there; a fresh fork picks its own:
// - `TELEGRAM_WEBHOOK_LABEL`: the Telegram webhook's secret is derived from it,
//   so a new value refuses every update until the webhook is registered again.
// - `HEADER_PREFIX`: bots, the Mac's runner and the bot-events receivers send
//   or check these header names.
// - `TOKEN_STEM`: every token already issued begins with it.
// - `PRODUCT.slug`: the MCP server's name in Claude's configuration, the
//   runner's allow-list and the stored id of the OS's own agent project.
// - `LAUNCHD_LABEL`: the installed launchd agent on the owner's Mac.
// - A company's `hashtags`: what the Telegram groups type to name its board.

/** The product: what the app, its MCP server and its tokens are called. */
export const PRODUCT = {
  /** As people read it: titles, the sign-in page, OAuth's consent. */
  name: "Startup OS",
  /** The tag set beside a company's logo. */
  shortName: "OS",
  /** One line, no closing stop: the page description and the sign-in page. */
  description: "The company's internal operating system",
  /** As machines read it: the MCP server's name, User-Agent, the agent project's id. */
  slug: "startup-os",
  /** The logo the sign-in and refusal pages show (a key of `LOGOS`). */
  logo: "startup",
} as const;

/** The app's public host, and its origin (https, no closing slash). */
export const APP_HOST = "os.example.com";
export const APP_URL = `https://${APP_HOST}`;

/** The browser's title: a page's own, then the product's name. */
export const PAGE_TITLE = { template: `%s · ${PRODUCT.name}`, default: PRODUCT.name } as const;

/** Every custom HTTP header begins with this. */
export const HEADER_PREFIX = "X-Startup";
/**
 * The custom headers. `agent` and `run` are sent to POST /mcp/v1 by bots and
 * the Mac's runner (convex/lib/osAgents.ts); the other three sign what the OS
 * sends out (convex/lib/botEvents.ts, convex/agentPush.ts).
 */
export const HEADERS = {
  agent: `${HEADER_PREFIX}-Agent`,
  run: `${HEADER_PREFIX}-Run`,
  timestamp: `${HEADER_PREFIX}-Timestamp`,
  signature: `${HEADER_PREFIX}-Signature`,
  previousSignature: `${HEADER_PREFIX}-Signature-Previous`,
} as const;

/** The first three letters of every token the OS issues (`sos_`, `sosa_`, `soso_` and the rest). */
export const TOKEN_STEM = "sos";

/** What the Telegram webhook's secret is an HMAC of (convex/lib/telegramCommand.ts). Never change it on a live deployment. */
export const TELEGRAM_WEBHOOK_LABEL = "startup-os-webhook-v1";

/** The launchd agent that keeps the Mac's runner going (scripts/assistantLaunchd.ts). */
export const LAUNCHD_LABEL = "ai.startup.os.assistant";

/** A drawn logo, by name: src/components/brand-logo.tsx holds the artwork of each. */
export type LogoId = "startup" | "globex";

export type CompanyIdentity = {
  name: string;
  /** Where it operates, as the switch shows it beside the name. */
  marketLabel: string;
  /** The company as the law and the bank name it. */
  legalName: string;
  /** The company that owns this one, for a subsidiary. */
  parent?: "us" | "kz";
  /** Its logo in the sidebar. */
  logo: LogoId;
  /**
   * The currency its money is kept in: its bank, costs, pay and budget, and
   * what its own Finance lens shows. One the OS knows (`CURRENCIES` in
   * convex/lib/metricRegistry.ts); a figure in another company's currency is
   * converted at the stored rate, US dollars to tenge (`fx_usd_kzt`).
   */
  currency: "USD" | "KZT";
  /**
   * The hashtags that name its board in a Telegram group (convex/lib/telegramCommand.ts),
   * without the "#", in lower case. The first is the one the bot and the
   * settings page show; the rest are read as well. Its id ("#us", "#kz") is
   * always read too. A live contract: groups already type them.
   */
  hashtags: readonly [string, ...string[]];
};

/**
 * The companies, by their internal id (convex/lib/company.ts: the id is the
 * market, and stays "us" and "kz" in every fork). Whether the OS is run for
 * the second ("kz") at all is the `secondCompany` switch in
 * convex/lib/features.ts: off (as the template ships), "us" is the only
 * company and the "kz" entry here is never shown, though a fork keeps one for
 * the types. Turn it on and fill this entry in to run the OS for a second
 * company, a subsidiary (`parent`) or not.
 */
export const COMPANY_IDENTITY = {
  us: { name: "Startup", marketLabel: "US", legalName: "Startup Inc", logo: "startup", currency: "USD", hashtags: ["startup"] },
  kz: {
    name: "Globex",
    marketLabel: "KZ",
    legalName: "Globex LLP",
    parent: "us",
    logo: "globex",
    currency: "KZT",
    hashtags: ["globex", "globexai"],
  },
} as const satisfies Record<"us" | "kz", CompanyIdentity>;
