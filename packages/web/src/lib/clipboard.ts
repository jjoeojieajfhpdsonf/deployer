/**
 * Text in die Zwischenablage. navigator.clipboard gibt es nur in sicheren
 * Kontexten (HTTPS oder localhost); die Oberfläche läuft im LAN bis M4 über
 * HTTP. Dann über ein verstecktes Textfeld und execCommand.
 *
 * Gibt false zurück, wenn beides scheitert – die Oberfläche bittet dann,
 * den Text von Hand zu markieren.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* weiter mit dem Rückfall */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}
