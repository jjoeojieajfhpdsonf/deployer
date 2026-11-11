import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { copyText } from '../lib/clipboard.js'
import { IconWarn } from './Icons.js'

/**
 * Rückfragen (Antwort 3 und 10, docs/design-cal/README.md):
 *   InlineConfirm – normale Rückfrage an derselben Stelle: Warnzeile,
 *                   «Abbrechen», bestätigender Knopf.
 *   ConfirmDialog – modaler Dialog nur für Zerstörerisches (Projekt löschen,
 *                   Cloudflare trennen, ganz offline nehmen, Token widerrufen,
 *                   Umgebung löschen); Löschen mit eingetipptem Kurznamen.
 * Menüs behalten ihr eigenes Muster (menu-confirm, components/useMenu.ts).
 */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Offen/zu einer Inline-Rückfrage mit Fokus zurück auf den Auslöser – nach
 * «Abbrechen» und auch nach dem Bestätigen (close() in onSettled).
 */
export function useConfirmState<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<T>(null)
  const back = useRef(false)
  useEffect(() => {
    if (!open && back.current) {
      back.current = false
      trigger.current?.focus()
    }
  }, [open])
  return {
    open,
    trigger,
    show: () => setOpen(true),
    close: () => {
      back.current = true
      setOpen(false)
    },
  }
}

export interface InlineConfirmProps {
  /** Name der Gruppe für Screenreader («Rollback bestätigen») */
  label: string
  /** Warnzeile: was passiert, in einem Satz */
  note?: ReactNode
  /** Zeichen vor der Warnzeile (Standard: ja) */
  noteIcon?: boolean
  /** Klasse der Warnzeile (Standard: confirm-note) */
  noteClassName?: string
  confirmLabel: ReactNode
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  /** Läuft: Bestätigen gesperrt und aria-busy */
  busy?: boolean
  /** Gesperrt, ohne dass etwas läuft (z.B. andere Aktion des Blocks läuft) */
  disabled?: boolean
  /** Sperren per aria-disabled statt disabled: der Fokus bleibt auf dem Knopf */
  softDisable?: boolean
  onConfirm: () => void
  onCancel: () => void
  small?: boolean
  /** Welcher Knopf beim Öffnen den Fokus bekommt (Standard: der bestätigende) */
  focus?: 'confirm' | 'cancel' | 'none'
  /** Nach «Abbrechen» hierhin; sonst auf den nächsten Knopf an der Stelle (nie auf <body>) */
  returnFocusTo?: RefObject<HTMLElement | null>
  className?: string
  as?: 'span' | 'div'
}

