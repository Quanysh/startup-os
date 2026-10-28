import { COMPANY_IDENTITY, PRODUCT, type LogoId } from "@convex/lib/identity";
import { GlobexMark } from "@/components/globex-mark";
import { StartupLogo } from "@/components/startup-logo";
import { DEFAULT_COMPANY, type CompanyId } from "@/lib/company";

/** Globex's: its mark and its name set in type (it has no drawn wordmark), with the product's tag. */
function GlobexLogo() {
  return (
    <span className="inline-flex items-center gap-2">
      <GlobexMark className="size-7 shrink-0" />
      <span className="text-lg leading-none font-semibold tracking-tight text-foreground">
        {COMPANY_IDENTITY.kz.name}
      </span>
      <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-brand">
        {PRODUCT.shortName}
      </span>
    </span>
  );
}

/** The artwork of each logo the identity (convex/lib/identity.ts) may name. */
export const LOGOS: Record<LogoId, React.ComponentType> = {
  startup: StartupLogo,
  globex: GlobexLogo,
};

/** A company's logo, as the identity names it; the default company's when none is chosen. */
export function CompanyLogo({ company }: { company: CompanyId | null }) {
  const Logo = LOGOS[COMPANY_IDENTITY[company ?? DEFAULT_COMPANY].logo];
  return <Logo />;
}

/** The product's own logo: the sign-in page and the refusal page. */
export function ProductLogo() {
  const Logo = LOGOS[PRODUCT.logo];
  return <Logo />;
}
