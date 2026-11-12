import { z } from 'zod'

/* =========================================================================
 * Etappe 7 – Spass-Paket
 *
 * Achievements (Liste im Konto) und die Seite «Kein Projekt unter diesem
 * Namen» mit Snake für unbekannte interne Namen. Nichts davon erscheint auf
 * öffentlichen Seiten: die Snake-Seite liefert Caddy nur an interne Namen
 * aus LAN/Tailnet, nie über den Tunnel (drivers/caddy-config.ts).
 * ========================================================================= */

/* --- Achievements --------------------------------------------------------- */

/**
 * Reihenfolge = Anzeige im Konto. Die Regeln (reine Funktionen über echte
 * Daten) stehen in packages/api/src/domain/achievements.ts.
 */
export const achievementIds = ['first_deploy', 'first_public', 'grade_a', 'uptime_100', 'all_fixed', 'night_shift', 'secrets'] as const
export type AchievementId = (typeof achievementIds)[number]

export const ACHIEVEMENTS: Record<AchievementId, { title: string; description: string }> = {
  first_deploy: { title: 'Erster Deploy', description: 'Ein Projekt ist zum ersten Mal erfolgreich gelaufen.' },
  first_public: { title: 'Erstes öffentliches Projekt', description: 'Ein Projekt war zum ersten Mal aus dem Internet erreichbar.' },
  grade_a: { title: 'Note A', description: 'Ein Security-Scan hat die Note A ergeben.' },
  uptime_100: { title: '100 Tage ohne Ausfall', description: 'Ein Projekt war 100 gemessene Tage am Stück ohne Störung.' },
  all_fixed: { title: 'Alle Befunde behoben', description: 'Kein gescanntes Projekt hat mehr einen offenen Befund.' },
  night_shift: { title: 'Nachtschicht', description: 'Ein Deploy zwischen 0 und 4 Uhr (Zürcher Zeit) von Hand gestartet.' },
  secrets: { title: 'Geheimnisse gefunden', description: 'Alle versteckten Freischaltungen entdeckt.' },
}

export interface AchievementDto {
  id: AchievementId
  title: string
  description: string
  /** Wann erreicht (aus den Daten, z. B. Ende des ersten Deploys); null = noch nicht */
  achievedAt: string | null
  /** Schon gemeldet (Konfetti nur einmal, nicht beim Neuladen) */
  seen: boolean
}

export interface AchievementsDto {
  achievements: AchievementDto[]
  /** Spass-Funktionen an? Aus: keine Liste, kein Konfetti */
  enabled: boolean
}

/** POST /auth/achievements/seen */
export const achievementsSeenSchema = z.object({
  ids: z.array(z.enum(achievementIds, { message: 'Unbekanntes Achievement' })).min(1).max(achievementIds.length),
})

/* --- Snake auf der 404-Seite der internen Adressen ------------------------- */

/** Text der schlichten Auffangseite (öffentlich, Tunnel, unbekannte Absender) – unverändert seit M1 */
export const NOT_FOUND_TEXT = 'Kein Projekt unter diesem Namen.'

/**
 * Stil der Snake-Seite. Eigene Tokens (hell; dunkel über prefers-color-scheme),
 * Systemschrift, keine Airlock-Assets. Kontraste: docs/design-cal/contrast.mjs
 * (Block «Snake-Seite»). Keine Inline-Styles im HTML (CSP mit Hash).
 */
export const SNAKE_CSS = `:root {
  --bg: #ffffff;
  --surface: #f3f4f6;
  --line: #d5d8dd;
  --ink: #1f2328;
  --muted: #5f636c;
  --snake: #13753a;
  --food: #c0281a;
  --focus: #1d58c2;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0b;
    --surface: #141415;
    --line: #2c2c31;
    --ink: #f2f2f3;
    --muted: #9b9ba2;
    --snake: #4fc985;
    --food: #f47a70;
    --focus: #7eaaf5;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 64px 24px; }
h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; font-weight: 650; letter-spacing: -0.01em; }
p { margin: 0 0 8px; color: var(--muted); }
code { font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--ink); overflow-wrap: anywhere; }
.game { margin-top: 32px; max-width: 400px; }
.game[hidden] { display: none; }
.hud { display: flex; justify-content: space-between; margin-bottom: 8px; font-variant-numeric: tabular-nums; color: var(--muted); }
.hud b { color: var(--ink); font-weight: 600; }
canvas { display: block; width: 100%; max-width: 400px; aspect-ratio: 1; border-radius: 12px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); touch-action: none; }
canvas:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.row { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.row p { margin: 0; }
button { min-height: 40px; padding: 0 16px; border: 0; border-radius: 10px; background: var(--ink); color: var(--bg); font: 600 15px/1 system-ui, -apple-system, 'Segoe UI', sans-serif; cursor: pointer; }
button:active { transform: translateY(1px); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`

