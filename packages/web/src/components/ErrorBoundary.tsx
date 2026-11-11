import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Fängt Renderfehler ab, statt die ganze Oberfläche schwarz zu lassen.
 * Einmal um die App (scope «app») und um jede Seite (scope «page», mit
 * resetKey = Pfad: ein Seitenwechsel versucht es neu). Der Fehler geht an
 * die API (POST /client-errors) und landet dort im Log – ohne Secrets: nur
 * Meldung, gekürzter Stack, Komponentenpfad und Seitenpfad ohne Query.
 */

/**
 * scope «part»: Zusatz in der Shell (Befehlspalette, Aktivitätsanzeige). Ein
 * Fehler dort wird gemeldet, der Teil fällt still weg – die Seite bleibt.
 */
type Props = { children: ReactNode; scope: 'app' | 'page' | 'part'; resetKey?: string }
type State = { error: Error | null; componentStack: string | null; reported: boolean }

/** Gemeldete Fehler pro Seitenaufruf begrenzen (eine Schleife flutet sonst das Log). */
let reports = 0

export function reportClientError(error: Error, componentStack: string | null, scope: string): void {
  if (reports >= 10) return
  reports++
  const body = JSON.stringify({
    message: String(error?.message ?? error).slice(0, 500),
    name: error?.name ?? 'Error',
    stack: (error?.stack ?? '').split('\n').slice(0, 12).join('\n').slice(0, 2000),
    componentStack: (componentStack ?? '').split('\n').slice(0, 12).join('\n').slice(0, 1500),
    // Nur der Pfad: Query und Hash können Tokens oder Namen enthalten
    path: window.location.pathname.slice(0, 200),
    scope,
  })
  try {
    void fetch('/api/v1/client-errors', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {})
  } catch { /* Melden darf nie selbst scheitern */ }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null, reported: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Airlock] Fehler in der Oberfläche', error, info.componentStack)
    reportClientError(error, info.componentStack ?? null, this.props.scope)
    this.setState({ componentStack: info.componentStack ?? null, reported: true })
  }

  componentDidUpdate(prev: Props): void {
    // Seitenwechsel: neue Seite, neuer Versuch
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, componentStack: null, reported: false })
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children
    if (this.props.scope === 'part') return null
    const details = `${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ''}${componentStack ? `\n\nKomponenten:${componentStack}` : ''}`
    return (
      <section className={this.props.scope === 'app' ? 'crash crash-app' : 'crash'} role="alert" aria-labelledby="crash-h">
        <h1 id="crash-h">Etwas ist schiefgelaufen</h1>
        <p className="crash-lede">
          {this.props.scope === 'app'
            ? 'Die Oberfläche ist an einem Fehler hängen geblieben. Deine Projekte laufen davon unberührt weiter.'
            : 'Diese Seite ist an einem Fehler hängen geblieben. Die übrigen Seiten und deine Projekte laufen weiter.'}
          {' '}Der Fehler wurde ins Log von Airlock geschrieben.
        </p>
        <div className="crash-actions">
          <button type="button" className="button-primary" onClick={() => window.location.reload()}>Neu laden</button>
          {this.props.scope === 'page' && <button type="button" onClick={() => this.setState({ error: null, componentStack: null, reported: false })}>Nochmals versuchen</button>}
        </div>
        <details className="crash-details">
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      </section>
    )
  }
}