/** Inline-Rückfrage: span.confirm-inline mit Warnzeile, «Abbrechen» und Bestätigen. */
export function InlineConfirm({
  label, note, noteIcon = true, noteClassName = 'confirm-note', confirmLabel, cancelLabel = 'Abbrechen', tone = 'danger',
  busy, disabled, softDisable, onConfirm, onCancel, small, focus = 'confirm', returnFocusTo, className, as = 'span',
}: InlineConfirmProps) {
  const ref = useRef<HTMLElement>(null)
  const size = small ? 'button-small ' : ''
  const locked = Boolean(busy || disabled)
  const Tag = as

  const cancel = () => {
    // Ohne returnFocusTo: der Auslöser erscheint meist wieder an der Stelle der Rückfrage (neu im
    // DOM); sonst das Element davor (z.B. der Schalter, der sie geöffnet hat)
    const group = ref.current
    const before = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const prev = group ? before.filter((el) => !group.contains(el) && el.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).pop() : undefined
    const known = new Set(before)
    onCancel()
    requestAnimationFrame(() => {
      const target = returnFocusTo?.current
      if (target?.isConnected) { target.focus(); return }
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      const fresh = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => !known.has(el) && (!prev || prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
      ;(fresh ?? (prev?.isConnected ? prev : undefined))?.focus()
    })
  }

  return (
    <Tag ref={ref as never} className={`confirm-inline${className ? ` ${className}` : ''}`} role="group" aria-label={label}>
      {note != null && <span className={noteClassName}>{noteIcon && <IconWarn />}{note}</span>}
      <button type="button" className={size.trim() || undefined} onClick={cancel} autoFocus={focus === 'cancel'}>{cancelLabel}</button>
      <button
        type="button"
        className={`${size}${tone === 'danger' ? 'button-danger-solid' : 'button-primary'}`}
        autoFocus={focus === 'confirm'}
        disabled={softDisable ? undefined : locked}
        aria-disabled={softDisable && locked ? true : undefined}
        aria-busy={busy || undefined}
        onClick={() => { if (!locked) onConfirm() }}
      >
        {confirmLabel}
      </button>
    </Tag>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: ReactNode
  /** Was passiert – Text der bisherigen Warnung, ggf. weitere Felder (z.B. ein Haken) */
  children?: ReactNode
  confirmLabel: ReactNode
  busy?: boolean
  error?: ReactNode
  onConfirm: () => void
  onCancel: () => void
  /** Bestätigen erst, wenn der Wert genau eingetippt ist (Löschen: Kurzname) */
  typeToConfirm?: { value: string; label: string }
  /** Fokus nach dem Schliessen, falls der Auslöser nicht mehr da ist (z.B. Menüeintrag) */
  returnFocusTo?: RefObject<HTMLElement | null>
}

/**
 * Modaler Dialog für zerstörerische Aktionen. Esc und Klick auf den
 * Hintergrund brechen ab (nicht, solange es läuft); danach Fokus zurück auf
 * das auslösende Element.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, busy, error, onConfirm, onCancel, typeToConfirm, returnFocusTo }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const back = useRef<HTMLElement | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const cancelBtn = useRef<HTMLButtonElement>(null)
  const downOnBackdrop = useRef(false)
  const openRef = useRef(open)
  openRef.current = open
  const [typed, setTyped] = useState('')
  const headingId = `${useId()}-h`

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      back.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
      setTyped('')
      d.showModal()
      // Mit Eingabe dorthin, sonst die sichere Wahl: Abbrechen
      requestAnimationFrame(() => (input.current ?? cancelBtn.current)?.focus())
    }
    if (!open && d.open) {
      d.close()
      requestAnimationFrame(() => {
        const t = back.current?.isConnected ? back.current : returnFocusTo?.current
        back.current = null
        t?.focus()
      })
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Beim Verschwinden der Seite offen: modalen Zustand nicht stehen lassen
  useEffect(() => () => { if (ref.current?.open) ref.current.close() }, [])

  const ready = !typeToConfirm || typed.trim() === typeToConfirm.value
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready && !busy) onConfirm()
  }

  // Im <body>, nicht an der Stelle des Auslösers: sonst erbte der Dialog Regeln der Umgebung
  // (z.B. rote Überschrift der .danger-zone) und störte :last-child der Zeilen
  return createPortal(
    <dialog
      ref={ref}
      className="dialog confirm-dialog"
      aria-labelledby={headingId}
      onCancel={(e) => { e.preventDefault(); if (!busy) onCancel() }}
      // Schliesst der Browser den Dialog trotzdem (zweites Esc), heisst das Abbrechen
      onClose={() => { if (openRef.current) onCancel() }}
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnBackdrop.current && !busy) onCancel() }}
    >
      <ConfirmDialogBody
        title={title}
        confirmLabel={confirmLabel}
        busy={busy}
        error={error}
        ready={ready}
        typeToConfirm={typeToConfirm}
        typed={typed}
        onTyped={setTyped}
        onSubmit={submit}
        onCancel={() => { if (!busy) onCancel() }}
        inputRef={input}
        cancelRef={cancelBtn}
        headingId={headingId}
      >
        {children}
      </ConfirmDialogBody>
    </dialog>,
    document.body,
  )
}

/**
 * Inhalt des Dialogs – auch ohne <dialog> nutzbar (Bausteine-Seite).
 * Überschrift (h2) mit id `<id>-h`, auf die der Dialog zeigt.
 */
export function ConfirmDialogBody({
  title, children, confirmLabel, busy, error, ready = true, typeToConfirm, typed = '', onTyped, onSubmit, onCancel, inputRef, cancelRef, headingId,
}: {
  title: ReactNode
  children?: ReactNode
  confirmLabel: ReactNode
  busy?: boolean
  error?: ReactNode
  ready?: boolean
  typeToConfirm?: { value: string; label: string }
  typed?: string
  onTyped?: (v: string) => void
  onSubmit?: (e: FormEvent) => void
  onCancel?: () => void
  inputRef?: RefObject<HTMLInputElement | null>
  cancelRef?: RefObject<HTMLButtonElement | null>
  headingId?: string
}) {
  const own = useId()
  const hId = headingId ?? `${own}-h`
  const inputId = `${own}-type`
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  const copy = async () => {
    if (!typeToConfirm) return
    const ok = await copyText(typeToConfirm.value)
    setCopied(ok ? 'ok' : 'manual')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 2000)
  }

  return (
    <form className="dialog-body" noValidate onSubmit={onSubmit ?? ((e) => e.preventDefault())}>
      <h2 id={hId}>{title}</h2>
      {children != null && <div className="confirm-dialog-text">{children}</div>}
      {typeToConfirm && (
        <div className="field confirm-dialog-type">
          <label htmlFor={inputId}>{typeToConfirm.label}</label>
          <div className="confirm-dialog-value">
            <code>{typeToConfirm.value}</code>
            <button type="button" className="button-small" onClick={() => void copy()}>{copied === 'ok' ? 'Kopiert' : 'Kopieren'}</button>
            <span className="visually-hidden" role="status">
              {copied === 'ok' && `${typeToConfirm.value} kopiert`}
              {copied === 'manual' && 'Kopieren ging nicht, bitte von Hand eintippen'}
            </span>
          </div>
          <input
            ref={inputRef}
            id={inputId}
            value={typed}
            onChange={(e) => onTyped?.(e.target.value)}
            placeholder={typeToConfirm.value}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
      )}
      {error ? <p role="alert" className="error">{error}</p> : null}
      <div className="dialog-actions">
        <button type="button" ref={cancelRef} onClick={onCancel} disabled={busy}>Abbrechen</button>
        <button type="submit" className="button-danger-solid" disabled={!ready || busy} aria-busy={busy || undefined}>{confirmLabel}</button>
      </div>
    </form>
  )
}
