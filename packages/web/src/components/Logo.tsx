/**
 * Bildmarke von Airlock: Variante 1 («Doppeltor») aus docs/design-cal/marke/
 * (Antwort 6). Steht im Favicon, auf der Anmeldeseite und in der Seitenleiste
 * vor «Airlock».
 * Farbe über currentColor, damit Hell und Dunkel von selbst passen.
 */
export function Logo({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" className={className} aria-hidden="true">
      <path d="M4 28V16a12 12 0 0 1 24 0v12h-4V16a8 8 0 0 0-16 0v12z" />
      <path d="M12 28V16a4 4 0 0 1 8 0v12z" />
    </svg>
  )
}
