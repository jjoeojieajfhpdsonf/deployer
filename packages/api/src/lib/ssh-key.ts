import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { GitHostKeyDto } from '@airlock/shared'

/**
 * Nacht 3, Etappe 2: Deploy-Keys (ed25519) mit node:crypto, ohne Bibliothek.
 *
 * ssh liest ed25519-Schlüssel zuverlässig nur im eigenen Format
 * («openssh-key-v1», PROTOCOL.key in OpenSSH). Das ist ein einfaches
 * Längen-Präfix-Format; hier unverschlüsselt (ciphername "none"), weil der
 * Schlüssel in der Datenbank ohnehin mit AES-GCM verschlüsselt liegt und nur
 * für einen Clone kurz als 0600-Datei auf die Platte kommt.
 */

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
/** SSH-«string»: Länge (uint32) + Bytes */
const sshString = (v: Buffer | string) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')
  return Buffer.concat([u32(b.length), b])
}

export interface DeployKey {
  /** «ssh-ed25519 AAAA… kommentar» */
  publicKey: string
  /** OpenSSH-Format (Kopfzeile BEGIN OPENSSH PRIVATE KEY) */
  privateKey: string
  /** SHA256:… wie ssh-keygen -l und GitLab ihn zeigen */
  fingerprint: string
}

/** Wire-Format des öffentlichen Schlüssels (string "ssh-ed25519", string pub) */
function ed25519Blob(pub: Buffer): Buffer {
  return Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
}

export function fingerprintOfBlob(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** Kommentar am Schlüssel: nur harmlose Zeichen (er steht beim Anbieter in der Liste) */
const cleanComment = (c: string) => c.replace(/[^A-Za-z0-9._@:+-]/g, '-').slice(0, 80)

export function generateDeployKey(comment: string): DeployKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwkPub = publicKey.export({ format: 'jwk' }) as { x?: string }
  const jwkPriv = privateKey.export({ format: 'jwk' }) as { d?: string }
  const pub = Buffer.from(jwkPub.x ?? '', 'base64url')
  const seed = Buffer.from(jwkPriv.d ?? '', 'base64url')
  if (pub.length !== 32 || seed.length !== 32) throw new Error('ed25519-Schlüssel hat eine unerwartete Länge')
  const note = cleanComment(comment)
  const blob = ed25519Blob(pub)

  const check = randomBytes(4)
  let priv = Buffer.concat([
    check, check,
    sshString('ssh-ed25519'),
    sshString(pub),
    // OpenSSH speichert 64 Bytes: Seed und öffentlicher Teil
    sshString(Buffer.concat([seed, pub])),
    sshString(note),
  ])
  // Auffüllen auf die Blockgrösse 8 mit 1, 2, 3, …
  const pad: number[] = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(blob),
    sshString(priv),
  ])
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n$/, '')
  return {
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${note}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`, // allowlist-secret (Format, Inhalt zur Laufzeit erzeugt)
    fingerprint: fingerprintOfBlob(blob),
  }
}

/** Fingerabdruck einer Zeile «typ base64 [kommentar]» (öffentlicher Schlüssel) */
export function fingerprintOfPublicKey(line: string): string | null {
  const b64 = line.trim().split(/\s+/)[1]
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return null
  return fingerprintOfBlob(Buffer.from(b64, 'base64'))
}

/** Erlaubte Schlüsseltypen eines Git-Servers */
const HOST_KEY_TYPES = new Set([
  'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
])

export interface HostKeyLine {
  type: string
  key: string
  fingerprint: string
}

/**
 * Ausgabe von ssh-keyscan (oder gespeicherte known_hosts) lesen. Kommentare,
 * fremde Typen und kaputte Zeilen fallen weg; doppelte Schlüssel zählen einmal.
 */
export function parseHostKeys(text: string): HostKeyLine[] {
  const out: HostKeyLine[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const [type, key] = parts.length >= 3 ? [parts[1]!, parts[2]!] : [parts[0]!, parts[1] ?? '']
    if (!HOST_KEY_TYPES.has(type) || !/^[A-Za-z0-9+/]+=*$/.test(key)) continue
    const blob = Buffer.from(key, 'base64')
    // Der Typ steht auch im Schlüssel selbst – muss übereinstimmen
    if (blob.length < 8 || blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('latin1') !== type) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type, key, fingerprint: fingerprintOfBlob(blob) })
  }
  return out
}

/** known_hosts-Zeilen für genau diesen Namen (HostKeyAlias beim Verbinden) */
export function knownHostsFor(alias: string, keys: HostKeyLine[]): string {
  if (!/^[A-Za-z0-9.:[\]-]+$/.test(alias)) throw new Error('Ungültiger Host für known_hosts')
  return keys.map((k) => `${alias} ${k.type} ${k.key}`).join('\n') + '\n'
}

export const hostKeyDtos = (keys: HostKeyLine[]): GitHostKeyDto[] => keys.map((k) => ({ type: k.type, fingerprint: k.fingerprint }))

/** Name in known_hosts: Port 22 ohne Klammern, sonst «[host]:port» (wie OpenSSH) */
export const hostAlias = (host: string, port: number): string => (port === 22 ? host : `[${host}]:${port}`)
