import { normalizePublicLabel, splitPublicHost, type PublicNameCheckDto } from '@airlock/shared'

/**
 * Öffentliche Adresse als Name + Zone (Veröffentlichen, Adresse ändern,
 * Neues Projekt). Rein, ohne React – getestet in public-name.test.ts.
 */
export interface PublicName {
  /** Name vor der Zone (beim Tippen normalisiert; leer bei apex) */
  label: string
  zone: string
  /** Direkt unter der Zone (nur über den Schalter) */
  apex: boolean
}

/**
 * Normalisieren beim Tippen: wie normalizePublicLabel, aber ein Bindestrich
 * am Ende bleibt stehen – sonst liesse sich «mein shop» nicht tippen (das
 * Leerzeichen verschwände sofort). Beim Verlassen und Absenden gilt
 * normalizePublicLabel.
 */
export function normalizeWhileTyping(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63)
}

/**
 * Eingabe ins Namensfeld übernehmen. Ein eingefügter voller Name (auch mit
 * https:// und Pfad) wird in Name und Zone zerlegt, wenn die Zone zur
 * Umgebung gehört; sonst bleibt der erste Teil als Name und note sagt,
 * warum.
 */
export function applyNameInput(raw: string, zones: readonly string[], current: PublicName): { name: PublicName; note: string | null } {
  const looksLikeHost = /:\/\//.test(raw) || /[a-z0-9]\.[a-z]/i.test(raw.trim())
  if (looksLikeHost) {
    const split = splitPublicHost(raw, zones)
    if (split) return { name: { label: split.label, zone: split.zone, apex: split.apex }, note: null }
    const host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '')
    const [first, ...rest] = host.split('.')
    return {
      name: { ...current, label: normalizeWhileTyping(first ?? ''), apex: false },
      note: `${rest.join('.')} ist keine Domain dieser Umgebung${zones.length ? ` (möglich: ${zones.join(', ')})` : ''}`,
    }
  }
  return { name: { ...current, label: normalizeWhileTyping(raw) }, note: null }
}

/** Fertiger Hostname aus Name und Zone; null, solange ein Teil fehlt. */
export function hostOf(n: PublicName): string | null {
  if (!n.zone) return null
  if (n.apex) return n.zone
  const label = normalizePublicLabel(n.label)
  return label ? `${label}.${n.zone}` : null
}

/** Bestehenden Namen (z. B. die aktuelle Adresse) in Name und Zone zerlegen. */
export function nameFromHost(host: string | null, zones: readonly string[], fallbackZone: string): PublicName {
  const split = host ? splitPublicHost(host, zones) : null
  if (split) return { label: split.label, zone: split.zone, apex: split.apex }
  return { label: '', zone: fallbackZone, apex: false }
}

/** Was die Zeile unter dem Feld zeigt: Zeichen und Wort, nie nur Farbe. */
export type Verdict =
  | { tone: 'idle' }
  | { tone: 'checking'; word: string }
  | { tone: 'ok'; word: string; text?: string }
  | { tone: 'warn'; word: string; text: string }
  | { tone: 'bad'; word: string; text: string }

const WORD: Record<PublicNameCheckDto['problems'][number]['kind'], string> = {
  format: 'Ungültig', reserved: 'Reserviert', zone: 'Andere Domain', internal: 'Interne Basis',
  taken: 'Vergeben', dns: 'Eintrag vorhanden', depth: 'Ungültig',
}

/**
 * Ergebnis der Prüfung in Worte fassen. blocking: Speichern geht so nicht.
 * Ein fremder DNS-Eintrag hält nur auf, bis «Bestehenden Eintrag ersetzen»
 * angehakt ist – nie bei Worker/Custom Domain, und nur wo Ersetzen geht.
 */
export function verdictOf(c: PublicNameCheckDto | null, o: { checking: boolean; takeOver: boolean; canTakeOver: boolean; current?: string | null; failed?: string | null }): { verdict: Verdict; blocking: boolean } {
  if (o.checking) return { verdict: { tone: 'checking', word: 'Wird geprüft …' }, blocking: false }
  if (o.failed) return { verdict: { tone: 'warn', word: 'Nicht geprüft', text: o.failed }, blocking: false }
  if (!c) return { verdict: { tone: 'idle' }, blocking: false }
  if (c.host && o.current && c.host === o.current) return { verdict: { tone: 'ok', word: 'Aktuelle Adresse' }, blocking: false }
  const others = c.problems.filter((p) => p.kind !== 'dns')
  if (others.length) return { verdict: { tone: 'bad', word: WORD[others[0]!.kind], text: others.map((p) => p.message).join('; ') }, blocking: true }
  if (c.existing) {
    if (c.existing.worker) return { verdict: { tone: 'bad', word: 'Belegt', text: 'durch einen Worker oder eine Custom Domain bei Cloudflare – dort entfernen, dann erneut versuchen' }, blocking: true }
    const what = `${c.existing.type} → ${c.existing.content}, nicht von Airlock`
    if (!o.canTakeOver) return { verdict: { tone: 'bad', word: 'Eintrag vorhanden', text: `${what}. Ersetzen geht nach dem Anlegen unter Einstellungen → Veröffentlichung.` }, blocking: true }
    return { verdict: { tone: 'warn', word: o.takeOver ? 'Wird ersetzt' : 'Eintrag vorhanden', text: what }, blocking: !o.takeOver }
  }
  return { verdict: { tone: 'ok', word: 'Frei' }, blocking: false }
}
