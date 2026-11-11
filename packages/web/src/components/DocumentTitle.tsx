import { useEffect } from 'react'
import { PRODUCT_NAME } from '@airlock/shared'
import { usePageName } from './PageHead.js'
import { useActivities } from '../lib/activities.js'
import { useProjects, deployFailedState } from '../lib/projects.js'
import { useServerEvents } from '../lib/live.js'
import { faviconSvg, titleFor } from '../lib/title.js'

/**
 * UI-Qualität 3, in der angemeldeten Shell: Ereignisstrom, Tab-Titel
 * (lib/title.ts) und Favicon-Punkt bei gescheitertem Deploy oder offenem
 * kritischen Befund.
 */
export function ShellLive() {
  useServerEvents()
  const page = usePageName()
  const running = useActivities()
  const projects = useProjects().data?.projects ?? []
  const alarm = projects.some((p) => deployFailedState(p) || (p.security?.open.critical ?? 0) > 0)

  const title = titleFor(page, running)
  useEffect(() => {
    document.title = title
  }, [title])

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = faviconSvg(alarm)
  }, [alarm])

  // Abgemeldet bzw. Shell verlassen: Titel und Favicon zurück
  useEffect(() => () => {
    document.title = PRODUCT_NAME
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link) link.href = faviconSvg(false)
  }, [])
  return null
}
