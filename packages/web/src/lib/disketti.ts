import { headerFixFor, type FindingDto, type HeaderKey, type ProjectDto } from '@airlock/shared'
import { deployFailedState } from './projects.js'

/**
 * Etappe 7 – Disketti: was die Helferfigur sagt. Ausschliesslich aus echten,
 * offenen Fehlern und Befunden des aktuellen Projekts; ohne solche Daten
 * gibt es keinen Hinweis (und keine Figur). Reine Funktion, getestet.
 *
 * Reihenfolge: ein gescheiterter Deploy zuerst (das Projekt läuft dann nicht
 * oder auf alter Fassung), dann der schwerste offene Befund.
 */
export interface DiskettiTip {
  /** Bleibt für denselben Fehler gleich: «Nein» und «schon gezeigt» gelten je Hinweis */
  key: string
  kind: 'deploy' | 'finding'
  /** Satz der Sprechblase ohne die Frage */
  text: string
  /** Frage für «Ja» */
  question: string
  deploymentId?: string
  findingId?: string
}

const SEV_ORDER: Record<FindingDto['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 }
const SEV_WORD: Record<FindingDto['severity'], string> = { critical: 'kritisch', high: 'hoch', medium: 'mittel', low: 'niedrig' }

const HEADER_PHRASE: Record<HeaderKey, string> = {
  'content-security-policy': 'Sieht aus, als fehlt eine CSP.',
  'frame-ancestors': 'Sieht aus, als liesse sich die Seite in fremde Seiten einbetten.',
  'x-content-type-options': 'Sieht aus, als fehlt X-Content-Type-Options.',
  'referrer-policy': 'Sieht aus, als fehlt eine Referrer-Policy.',
  'strict-transport-security': 'Sieht aus, als fehlt HSTS.',
  'permissions-policy': 'Sieht aus, als fehlt eine Permissions-Policy.',
}

const ASK_CLAUDE = 'Soll Claude helfen?'

export function diskettiTip(input: { project: ProjectDto | null | undefined; findings: readonly FindingDto[] | null | undefined }): DiskettiTip | null {
  const p = input.project
  if (!p) return null
  const d = p.lastDeployment
  if (d && d.status === 'failed' && deployFailedState(p)) {
    const what = d.failure?.title?.trim() || d.errorMessage?.trim()
    if (what) {
      // Die Fehlerbox bietet «Mit Claude lösen» nur bei passender Ursache; sonst führt «Ja» zur Box
      const claude = d.failure?.action?.kind === 'claude'
      return {
        key: `deploy:${d.id}`, kind: 'deploy', deploymentId: d.id,
        text: `Der letzte Deploy hat nicht geklappt: ${trimEnd(what)}.`,
        question: claude ? ASK_CLAUDE : 'Soll ich dir zeigen, was zu tun ist?',
      }
    }
  }
  const open = (input.findings ?? []).filter((f) => f.status === 'open')
  if (!open.length) return null
  const f = [...open].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])[0]!
  const header = headerFixFor(f)
  if (header) {
    return {
      key: `finding:${f.id}`, kind: 'finding', findingId: f.id,
      text: HEADER_PHRASE[header],
      // Die CSP hat einen eigenen Ablauf mit «Mit Claude lösen»; die übrigen Header setzt Airlock selbst
      question: header === 'content-security-policy' ? ASK_CLAUDE : 'Soll ich dir zeigen, wie du ihn setzt?',
    }
  }
  // Fertiges Image mit bekannter Schwachstelle: der Ablauf zeigt die Abhilfe (neues Image), kein Auftrag an Claude
  const imageCve = p.sourceType === 'image' && f.tool === 'trivy'
  const claude = p.sourceType !== 'static' && !imageCve
  return {
    key: `finding:${f.id}`, kind: 'finding', findingId: f.id,
    text: `Ein offener Befund (${SEV_WORD[f.severity]}): ${trimEnd(f.title)}.`,
    question: imageCve ? 'Soll ich dir die Abhilfe zeigen?' : claude ? ASK_CLAUDE : 'Soll ich dir den Befund zeigen?',
  }
}

/** Ohne Schlusspunkt (der Satz bekommt seinen eigenen) */
const trimEnd = (s: string) => s.replace(/[.\s]+$/, '')
