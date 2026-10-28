// Published benchmark bands for a seed-stage (under $1M ARR) B2B SaaS company,
// each with the page it came from. Researched October 2026.
//
// Rules:
// - `derived: true` means the band's edges were set here from the source's
//   quartiles or stated figures; the source does not publish them as a band.
//   The tile says so.
// - Figures that could not be confirmed on a primary page are not in this
//   file at all (Carta seed-to-A data, DocSend funnel counts, Mixpanel
//   stickiness).
// - Every source is US/EU data. Do not show a band on a Kazakhstan-scope tile.
// - Where reputable sources disagree, `alt` names the other number.

export type Benchmark = {
  id: string;
  label: string;
  /** Which direction is good. */
  better: "higher" | "lower";
  /**
   * The typical band, low to high. A verdict is always relative to this band:
   * a value outside it is weaker or stronger than typical, so the label can
   * never contradict the band printed beside it. Where a source gives
   * quartiles, this is the range between the lower and upper quartile.
   */
  typical: readonly [number, number];
  /** The published bands as text: weak / typical / strong. */
  bands: string;
  /** What a Series A investor looks for, when the source gives one. */
  seriesA?: string;
  derived: boolean;
  source: { name: string; url: string; year: string };
  /** A reputable source that disagrees. */
  alt?: string;
  caveat?: string;
};

export type Verdict = "weaker" | "typical" | "stronger";

/** Place a value against the typical band. A value on either edge is typical. */
export function classify(value: number, benchmark: Benchmark): Verdict | null {
  if (!Number.isFinite(value)) return null;
  const [low, high] = benchmark.typical;
  if (value >= low && value <= high) return "typical";
  const above = value > high;
  return above === (benchmark.better === "higher") ? "stronger" : "weaker";
}

