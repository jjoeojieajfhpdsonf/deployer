import { createServer, type Server } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Kleiner Git-Server (Smart HTTP über `git http-backend` als CGI) für Tests
 * und die lokale Abnahme. Nicht für den Produktivpfad.
 *
 * Smart HTTP ist nötig, weil `git clone --depth 1` über das einfache
 * Datei-Protokoll nicht geht.
 */

export interface GitHttpServer {
  server: Server
  port: number
  close(): Promise<void>
}

export function startGitHttpServer(projectRoot: string, host = '0.0.0.0', port = 0): Promise<GitHttpServer> {
  const backend = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim() + '/git-http-backend'

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const child = spawn(backend, [], {
      env: {
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        REQUEST_METHOD: req.method ?? 'GET',
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_ADDR: req.socket.remoteAddress ?? '',
        GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        PATH: process.env.PATH,
      },
    })
    req.pipe(child.stdin)

    let headerBuf = Buffer.alloc(0)
    let headersDone = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk)
        return
      }
      headerBuf = Buffer.concat([headerBuf, chunk])
      const idx = headerBuf.indexOf('\r\n\r\n')
      const idx2 = idx === -1 ? headerBuf.indexOf('\n\n') : -1
      const cut = idx !== -1 ? idx : idx2
      if (cut === -1) return
      const sepLen = idx !== -1 ? 4 : 2
      const head = headerBuf.subarray(0, cut).toString('utf8')
      let status = 200
      for (const line of head.split(/\r?\n/)) {
        const m = /^([^:]+):\s*(.*)$/.exec(line)
        if (!m) continue
        if (m[1]!.toLowerCase() === 'status') status = Number(m[2]!.split(' ')[0])
        else res.setHeader(m[1]!, m[2]!)
      }
      res.statusCode = status
      headersDone = true
      res.write(headerBuf.subarray(cut + sepLen))
    })
    child.stdout.on('end', () => res.end())
    child.on('error', () => {
      res.statusCode = 500
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address()
      const p = typeof addr === 'object' && addr ? addr.port : port
      resolve({
        server,
        port: p,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/** Eine Adresse dieses Rechners, die nicht Loopback ist (die ist für Clones gesperrt). */
export function nonLoopbackIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return null
}

/** Legt ein Repo mit den angegebenen Dateien an und gibt den Commit zurück. */
export function makeRepo(dir: string, files: Record<string, string>, symlinks: Record<string, string> = {}): string {
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  for (const [path, target] of Object.entries(symlinks)) {
    symlinkSync(target, join(dir, path))
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return git('rev-parse', 'HEAD')
}
