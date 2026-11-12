#!/usr/bin/env bash
# Smoke-Test «Private Git-Repos» (Nacht 3, Etappe 2): privates Test-Repo per
# Deploy-Key klonen – mit dem echten Airlock-Image und dessen Code.
#
#   scripts/smoke-git-privat.sh
#
# Ablauf:
#  1. Airlock-Image aus diesem Checkout bauen (ssh, ssh-keyscan, git darin?)
#  2. Wegwerf-Git-Server (alpine + sshd, nur git-shell) mit einem privaten Repo
#  3. Im Airlock-Image: Deploy-Key erzeugen (ed25519, node:crypto)
#  4. Öffentlichen Schlüssel beim Git-Server eintragen (wie bei GitLab «Deploy keys»)
#  5. Im Airlock-Image: Server-Schlüssel holen (TOFU), mit StrictHostKeyChecking=yes
#     klonen, prüfen: richtiger Commit, kein Schlüssel und kein origin im Ordner;
#     ohne bestätigten Server-Schlüssel und mit fremdem Schlüssel scheitert es
#  6. Alles abräumen (Container, Volume, Netz, Image; KEEP_IMAGE=1 behält das Image)
#
# Eigene Namen (airlock-smoke-git-*), die laufende Installation bleibt
# unangetastet, kein Host-Port. Braucht nur bash und docker; liest keine .env.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=airlock-smoke-git:test
NET=airlock_smoke_git
SRV=airlock-smoke-git-srv
VOL=airlock_smoke_git_work

