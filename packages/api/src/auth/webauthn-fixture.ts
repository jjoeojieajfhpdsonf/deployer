import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON,
} from '@simplewebauthn/server'

/**
 * Nur für Tests: ein Authenticator in Software (ES256, P-256), wie ein
 * Passkey im Telefon – erzeugt Registrierung und Anmeldung nach WebAuthn
 * Level 2 (Attestation «none»). So prüfen die Tests den echten Weg durch
 * @simplewebauthn/server statt einer Attrappe.
 */

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url')
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest()

interface Cred { id: Buffer; key: KeyObject; counter: number; userHandle: string | null; rpID: string }

export class SoftAuthenticator {
  readonly creds: Cred[] = []

  constructor(public origin: string, public rpID: string) {}

  register(options: PublicKeyCredentialCreationOptionsJSON, o: { origin?: string; rpID?: string; userVerified?: boolean } = {}): RegistrationResponseJSON {
    const rpID = o.rpID ?? this.rpID
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const id = randomBytes(16)
    const cose = new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))],
    ])
    const flags = 0x01 | (o.userVerified === false ? 0 : 0x04) | 0x40
    const len = Buffer.alloc(2)
    len.writeUInt16BE(id.length)
    const authData = Buffer.concat([sha256(rpID), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, id, Buffer.from(isoCBOR.encode(cose))])
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }))
    const att = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never)
    this.creds.push({ id, key: privateKey, counter: 0, userHandle: options.user.id, rpID })
    return {
      id: b64u(id), rawId: b64u(id), type: 'public-key',
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    }
  }

  authenticate(options: PublicKeyCredentialRequestOptionsJSON, o: { origin?: string; credential?: Cred; counter?: number } = {}): AuthenticationResponseJSON {
    const allowed = options.allowCredentials?.map((c) => c.id) ?? []
    const cred = o.credential ?? this.creds.find((c) => c.rpID === options.rpId && (!allowed.length || allowed.includes(b64u(c.id))))
    if (!cred) throw new Error('Kein passender Passkey')
    cred.counter = o.counter ?? cred.counter + 1
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(cred.counter)
    const authData = Buffer.concat([sha256(cred.rpID), Buffer.from([0x01 | 0x04]), counter])
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origin ?? this.origin, crossOrigin: false }))
    const sig = createSign('sha256').update(Buffer.concat([authData, sha256(clientData)])).sign(cred.key)
    return {
      id: b64u(cred.id), rawId: b64u(cred.id), type: 'public-key',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), ...(cred.userHandle ? { userHandle: cred.userHandle } : {}) },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    }
  }
}
