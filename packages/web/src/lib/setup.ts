import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { setupSteps, type SetupPrefs, type SetupStep } from '@airlock/shared'
import { api, type MeDto } from '../api.js'
import { useSystem } from '../components/ServerName.js'
import { useProjects } from './projects.js'
import { relativeTime } from './format.js'

/**
 * Einrichtungs-Assistent (erster Start): Passwort → Cloudflare →
 * Tailscale/Adressen → Zertifikat → erstes Projekt. Ob ein Schritt erledigt
 * ist, steht in den Daten (nichts doppelt gespeichert); gespeichert wird nur,
 * was bewusst übersprungen ist und ob der Assistent von selbst erscheinen
 * soll (UiPrefs.setup, auf dem Server).
 */

export interface SetupStepState {
  key: SetupStep
  title: string
  why: string
  done: boolean
  skipped: boolean
  /** Wird gerade eingerichtet (Zertifikat) */
  running?: boolean
  /** Stand in einem Satz */
  detail: string
  action: { label: string; to: string }
}

export const STEP_TITLE: Record<SetupStep, string> = {
  passwort: 'Eigenes Passwort',
  cloudflare: 'Cloudflare verbinden',
  adressen: 'Tailnet und Adressen',
  zertifikat: 'Zertifikat für HTTPS',
  projekt: 'Erstes Projekt',
}

export function useSetup() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  const system = useSystem()
  const cf = useQuery({ queryKey: ['cloudflare'], queryFn: api.cloudflare, staleTime: 10_000 })
  const projects = useProjects()
  const prefs: SetupPrefs = me.data?.setup ?? { dismissed: false, skipped: [] }
  // Bereit, sobald jede Abfrage Daten oder einen Fehler hat: Fehlt eine, steht der betroffene
  // Schritt als «nicht abrufbar» da, der Rest normal
  const settled = (q: { data: unknown; isError: boolean }) => q.data !== undefined || q.isError
  const ready = Boolean(me.data) && settled(system) && settled(cf) && settled(projects)
  const unknown = 'Stand gerade nicht abrufbar.'

  const s = system.data
  const c = cf.data
  const list = projects.data?.projects ?? []
  const facts: Record<SetupStep, Omit<SetupStepState, 'key' | 'title' | 'skipped'>> = {
    passwort: {
      why: 'Ersetzt das Startpasswort aus der .env-Datei; danach steht es nirgends im Klartext.',
      done: me.data?.passwordSource === 'ui',
      detail: me.data?.passwordSource === 'ui' ? `Eigenes Passwort, geändert ${relativeTime(me.data.passwordChangedAt)}.` : 'Noch das Startpasswort aus der .env-Datei.',
      action: { label: 'Passwort ändern', to: '/konto#passwort' },
    },
    cloudflare: {
      why: 'Für HTTPS mit eigener Domain, öffentliche Adressen und den Tunnel. Ohne Cloudflare bleibt alles intern.',
      // Erledigt erst mit gültigem Token (letzte Prüfung nicht gescheitert)
      done: Boolean(c?.token.present && c.token.lastCheck?.valid !== false),
      detail: !c ? unknown : !c.token.present ? 'Noch kein API-Token gespeichert.'
        : c.token.lastCheck?.valid === false ? 'Token gespeichert, aber die letzte Prüfung bei Cloudflare ist gescheitert.'
        : `Token gespeichert${c.account?.name ? `, Konto ${c.account.name}` : ''}.`,
      action: { label: 'Cloudflare einrichten', to: '/system/cloudflare' },
    },
    adressen: {
      why: 'Eine Basisdomain gibt Projekten feste Namen; die Tailnet-Adresse macht sie unterwegs erreichbar.',
      done: Boolean(s?.baseDomain && s.tls.tailscaleIp),
      detail: !s ? unknown : s.baseDomain && s.tls.tailscaleIp ? `*.${s.baseDomain}, Tailnet über ${s.tls.tailscaleIp}.`
        : !s.baseDomain && !s.tls.tailscaleIp ? 'Weder Basisdomain noch Tailnet-Adresse – Projekte laufen über nip.io im LAN.'
        : !s.baseDomain ? 'Die Tailnet-Adresse ist da, die Basisdomain fehlt.' : 'Basisdomain ist da, die Tailnet-Adresse fehlt.',
      action: { label: 'Adressen prüfen', to: '/system' },
    },
    zertifikat: {
      why: 'Ein Wildcard-Zertifikat von Let’s Encrypt, damit interne Adressen über https laufen.',
      // Massgebend ist das Zertifikat selbst; «phase done» allein genügt nicht, wenn es ungültig ist
      done: Boolean(s?.tls.cert?.ok) || (c?.tls.phase === 'done' && c.tls.cert?.ok !== false && s?.tls.cert?.ok !== false),
      running: c?.tls.phase === 'staging' || c?.tls.phase === 'production',
      detail: !s && !c ? unknown
        : s?.tls.cert?.ok || (c?.tls.phase === 'done' && c.tls.cert?.ok !== false) ? `Gültig${s?.tls.cert?.daysLeft != null ? `, noch ${s.tls.cert.daysLeft} Tage` : ''}, erneuert sich selbst.`
        : c?.tls.phase === 'staging' || c?.tls.phase === 'production' ? 'Wird gerade eingerichtet.'
        : c?.tls.phase === 'failed' || (c?.tls.phase === 'done' && c.tls.cert?.ok === false) ? 'Letzter Versuch ist gescheitert.'
        : 'Noch kein Zertifikat – interne Adressen laufen über http.',
      action: { label: 'Zertifikat einrichten', to: '/system/cloudflare' },
    },
    projekt: {
      why: 'Ein Image, ein Repo, eine Compose-Datei oder eine statische Seite – oder direkt aus dem Chat mit Claude.',
      done: list.length > 0,
      detail: !projects.data ? unknown : list.length === 0 ? 'Noch kein Projekt.' : list.length === 1 ? '1 Projekt angelegt.' : `${list.length} Projekte angelegt.`,
      action: { label: 'Projekt anlegen', to: '/projekte/neu' },
    },
  }
  const steps: SetupStepState[] = setupSteps.map((key) => ({ key, title: STEP_TITLE[key], skipped: prefs.skipped.includes(key) && !facts[key].done, ...facts[key] }))
  const done = steps.filter((x) => x.done).length
  const open = steps.filter((x) => !x.done && !x.skipped)
  return {
    ready,
    error: me.error ?? system.error ?? cf.error ?? projects.error ?? null,
    steps,
    done,
    total: steps.length,
    /** Erster Schritt, der weder erledigt noch übersprungen ist */
    current: open[0]?.key ?? null,
    open: open.length,
    dismissed: prefs.dismissed,
    prefs,
  }
}

/** Übersprungene Schritte und «Später» speichern (Server; gilt auf jedem Gerät) */
export function useSaveSetup() {
  const qc = useQueryClient()
  return useMutation({
    meta: { errorTitle: 'Einrichtung nicht gespeichert' },
    mutationFn: (setup: SetupPrefs) => api.setPreferences({ setup }),
    onMutate: async (setup) => {
      // Sofort anzeigen; ein laufender Abruf darf das nicht überschreiben. Bei Fehler zurück.
      await qc.cancelQueries({ queryKey: ['me'] })
      const before = qc.getQueryData<MeDto>(['me'])
      qc.setQueryData<MeDto>(['me'], (old) => (old ? { ...old, setup } : old))
      return { before }
    },
    onError: (_e, _v, ctx) => { if (ctx?.before) qc.setQueryData(['me'], ctx.before) },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  })
}
