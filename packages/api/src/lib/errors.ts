export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} nicht gefunden`, 404)
export const conflict = (msg: string) => new AppError('conflict', msg, 409)
export const badRequest = (msg: string, details?: unknown) => new AppError('bad_request', msg, 400, details)
export const unauthorized = () => new AppError('unauthorized', 'Nicht angemeldet', 401)

/** Verstoss gegen die Container-Richtlinie. Eigener Code fuer das Audit-Log. */
export class PolicyError extends AppError {
  constructor(readonly rule: string, message: string) {
    super('policy_violation', message, 400, { rule })
    this.name = 'PolicyError'
  }
}
