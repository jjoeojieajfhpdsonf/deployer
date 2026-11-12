import { useEffect, useRef } from 'react'
import { useProjects } from '../lib/projects.js'
import { isDeployRunning } from '../lib/activities.js'
import { matrixActive, useFunPrefs, usePageVisible, useReducedMotion, useResolvedTheme } from '../lib/fun.js'

/**
 * Etappe 7: Matrix-Regen – Leinwand im Hintergrund, solange ein Deploy läuft.
 * Im Terminal-Theme an, sonst per Schalter in Darstellung. Höchstens 30 Bilder
 * pro Sekunde, hält bei verstecktem Tab an, aria-hidden und nie klickbar.
 * Die Zeichen sind höchstens so hell wie --matrix: Text darüber behält seinen
 * Kontrast (contrast.mjs), und die Shell liegt ohnehin darüber.
 *
 * Bewegung (Emil): reine Deko während eines seltenen, langen Vorgangs; linear
 * (konstante Bewegung), mit reduzierter Bewegung ganz aus.
 */
const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789'
const FPS = 30
const CELL = 18

declare global {
  interface Window {
    /** Nur Screenshots: feste Folge von Bildern zeichnen und stehen lassen (auch bei reduzierter Bewegung) */
    __AIRLOCK_MATRIX_STILL__?: boolean
  }
}

/** Kleiner, fester Zufall (Screenshots sollen gleich aussehen) */
function seeded(seed: number) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

export function MatrixRain() {
  const prefs = useFunPrefs()
  const theme = useResolvedTheme()
  const reduced = useReducedMotion()
  const visible = usePageVisible()
  const projects = useProjects()
  const deploying = (projects.data?.projects ?? []).some((p) => p && isDeployRunning(p))
  const still = typeof window !== 'undefined' && window.__AIRLOCK_MATRIX_STILL__ === true
  const active = matrixActive({ prefs, theme, deploying, reducedMotion: reduced && !still, visible })
  const ref = useRef<HTMLCanvasElement>(null)

  // Die Shell legt sich über die Leinwand (styles.css: html[data-matrix='on'])
  useEffect(() => {
    if (!active) return
    document.documentElement.dataset.matrix = 'on'
    return () => { delete document.documentElement.dataset.matrix }
  }, [active])

  useEffect(() => {
    const canvas = ref.current
    if (!active || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const css = getComputedStyle(document.documentElement)
    const glyph = css.getPropertyValue('--matrix').trim() || '#11251a'
    const ground = css.getPropertyValue('--bg').trim() || '#000000'
    const rnd = still ? seeded(7) : Math.random
    let cols: number[] = []
    let w = 0
    let h = 0
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = ground
      ctx.fillRect(0, 0, w, h)
      cols = Array.from({ length: Math.ceil(w / CELL) }, () => Math.floor(rnd() * -h / CELL))
    }
    const frame = () => {
      // Spur: jedes Bild den Grund leicht darüber – ältere Zeichen verblassen
      ctx.globalAlpha = 0.09
      ctx.fillStyle = ground
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1
      ctx.fillStyle = glyph
      ctx.font = `${CELL - 4}px ui-monospace, Menlo, Consolas, monospace`
      for (let i = 0; i < cols.length; i++) {
        const y = cols[i]!
        if (y >= 0) ctx.fillText(GLYPHS[Math.floor(rnd() * GLYPHS.length)]!, i * CELL, y * CELL)
        cols[i] = y * CELL > h && rnd() > 0.975 ? 0 : y + 1
      }
    }
    resize()
    if (still) {
      for (let n = 0; n < 90; n++) frame()
      return
    }
    let raf = 0
    let last = 0
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      if (t - last < 1000 / FPS - 1) return
      last = t
      frame()
    }
    raf = requestAnimationFrame(loop)
    window.addEventListener('resize', resize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize) }
  }, [active, still])

  if (!active) return null
  return <canvas ref={ref} className="matrix-rain" aria-hidden="true" />
}
