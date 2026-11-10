#!/usr/bin/env node
/**
 * PreToolUse-Hook (Bash): Projektdateien nur mit Edit/Write ändern, nie per
 * Shell (Regel aus CLAUDE.md, wurde mehrfach gebrochen).
 *
 * Blockiert:
 * - sed -i / sed --in-place, perl -i (auch -pi, -i.bak)
 * - Umleitungen (>, >>, &>, 1>) und tee in eine Datei im Projekt – mit oder
 *   ohne Heredoc
 *
 * Erlaubt bleibt: Heredoc als Eingabe (git commit -F - <<'MSG'), Umleitungen
 * nach /dev/null, /tmp, /private/tmp und ausserhalb des Projekts sowie in
 * .git/ (Git-Verwaltung, keine Projektdatei).
 *
 * Eingabe: JSON auf stdin ({ tool_input: { command }, cwd }).
 * Ausgabe: bei Verstoss permissionDecision "deny" mit Begründung.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
const cmd = String(input?.tool_input?.command ?? '')
const cwd = String(input?.cwd || process.cwd())
const root = resolve(process.env.CLAUDE_PROJECT_DIR || cwd)

/** Heredoc-Körper entfernen: was dort steht, ist Text, keine Befehle. */
function stripHeredocs(s) {
  const lines = s.split('\n')
  const out = []
  let end = null
  for (const line of lines) {
    if (end !== null) {
      if (line.replace(/^\t+/, '') === end) end = null
      continue
    }
    out.push(line)
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (m) end = m[2]
  }
  return out.join('\n')
}

/** Einfache Wortzerlegung mit Anführungszeichen (reicht für Pfade). */
function words(s) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

const insideProject = (target) => {
  if (!target || target.startsWith('&') || target.startsWith('$(')) return false
  const t = target.replace(/^~(?=\/)/, process.env.HOME ?? '~')
  if (/^\/dev\//.test(t)) return false
  const abs = isAbsolute(t) ? resolve(t) : resolve(cwd, t)
  if (/^\/(private\/)?tmp\//.test(abs) || /^\/private\/var\/folders\//.test(abs)) return false
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  if (rel === '.git' || rel.startsWith(`.git/`) || /(^|\/)\.git\//.test(rel)) return false
  return true
}

const code = stripHeredocs(cmd)
const reasons = []

// sed -i / --in-place (auch zusammengesetzte Flags wie -Ei, -i.bak, -i '')
for (const seg of code.split(/[;&|\n]+/)) {
  const w = words(seg.trim())
  const i = w.findIndex((x) => /(^|\/)(g?sed)$/.test(x))
  if (i >= 0 && w.slice(i + 1).some((x) => /^--in-place/.test(x) || /^-[a-zA-Z]*i/.test(x))) reasons.push('sed -i')
  const p = w.findIndex((x) => /(^|\/)perl$/.test(x))
  if (p >= 0 && w.slice(p + 1).some((x) => /^-[a-zA-Z]*i/.test(x))) reasons.push('perl -i')
}

// Ausgabe-Umleitungen in Projektdateien (>, >>, &>, 1>, >|), nicht 2> und nicht >&N.
// Strings in Anführungszeichen vorher maskieren (grep 'a > b'), ausser direkt
// nach einem Umleitungszeichen – dort ist der String das Ziel.
const unquoted = code.replace(/(?<!>\s*)("(?:[^"\\]|\\.)*"|'[^']*')/g, '__Q__')
const redirect = /(?:^|[^<>&0-9])(?:[1&]?>>?|>\|)\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g
let m
while ((m = redirect.exec(unquoted))) {
  const target = m[1].replace(/^["']|["']$/g, '')
  if (insideProject(target)) reasons.push(`Umleitung nach ${target}`)
}

// tee [-a] datei
for (const seg of code.split(/[;&|\n]+/)) {
  const w = words(seg.trim())
  const t = w.findIndex((x) => /(^|\/)tee$/.test(x))
  if (t >= 0) for (const f of w.slice(t + 1).filter((x) => !x.startsWith('-'))) if (insideProject(f)) reasons.push(`tee nach ${f}`)
}

if (reasons.length) {
  const uniq = [...new Set(reasons)]
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Projektdateien nur mit Edit/Write ändern, nie per Shell (${uniq.join(', ')}). ` +
        'Siehe CLAUDE.md. Temporäre Dateien gehören ins Scratchpad bzw. nach /tmp.',
    },
  }))
}
process.exit(0)
