import { redactSecrets } from './redact.js'

type Level = 'info' | 'warn' | 'error'

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const line = { t: new Date().toISOString(), level, msg, ...extra }
  // Fehler von Caddy, Cloudflare und cloudflared können Tokens enthalten
  const text = redactSecrets(JSON.stringify(line))
  if (level === 'error') console.error(text)
  else if (level === 'warn') console.warn(text)
  else console.log(text)
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
}
