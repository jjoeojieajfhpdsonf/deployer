import { useEffect, useRef, useState } from 'react'
import { subscribeDeployment, type DeployEvent } from '../api.js'

/** Die Schritte der Pipeline in der Reihenfolge, in der sie durchlaufen werden. */
const STEPS = [
  { key: 'pulling', label: 'Quelle holen' },
  { key: 'starting', label: 'Starten' },
  { key: 'healthchecking', label: 'Healthcheck' },
  { key: 'active', label: 'Umschalten' },
] as const

export function DeployProgress({
  deploymentId,
  onFinished,
}: {
  deploymentId: string
  onFinished?: (ok: boolean) => void
}) {
  const [status, setStatus] = useState<string>('pending')
  const [lines, setLines] = useState<string[]>([])
  const [done, setDone] = useState<{ ok: boolean } | null>(null)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setLines([])
    setDone(null)
    const stop = subscribeDeployment(deploymentId, (e: DeployEvent) => {
      if (e.type === 'line' && e.line) setLines((l) => [...l.slice(-500), e.line!])
      if (e.type === 'status' && e.status) setStatus(e.status)
      if (e.type === 'done') {
        setDone({ ok: Boolean(e.ok) })
        onFinished?.(Boolean(e.ok))
      }
    })
    return stop
  }, [deploymentId, onFinished])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [lines])

  const activeIndex = STEPS.findIndex((s) => s.key === status)
  const failed = done && !done.ok

  return (
    <section className="deploy-progress">
      <ol className="steps">
        {STEPS.map((step, i) => {
          const state = failed && i === activeIndex ? 'failed'
            : done?.ok || (activeIndex > i && activeIndex !== -1) ? 'done'
            : i === activeIndex ? 'current'
            : 'todo'
          return (
            <li key={step.key} className={`step step-${state}`} aria-current={state === 'current'}>
              {step.label}
            </li>
          )
        })}
      </ol>

      {/* Statuswechsel für Screenreader: jeder Schritt und das Ende werden angesagt */}
      <p className="sr-only" role="status">
        {done ? (done.ok ? 'Deploy fertig. Der neue Stand ist live.' : '') : activeIndex >= 0 ? `Deploy: ${STEPS[activeIndex]!.label} (Schritt ${activeIndex + 1} von ${STEPS.length})` : ''}
      </p>
      {failed && (
        <p role="alert" className="error">
          Der Deploy ist fehlgeschlagen. Die vorherige Fassung läuft weiter.
        </p>
      )}

      {/* Log direkt daneben, nicht zwei Klicks entfernt. */}
      <pre className="log" ref={logRef} aria-label="Deploy-Log">
        {lines.join('\n') || 'Noch keine Ausgabe…'}
      </pre>
    </section>
  )
}
