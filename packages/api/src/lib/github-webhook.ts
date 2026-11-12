import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Etappe 6: Signatur eines GitHub-Webhooks prüfen (X-Hub-Signature-256).
 *
 * Bewusst OHNE Endpunkt: Airlock ist nie öffentlich erreichbar, GitHub kann
 * es nicht aufrufen. Vorschauen und Auto-Deploy fragen deshalb die GitHub-API
 * ab (jobs/previews.ts, jobs/auto-deploy.ts). Die Prüfung liegt hier als
 * reine, getestete Funktion bereit für einen späteren Weg, der Ereignisse
 * zustellt, ohne Airlock zu öffnen (z. B. ein Relay, das nur ausgehend
 * verbunden ist). Das Secret wäre gitConnections.webhookSecretEncrypted.
 *
 * Regeln: nur «sha256=<64 Hex>», HMAC-SHA256 über die rohen Bytes des
 * Bodys (nicht über neu serialisiertes JSON), zeitkonstanter Vergleich,
 * ohne Secret nie gültig.
 */
export function verifyWebhookSignature(secret: string | null | undefined, rawBody: Buffer | string, header: string | null | undefined): boolean {
  if (!secret || !header) return false
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
  if (!m) return false
  const given = Buffer.from(m[1]!.toLowerCase(), 'hex')
  const expected = createHmac('sha256', secret).update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Signatur erzeugen (Gegenstück, für Tests und ein späteres Relay) */
export function signWebhook(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody).digest('hex')}`
}
