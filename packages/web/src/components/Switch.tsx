/**
 * Schalter (role="switch"): ein Knopf mit aria-checked, beschriftet über
 * aria-labelledby/aria-label. Der Zustand steht zusätzlich als Wort daneben
 * (beim Aufrufer), nie nur über Farbe und Lage des Knopfs.
 * Bewegung (Emil): der Knopf gleitet 160 ms ease-out, beim Drücken wird er
 * etwas breiter; ohne Bewegung bei prefers-reduced-motion.
 */
export function Switch({
  checked, onChange, disabled, label, labelledBy, describedBy, busy,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
  labelledBy?: string
  describedBy?: string
  /** Speichern läuft: fokussierbar bleiben, aber nichts auslösen */
  busy?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => { if (!busy) onChange(!checked) }}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  )
}
