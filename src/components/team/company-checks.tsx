import { COMPANIES, companyIds, manyCompanies, type CompanyId } from "@/lib/company";

/** The server's own words (convex/team.ts), said before the round trip. */
export const NO_COMPANY = "Pick at least one company.";

/** The chosen companies' names, in the usual order. */
export function companyNames(companies: readonly CompanyId[]): string {
  return companyIds().filter((id) => companies.includes(id))
    .map((id) => COMPANIES[id].name)
    .join(", ");
}

/**
 * One checkbox per company: a teammate is on one or both. `offered` is the
 * companies the viewer can put someone on: all of them for the owner, their
 * own for a teammate who manages the team (the server refuses any other).
 */
export function CompanyChecks({
  value,
  onChange,
  offered = companyIds(),
}: {
  value: readonly CompanyId[];
  onChange: (next: CompanyId[]) => void;
  offered?: readonly CompanyId[];
}) {
  // With one company everyone is on it: there is nothing to ask.
  if (!manyCompanies()) return null;
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">Companies</legend>
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
        {companyIds().filter((id) => offered.includes(id)).map((id) => (
          <label key={id} className="flex min-h-6 items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={value.includes(id)}
              onChange={(e) =>
                // Rebuilt from companyIds(), so the order sent never depends on the clicks.
                onChange(
                  companyIds().filter((other) =>
                    other === id ? e.target.checked : value.includes(other),
                  ),
                )
              }
              className="size-4 accent-brand"
            />
            {COMPANIES[id].name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
