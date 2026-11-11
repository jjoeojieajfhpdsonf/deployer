import { defineConfig } from '@playwright/test'

/**
 * Visuelle Regressionstests: Hauptseiten und wichtige Zustände in Hell und
 * Dunkel bei 1440 px, mit den Fixtures aus design-shots/. Referenzbilder in
 * visual/referenz/ (eingecheckt), Ergebnisse und Diff-Bilder bei Abweichung
 * in visual/ergebnis/, Bericht in visual/bericht/ (beides nicht eingecheckt).
 *
 *   pnpm test:visual          vergleichen
 *   pnpm test:visual:update   gewollte Änderungen als neue Referenz übernehmen
 *
 * Eigener Port (5299), damit es nicht mit dem Screenshot-Werkzeug (5199)
 * zusammenstösst. Mit VISUAL_PORT=… ein anderer, damit mehrere Worktrees
 * gleichzeitig testen können.
 */
export const VISUAL_PORT = Number(process.env.VISUAL_PORT) || 5299

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './ergebnis',
  snapshotPathTemplate: '{testDir}/referenz/{arg}{ext}',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { outputFolder: './bericht', open: 'never' }]],
  expect: {
    toHaveScreenshot: {
      // Klein und absolut: höchstens 20 Pixel dürfen abweichen (Kantenglättung). Ein Anteil
      // (z. B. 0,2 %) war bei ganzen Seiten zu grob – ein halb so langer Balken rutschte durch.
      maxDiffPixels: 20,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: {
    // Installiertes Chrome (kein Browser-Download); PW_CHANNEL=chromium für Playwrights eigenen
    channel: process.env.PW_CHANNEL ?? 'chrome',
    // Feste Schriftglättung: sonst wechselt sie (LCD ↔ Graustufen), sobald ein Menü eine eigene
    // Ebene bildet, und ganze Seiten weichen um Tausende Pixel ab
    launchOptions: { args: ['--disable-lcd-text', '--disable-gpu', '--force-color-profile=srgb', '--font-render-hinting=none'] },
  },
  webServer: {
    command: `npx vite --port ${VISUAL_PORT} --strictPort --logLevel error`,
    cwd: '..',
    url: `http://localhost:${VISUAL_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