/**
 * Spiel-Logik als reine Funktionen (ohne DOM); dieselbe Zeichenkette steckt
 * in der Seite. Die Tests holen sich die Funktionen mit new Function heraus.
 *
 * Achtung Caddy: static_response ersetzt bekannte Platzhalter wie
 * «{http.request.host}» im Text und wertet «\\{» als Escape. Deshalb nie eine
 * geschweifte Klammer direkt vor einem Namen mit Punkt und nie ein Backslash
 * vor einer Klammer (geprüft in caddy-snake.test.ts).
 */
export const SNAKE_LOGIC_JS = `var SIZE = 20;
var DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
function keyDir(key) {
  var k = key.length === 1 ? key.toLowerCase() : key;
  return DIRS[k] || null;
}
function swipeDir(dx, dy, min) {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? [1, 0] : [-1, 0];
  return dy > 0 ? [0, 1] : [0, -1];
}
function turn(dir, next) {
  if (!next) return dir;
  if (next[0] === -dir[0] && next[1] === -dir[1]) return dir;
  return next;
}
function placeFood(snake, size, rnd) {
  var free = [];
  for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
    var hit = false;
    for (var i = 0; i < snake.length; i++) if (snake[i][0] === x && snake[i][1] === y) hit = true;
    if (!hit) free.push([x, y]);
  }
  if (!free.length) return null;
  return free[Math.floor(rnd() * free.length) % free.length];
}
function newGame(size, rnd) {
  var mid = Math.floor(size / 2);
  var snake = [[mid, mid], [mid - 1, mid], [mid - 2, mid]];
  return { size: size, snake: snake, dir: [1, 0], food: placeFood(snake, size, rnd), alive: true, score: 0 };
}
function step(state, nextDir, rnd) {
  if (!state.alive) return state;
  var dir = turn(state.dir, nextDir);
  var head = [state.snake[0][0] + dir[0], state.snake[0][1] + dir[1]];
  var size = state.size;
  var eats = state.food && head[0] === state.food[0] && head[1] === state.food[1];
  var body = eats ? state.snake : state.snake.slice(0, -1);
  var out = head[0] < 0 || head[1] < 0 || head[0] >= size || head[1] >= size;
  var bites = false;
  for (var i = 0; i < body.length; i++) if (body[i][0] === head[0] && body[i][1] === head[1]) bites = true;
  if (out || bites) return { size: size, snake: state.snake, dir: dir, food: state.food, alive: false, score: state.score };
  var snake = [head].concat(body);
  return { size: size, snake: snake, dir: dir, food: eats ? placeFood(snake, size, rnd) : state.food, alive: true, score: state.score + (eats ? 1 : 0) };
}
function tickMs(score) { return Math.max(70, 140 - score * 3); }
`

