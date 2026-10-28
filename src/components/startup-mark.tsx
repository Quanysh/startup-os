import { useId } from "react";

// A placeholder mark: a rounded square in a pale-to-slate gradient with a
// plain ring inside. Draw your own here. The same artwork on a light ground
// and a dark one (it reads on both), so its colours are written here and not
// tokens. One of the four places allowed to (src/styles/colours.test.ts).
export function StartupMark({ className }: { className?: string }) {
  const uid = useId();
  const fill = `startup-mark-${uid}`;
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="8" fill={`url(#${fill})`} />
      <circle cx="16" cy="16" r="7" stroke="white" strokeWidth="3" />
      <defs>
        <linearGradient id={fill} x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#e2e8f0" />
          <stop offset="1" stopColor="#475569" />
        </linearGradient>
      </defs>
    </svg>
  );
}
