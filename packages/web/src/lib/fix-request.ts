import { useEffect, useRef } from 'react'

/**
 * Etappe 7: «Ja» bei Disketti öffnet den bestehenden Fix-Ablauf. Disketti
 * merkt hier vor, welcher Ablauf gemeint ist («finding:<id>» oder
 * «deploy:<id>»), wechselt den Reiter, und der Ablauf öffnet sich, sobald er
 * erscheint – oder sofort, wenn er schon da ist.
 */
let pending: string | null = null
let clearTimer: ReturnType<typeof setTimeout> | undefined
const EVENT = 'airlock:fix-request'
/** So lange gilt die Anforderung: der Reiter lädt, der Bericht kann einmal neu aufgebaut werden */
const PENDING_MS = 4000

export function requestFix(key: string): void {
  pending = key
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => { pending = null }, PENDING_MS)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }))
}

/** Nicht verbrauchend: wird der Ablauf kurz danach neu aufgebaut, öffnet er sich wieder (Öffnen ist idempotent) */
const take = (key: string): boolean => pending === key

/** Ruft onRequest auf, wenn der Ablauf mit diesem Schlüssel angefordert ist (enabled: nur wenn er hier angeboten wird). */
export function useFixRequest(key: string | null, enabled: boolean, onRequest: () => void): void {
  const cb = useRef(onRequest)
  cb.current = onRequest
  useEffect(() => {
    if (!key || !enabled) return
    if (take(key)) cb.current()
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === key && take(key)) cb.current() }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [key, enabled])
}

/**
 * Wie useFixRequest, aber für jeden Schlüssel mit diesem Anfang («finding:»):
 * die Befundliste wählt den Befund, bevor sein Ablauf erscheint. Nicht
 * verbrauchend – der Ablauf selbst öffnet sich danach über useFixRequest.
 */
export function useFixRequestPrefix(prefix: string, onRequest: (rest: string) => void): void {
  const cb = useRef(onRequest)
  cb.current = onRequest
  useEffect(() => {
    if (pending?.startsWith(prefix)) cb.current(pending.slice(prefix.length))
    const on = (e: Event) => {
      const key = (e as CustomEvent<string>).detail
      if (key.startsWith(prefix) && take(key)) cb.current(key.slice(prefix.length))
    }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [prefix])
}

/**
 * Element erscheint (Reiter lädt noch): bis zu 3 s warten, dann in den Blick
 * rollen und den ersten Knopf darin fokussieren – Tastatur bleibt im Ablauf.
 */
export function revealFix(selector: string, focusSelector = 'button'): void {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const go = (tries: number) => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) { if (tries > 0) setTimeout(() => go(tries - 1), 100); return }
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
    const target = el.querySelector<HTMLElement>(focusSelector)
    ;(target ?? el).focus({ preventScroll: true })
  }
  go(30)
}
