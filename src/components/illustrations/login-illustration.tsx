// Hand-authored inline SVG (no external assets) — a soft, baby-products-themed
// mark for the sign-in screen: a bottle on a blob backdrop with a couple of
// playful accents. Kept simple/tasteful for a business tool, not a toy site.
export function LoginIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 160"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <ellipse cx="100" cy="120" rx="78" ry="26" className="fill-primary/10" />
      <circle cx="40" cy="34" r="10" className="fill-amber-400/30" />
      <circle cx="164" cy="46" r="7" className="fill-pink-400/30" />
      <circle cx="150" cy="20" r="4" className="fill-emerald-400/40" />

      {/* Bottle */}
      <g>
        <rect x="86" y="26" width="28" height="14" rx="5" className="fill-primary/70" />
        <rect x="92" y="16" width="16" height="12" rx="4" className="fill-primary/50" />
        <path
          d="M78 46c0-4 3.5-7 8-7h28c4.5 0 8 3 8 7v56c0 8-6.5 14-14 14H92c-7.5 0-14-6-14-14V46z"
          className="fill-primary"
        />
        <rect x="82" y="58" width="36" height="8" rx="2" className="fill-background/70" />
        <rect x="82" y="74" width="36" height="8" rx="2" className="fill-background/50" />
      </g>

      {/* Little sparkle accents */}
      <path d="M30 90l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" className="fill-amber-400/60" />
      <path d="M170 96l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" className="fill-emerald-400/60" />
    </svg>
  );
}
