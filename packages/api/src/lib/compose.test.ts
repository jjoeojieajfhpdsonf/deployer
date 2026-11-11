import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'yaml'
import { normalizeCompose, parseDotenv, withServiceEnv, withMappedEnv, retargetCompose, type ComposeContext } from './compose.js'

const files: Record<string, string> = {
  'app.env': 'FROM_FILE=1\n# Kommentar\nQUOTED="mit leerzeichen"\n',
}

function ctx(over: Partial<ComposeContext> = {}): ComposeContext {
  return {
    slug: 'shop',
    deploymentShort: 'abc123',
    deploymentId: '11111111-2222-3333-4444-555555555555',
    webService: 'web',
    network: 'air_shop',
    memoryLimitMb: 512,
    cpuLimit: 1,
    projectEnv: { SECRET_KEY: 's3cr$t' },
    repo: {
      resolvePath: async (rel) => {
        if (rel.includes('..')) throw new Error(`Pfad "${rel}" liegt nicht im Repo`)
        return `/data/work/x/${rel}`
      },
      readFile: async (rel) => {
        const c = files[rel]
        if (c === undefined) throw new Error(`"${rel}" gibt es im Repo nicht`)
        return c
      },
    },
    ...over,
  }
}

const norm = async (yaml: string, c = ctx()) => {
  const r = await normalizeCompose(yaml, c)
  return { ...r, doc: parse(r.yaml) as Record<string, any> }
}

async function rejects(yaml: string, re: RegExp, c = ctx()) {
  await assert.rejects(normalizeCompose(yaml, c), (err: Error) => {
    assert.match(err.message, re)
    return true
  })
}

const WEB = 'services:\n  web:\n    image: traefik/whoami:latest\n'

describe('Compose: gültige Datei wird normalisiert', () => {
  test('Web-Dienst und Datenbank mit benanntem Volume', async () => {
    const r = await norm(`
services:
  web:
    image: ghcr.io/x/shop:1.2
    depends_on: [db]
    environment:
      DB_HOST: db
  db:
    image: postgres:17-alpine
    environment: [POSTGRES_PASSWORD=pw]
    volumes:
      - daten:/var/lib/postgresql/data
volumes:
  daten:
`)
    assert.equal(r.projectName, 'air_shop')
    assert.equal(r.webContainer, 'air_shop-web-1')
    assert.deepEqual(r.services, ['web', 'db'])
    assert.deepEqual(r.doc.networks, { default: { name: 'air_shop', external: true } })
    assert.deepEqual(r.doc.volumes, { daten: {} })
    assert.deepEqual(r.doc.services.db.volumes, ['daten:/var/lib/postgresql/data'])
  })

  test('jeder Dienst bekommt Grenzen, Log-Rotation, no-new-privileges und Labels', async () => {
    const { doc } = await norm(WEB)
    const web = doc.services.web
    assert.equal(web.mem_limit, '512m')
    assert.equal(web.cpus, 1)
    assert.deepEqual(web.security_opt, ['no-new-privileges:true'])
    assert.deepEqual(web.logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '5' } })
    assert.equal(web.restart, 'unless-stopped')
    assert.equal(web.labels['airlock.project'], 'shop')
    assert.equal(web.labels['airlock.managed'], 'true')
    assert.equal(web.labels['deployer.project'], undefined)
  })

  test('Projekt-Env nur beim Web-Dienst', async () => {
    const { doc } = await norm(WEB + '  worker:\n    image: alpine\n')
    assert.ok(doc.services.web.environment.SECRET_KEY)
    assert.equal(doc.services.worker.environment, undefined)
  })

  test('"$" bleibt wörtlich: keine Interpolation aus der Umgebung von Airlock', async () => {
    const r = await norm(`
services:
  web:
    image: alpine
    command: echo \${DATABASE_URL}
    environment:
      A: "\${ADMIN_PASSWORD}"
`)
    // In der Datei steht "$$", das Compose zu einem wörtlichen "$" macht.
    assert.match(r.yaml, /\$\$\{DATABASE_URL\}/)
    assert.equal(r.doc.services.web.environment.A, '$${ADMIN_PASSWORD}')
    // Auch die Secrets des Projekts werden maskiert, nicht interpoliert.
    assert.equal(r.doc.services.web.environment.SECRET_KEY, 's3cr$$t')
  })

  test('build bekommt einen eigenen Tag pro Fassung', async () => {
    const r = await norm('services:\n  web:\n    build: .\n')
    assert.equal(r.doc.services.web.image, 'airlock/shop-web:abc123')
    assert.equal(r.doc.services.web.build.context, '/data/work/x/.')
    assert.deepEqual(r.builtImages, ['airlock/shop-web:abc123'])
  })

  test('env_file wird aus dem Repo gelesen und übernommen', async () => {
    const { doc } = await norm('services:\n  web:\n    image: alpine\n    env_file: app.env\n    environment:\n      FROM_FILE: "2"\n')
    assert.equal(doc.services.web.environment.FROM_FILE, '2', 'environment gewinnt über env_file')
    assert.equal(doc.services.web.environment.QUOTED, 'mit leerzeichen')
  })

  test('x-Erweiterungen werden verworfen', async () => {
    const { doc } = await norm('x-common: &c\n  image: alpine\nservices:\n  web:\n    <<: *c\n    x-note: egal\n')
    assert.equal(doc['x-common'], undefined)
    assert.equal(doc.services.web.image, 'alpine')
    assert.equal(doc.services.web['x-note'], undefined)
  })

  test('Etappe 4: x-airlock-env und x-airlock-internal bleiben (nur Namen und Port)', async () => {
    const r = await norm('services:\n  web:\n    image: a\n  db:\n    image: postgres:17\n    x-airlock-env:\n      POSTGRES_PASSWORD: DB_PASSWORD\n  adminer:\n    image: adminer:5\n    x-airlock-internal: 8080\n')
    assert.deepEqual(r.doc.services.db['x-airlock-env'], { POSTGRES_PASSWORD: 'DB_PASSWORD' })
    assert.equal(r.doc.services.adminer['x-airlock-internal'], 8080)
    assert.deepEqual(r.internal, [{ service: 'adminer', port: 8080 }])
    // Kein Wert im Artefakt
    assert.equal(r.doc.services.db.environment, undefined)
  })

  test('restart: always wird zu unless-stopped, no bleibt', async () => {
    const { doc } = await norm('services:\n  web:\n    image: a\n    restart: always\n  job:\n    image: b\n    restart: "no"\n')
    assert.equal(doc.services.web.restart, 'unless-stopped')
    assert.equal(doc.services.job.restart, 'no')
  })
})

