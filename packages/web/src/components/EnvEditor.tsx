export interface EnvRow {
  key: string
  value: string
  isSecret: boolean
  /** true, wenn der Wert bereits verschlüsselt gespeichert ist. */
  stored?: boolean
}

/**
 * Geheime Werte werden nie zurückgelesen, nur überschrieben. Ein leeres
 * Feld bei einem gespeicherten Secret bedeutet deshalb "unverändert lassen",
 * nicht "löschen".
 */
export function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (r: EnvRow[]) => void }) {
  const update = (i: number, patch: Partial<EnvRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  return (
    <fieldset className="field-group env-editor">
      <legend>Umgebungsvariablen</legend>

      {rows.length === 0 && <p className="hint">Keine – das ist für viele Images in Ordnung.</p>}

      {rows.map((row, i) => (
        <div key={i} className="env-row">
          <input
            aria-label="Name"
            placeholder="DATABASE_URL"
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <input
            aria-label="Wert"
            type={row.isSecret ? 'password' : 'text'}
            placeholder={row.stored && row.isSecret ? 'gespeichert – leer lassen zum Behalten' : 'Wert'}
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <label className="env-secret">
            <input
              type="checkbox"
              checked={row.isSecret}
              onChange={(e) => update(i, { isSecret: e.target.checked })}
            />
            geheim
          </label>
          <button type="button" onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
            Entfernen
          </button>
        </div>
      ))}

      <button type="button" onClick={() => onChange([...rows, { key: '', value: '', isSecret: false }])}>
        Variable hinzufügen
      </button>
    </fieldset>
  )
}
