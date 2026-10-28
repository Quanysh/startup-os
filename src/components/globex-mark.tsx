// A placeholder mark for the second company (shown only with the
// `secondCompany` switch on): two overlapping circles in two violets. Draw
// your own here. The same artwork on a light ground and a dark one, so its
// two colours are written here and not tokens (allowed in
// src/styles/colours.test.ts).
export function GlobexMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <circle cx="15" cy="20" r="11" fill="#574AE2" />
      <circle cx="25" cy="20" r="11" fill="#654597" fillOpacity="0.85" />
    </svg>
  );
}