describe('Compose: Ausbrüche werden abgelehnt', () => {
  const cases: [string, string, RegExp][] = [
    ['privileged', 'privileged: true', /privileged.*Root-Rechte/],
    ['ports', 'ports: ["8080:80"]', /ports.*Host-Ports/],
    ['ports nur Container-Port', 'ports: ["80"]', /ports/],
    ['network_mode host', 'network_mode: host', /network_mode/],
    ['cap_add', 'cap_add: [SYS_ADMIN]', /cap_add/],
    ['devices', 'devices: ["/dev/sda:/dev/sda"]', /devices/],
    ['pid host', 'pid: host', /pid/],
    ['security_opt', 'security_opt: ["seccomp=unconfined"]', /security_opt/],
    ['sysctls', 'sysctls: {net.ipv4.ip_forward: 1}', /sysctls/],
    ['volumes_from', 'volumes_from: [db]', /volumes_from/],
    ['container_name', 'container_name: airlock-app', /container_name/],
    ['eigene Netze', 'networks: [x]', /networks/],
    ['Grenzen selbst setzen', 'mem_limit: 64g', /Grenzen kommen aus dem Projekt/],
    ['Log-Rotation abschalten', 'logging: {driver: none}', /Log-Rotation/],
    ['userns', 'userns_mode: host', /userns_mode/],
    ['extends', 'extends: {file: ../x.yaml, service: y}', /extends/],
    ['unbekanntes Feld', 'future_escape_hatch: true', /Erlaubnisliste/],
  ]
  for (const [title, line, re] of cases) {
    test(title, async () => {
      await rejects(`services:\n  web:\n    image: alpine\n    ${line}\n`, re)
    })
  }

  test('Bind-Mount relativ', async () => {
    await rejects('services:\n  web:\n    image: a\n    volumes: ["./nginx.conf:/etc/nginx/nginx.conf"]\n', /Bind-Mount/)
  })

  test('Bind-Mount absolut auf den Docker-Socket', async () => {
    await rejects('services:\n  web:\n    image: a\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n', /Bind-Mount/)
  })

  test('Bind-Mount in Langform', async () => {
    await rejects('services:\n  web:\n    image: a\n    volumes:\n      - type: bind\n        source: /\n        target: /host\n', /Typ "bind"/)
  })

  test('Volume mit driver_opts als Bind durch die Hintertür', async () => {
    await rejects('services:\n  web:\n    image: a\n    volumes: [v:/x]\nvolumes:\n  v:\n    driver_opts: {type: none, o: bind, device: /}\n', /driver_opts.*nicht erlaubt/)
  })

  test('Volume mit name zeigt auf ein fremdes Projekt', async () => {
    await rejects('services:\n  web:\n    image: a\n    volumes: [v:/x]\nvolumes:\n  v:\n    name: air_anderes_db\n', /ausserhalb des Projekts/)
  })

  test('external Volume', async () => {
    await rejects('services:\n  web:\n    image: a\nvolumes:\n  v:\n    external: true\n', /ausserhalb des Projekts/)
  })

  test('nicht deklariertes Volume', async () => {
    await rejects('services:\n  web:\n    image: a\n    volumes: ["v:/x"]\n', /nicht deklariert/)
  })

  test('include auf oberster Ebene', async () => {
    await rejects('include: [../other.yaml]\n' + WEB, /include/)
  })

  test('networks auf oberster Ebene', async () => {
    await rejects(WEB + 'networks:\n  x: {}\n', /networks/)
  })

  test('environment ohne Wert (Liste) zöge Werte aus der Umgebung von Airlock', async () => {
    await rejects('services:\n  web:\n    image: a\n    environment: [DATABASE_URL]\n', /keinen Wert/)
  })

  test('environment ohne Wert (Zuordnung)', async () => {
    await rejects('services:\n  web:\n    image: a\n    environment:\n      ADMIN_PASSWORD:\n', /keinen Wert/)
  })

  test('reservierte Labels', async () => {
    await rejects('services:\n  web:\n    image: a\n    labels: {airlock.project: anderes}\n', /reserviert/)
    await rejects('services:\n  web:\n    image: a\n    labels: {deployer.project: anderes}\n', /reserviert/)
    await rejects('services:\n  web:\n    image: a\n    labels: ["com.docker.compose.project=x"]\n', /reserviert/)
  })

  test('build ohne Repo (hochgeladene Datei)', async () => {
    await rejects('services:\n  web:\n    build: .\n', /nur mit einem Repo/, ctx({ repo: null }))
  })

  test('build-Kontext ausserhalb des Repos', async () => {
    await rejects('services:\n  web:\n    build: ../../\n', /nicht im Repo/)
  })

  test('REVIEW: absoluter Dockerfile-Pfad bei Kontext ≠ "." wird abgelehnt', async () => {
    // Vorher: "app" + "/proc/1/environ" ergab "app//proc/1/environ", bestand
    // die Repo-Prüfung, und "/proc/1/environ" ging unverändert an Compose.
    await rejects('services:\n  web:\n    build:\n      context: app\n      dockerfile: /proc/1/environ\n', /relativer Pfad/)
  })

  test('REVIEW: Dockerfile ausserhalb des Kontexts wird abgelehnt', async () => {
    await rejects('services:\n  web:\n    build:\n      context: app\n      dockerfile: ../Dockerfile\n', /innerhalb des Build-Kontexts|nicht im Repo/)
  })

  test('Dockerfile im Kontext: Ausgabe ist der geprüfte relative Pfad', async () => {
    const { doc } = await norm('services:\n  web:\n    build:\n      context: app\n      dockerfile: docker/prod.Dockerfile\n')
    assert.equal(doc.services.web.build.context, '/data/work/x/app')
    assert.equal(doc.services.web.build.dockerfile, 'docker/prod.Dockerfile')
  })

  test('build mit network (z.B. host) ist nicht erlaubt', async () => {
    await rejects('services:\n  web:\n    build:\n      context: .\n      network: host\n', /build\.network/)
  })

  test('env_file ohne Repo', async () => {
    await rejects('services:\n  web:\n    image: a\n    env_file: .env\n', /nur mit einem Repo/, ctx({ repo: null }))
  })

  test('Web-Dienst fehlt', async () => {
    await rejects('services:\n  api:\n    image: a\n', /Web-Dienst "web" fehlt/)
  })

  test('depends_on auf einen unbekannten Dienst', async () => {
    await rejects('services:\n  web:\n    image: a\n    depends_on: [gibtsnicht]\n', /gibt es nicht/)
  })

  test('kein gültiges YAML', async () => {
    await rejects('services: [\n', /kein gültiges YAML/)
  })

  test('Etappe 4: x-airlock-env mit Wert statt Variablenname', async () => {
    await rejects('services:\n  web:\n    image: a\n  db:\n    image: b\n    x-airlock-env:\n      POSTGRES_PASSWORD: "geheim 123"\n', /x-airlock-env/)
  })

  test('Etappe 4: x-airlock-env als Liste', async () => {
    await rejects('services:\n  web:\n    image: a\n  db:\n    image: b\n    x-airlock-env: [A]\n', /Zuordnung/)
  })

  test('Etappe 4: x-airlock-internal am Web-Dienst oder ohne gültigen Port', async () => {
    await rejects('services:\n  web:\n    image: a\n    x-airlock-internal: 80\n', /Web-Dienst/)
    await rejects('services:\n  web:\n    image: a\n  ui:\n    image: b\n    x-airlock-internal: abc\n', /Portnummer/)
  })

  test('Alias-Bombe', async () => {
    const lines = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]']
    for (let i = 0; i < 12; i++) lines.push(`${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)},*${String.fromCharCode(97 + i)}]`)
    await rejects(lines.join('\n') + '\n' + WEB, /YAML|Alias|services/)
  })
})

