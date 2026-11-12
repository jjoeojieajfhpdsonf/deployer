import {
  browserSupportsWebAuthn, startAuthentication, startRegistration,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'

/**
 * Passkeys im Browser (WebAuthn über @simplewebauthn/browser). Fehler des
 * Browsers werden zu kurzen deutschen Sätzen; «abgebrochen» ist kein Fehler
 * im eigentlichen Sinn und bekommt einen eigenen Code.
 */

export const passkeysSupported = (): boolean => {
  try {
    return browserSupportsWebAuthn()
  } catch {
    return false
  }
}

export class PasskeyError extends Error {
  constructor(readonly cancelled: boolean, message: string) {
    super(message)
  }
}

function translate(err: unknown): PasskeyError {
  const name = (err as { name?: string; cause?: { name?: string } })?.cause?.name ?? (err as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyError(true, 'Abgebrochen oder die Zeit ist abgelaufen.')
  if (name === 'InvalidStateError') return new PasskeyError(false, 'Dieser Passkey ist auf diesem Gerät schon eingerichtet.')
  if (name === 'SecurityError') return new PasskeyError(false, 'Der Browser lässt Passkeys auf dieser Adresse nicht zu (HTTPS unter der Hauptadresse nötig).')
  return new PasskeyError(false, 'Der Passkey hat nicht geklappt. Bitte noch einmal versuchen.')
}

export async function getPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<unknown> {
  try {
    return await startAuthentication({ optionsJSON: options })
  } catch (e) {
    throw translate(e)
  }
}

export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<unknown> {
  try {
    return await startRegistration({ optionsJSON: options })
  } catch (e) {
    throw translate(e)
  }
}
