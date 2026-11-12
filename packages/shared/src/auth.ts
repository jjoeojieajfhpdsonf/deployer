import { z } from 'zod'

/* ------------------------------------------------------------------ *
 * Nacht 3, Etappe 1: Passkeys, Authenticator-App (TOTP),
 * Wiederherstellungscodes, Sitzungen, erneute Bestätigung (sudo).
 * Gemeinsame Typen und Eingaberegeln für API und Oberfläche.
 * ------------------------------------------------------------------ */

/** Wie lange eine erneute Bestätigung gilt */
export const SUDO_MINUTES = 10
/** Anzahl Wiederherstellungscodes je Satz */
export const RECOVERY_CODE_COUNT = 10

/** Womit eine Sitzung angemeldet wurde */
export type SessionMethod = 'password' | 'password_totp' | 'password_recovery' | 'passkey'

/** Über welchen Weg ein Gerät kam (aus der Absenderadresse, wie Caddy sie sieht) */
export type SessionAccess = 'tailnet' | 'lan' | 'gateway' | 'server' | 'unknown'

export interface SessionDto {
  id: string
  current: boolean
  createdAt: string
  lastSeenAt: string
  /** «Firefox auf macOS»; null, wenn der Browser sich nicht zu erkennen gibt */
  device: string | null
  ip: string | null
  access: SessionAccess
  method: SessionMethod
}

export interface PasskeyDto {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  /** Synchronisiert (z. B. iCloud-Schlüsselbund) oder an ein Gerät gebunden; null = unbekannt */
  synced: boolean | null
  /** Adresse, für die der Passkey gilt (RP-ID) */
  rpId: string
}

/** Wo Passkeys gehen: nur unter der Hauptadresse über HTTPS */
export interface PasskeyHostDto {
  /** Auf dieser Adresse lassen sich Passkeys verwenden */
  available: boolean
  /** Die Adresse, für die Passkeys gelten (RP-ID); null = keine (kein interner Name, kein HTTPS) */
  rpId: string | null
  /** URL der Hauptadresse, wenn diese Seite unter einer anderen Adresse offen ist */
  mainUrl: string | null
  /** Warum hier nicht (nur wenn !available) */
  reason: 'other_host' | 'no_https' | 'no_base_domain' | null
}

export interface SecurityDto {
  passkeys: PasskeyDto[]
  totp: { enabled: boolean; enabledAt: string | null }
  recovery: { total: number; remaining: number; createdAt: string | null }
  /** «Zweiter Faktor erforderlich»: wirksam (nur mit eingerichtetem Faktor) */
  required: boolean
  /** gespeicherte Einstellung: null = Standard (an, sobald ein Faktor da ist) */
  requiredSetting: boolean | null
  /** Ein Faktor ist eingerichtet (Passkey oder TOTP) */
  hasFactor: boolean
  /** Erneute Bestätigung gilt bis (ISO); null = nicht bestätigt */
  sudoUntil: string | null
  passkeyHost: PasskeyHostDto
}

/** Was die erneute Bestätigung bzw. der zweite Schritt der Anmeldung verlangt */
export interface SecondFactorDto {
  /** Code aus der Authenticator-App möglich */
  totp: boolean
  /** Wiederherstellungscode möglich (noch Codes übrig) */
  recovery: boolean
  /** Passkey möglich (eingerichtet und auf dieser Adresse verwendbar) */
  passkey: boolean
}

/** Antwort auf POST /auth/login */
export type LoginResultDto =
  | { ok: true; recoveryRemaining?: number }
  | { ok: false; secondFactor: SecondFactorDto; passkeyHost: PasskeyHostDto }

/** Ohne Anmeldung: was die Anmeldeseite anbieten kann (GET /auth/me) */
export interface LoginOptionsDto {
  passkeyHost: PasskeyHostDto
  /** Mindestens ein Passkey ist eingerichtet (für diese Adresse) */
  passkeys: boolean
}

export interface SudoStatusDto {
  until: string | null
  needs: SecondFactorDto & { password: boolean }
}

/** TOTP einrichten: Geheimnis (zum Abtippen), otpauth-URI und QR-Code als Zeilen «0101…» (wie beim Backup-Schlüssel) */
export interface TotpSetupDto {
  secret: string
  uri: string
  qr: string[]
}

/** Neue Wiederherstellungscodes – nur in dieser einen Antwort im Klartext */
export interface RecoveryCodesDto {
  codes: string[]
  createdAt: string
  /** Inhalt der .txt-Datei zum Herunterladen */
  text: string
}

/* --- Eingaben -------------------------------------------------------------- */

/** 6 Ziffern; Leerzeichen und Bindestrich (aus der App kopiert) werden entfernt */
export const totpCodeSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Gib die 6 Ziffern aus der Authenticator-App ein'))

/** Wiederherstellungscode: 12 Zeichen, Bindestriche/Leerzeichen egal */
export const recoveryCodeSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, '').toLowerCase())
  .pipe(z.string().regex(/^[0-9a-z]{12}$/, 'Ein Wiederherstellungscode hat 12 Zeichen, z. B. abcd-efgh-2345'))

export const secondFactorSchema = z.union([
  z.object({ code: totpCodeSchema }).strict(),
  z.object({ recoveryCode: recoveryCodeSchema }).strict(),
])

export const sudoSchema = z.object({
  password: z.string().min(1, 'Gib dein Passwort ein').max(512, 'Höchstens 512 Zeichen'),
  code: totpCodeSchema.optional(),
  recoveryCode: recoveryCodeSchema.optional(),
})

export const passkeyNameSchema = z.object({
  name: z.string().trim().min(1, 'Gib dem Passkey einen Namen, z. B. MacBook oder iPhone').max(60, 'Höchstens 60 Zeichen'),
})

export const totpEnableSchema = z.object({ code: totpCodeSchema })

export const requiredSchema = z.object({ required: z.boolean() })

/** Lesbarer Name der Anmeldeart */
export function sessionMethodLabel(m: SessionMethod): string {
  switch (m) {
    case 'passkey': return 'Passkey'
    case 'password_totp': return 'Passwort + Authenticator'
    case 'password_recovery': return 'Passwort + Wiederherstellungscode'
    default: return 'Passwort'
  }
}

export function sessionAccessLabel(a: SessionAccess): string {
  switch (a) {
    case 'tailnet': return 'Tailnet'
    case 'lan': return 'LAN'
    case 'gateway': return 'Docker-Gateway'
    case 'server': return 'Server selbst'
    default: return 'unbekannt'
  }
}
