/**
 * Feste Uhr für die visuellen Tests: Die Fixtures rechnen beim Import mit
 * Date.now() («vor 2 Std.»), die Seite ebenso. Damit die Referenzbilder
 * stabil bleiben, laufen beide auf demselben Zeitpunkt:
 *   - hier in Node (muss vor den Fixtures importiert werden),
 *   - im Browser über page.clock.setFixedTime(FIXED_NOW).
 */
export const FIXED_NOW = Date.parse('2026-11-10T14:00:00+01:00')

const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED_NOW)
    // @ts-expect-error – Date nimmt dieselben Argumente wie das Original
    else super(...args)
  }
  static now(): number { return FIXED_NOW }
}
globalThis.Date = FixedDate as unknown as DateConstructor
