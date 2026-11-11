import type { FindingInput } from './score.js'

/**
 * Eigener Header-Check (Stufe 2). Reine Funktion auf einer Antwort.
 * Er ist massgeblich für Security-Header; die gleichbedeutenden ZAP-Regeln
 * werden deshalb nicht noch einmal gezählt (siehe ZAP_COVERED_BY_HEADERS).
 */

export interface HttpResponseLike {
  url: string
  status: number
  /** Header in Kleinbuchstaben; set-cookie als Liste. */
  headers: Record<string, string | string[]>
  body: string
  isHttps: boolean
}

const TOOL = 'header-check'

const one = (h: string | string[] | undefined): string | undefined => (Array.isArray(h) ? h[0] : h)

export function checkHeaders(r: HttpResponseLike): FindingInput[] {
  const out: FindingInput[] = []
  const h = r.headers
  const loc = r.url
  const add = (severity: FindingInput['severity'], title: string, description: string, fix: string) =>
    out.push({ tool: TOOL, severity, title, location: loc, description, fix })

  const csp = one(h['content-security-policy'])
  // M8: Eine CSP schützt vor XSS nur mit default-src oder script-src. Eine,
  // die nur das Einbetten regelt (frame-ancestors, auch von Caddy ergänzt),
  // zählt nicht – sonst verschwände der Befund, ohne dass etwas geschützt ist.
  // Gleicher Titel: der Fingerabdruck (und eine Akzeptanz) bleibt.
  if (!csp || !/(^|;)\s*(default-src|script-src)\b/i.test(csp)) {
    add('medium', 'Content-Security-Policy fehlt',
      csp
        ? 'Die vorhandene CSP legt nicht fest, woher Skripte kommen dürfen (kein default-src oder script-src); eingeschleustes Skript (XSS) liefe ungehindert.'
        : 'Ohne CSP kann eingeschleustes Skript (XSS) ungehindert laufen und Daten abfliessen lassen.',
      'Header Content-Security-Policy setzen, z.B. "default-src \'self\'" als Ausgangspunkt.')
  }

  const xfo = one(h['x-frame-options'])
  if (!(csp && /frame-ancestors/i.test(csp)) && !xfo) {
    add('medium', 'Schutz gegen Einbetten fehlt (frame-ancestors / X-Frame-Options)',
      'Die Seite lässt sich in fremde Seiten einbetten (Clickjacking).',
      'In der CSP "frame-ancestors \'self\'" setzen oder X-Frame-Options: DENY.')
  }

  if ((one(h['x-content-type-options']) ?? '').toLowerCase() !== 'nosniff') {
    add('low', 'X-Content-Type-Options: nosniff fehlt',
      'Browser könnten Inhalte anders deuten als ausgeliefert (MIME-Sniffing).',
      'Header X-Content-Type-Options: nosniff setzen.')
  }

  if (!one(h['referrer-policy'])) {
    add('low', 'Referrer-Policy fehlt',
      'Volle Adressen (mit Pfad und Parametern) gehen als Referrer an fremde Seiten.',
      'Header Referrer-Policy: strict-origin-when-cross-origin setzen.')
  }

  if (r.isHttps && !one(h['strict-transport-security'])) {
    add('medium', 'Strict-Transport-Security fehlt',
      'Ohne HSTS kann eine erste Verbindung auf HTTP herabgestuft werden.',
      'Header Strict-Transport-Security: max-age=31536000 setzen.')
  }

  for (const name of ['server', 'x-powered-by']) {
    const v = one(h[name])
    if (v && /\d/.test(v)) {
      add('low', `Versionsangabe im Header ${name === 'server' ? 'Server' : 'X-Powered-By'}`,
        `Der Header verrät "${v.slice(0, 60)}" und erleichtert gezielte Angriffe auf bekannte Lücken.`,
        'Versionsangabe entfernen oder den Header ganz weglassen.')
    }
  }

  const cookies = Array.isArray(h['set-cookie']) ? h['set-cookie'] : h['set-cookie'] ? [h['set-cookie']] : []
  for (const c of cookies) {
    const name = c.split('=')[0]?.trim() ?? 'Cookie'
    const attrs = c.toLowerCase()
    if (!/;\s*httponly/.test(attrs)) {
      add('medium', `Cookie "${name}" ohne HttpOnly`,
        'Skript auf der Seite (auch eingeschleustes) kann das Cookie lesen.',
        'Cookie mit HttpOnly setzen, sofern es nicht von Skript gebraucht wird.')
    }
    if (!/;\s*samesite=/.test(attrs)) {
      add('low', `Cookie "${name}" ohne SameSite`,
        'Das Cookie wird auch bei Anfragen von fremden Seiten mitgeschickt (CSRF).',
        'SameSite=Lax oder Strict setzen.')
    }
    if (r.isHttps && !/;\s*secure/.test(attrs)) {
      add('medium', `Cookie "${name}" ohne Secure`,
        'Das Cookie kann über eine unverschlüsselte Verbindung mitgehen.',
        'Cookie mit Secure setzen.')
    }
  }

  if (r.isHttps && /<(script|link|img|iframe)[^>]+(src|href)=["']http:\/\//i.test(r.body)) {
    add('medium', 'Gemischte Inhalte (HTTP auf einer HTTPS-Seite)',
      'Die Seite lädt Ressourcen unverschlüsselt nach; sie lassen sich unterwegs verändern.',
      'Alle Ressourcen über https:// oder relativ laden.')
  }

  return out
}

/** ZAP-Regeln, die der eigene Header-Check abdeckt; sonst zählte derselbe Mangel doppelt. */
export const ZAP_COVERED_BY_HEADERS = new Set([
  '10038', // CSP fehlt
  '10020', // Anti-Clickjacking
  '10021', // X-Content-Type-Options
  '10035', // HSTS
  '10010', // Cookie ohne HttpOnly
  '10011', // Cookie ohne Secure
  '10054', // Cookie ohne SameSite
  '10036', // Server-Version
  '10037', // X-Powered-By
  '10040', // Gemischte Inhalte (HTTP auf HTTPS-Seite) – prüft der Header-Check auch
  '10116', // "ZAP is Out of Date" – betrifft den Scanner, nicht das Ziel
])
