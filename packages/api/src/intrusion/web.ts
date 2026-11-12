import { WebScanCounter } from './rules.js'

/**
 * Nacht 3, Etappe 5: Zähler für «Scan von aussen». Das Besucher-Log
 * (traffic/service.ts) meldet jede Anfrage hierher; die Einbruchserkennung
 * holt jede Minute ab (intrusion/jobs.ts). Eigenes Modul, damit die
 * Besucher-Auswertung nicht die ganze Einbruchserkennung lädt.
 */
export const webScans = new WebScanCounter()