describe('withServiceEnv (Secrets erst beim Start, nicht im Artefakt)', () => {
  test('setzt Env nur im Web-Dienst und maskiert "$"', async () => {
    const r = await normalizeCompose(WEB + '  db:\n    image: postgres\n', ctx({ projectEnv: {} }))
    assert.equal((parse(r.yaml) as any).services.web.environment, undefined, 'Artefakt ohne Env')
    const out = parse(withServiceEnv(r.yaml, 'web', { TOKEN: 'a$b' })) as any
    assert.equal(out.services.web.environment.TOKEN, 'a$$b')
    assert.equal(out.services.db.environment, undefined)
  })
  test('ungültiger Variablenname', async () => {
    const r = await normalizeCompose(WEB, ctx({ projectEnv: {} }))
    assert.throws(() => withServiceEnv(r.yaml, 'web', { 'A-B': 'x' }), /ungültig/)
  })
})

describe('withMappedEnv (Etappe 4: Werte für x-airlock-env erst beim Start)', () => {
  const file = 'services:\n  web:\n    image: a\n  db:\n    image: postgres:17\n    environment:\n      POSTGRES_USER: app\n    x-airlock-env:\n      POSTGRES_PASSWORD: DB_PASSWORD\n  ui:\n    image: adminer\n    x-airlock-internal: 8080\n'
  test('setzt Werte aus der Projekt-Env, maskiert "$" und entfernt die Erweiterungen', () => {
    const doc = parse(withMappedEnv(file, { DB_PASSWORD: 'pa$s' })) as Record<string, any> // allowlist-secret
    assert.deepEqual(doc.services.db.environment, { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pa$$s' })
    assert.equal(doc.services.db['x-airlock-env'], undefined)
    assert.equal(doc.services.ui['x-airlock-internal'], undefined)
    assert.equal(doc.services.web.environment, undefined)
  })
  test('fehlende Variable: klare Meldung statt leerem Passwort', () => {
    assert.throws(() => withMappedEnv(file, {}), /DB_PASSWORD.*fehlt/)
  })
})

describe('parseDotenv', () => {
  test('liest Zuweisungen, Anführungszeichen und Kommentare', () => {
    assert.deepEqual(parseDotenv('A=1\nexport B="x y"\n# c\nC=z # kommentar\n', 'f'), { A: '1', B: 'x y', C: 'z' })
  })
  test('lehnt kaputte Zeilen ab', () => {
    assert.throws(() => parseDotenv('nicht gueltig\n', 'f'), /keine Zuweisung/)
  })
})

describe('retargetCompose (Übergang deployer → Airlock)', () => {
  const OLD = `# Erzeugt von deployer aus geprüften Werten. Nicht von Hand ändern.
name: dep_shop
services:
  web:
    image: deployer/shop-web:abc123
    labels:
      app: eigen
      deployer.managed: "true"
      deployer.project: shop
      deployer.compose-service: web
networks:
  default:
    name: dep_shop
    external: true
`

  test('Name, Netz und Labels gehen auf die neuen Namen, Images und eigene Labels bleiben', () => {
    const doc = parse(retargetCompose(OLD, 'air_shop'))
    assert.equal(doc.name, 'air_shop')
    assert.deepEqual(doc.networks, { default: { name: 'air_shop', external: true } })
    assert.deepEqual(doc.services.web.labels, { app: 'eigen', 'airlock.managed': 'true', 'airlock.project': 'shop', 'airlock.compose-service': 'web' })
    assert.equal(doc.services.web.image, 'deployer/shop-web:abc123')
  })

  test('eine Datei mit neuen Namen bleibt inhaltlich gleich', async () => {
    const r = await normalizeCompose('services:\n  web:\n    image: alpine\n', ctx())
    assert.deepEqual(parse(retargetCompose(r.yaml, 'air_shop')), parse(r.yaml))
  })
})
