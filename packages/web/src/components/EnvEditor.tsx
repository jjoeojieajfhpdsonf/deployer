import type { Errors } from '../lib/form.js'
import { FieldError } from './Field.js'
import { fieldId } from '../lib/form.js'

export interface EnvRow {
  key: string
  value: string
  isSecret: boolean
  /** true, wenn der Wert bereits verschlüsselt gespeichert ist. */
  stored?: boolean
}

type FieldProps = (name: string, describedBy?: string) => Record<string, unknown>

/**
 * Geheime Werte werden nie zurückgelesen, nur überschrieben. Ein leeres
 * Feld bei einem gespeicherten Secret bedeutet deshalb "unverändert lassen",
 * nicht "löschen".
 *
 * Fehler kommen aus der Prüfung des umgebenden Formulars (Pfade
 * `<prefix>.<i>.key` / `.value`, gleiche Regeln wie die API).
 */
export function EnvEditor({
  rows,
  onChange,
  prefix = 'env',
  errors = {},
  field,
}: {
  rows: EnvRow[]
  onChange: (r: EnvRow[]) => void
  prefix?: string
  errors?: Errors
  field?: FieldProps
}) {
  const update = (i: number, patch: Partial<EnvRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const props = (name: string) => (field ? field(name) : { id: fieldId(name) })
  const dupes = new Set(rows.map((r) => r.key.trim()).filter((k, i, a) => k && a.indexOf(k) !== i))

  return (
    <fieldset className="field-group env-editor">
      <legend>Umgebungsvariablen</legend>

      {rows.length === 0 && <p className="hint">Keine – das ist für viele Images in Ordnung.</p>}

      {rows.map((row, i) => {
        const kName = `${prefix}.${i}.key`
        const vName = `${prefix}.${i}.value`
        const keyError = errors[kName] ?? (dupes.has(row.key.trim()) ? `«${row.key.trim()}» kommt mehrfach vor; jeder Name nur einmal` : undefined)
        return (
          <div key={i} className="env-row">
            <input
              {...props(kName)}
              aria-label={`Name der Variable ${i + 1}`}
              aria-invalid={keyError ? true : undefined}
              aria-describedby={keyError ? `${fieldId(kName)}-error` : undefined}
              placeholder="DATABASE_URL"
              value={row.key}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <input
              {...props(vName)}
              aria-label={`Wert der Variable ${i + 1}`}
              type={row.isSecret ? 'password' : 'text'}
              placeholder={row.stored && row.isSecret ? 'gespeichert – leer lassen zum Behalten' : 'Wert'}
              value={row.value}
              autoComplete="off"
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
            <button type="button" onClick={() => onChange(rows.filter((_, idx) => idx !== i))} aria-label={`Variable ${row.key || i + 1} entfernen`}>
              Entfernen
            </button>
            {keyError && <FieldError id={fieldId(kName)} message={keyError} />}
            {errors[vName] && <FieldError id={fieldId(vName)} message={errors[vName]!} />}
          </div>
        )
      })}

      <button type="button" onClick={() => onChange([...rows, { key: '', value: '', isSecret: false }])}>
        Variable hinzufügen
      </button>
    </fieldset>
  )
}