export const BENCHMARKS = {
  runway_months: {
    id: "runway_months",
    label: "Runway",
    better: "higher",
    typical: [12, 18],
    bands: "<12 / 12–18 / ≥18 months",
    seriesA: "Start the raise with 12 months left",
    derived: true,
    source: {
      name: "Kruze Consulting",
      url: "https://kruzeconsulting.com/blog/startup-runway/",
      year: "2024",
    },
    caveat: "Kruze's own client base. Under 6 months is critical.",
  },
  burn_multiple: {
    id: "burn_multiple",
    label: "Burn multiple",
    better: "lower",
    typical: [2, 3],
    bands: ">3 / 2–3 / <1.5",
    seriesA: "≤1.5–2",
    derived: true,
    source: {
      name: "David Sacks, The Burn Multiple",
      url: "https://sacks.substack.com/p/the-burn-multiple-51a7e43cb200",
      year: "2020",
    },
    alt: "Scale Venture Partners observed an average of 3.4x at $0–1M ARR (2022).",
    caveat: "Undefined when net new ARR is zero or negative. Use a trailing 6–12 months.",
  },
  mrr_growth_mom: {
    id: "mrr_growth_mom",
    label: "MRR growth, month over month",
    better: "higher",
    typical: [15, 25],
    bands: "<10% / 15–25% / >25%",
    seriesA: "T2D3 from $2M ARR",
    derived: true,
    source: {
      name: "Lenny's Newsletter investor survey",
      url: "https://www.lennysnewsletter.com/p/what-is-a-good-growth-rate",
      year: "2022",
    },
    caveat: "Investor opinion rather than a dataset; acceleration matters more than level.",
  },
  arr_growth_yoy: {
    id: "arr_growth_yoy",
    label: "ARR growth, year over year",
    better: "higher",
    typical: [20, 100],
    bands: "20% / 40% / 100% (25th / 50th / 75th percentile under $1M ARR)",
    seriesA: "14% / 28% / 50% at $1–3M ARR",
    derived: false,
    source: {
      name: "SaaS Capital",
      url: "https://www.saas-capital.com/wp-content/uploads/2025/06/RB33WS5-2025-B2B-Benchmarking-Private-SaaS-Company-Growth-Rates.pdf",
      year: "2024",
    },
    alt: "High Alpha (2025) reports medians of 75% for SaaS and 100% for AI-native.",
    caveat: "Sample includes bootstrapped and older companies.",
  },
  gross_margin_ai: {
    id: "gross_margin_ai",
    label: "Gross margin, AI-native",
    better: "higher",
    typical: [45, 55],
    bands: "<40% / 45–55% / ≥60%",
    seriesA: "About 60% and rising",
    derived: true,
    source: {
      name: "ICONIQ, State of AI",
      url: "https://www.iconiq.com/growth/reports/state-of-ai-2026",
      year: "2025–2026",
    },
    alt: "Bessemer (2025): efficient AI startups about 60%, hyper-growth ones about 25%.",
    caveat: "Inference must be counted in cost of revenue. Classic SaaS runs 75–80%.",
  },
  logo_churn_monthly: {
    id: "logo_churn_monthly",
    label: "Monthly logo churn, SMB",
    better: "lower",
    typical: [3, 5],
    bands: ">5% / 3–5% / <2%",
    seriesA: "≤2%",
    derived: true,
    source: {
      name: "Tomasz Tunguz",
      url: "https://tomtunguz.com/saas-innovators-dilemma/",
      year: "2015",
    },
    alt: "ChartMogul (2023) shows a median near 2–3% at $25–1K monthly revenue per account.",
    caveat: "With few customers one loss moves this a lot; read it alongside the count.",
  },
  gross_revenue_retention: {
    id: "gross_revenue_retention",
    label: "Gross revenue retention",
    better: "higher",
    typical: [85, 95],
    bands: "<85% / ~90% / ≥95%",
    seriesA: "≥90%",
    derived: true,
    source: {
      name: "SaaS Capital",
      url: "https://www.saas-capital.com/wp-content/uploads/2025/09/RB32WS1-2025-B2B-SaaS-Retention-Benchmarks.pdf",
      year: "2024",
    },
    alt: "Benchmarkit median 88%; Ebsta × Pavilion 82%.",
    caveat: "The source excludes companies under $1M ARR.",
  },
  arr_per_employee: {
    id: "arr_per_employee",
    label: "ARR per employee",
    better: "higher",
    typical: [50_000, 100_000],
    bands: "<$50K / $56K median / $100K top quartile",
    seriesA: "$136K median at $1–5M ARR",
    derived: true,
    source: {
      name: "High Alpha",
      url: "https://highalpha.com/blog/is-your-team-overstaffed-for-the-ai-era-b2b-saas-company-benchmarks",
      year: "2025",
    },
    caveat: "Noisy at small scale.",
  },
  cac_payback_months: {
    id: "cac_payback_months",
    label: "CAC payback",
    better: "lower",
    typical: [6, 24],
    bands: "24 / 16 / 6 months (lower quartile, median, upper quartile)",
    seriesA: "≤12–18 months",
    derived: false,
    source: {
      name: "Aleph × Benchmarkit",
      url: "https://www.getaleph.com/answers/cac-payback-period-saas-2026",
      year: "2025",
    },
    alt: "David Skok: 5–7 months is good, anything beyond 12 is slow.",
    caveat: "Founder-led sales understates sales and marketing cost.",
  },
  win_rate_new_logo: {
    id: "win_rate_new_logo",
    label: "New-logo win rate",
    better: "higher",
    typical: [15, 25],
    bands: "<15% / ~19% / >25%",
    derived: true,
    source: {
      name: "Ebsta × Pavilion GTM Benchmarks",
      url: "https://benchmarks.ebsta.com/2025-gtm-benchmarks",
      year: "2024–2025",
    },
    caveat: "Depends on what counts as an opportunity.",
  },
  cold_email_reply_rate: {
    id: "cold_email_reply_rate",
    label: "Cold email reply rate",
    better: "higher",
    typical: [3.4, 4.5],
    bands: "<2% / 3.4–4.5% / >5.5%",
    derived: true,
    source: {
      name: "Instantly Cold Email Benchmark Report",
      url: "https://instantly.ai/cold-email-benchmark-report-2026",
      year: "2025",
    },
    alt: "Hunter (2025) reports 4.5% overall and 3% for sales emails.",
    caveat: "Vendor platform data.",
  },
  activation_rate: {
    id: "activation_rate",
    label: "Activation rate",
    better: "higher",
    typical: [25, 35],
    bands: "<20% / 25–35% / >40%",
    derived: true,
    source: {
      name: "Lenny's Newsletter",
      url: "https://www.lennysnewsletter.com/p/what-is-a-good-activation-rate",
      year: "2022",
    },
    alt: "Userpilot (2024): 34.6% product-led, 41.6% sales-led.",
    caveat: "Definitions of 'activated' differ between products.",
  },
  visitor_to_signup: {
    id: "visitor_to_signup",
    label: "Visitor to signup",
    better: "higher",
    typical: [5, 9],
    bands: "5% free trial, 9% freemium (medians)",
    derived: true,
    source: {
      name: "Lenny's Newsletter with OpenView and Pendo",
      url: "https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion",
      year: "2023",
    },
    caveat: "Two medians for product-led products, used here as the band's edges.",
  },
} as const satisfies Record<string, Benchmark>;

