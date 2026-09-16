import { BRAND_NAME, BRAND_TAGLINE } from "../lib/brand";

type BrandLockupProps = {
  compact?: boolean;
  showTagline?: boolean;
  className?: string;
};

export function BrandLockup({ compact = false, showTagline = true, className = "" }: BrandLockupProps) {
  return (
    <div className={`brand-lockup ${compact ? "brand-lockup--compact" : ""} ${className}`.trim()} aria-label={BRAND_NAME}>
      <img className="brand-lockup__mark" src="/brand/continuixai-mark.svg" alt="" aria-hidden="true" />
      <div className="brand-lockup__copy">
        <div className="brand-lockup__name">{BRAND_NAME}</div>
        {showTagline && <div className="brand-lockup__tagline">{BRAND_TAGLINE}</div>}
      </div>
    </div>
  );
}
