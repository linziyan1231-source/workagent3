/** Port of renderer/assets/logo.svg from AionUi. */
export function BrandLogo({ size = 32 }: { size?: number }) {
  return (
    <span className="aion-brand-logo" style={{ width: size, height: size }}>
      <svg viewBox="0 0 80 80" fill="none" aria-hidden="true">
        <path
          d="M40 20 Q38 22 25 40 Q23 42 26 42 L30 42 Q32 40 40 30 Q48 40 50 42 L54 42 Q57 42 55 40 Q42 22 40 20"
          fill="white"
        />
        <circle cx="40" cy="46" r="3" fill="white" />
        <path
          d="M18 50 Q40 70 62 50"
          stroke="white"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
