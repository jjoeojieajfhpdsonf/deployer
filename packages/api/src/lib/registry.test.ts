import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseImageRef } from './registry.js'

describe('parseImageRef', () => {
  test('Docker-Hub-Kurzname bekommt library/ und latest', () => {
    assert.deepEqual(parseImageRef('nginx'), { registry: 'registry-1.docker.io', repository: 'library/nginx', reference: 'latest' })
  })
  test('Benutzer-Repo mit Tag', () => {
    assert.deepEqual(parseImageRef('traefik/whoami:v1.10.1'), { registry: 'registry-1.docker.io', repository: 'traefik/whoami', reference: 'v1.10.1' })
  })
  test('fremde Registry mit Pfad', () => {
    assert.deepEqual(parseImageRef('ghcr.io/user/app:1.2'), { registry: 'ghcr.io', repository: 'user/app', reference: '1.2' })
  })
  test('Registry mit Port ist kein Tag', () => {
    assert.deepEqual(parseImageRef('localhost:5000/app'), { registry: 'localhost:5000', repository: 'app', reference: 'latest' })
  })
  test('Digest', () => {
    assert.deepEqual(parseImageRef('nginx@sha256:abc'), { registry: 'registry-1.docker.io', repository: 'library/nginx', reference: 'sha256:abc' })
  })
  test('docker.io wird zur echten Registry', () => {
    assert.equal(parseImageRef('docker.io/library/redis:7').registry, 'registry-1.docker.io')
  })
})
