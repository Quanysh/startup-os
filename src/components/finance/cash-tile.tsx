import { SCOPE_CURRENCY, SCOPE_LABELS, getMetric } from "@convex/lib/metricRegistry";
import { DerivedTile } from "@/components/metrics/derived-tile";
import { dayLabel, formatExact, formatPeriod, formatUsd, formatValue } from "@/lib/format";
import { BOTH_MARKETS, type CashNow, type Market } from "@/lib/metrics/finance";
import {
  ENTER_KZ_CASH,
  Note,
  NoteLink,
  OWNER_ENTERS_KZ_CASH,
  cashPartIsOld,
  sourceWords,
  type HeroExtras,
} from "./notes";

/**
 * What the total is missing, in the order the owner would fix it. `alone` is
 * a view of Kazakhstan only: with no rate there is no total for it to be
 * "left out" of.
 */
function MissingLines({ missing, alone }: { missing: CashNow["missing"]; alone: boolean }) {
  return (
    <>
      {missing.includes("us") && <Note>No US balance yet. It arrives with Mercury.</Note>}
      {missing.includes("kz") && (
        <Note>
          No Kazakhstan balance yet.{" "}
          <NoteLink href={ENTER_KZ_CASH} otherwise={OWNER_ENTERS_KZ_CASH}>
            Enter Kazakhstan&apos;s balance
          </NoteLink>
        </Note>
      )}
      {missing.includes("fx") && (
        <Note>
          {alone
            ? "There is no dollar figure until a USD/KZT rate arrives with the CFO workbook."
            : "Kazakhstan is left out until a USD/KZT rate arrives with the CFO workbook."}
        </Note>
      )}
    </>
  );
}

/**
 * Cash in the bank in the markets in view, in dollars. A market with no
 * balance makes the total partial and is named; tenge with no rate to convert
 * it is left out, never shown as zero dollars. A market not in view is never
 * named: in one company's view the tile is that company's balance alone.
 */
export function CashTile({
  cash,
  now,
  markets = BOTH_MARKETS,
  hero,
}: {
  cash: CashNow | null;
  now: number;
  markets?: readonly Market[];
  /** In the Finance hero: the trend, tenge first for Globex, and the source said once. */
  hero?: HeroExtras;
}) {
  const both = markets.includes("us") && markets.includes("kz");
  const alone = !markets.includes("us");

  if (cash === null || cash.parts.length === 0) {
    return (
      <DerivedTile label="Cash" value={null}>
        {both && <Note>US cash arrives with Mercury. Kazakhstan&apos;s balance is typed in.</Note>}
        {/* One company's view has one balance to wait for, so it is named outright. */}
        <MissingLines missing={cash?.missing ?? (both ? [] : [...markets])} alone={alone} />
      </DerivedTile>
    );
  }

  const converted = cash.parts.some((part) => part.scope === "kz");
  // In the hero, one market's balance is the figure itself: it is said once,
  // with its source and day, not again as a note.
  const single = hero !== undefined && markets.length === 1 && cash.parts.length === 1 ? cash.parts[0]! : null;
  const tenge = single !== null && single.scope === "kz" && hero?.own === true;
  const source =
    single === null
      ? undefined
      : [
          sourceWords(getMetric("cash")!.sources[single.scope]!),
          dayLabel(single.periodStart, now),
          ...(cashPartIsOld(single, now) ? ["out of date"] : []),
        ].join(" · ");
  return (
    <DerivedTile
      label="Cash"
      value={tenge ? formatValue(single.native, "currency", "KZT") : formatUsd(cash.usd)}
      exact={tenge ? formatExact(single.native, "currency", "KZT") : formatExact(cash.usd, "currency", "USD")}
      badge={cash.missing.length > 0 ? "partial" : undefined}
      count={
        tenge
          ? { value: single.native, format: (n) => formatValue(n, "currency", "KZT") }
          : { value: cash.usd, format: formatUsd }
      }
      alongside={tenge ? `≈ ${formatUsd(cash.usd)}` : undefined}
      trend={hero?.trend}
      source={source}
    >
      {single === null &&
        cash.parts.map((part) => (
          <Note key={part.scope}>
            {[
              `${SCOPE_LABELS[part.scope]} ${formatValue(part.native, "currency", SCOPE_CURRENCY[part.scope])}`,
              dayLabel(part.periodStart, now),
              ...(cashPartIsOld(part, now) ? ["out of date"] : []),
            ].join(" · ")}
          </Note>
        ))}
      {converted && cash.rate !== null && cash.ratePeriodStart !== null && (
        <Note>
          {`Converted at ₸${cash.rate.toLocaleString("en-US")} per $1, the ${formatPeriod("month", cash.ratePeriodStart)} rate.`}
        </Note>
      )}
      <MissingLines missing={cash.missing} alone={alone} />
    </DerivedTile>
  );
}
