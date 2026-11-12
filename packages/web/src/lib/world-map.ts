/**
 * Weltkarte der Seite «Besucher»: Ländergrenzen aus Natural Earth
 * (Admin 0, 1:110 Mio., Version 4.1.0 – gemeinfrei / public domain), als
 * TopoJSON verteilt im npm-Paket world-atlas 2.0.2 (Lizenz ISC, Mike
 * Bostock). Hier nur der Decoder: Bögen auflösen, gleichabständig
 * (plattkarte) projizieren, je Land ein SVG-Pfad. Keine Kartenbibliothek.
 *
 * Kleine Länder fehlen im Massstab 1:110 Mio. (z. B. Liechtenstein, Monaco,
 * Singapur) – sie stehen nur in der Tabelle.
 */

export interface Topology {
  transform?: { scale: [number, number]; translate: [number, number] }
  arcs: [number, number][][]
  objects: { countries: { geometries: { type: string; id?: string; properties?: { name?: string }; arcs?: unknown }[] } }
}

/** ISO 3166-1 numerisch (Natural Earth) → alpha-2 (wie CF-IPCountry) */
const NUMERIC_TO_ALPHA2: Record<string, string> = Object.fromEntries(
  ('242:FJ 834:TZ 732:EH 124:CA 840:US 398:KZ 860:UZ 598:PG 360:ID 032:AR 152:CL 180:CD 706:SO 404:KE 729:SD 148:TD 332:HT 214:DO 643:RU '
  + '044:BS 238:FK 578:NO 304:GL 260:TF 626:TL 710:ZA 426:LS 484:MX 858:UY 076:BR 068:BO 604:PE 170:CO 591:PA 188:CR 558:NI 340:HN 222:SV '
  + '320:GT 084:BZ 862:VE 328:GY 740:SR 250:FR 218:EC 630:PR 388:JM 192:CU 716:ZW 072:BW 516:NA 686:SN 466:ML 478:MR 204:BJ 562:NE 566:NG '
  + '120:CM 768:TG 288:GH 384:CI 324:GN 624:GW 430:LR 694:SL 854:BF 140:CF 178:CG 266:GA 226:GQ 894:ZM 454:MW 508:MZ 748:SZ 024:AO 108:BI '
  + '376:IL 422:LB 450:MG 275:PS 270:GM 788:TN 012:DZ 400:JO 784:AE 634:QA 414:KW 368:IQ 512:OM 548:VU 116:KH 764:TH 418:LA 104:MM 704:VN '
  + '408:KP 410:KR 496:MN 356:IN 050:BD 064:BT 524:NP 586:PK 004:AF 762:TJ 417:KG 795:TM 364:IR 760:SY 051:AM 752:SE 112:BY 804:UA 616:PL '
  + '040:AT 348:HU 498:MD 642:RO 440:LT 428:LV 233:EE 276:DE 100:BG 300:GR 792:TR 008:AL 191:HR 756:CH 442:LU 056:BE 528:NL 620:PT 724:ES '
  + '372:IE 540:NC 090:SB 554:NZ 036:AU 144:LK 156:CN 158:TW 380:IT 208:DK 826:GB 352:IS 031:AZ 268:GE 608:PH 458:MY 096:BN 705:SI 246:FI '
  + '703:SK 203:CZ 232:ER 392:JP 600:PY 887:YE 682:SA 196:CY 504:MA 818:EG 434:LY 231:ET 262:DJ 800:UG 646:RW 070:BA 807:MK 688:RS 499:ME '
  + '780:TT 728:SS').split(' ').map((p) => p.split(':') as [string, string]),
)
/** Ohne Nummer in Natural Earth */
const BY_NAME: Record<string, string> = { Kosovo: 'XK' }

/** Ausschnitt: ohne Antarktis, bis zum nördlichsten Land */
export const MAP_NORTH = 84
export const MAP_SOUTH = -57
export const MAP_WIDTH = 360
export const MAP_HEIGHT = MAP_NORTH - MAP_SOUTH

export interface CountryShape {
  code: string
  name: string
  d: string
  /** Mitte des grössten Teils (Punkt «letzter Aufruf»; nur Land, keine Koordinaten des Besuchers) */
  cx: number
  cy: number
}

/** Ausschnitte der Karte (viewBox): Welt und Europa */
export const MAP_VIEWS = {
  world: { x: 0, y: 0, w: MAP_WIDTH, h: MAP_HEIGHT },
  // Europa: 25° W bis 45° O, 72° N bis 34° N
  europe: { x: 180 - 25, y: MAP_NORTH - 72, w: 70, h: 38 },
} as const
export type MapView = keyof typeof MAP_VIEWS

function decodeArcs(t: Topology): [number, number][][] {
  const [sx, sy] = t.transform?.scale ?? [1, 1]
  const [tx, ty] = t.transform?.translate ?? [0, 0]
  return t.arcs.map((arc) => {
    let x = 0
    let y = 0
    return arc.map(([dx, dy]) => {
      // Quantisiert und delta-kodiert (TopoJSON-Spezifikation)
      x += dx
      y += dy
      return t.transform ? [x * sx + tx, y * sy + ty] : [dx, dy]
    })
  })
}

const project = ([lon, lat]: [number, number]): [number, number] => [lon + 180, MAP_NORTH - Math.max(MAP_SOUTH, Math.min(MAP_NORTH, lat))]

/** TopoJSON-Länder → SVG-Pfade (viewBox 0 0 360 141), Antarktis und Länder ohne Code weggelassen */
export function countryShapes(t: Topology): CountryShape[] {
  const arcs = decodeArcs(t)
  // Grösster Ring je Land (nach Fläche des Rahmens): seine Mitte trägt den Punkt «letzter Aufruf»
  let best: { area: number; cx: number; cy: number } | null = null
  const ring = (idx: number[]): string => {
    const pts: [number, number][] = []
    for (const i of idx) {
      const a = i < 0 ? [...arcs[~i]!].reverse() : arcs[i]!
      // Anschlusspunkt des nächsten Bogens nicht doppelt
      pts.push(...(pts.length ? a.slice(1) : a))
    }
    const xy = pts.map(project)
    const xs = xy.map((p) => p[0])
    const ys = xy.map((p) => p[1])
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    // Ringe über die Datumsgrenze (Rahmen fast so breit wie die Welt) taugen nicht als Mitte
    const area = x1 - x0 > 180 ? 0 : (x1 - x0) * (y1 - y0)
    if (!best || area > best.area) best = { area, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
    let d = ''
    let last = ''
    let prevX: number | null = null
    for (const [x, y] of xy) {
      const s = `${x.toFixed(1)},${y.toFixed(1)}`
      if (s === last) continue
      // Sprung über die Datumsgrenze (Russland, Fidschi): neues Teilstück statt Linie quer über die Karte
      const jump = prevX !== null && Math.abs(x - prevX) > 180
      d += `${prevX === null || jump ? 'M' : 'L'}${s}`
      last = s
      prevX = x
    }
    return `${d}Z`
  }
  const out: CountryShape[] = []
  for (const g of t.objects.countries.geometries) {
    const name = g.properties?.name ?? ''
    const code = (g.id && NUMERIC_TO_ALPHA2[g.id]) || BY_NAME[name]
    if (!code || !g.arcs) continue
    const polys = (g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : []) as number[][][]
    best = null
    const d = polys.flatMap((poly) => poly.map(ring)).join('')
    const c = best as { cx: number; cy: number } | null
    out.push({ code, name, d, cx: Math.round((c?.cx ?? 0) * 10) / 10, cy: Math.round((c?.cy ?? 0) * 10) / 10 })
  }
  return out
}