cleanup() {
  docker rm -f "$SRV" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [ "${KEEP_IMAGE:-}" != "1" ]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

fail() { echo "FEHLER: $*" >&2; exit 1; }
command -v docker >/dev/null || fail "docker fehlt"
cleanup

# Node-Teil im Airlock-Image: benutzt genau den gebauten Code (dist/lib/git.js, ssh-key.js)
# Schritt «key»: Deploy-Key erzeugen, privat nach /work/id (0600), öffentlich auf stdout.
read -r -d '' JS_KEY <<'JS' || true
const { generateDeployKey } = await import('/app/packages/api/dist/lib/ssh-key.js')
const { writeFileSync } = await import('node:fs')
const k = generateDeployKey('airlock-smoke')
writeFileSync('/work/id', k.privateKey, { mode: 0o600 })
writeFileSync('/work/id.pub', k.publicKey + '\n')
console.log(k.publicKey)
JS

# Schritt «clone»: TOFU, Clone mit Deploy-Key, Gegenproben
read -r -d '' JS_CLONE <<'JS' || true
const { cloneRepo, scanHostKeys } = await import('/app/packages/api/dist/lib/git.js')
const { generateDeployKey, knownHostsFor } = await import('/app/packages/api/dist/lib/ssh-key.js')
const { readFileSync, readdirSync, statSync, existsSync } = await import('node:fs')
const { lookup } = await import('node:dns/promises')
const policy = { deniedHosts: [], deniedCidrs: [], resolve: async (h) => (await lookup(h, { all: true })).map((a) => a.address) }
const url = process.env.REPO_URL
const want = process.env.WANT_COMMIT
const privateKey = readFileSync('/work/id', 'utf8')
const keyBody = privateKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')
const fail = (m) => { console.error('FEHLER: ' + m); process.exit(1) }

// a) Server-Schlüssel holen (das zeigt die Oberfläche zum Bestätigen)
const scan = await scanHostKeys({ url, policy })
console.log('   Server-Schlüssel ' + scan.alias + ': ' + scan.keys.map((k) => k.type + ' ' + k.fingerprint).join(', '))
const knownHosts = knownHostsFor(scan.alias, scan.keys)

// b) Ohne bestätigten Server-Schlüssel: muss scheitern (StrictHostKeyChecking=yes)
try {
  await cloneRepo({ url, dest: '/tmp/c0', policy, auth: { kind: 'ssh', privateKey, knownHosts: '' } })
  fail('Clone ohne bestätigten Server-Schlüssel ging durch')
} catch (e) {
  if (!/Host key verification failed|host key/i.test(e.message)) fail('unerwartete Meldung ohne known_hosts: ' + e.message)
  console.log('   ohne bestätigten Server-Schlüssel: abgelehnt')
}

// c) Fremder Schlüssel (nicht eingetragen): muss scheitern
try {
  await cloneRepo({ url, dest: '/tmp/c1', policy, auth: { kind: 'ssh', privateKey: generateDeployKey('fremd').privateKey, knownHosts } })
  fail('Clone mit fremdem Schlüssel ging durch')
} catch (e) {
  if (!/Permission denied/i.test(e.message)) fail('unerwartete Meldung mit fremdem Schlüssel: ' + e.message)
  console.log('   fremder Schlüssel: abgelehnt (Permission denied)')
}

// d) Ohne Deploy-Key: SSH-Adresse wird gar nicht erst versucht
try {
  await cloneRepo({ url, dest: '/tmp/c2', policy })
  fail('SSH ohne Deploy-Key ging durch')
} catch (e) {
  console.log('   ohne Deploy-Key: abgelehnt')
}

// e) Mit Deploy-Key und bestätigtem Server: klont den richtigen Commit
const lines = []
const r = await cloneRepo({ url, ref: 'main', dest: '/tmp/repo', policy, auth: { kind: 'ssh', privateKey, knownHosts }, onLine: (l) => lines.push(l) })
if (r.commit !== want) fail('falscher Commit ' + r.commit + ' statt ' + want)
if (readFileSync('/tmp/repo/index.html', 'utf8').trim() !== '<h1>privat</h1>') fail('Inhalt stimmt nicht')
console.log('   geklont: ' + r.displayUrl + ' @ ' + r.commit.slice(0, 12))

// f) Nichts vom Schlüssel im Ordner (Artefakt, .git/config), im Log, in /tmp
const walk = (d) => readdirSync(d).flatMap((n) => { const p = d + '/' + n; return statSync(p).isDirectory() ? walk(p) : [p] })
for (const f of walk('/tmp/repo')) if (readFileSync(f).toString('latin1').includes(keyBody.slice(20, 80))) fail('Schlüssel in ' + f)
if (/\[remote "origin"\]/.test(readFileSync('/tmp/repo/.git/config', 'utf8'))) fail('origin steht noch in .git/config')
if (lines.join('\n').includes(keyBody.slice(20, 80))) fail('Schlüssel im Log')
const left = readdirSync('/tmp').filter((n) => n.startsWith('airlock-ssh-'))
if (left.length) fail('Schlüsselordner nicht weggeräumt: ' + left.join(', '))
console.log('   kein Schlüssel und kein origin im Ordner, Schlüsseldatei weggeräumt')
JS

echo "1. Image bauen (dauert ein paar Minuten)"
docker build -q -t "$IMAGE" "$ROOT" >/dev/null
docker run --rm "$IMAGE" sh -c 'command -v ssh && command -v ssh-keyscan && command -v git' >/dev/null || fail "ssh, ssh-keyscan oder git fehlt im Image"

echo "2. Wegwerf-Git-Server mit privatem Repo (nur SSH, nur git-shell)"
docker network create "$NET" >/dev/null
docker volume create "$VOL" >/dev/null
docker run -d --name "$SRV" --network "$NET" alpine:3.20 sh -c '
  set -e
  apk add --no-cache openssh-server git >/dev/null
  ssh-keygen -A >/dev/null
  adduser -D -s /usr/bin/git-shell git
  echo "git:*" | chpasswd -e >/dev/null 2>&1
  mkdir -p /home/git/.ssh /srv/src
  touch /home/git/.ssh/authorized_keys
  chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys
  cd /srv/src && git init -q -b main && echo "<h1>privat</h1>" > index.html
  git -c user.name=smoke -c user.email=smoke@example.invalid add -A
  git -c user.name=smoke -c user.email=smoke@example.invalid commit -qm init
  git clone -q --bare /srv/src /home/git/privat.git
  chown -R git:git /home/git
  touch /ready
  exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no
' >/dev/null
for _ in $(seq 1 60); do
  docker exec "$SRV" test -f /ready >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$SRV" test -f /ready || fail "Git-Server startet nicht"
sleep 1
WANT="$(docker exec -u git "$SRV" git -C /home/git/privat.git rev-parse main)"

echo "3. Deploy-Key im Airlock-Image erzeugen"
PUB="$(docker run --rm -v "$VOL:/work" "$IMAGE" node --input-type=module -e "$JS_KEY")"
echo "$PUB" | grep -Eq '^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ airlock-smoke$' || fail "kein ed25519-Schlüssel: $PUB"
echo "   $PUB" | cut -c1-60

echo "4. Öffentlichen Schlüssel beim Git-Server eintragen (wie «Deploy keys», nur lesend)"
echo "$PUB" | docker exec -i "$SRV" sh -c 'cat >> /home/git/.ssh/authorized_keys'

echo "5. Im Airlock-Image: Server bestätigen (TOFU) und klonen"
docker run --rm --network "$NET" -v "$VOL:/work" -e REPO_URL="git@$SRV:privat.git" -e WANT_COMMIT="$WANT" \
  "$IMAGE" node --input-type=module -e "$JS_CLONE"

echo "   auch die ssh://-Form mit Port"
docker run --rm --network "$NET" -v "$VOL:/work" -e REPO_URL="ssh://git@$SRV:22/home/git/privat.git" -e WANT_COMMIT="$WANT" \
  "$IMAGE" node --input-type=module -e "$JS_CLONE" >/dev/null

echo "OK: privates Repo per Deploy-Key geklont (StrictHostKeyChecking=yes, kein Schlüssel im Ergebnis)."
