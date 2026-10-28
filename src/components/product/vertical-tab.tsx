import { TileGrid, type TabProps } from "./tile-grid";

const FIGURES = ["weekly_active_users", "practices_active", "core_actions", "practices"].map(
  (key) => ({ key, scope: "vertical_startup" }),
);

export function VerticalTab({ tiles, now }: TabProps) {
  return (
    <section aria-label="Vertical Startup figures" className="space-y-3">
      <TileGrid figures={FIGURES} tiles={tiles} now={now} />
      <p className="text-xs text-ink-2">
        Counts only, from Vertical Startup&apos;s own health endpoint. No published benchmark fits these,
        so they show trend only.
      </p>
    </section>
  );
}