/** Oberfläche: Zeichnen, Tasten, Wischen, Rekord (localStorage mit try/catch) */
export const SNAKE_JS = `${SNAKE_LOGIC_JS}
(function () {
  var host = document.getElementById('host');
  if (host) host.textContent = location.hostname;
  var game = document.getElementById('game');
  var canvas = document.getElementById('board');
  var startBtn = document.getElementById('start');
  var scoreEl = document.getElementById('score');
  var bestEl = document.getElementById('best');
  var statusEl = document.getElementById('status');
  if (!game || !canvas || !canvas.getContext) return;
  game.hidden = false;
  var ctx = canvas.getContext('2d');
  var KEY = 'airlock.snake.best';
  var best = 0;
  try { best = Number(localStorage.getItem(KEY)) || 0; } catch (e) { best = 0; }
  bestEl.textContent = String(best);
  var state = newGame(SIZE, Math.random);
  var pending = null;
  var running = false;
  var timer = null;
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function draw() {
    var px = canvas.width / SIZE;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (state.food) {
      ctx.fillStyle = css('--food');
      ctx.beginPath();
      ctx.arc((state.food[0] + 0.5) * px, (state.food[1] + 0.5) * px, px * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = css('--snake');
    for (var i = 0; i < state.snake.length; i++) {
      var c = state.snake[i];
      var inset = i === 0 ? 1 : 2;
      ctx.fillRect(c[0] * px + inset, c[1] * px + inset, px - inset * 2, px - inset * 2);
    }
  }
  function say(text) { statusEl.textContent = text; }
  function loop() {
    state = step(state, pending, Math.random);
    pending = null;
    scoreEl.textContent = String(state.score);
    draw();
    if (!state.alive) {
      running = false;
      if (state.score > best) {
        best = state.score;
        bestEl.textContent = String(best);
        try { localStorage.setItem(KEY, String(best)); } catch (e) { /* privat: nur diese Runde */ }
        say('Neuer Rekord: ' + state.score + '. Leertaste oder «Nochmal» für eine neue Runde.');
      } else {
        say('Vorbei – ' + state.score + ' Punkte. Leertaste oder «Nochmal» für eine neue Runde.');
      }
      startBtn.textContent = 'Nochmal';
      return;
    }
    timer = setTimeout(loop, tickMs(state.score));
  }
  function start() {
    if (running) return;
    if (!state.alive || state.score === 0) state = newGame(SIZE, Math.random);
    running = true;
    startBtn.textContent = 'Läuft …';
    say('Steuern mit den Pfeiltasten (oder W A S D) oder durch Wischen. Leertaste hält an.');
    canvas.focus();
    timer = setTimeout(loop, tickMs(state.score));
  }
  function pause() {
    if (!running) return;
    running = false;
    clearTimeout(timer);
    startBtn.textContent = 'Weiter';
    say('Angehalten. Leertaste oder «Weiter».');
  }
  startBtn.addEventListener('click', function () { if (running) pause(); else start(); });
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && (e.target === canvas || e.target === document.body)) {
      e.preventDefault();
      if (running) pause(); else start();
      return;
    }
    var d = keyDir(e.key);
    if (!d || !running) return;
    e.preventDefault();
    pending = d;
  });
  var touch = null;
  canvas.addEventListener('touchstart', function (e) { var t = e.changedTouches[0]; touch = [t.clientX, t.clientY]; if (!running) start(); }, { passive: true });
  canvas.addEventListener('touchend', function (e) {
    if (!touch) return;
    var t = e.changedTouches[0];
    var d = swipeDir(t.clientX - touch[0], t.clientY - touch[1], 24);
    touch = null;
    if (d) pending = d;
  }, { passive: true });
  document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); });
  draw();
})();
`

/**
 * Die Seite selbst: ohne JavaScript nur der Text (das Spiel ist «hidden»),
 * der Name der Adresse kommt per JavaScript dazu (textContent – nie aus
 * einem Platzhalter von Caddy, der Host ist Eingabe des Besuchers).
 */
export function renderSnakePage(): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Kein Projekt unter diesem Namen</title>
<style>${SNAKE_CSS}</style>
</head>
<body>
<main>
<h1>Kein Projekt unter diesem Namen</h1>
<p>Unter <code id="host">dieser Adresse</code> läuft in Airlock gerade nichts – vielleicht ein Tippfehler, oder das Projekt wurde gelöscht.</p>
<section id="game" class="game" aria-labelledby="game-title" hidden>
<h2 id="game-title" class="sr-only">Snake</h2>
<p>Wenn du schon hier bist: eine Runde Snake.</p>
<div class="hud"><span>Punkte <b id="score">0</b></span><span>Rekord <b id="best">0</b></span></div>
<canvas id="board" width="400" height="400" tabindex="0" role="img" aria-label="Spielfeld Snake, 20 mal 20 Felder"></canvas>
<div class="row"><button id="start" type="button">Spiel starten</button><p id="status" role="status">Pfeiltasten, W A S D oder Wischen. Leertaste startet und hält an.</p></div>
</section>
</main>
<script>${SNAKE_JS}</script>
</body>
</html>
`
}

/**
 * Content-Security-Policy der Snake-Seite: nichts von aussen, Skript und Stil
 * nur mit ihrem SHA-256 (kein unsafe-inline). hash: Base64 des SHA-256 einer
 * Zeichenkette (node:crypto in der API, im Screenshot-Werkzeug ebenso).
 */
export function snakeCsp(hash: (text: string) => string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash(SNAKE_JS)}'`,
    `style-src 'sha256-${hash(SNAKE_CSS)}'`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
