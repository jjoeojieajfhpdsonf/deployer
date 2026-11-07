import type { DeploymentDto, ProjectDto, ProjectStatus, RouteDto } from '@deployer/shared'

/**
 * Testdaten für Extremfälle (break-ui): ?demo=leer, ?demo=viele, ?demo=lang.
 * Nur in der Oberfläche, nie an die API geschickt. Deterministisch, damit
 * Screenshots vergleichbar bleiben.
 */

const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function dep(projectId: string, over: Partial<DeploymentDto> = {}): DeploymentDto {
  return {
    id: `${projectId}-d`,
    projectId,
    version: 'a3f9c21d0be4',
    sourceRef: null,
    status: 'active',
    errorMessage: null,
    startedAt: ago(2 * 60 * MIN),
    finishedAt: ago(2 * 60 * MIN - 40_000),
    isActive: true,
    durationMs: 40_000,
    trigger: 'deploy',
    rollbackOf: null,
    canRollback: false,
    ...over,
  }
}

function route(target: RouteDto['target'], host: string): RouteDto {
  return { target, targets: [target], hostname: host, aliases: [], urls: [`${target === 'public' ? 'https' : 'http'}://${host}`] }
}

function project(i: number, over: Partial<ProjectDto> & { name: string }): ProjectDto {
  const id = `demo-${i}`
  const slug = over.slug ?? over.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
  const active = dep(id)
  return {
    id,
    slug,
    sourceType: 'image',
    source: { type: 'image', image: 'traefik/whoami:v1.10.1' } as ProjectDto['source'],
    port: 80,
    healthcheckPath: '/',
    status: 'running',
    desiredState: 'running',
    keep: false,
    cpuLimit: 1,
    memoryLimitMb: 512,
    createdAt: ago(5 * 86_400_000),
    updatedAt: ago(60 * MIN),
    routes: [route('lan', `${slug}.int.deinedomain.ch`)],
    activeDeployment: active,
    runsAsRoot: null,
    runtimeKind: 'image',
    filesKind: null,
    lastChangeAt: ago(60 * MIN),
    expiresAt: null,
    security: { scanId: `${id}-s`, status: 'done', score: 96, grade: 'A', finishedAt: ago(50 * MIN), open: { critical: 0, high: 0, medium: 1, low: 0 } },
    lastDeployment: active,
    ...over,
  }
}

const STATUSES: ProjectStatus[] = ['running', 'running', 'running', 'deploying', 'failed', 'stopped', 'running', 'created']
const KINDS = ['image', 'dockerfile', 'compose', 'static', 'files'] as const

