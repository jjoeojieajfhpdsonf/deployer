/**
 * Adresse dieser Oberfläche (für die MCP-Adresse in Tokens und «Per Chat»).
 * Die Bildtests setzen eine feste Adresse (window.__AIRLOCK_ORIGIN__), damit
 * die Bilder nicht vom Port des Testservers abhängen; sonst gilt die echte.
 */
export function appOrigin(): string {
  const fixed = (window as { __AIRLOCK_ORIGIN__?: unknown }).__AIRLOCK_ORIGIN__
  return typeof fixed === 'string' && fixed ? fixed : window.location.origin
}
