import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeLabels, isProjectScoped, isLegacyName, isOwnImage, projectNetwork, legacyProjectNetwork, LABEL } from './names.js'

describe('Namen von Airlock und Übergang aus der deployer-Zeit', () => {
  test('neue Namen', () => {
    assert.equal(projectNetwork('solar'), 'air_solar')
    assert.equal(legacyProjectNetwork('solar'), 'dep_solar')
    assert.equal(LABEL.managed, 'airlock.managed')
    assert.equal(LABEL.composeService, 'airlock.compose-service')
  })

  test('deployer.*-Labels werden zusätzlich als airlock.* gelesen', () => {
    const { labels, legacy } = normalizeLabels({ 'deployer.managed': 'true', 'deployer.project': 'solar', 'deployer.compose-service': 'db', other: 'x' })
    assert.equal(legacy, true)
    assert.equal(labels['airlock.managed'], 'true')
    assert.equal(labels['airlock.project'], 'solar')
    assert.equal(labels['airlock.compose-service'], 'db')
    assert.equal(labels.other, 'x')
    assert.equal(labels['deployer.project'], 'solar', 'alte Schlüssel bleiben lesbar')
  })

  test('Container mit airlock.*-Labels sind nicht alt, auch mit Resten', () => {
    assert.equal(normalizeLabels({ 'airlock.managed': 'true', 'airlock.project': 'a' }).legacy, false)
    assert.equal(normalizeLabels({ 'airlock.managed': 'true', 'deployer.managed': 'true' }).legacy, false)
    assert.equal(normalizeLabels({}).legacy, false)
  })

  test('Präfixe erkennen', () => {
    assert.ok(isProjectScoped('air_solar'))
    assert.ok(isProjectScoped('dep_solar'))
    assert.ok(!isProjectScoped('airlock_edge'))
    assert.ok(!isProjectScoped('deployer_edge'))
    assert.ok(isLegacyName('dep_solar'))
    assert.ok(!isLegacyName('air_solar'))
    assert.ok(isOwnImage('airlock/solar:abc'))
    assert.ok(isOwnImage('deployer/solar:abc'))
    assert.ok(!isOwnImage('nginx:alpine'))
  })
})
