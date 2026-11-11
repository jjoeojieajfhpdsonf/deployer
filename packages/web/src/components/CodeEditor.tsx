import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language'
import { html } from '@codemirror/lang-html'
import { tags as t } from '@lezer/highlight'

/**
 * HTML-Editor (CodeMirror 6) für die Pause-Seite: Hervorhebung, Zeilennummern,
 * Zeilenumbruch, Platzhalter {{…}} markiert. Alle Farben kommen aus Tokens in
 * styles.css (--cm-*): hell im hellen, dunkel im dunklen Modus, ohne eigene
 * Umschaltung. Kein Violett (Taste Skill).
 */

export interface CodeEditorHandle {
  /** Text an der Cursorposition einsetzen (ersetzt die Auswahl) */
  insert: (text: string) => void
  /** Ganzen Inhalt ersetzen (eine Undo-Stufe) */
  replaceAll: (text: string) => void
  focus: () => void
}

const highlight = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: 'var(--cm-tag)' },
  { tag: t.attributeName, color: 'var(--cm-attr)' },
  { tag: [t.attributeValue, t.string], color: 'var(--cm-string)' },
  { tag: [t.comment, t.meta, t.processingInstruction, t.documentMeta], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [t.propertyName], color: 'var(--cm-attr)' },
  { tag: [t.number, t.unit, t.color, t.atom, t.keyword], color: 'var(--cm-number)' },
  { tag: [t.className, t.labelName, t.typeName], color: 'var(--cm-tag)' },
  { tag: t.invalid, color: 'var(--bad)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--cm-bg)', color: 'var(--cm-ink)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--cm-ink)' },
  '.cm-gutters': { backgroundColor: 'var(--cm-bg)', color: 'var(--cm-gutter)', border: 'none', paddingLeft: '6px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px', minWidth: '28px' },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active)', color: 'var(--cm-ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--cm-ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--cm-selection) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--cm-active)', outline: '1px solid var(--cm-gutter)' },
  '.cm-placeholder-token': { backgroundColor: 'var(--cm-token-bg)', color: 'var(--cm-token)', borderRadius: '3px', boxShadow: '0 0 0 1px var(--cm-token-line)' },
})

/** {{title}}, {{back_at}}, {{back_at_iso}} hervorheben */
const tokenMarks = new MatchDecorator({ regexp: /\{\{\s*[a-z_]+\s*\}\}/g, decoration: Decoration.mark({ class: 'cm-placeholder-token' }) })
const tokens = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = tokenMarks.createDeco(view) }
  update(u: ViewUpdate) { this.decorations = tokenMarks.updateDeco(u, this.decorations) }
}, { decorations: (v) => v.decorations })

export const CodeEditor = forwardRef<CodeEditorHandle, {
  value: string
  onChange: (v: string) => void
  /** Beschriftung für Screenreader (das Feld hat kein <label>) */
  label: string
  describedBy?: string
  invalid?: boolean
}>(function CodeEditor({ value, onChange, label, describedBy, invalid }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const change = useRef(onChange)
  change.current = onChange

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), indentOnInput(), bracketMatching(),
          EditorView.lineWrapping,
          html({ autoCloseTags: true }),
          syntaxHighlighting(highlight),
          tokens,
          theme,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ 'aria-label': label, ...(describedBy ? { 'aria-describedby': describedBy } : {}), 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off' }),
          EditorView.updateListener.of((u) => { if (u.docChanged) change.current(u.state.doc.toString()) }),
        ],
      }),
    })
    view.current = v
    return () => { v.destroy(); view.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Von aussen geänderter Wert (Vorlage, Zurücksetzen): übernehmen, ohne den Cursor zu verlieren, wenn gleich
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  useImperativeHandle(ref, () => ({
    insert: (text) => {
      const v = view.current
      if (!v) return
      const r = v.state.selection.main
      v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length }, scrollIntoView: true })
      v.focus()
    },
    replaceAll: (text) => {
      const v = view.current
      if (!v) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
      v.focus()
    },
    focus: () => view.current?.focus(),
  }), [])

  return <div ref={host} className={`code-editor${invalid ? ' code-editor-invalid' : ''}`} />
})