export type BenchmarkId = keyof typeof BENCHMARKS;

/** The ARR a competitive Series A is raised on. A target line, not a band. */
export const SERIES_A_ARR_BAR = {
  low: 2_000_000,
  median: 2_500_000,
  high: 5_000_000,
  source: {
    name: "CRV, Series A metrics VCs expect",
    url: "https://www.crv.com/content/series-a-metrics-vcs-expect",
    year: "2025–2026",
  },
} as const;

/**
 * ARR per employee: reference lines, not a band, and **no verdict is ever
 * drawn from them** (the Assistant page lists them beside the figure).
 *
 * An exception to "confirmed on a primary page", taken on the owner's
 * instruction and said on the tile: each figure below was read on one
 * secondary page (fetched 2026-10-13), which attributes it to the source
 * named. None was read at that source, so each is `verified: false` and the
 * tile says "reported, not verified at source". They describe US and EU
 * software companies, most of them far larger than this one: never show them
 * beside a Kazakhstan figure.
 */
export type ReferenceLine = {
  id: string;
  /** USD of ARR per employee. */
  value: number;
  label: string;
  /** Who the figure is attributed to, and for what. */
  attributed: string;
  /** Whether it was read at the source it is attributed to. */
  verified: boolean;
  source: { name: string; url: string; year: string };
};

const ARR_PER_EMPLOYEE_PAGE = {
  name: "Stealth Agents, ARR per employee benchmarks for startups",
  url: "https://stealthagents.com/research/startup-arr-per-employee-benchmarks-2026",
  year: "2026",
} as const;

export const ARR_PER_EMPLOYEE_LINES: readonly ReferenceLine[] = [
  {
    id: "early_ai_native",
    value: 164_000,
    label: "Early AI-native companies, average",
    attributed: "Bessemer Venture Partners (its early-stage AI cohort)",
    verified: false,
    source: ARR_PER_EMPLOYEE_PAGE,
  },
  {
    id: "investor_floor",
    value: 200_000,
    label: "The floor growth investors look for",
    attributed: "Scale Venture Partners, 2024, for companies at $50M to $100M ARR",
    verified: false,
    source: ARR_PER_EMPLOYEE_PAGE,
  },
  {
    id: "public_software",
    value: 283_000,
    label: "Public software companies, median",
    attributed: "High Alpha and OpenView, 2025",
    verified: false,
    source: ARR_PER_EMPLOYEE_PAGE,
  },
  {
    id: "new_bar",
    value: 500_000,
    label: '"$500K is the new $200K"',
    attributed: "SaaStr, 2025",
    verified: false,
    source: ARR_PER_EMPLOYEE_PAGE,
  },
  {
    id: "scaled_ai_native",
    value: 1_130_000,
    label: "Scaled AI-native companies, average",
    attributed: "Bessemer Venture Partners (its scaled AI cohort)",
    verified: false,
    source: ARR_PER_EMPLOYEE_PAGE,
  },
];
