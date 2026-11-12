import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { languageName } from '@airlock/shared'
import { browserOf, campaignOf, languageOf, parseBrands, systemOf } from './agent.js'

const UA = {
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chromeIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.51',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  chromeAndroidReduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  opera: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

describe('Besucher: Browser (Familie + Hauptversion)', () => {
  test('aus dem User-Agent, ohne Feinversion', () => {
    assert.equal(browserOf(UA.safariMac), 'Safari 18')
    assert.equal(browserOf(UA.safariIphone), 'Safari 18')
    assert.equal(browserOf(UA.chromeIphone), 'Chrome 131')
    assert.equal(browserOf(UA.chromeWin), 'Chrome 131')
    assert.equal(browserOf(UA.edgeWin), 'Edge 131')
    assert.equal(browserOf(UA.firefoxLinux), 'Firefox 132')
    assert.equal(browserOf(UA.samsung), 'Samsung Internet 26')
    assert.equal(browserOf(UA.opera), 'Opera 115')
    assert.equal(browserOf('irgendwas/1.0'), '')
  })
  test('Client Hints gehen vor (Brave sieht im User-Agent aus wie Chrome); Platzhalter und Chromium nur als Rückfall', () => {
    assert.deepEqual(parseBrands('"Chromium";v="131", "Not_A Brand";v="24"'), [{ brand: 'Chromium', version: '131' }, { brand: 'Not_A Brand', version: '24' }])
    assert.equal(browserOf(UA.chromeWin, '"Brave";v="131", "Chromium";v="131", "Not_A Brand";v="24"'), 'Brave 131')
    assert.equal(browserOf(UA.chromeWin, '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"'), 'Edge 131')
    // Nur Chromium und Platzhalter in den Hints: der User-Agent entscheidet
    assert.equal(browserOf(UA.chromeWin, '"Chromium";v="131", "Not_A Brand";v="24"'), 'Chrome 131')
  })
})

describe('Besucher: Betriebssystem', () => {
  test('iOS und Android mit Hauptversion, macOS und Windows ohne (eingefrorene User-Agents)', () => {
    assert.equal(systemOf(UA.safariIphone), 'iOS 18')
    assert.equal(systemOf(UA.chromeIphone), 'iOS 17')
    assert.equal(systemOf(UA.samsung), 'Android 14')
    assert.equal(systemOf(UA.chromeAndroidReduced), 'Android')
    assert.equal(systemOf(UA.safariMac), 'macOS')
    assert.equal(systemOf(UA.chromeWin), 'Windows')
    assert.equal(systemOf(UA.firefoxLinux), 'Linux')
    assert.equal(systemOf(UA.chromebook), 'ChromeOS')
    assert.equal(systemOf(''), '')
  })
  test('Client Hints: Windows 11 nur mit Plattform-Version ≥ 13, Android-Version aus den Hints', () => {
    assert.equal(systemOf(UA.chromeWin, '"Windows"', '"15.0.0"'), 'Windows 11')
    assert.equal(systemOf(UA.chromeWin, '"Windows"', '"10.0.0"'), 'Windows 10')
    assert.equal(systemOf(UA.chromeWin, '"Windows"'), 'Windows')
    assert.equal(systemOf(UA.chromeAndroidReduced, '"Android"', '"14.0.0"'), 'Android 14')
    assert.equal(systemOf(UA.chromeWin, '"macOS"'), 'macOS')
  })
})

describe('Besucher: Sprache aus Accept-Language', () => {
  test('erste Sprache, Region gross, Gewichte und Schrift weg', () => {
    assert.equal(languageOf('de-CH,de;q=0.9,en;q=0.8'), 'de-CH')
    assert.equal(languageOf('de'), 'de')
    assert.equal(languageOf('EN-us'), 'en-US')
    assert.equal(languageOf('zh-Hant-TW,zh;q=0.9'), 'zh-TW')
    assert.equal(languageOf('es-419'), 'es')
    assert.equal(languageOf('*'), '')
    assert.equal(languageOf(''), '')
  })
  test('Anzeige auf Deutsch', () => {
    assert.equal(languageName('de-CH'), 'Deutsch (Schweiz)')
    assert.equal(languageName('fr'), 'Französisch')
  })
})

describe('Besucher: Kampagnen (utm_*)', () => {
  test('nur utm_source, utm_medium, utm_campaign; klein, ohne Steuerzeichen; der Rest der Query bleibt weg', () => {
    assert.deepEqual(campaignOf('utm_source=Newsletter&utm_medium=E-Mail&utm_campaign=Herbst%202026&email=a%40b.ch&id=7'), { source: 'newsletter', medium: 'e-mail', campaign: 'herbst 2026' })
    assert.deepEqual(campaignOf('utm_campaign=launch'), { source: '', medium: '', campaign: 'launch' })
    assert.equal(campaignOf('utm_medium=social'), null)
    assert.equal(campaignOf('q=suche'), null)
    assert.equal(campaignOf(''), null)
  })
})
