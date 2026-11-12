/**
 * Browser, Betriebssystem und Sprache aus Kopfzeilen – rein, ohne
 * Abhängigkeit. Gespeichert wird nur Familie und Hauptversion
 * («Chrome 131», «iOS 18»), nie Feinversionen oder der ganze User-Agent:
 * so bleibt jede Zeile eine grobe Gruppe statt eines Fingerabdrucks.
 *
 * Client Hints (Sec-CH-UA, Sec-CH-UA-Platform) gehen vor, wo vorhanden:
 * Chromium-Browser frieren den User-Agent ein (Windows 10, Android 10,
 * «K»), die Hints nennen die Marke ehrlich (Edge, Brave, Opera …).
 */

/** Marken in Sec-CH-UA → Name; «Chromium» und Platzhalter («Not?A_Brand») zählen nur, wenn sonst nichts steht */
const HINT_BRANDS: [RegExp, string][] = [
  [/^Microsoft Edge$/i, 'Edge'],
  [/^Google Chrome$/i, 'Chrome'],
  [/^Opera( GX)?$/i, 'Opera'],
  [/^Brave$/i, 'Brave'],
  [/^Vivaldi$/i, 'Vivaldi'],
  [/^Samsung Internet$/i, 'Samsung Internet'],
  [/^YaBrowser$/i, 'Yandex'],
  [/^Arc$/i, 'Arc'],
]

/** Sec-CH-UA: '"Chromium";v="131", "Google Chrome";v="131", "Not_A Brand";v="24"' → [Marke, Version] */
export function parseBrands(hint: string): { brand: string; version: string }[] {
  return [...hint.matchAll(/"([^"]{1,60})"\s*;\s*v\s*=\s*"([^"]{0,20})"/g)].map((m) => ({ brand: m[1]!.trim(), version: m[2]!.trim() }))
}

const major = (v: string | undefined) => {
  const m = /^(\d{1,4})/.exec(v ?? '')
  return m ? String(Number(m[1])) : ''
}
const join = (name: string, version: string) => (version ? `${name} ${version}` : name)

/** Browser (Familie und Hauptversion) aus User-Agent und Sec-CH-UA; '' wenn unbekannt */
export function browserOf(ua: string, chUa = ''): string {
  if (chUa) {
    const brands = parseBrands(chUa)
    for (const [re, name] of HINT_BRANDS) {
      const b = brands.find((x) => re.test(x.brand))
      if (b) return join(name, major(b.version))
    }
  }
  const rules: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
    [/\b(?:OPR|OPT|Opera)\/(\d+)/, 'Opera'],
    [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/\bVivaldi\/(\d+)/, 'Vivaldi'],
    [/\bYaBrowser\/(\d+)/, 'Yandex'],
    [/\bFirefox\/(\d+)/, 'Firefox'],
    [/\bFxiOS\/(\d+)/, 'Firefox'],
    [/\bCriOS\/(\d+)/, 'Chrome'],
    [/\bChrome\/(\d+)/, 'Chrome'],
  ]
  for (const [re, name] of rules) {
    const m = re.exec(ua)
    if (m) return join(name, major(m[1]))
  }
  if (/\bChromium\//.test(ua)) return join('Chromium', major(/\bChromium\/(\d+)/.exec(ua)?.[1]))
  // Safari nennt seine Version hinter «Version/», nicht hinter «Safari/» (das ist WebKit)
  if (/\bSafari\//.test(ua) || /\b(iPhone|iPad|Macintosh)\b/.test(ua)) {
    const v = /\bVersion\/(\d+)/.exec(ua)?.[1]
    if (v) return join('Safari', major(v))
    if (/\b(iPhone|iPad)\b/.test(ua)) return 'Safari'
  }
  return ''
}

const PLATFORM_HINTS: Record<string, string> = {
  windows: 'Windows', macos: 'macOS', 'mac os x': 'macOS', ios: 'iOS', android: 'Android', linux: 'Linux', 'chrome os': 'ChromeOS', chromeos: 'ChromeOS',
}

/**
 * Betriebssystem (Familie, bei iOS und Android mit Hauptversion) aus
 * User-Agent und Client Hints. macOS bleibt ohne Version (der User-Agent
 * nennt seit Jahren «10_15_7»). Windows 11 nur, wenn
 * Sec-CH-UA-Platform-Version es sagt (≥ 13), sonst «Windows».
 */
export function systemOf(ua: string, chPlatform = '', chPlatformVersion = ''): string {
  const hint = PLATFORM_HINTS[chPlatform.replace(/"/g, '').trim().toLowerCase()]
  const hintMajor = Number(major(chPlatformVersion.replace(/"/g, '')))
  if (hint === 'Windows') return hintMajor >= 13 ? 'Windows 11' : hintMajor > 0 ? 'Windows 10' : 'Windows'
  if (hint === 'Android' && hintMajor > 0) return `Android ${hintMajor}`
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) {
    const v = /\bOS (\d+)[._]/.exec(ua)?.[1]
    return join('iOS', major(v))
  }
  if (/\bAndroid\b/.test(ua)) {
    const v = /\bAndroid (\d+)/.exec(ua)?.[1]
    // Chromium meldet seit 2023 immer «Android 10; K» – dann keine Version erfinden
    return /\bAndroid 10; K\b/.test(ua) ? 'Android' : join('Android', major(v))
  }
  if (hint) return hint
  if (/\bWindows\b/.test(ua)) return 'Windows'
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS'
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS'
  if (/\bLinux\b/.test(ua)) return 'Linux'
  return ''
}

/**
 * Erste Sprache aus Accept-Language als «de-CH» bzw. «de» (Sprache klein,
 * Region gross, ohne Schrift wie «-Hant»); '' bei fehlender oder
 * unbrauchbarer Angabe («*»).
 */
export function languageOf(acceptLanguage: string): string {
  const first = acceptLanguage.split(',')[0]?.split(';')[0]?.trim() ?? ''
  const m = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?\b/i.exec(first)
  if (!m) return ''
  const lang = m[1]!.toLowerCase()
  const region = m[3] && /^[a-z]{2}$/i.test(m[3]) ? `-${m[3].toUpperCase()}` : ''
  return `${lang}${region}`
}

/** utm_source/utm_medium/utm_campaign aus der Query (sonst nichts davon); null ohne utm_source und utm_campaign */
export function campaignOf(query: string): { source: string; medium: string; campaign: string } | null {
  if (!query || !/utm_/i.test(query)) return null
  let p: URLSearchParams
  try {
    p = new URLSearchParams(query)
  } catch {
    return null
  }
  // eslint-disable-next-line no-control-regex
  const clean = (v: string | null) => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().toLowerCase().slice(0, 60)
  const source = clean(p.get('utm_source'))
  const medium = clean(p.get('utm_medium'))
  const campaign = clean(p.get('utm_campaign'))
  if (!source && !campaign) return null
  return { source, medium, campaign }
}