export function demoProjects(mode: string): ProjectDto[] {
  if (mode === 'leer') return []

  if (mode === 'eins') {
    // Genau eins von allem: Plural-Fallen («1 Befunde», «1 laufen»)
    return [project(1, {
      name: 'J',
      slug: 'j',
      security: { scanId: 's', status: 'done', score: 99, grade: 'A', finishedAt: ago(MIN), open: { critical: 0, high: 1, medium: 0, low: 0 } },
      lastDeployment: dep('demo-1', { startedAt: ago(61_000) }),
    })]
  }

  if (mode === 'lang') {
    // Realistisch, an den echten Grenzen: Name bis 120 Zeichen (projectNameSchema),
    // Kurzname 40, öffentlicher Name bis 253, Image bis 255; Version und
    // Fehlermeldung sind in der API unbegrenzt.
    return [
      project(1, {
        name: 'Solarertrag-Dashboard für das Mehrfamilienhaus an der Bahnhofstrasse mit Speicherauswertung, Prognose und Abrechnung',
        slug: 'solarertrag-dashboard-mehrfamilienhaus-b',
        routes: [
          route('public', 'solarertrag-dashboard-mehrfamilienhaus-bahnhofstrasse-speicher.wisniewska-kowalczyk-photography.example.com'),
          { ...route('lan', 'solarertrag-dashboard-mehrfamilienhaus-b.192-168-178-254.nip.io'), targets: ['lan', 'tailnet'] },
        ],
        security: { scanId: 's', status: 'done', score: 0, grade: 'D', finishedAt: ago(MIN), open: { critical: 12, high: 48, medium: 230, low: 1284 } },
      }),
      project(2, {
        name: 'Benachrichtigungseinstellungsverwaltungsoberfläche',
        slug: 'benachrichtigungseinstellungsverwaltungso',
        sourceType: 'dockerfile',
        runtimeKind: 'dockerfile',
        status: 'failed',
        activeDeployment: dep('demo-2', { version: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e' }),
        lastDeployment: dep('demo-2', {
          status: 'failed', isActive: false, version: '1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b',
          errorMessage: 'Healthcheck auf Port 3000 ohne Antwort nach 60 s. Letzte Log-Zeilen:\nError: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)\n    at TCPConnectWrap.callbackTrampoline (node:internal/async_hooks:130:17)',
        }),
      }),
      project(3, {
        name: 'Đặng Thị Ngọc Hân – Fotoalbum',
        slug: 'dang-thi-ngoc-han-fotoalbum',
        status: 'deploying',
        sourceType: 'image',
        source: { type: 'image', image: 'ghcr.io/wisniewska-kowalczyk-photography/fotoalbum-frontend-mit-bildoptimierung:2026.11.07-build.4711-rc.3' } as ProjectDto['source'],
        lastDeployment: dep('demo-3', { status: 'healthchecking', isActive: false, finishedAt: null, startedAt: ago(20_000) }),
        security: null,
      }),
      project(4, {
        name: '🦊 Fox-Blog 王秀英',
        slug: 'fox-blog',
        sourceType: 'files',
        runtimeKind: 'static',
        expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        security: { scanId: 's', status: 'running', score: null, grade: null, finishedAt: null, open: { critical: 0, high: 0, medium: 0, low: 0 } },
      }),
      project(5, { name: 'Ohne Adresse und ohne Deploy', slug: 'ohne-adresse', status: 'created', desiredState: 'stopped', routes: [], activeDeployment: null, lastDeployment: null, security: null }),
      project(6, {
        name: 'Rezepte',
        slug: 'rezepte',
        status: 'stopped',
        desiredState: 'stopped',
        sourceType: 'compose',
        runtimeKind: 'compose',
        lastDeployment: dep('demo-6', { startedAt: ago(400 * 86_400_000) }),
        security: { scanId: 's', status: 'failed', score: null, grade: null, finishedAt: null, open: { critical: 0, high: 0, medium: 0, low: 0 } },
      }),
    ]
  }

  // viele: 50 gemischte Projekte; «hunderte»: 200 (oberes realistisches Ende)
  const count = mode === 'hunderte' ? 200 : 50
  const words = ['portfolio', 'solar-heute', 'nextcloud', 'blog-api', 'whoami', 'wetter-widget', 'garten-sensor', 'rezepte', 'kontoauszug', 'fotoalbum']
  return Array.from({ length: count }, (_, i) => {
    const status = STATUSES[i % STATUSES.length]!
    const kind = KINDS[i % KINDS.length]!
    const name = `${words[i % words.length]}${i >= words.length ? `-${Math.floor(i / words.length) + 1}` : ''}`
    const grade = (['A', 'B', 'C', 'D'] as const)[i % 4]!
    const score = { A: 96, B: 82, C: 61, D: 34 }[grade]
    const open = { critical: grade === 'D' ? 1 : 0, high: grade === 'C' ? 2 : 0, medium: i % 3, low: i % 5 }
    return project(i, {
      name,
      status,
      sourceType: kind,
      runtimeKind: kind === 'files' ? 'static' : kind,
      desiredState: status === 'stopped' || status === 'created' ? 'stopped' : 'running',
      routes: i % 6 === 0 ? [route('public', `${name}.deinedomain.ch`), route('lan', `${name}.int.deinedomain.ch`)] : [route('lan', `${name}.int.deinedomain.ch`)],
      security: status === 'created' ? null : { scanId: `s${i}`, status: 'done', score, grade, finishedAt: ago(i * 10 * MIN), open },
      lastDeployment: status === 'failed'
        ? dep(`demo-${i}`, { status: 'failed', isActive: false, errorMessage: 'Healthcheck auf Port 3000 ohne Antwort.', startedAt: ago(i * 7 * MIN) })
        : status === 'deploying'
          ? dep(`demo-${i}`, { status: 'starting', isActive: false, finishedAt: null, startedAt: ago(30_000) })
          : dep(`demo-${i}`, { startedAt: ago(i * 37 * MIN) }),
      activeDeployment: status === 'created' ? null : dep(`demo-${i}`, { startedAt: ago(i * 37 * MIN) }),
    })
  })
}
