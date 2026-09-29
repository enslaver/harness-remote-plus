import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { streamURL } from './opencode-events.ts'
import { agentScopedPath, authHeader, baseUrl, hasCredentials, isValidServerConfig, machineBaseUrl, normalizeBasePath, normalizeServerConfig, normalizeServerHost } from './serverConfig.ts'

const config = (host, port = 4096) => ({ backend: 'opencode', host, port, username: 'opencode', password: 'secret' })

for (const host of ['http:', 'http://', 'https:', 'https://', '', '   ']) {
  assert.equal(isValidServerConfig(config(host)), false, `half-typed host ${JSON.stringify(host)} must be rejected`)
}
for (const host of ['Giulio-S7', 'localhost', '192.168.1.64', 'http://192.168.1.64', 'https://example.com', 'http://192', 'HTTP://LOCALHOST/']) {
  assert.equal(isValidServerConfig(config(host)), true, `usable host ${JSON.stringify(host)} must be accepted`)
}
assert.equal(isValidServerConfig(config('localhost', 0)), false)
assert.equal(isValidServerConfig(config('localhost', 70000)), false)
assert.equal(isValidServerConfig(config('localhost', Number.NaN)), false)
assert.equal(isValidServerConfig(config('example.com/path')), false)
assert.equal(isValidServerConfig(config('example.com:4097')), false)
assert.equal(normalizeServerHost(' LOCALHOST '), 'localhost')
assert.equal(normalizeServerHost('HTTP://LOCALHOST/'), 'http://localhost')
assert.equal(normalizeServerHost('192.168.1.64'), '192.168.1.64')
assert.equal(baseUrl(config('192.168.1.64')), 'http://192.168.1.64:4096')
assert.equal(baseUrl(config('https://example.com')), 'https://example.com:4096')

const daemon = { ...config('192.168.1.64', 4097), backend: 'codex', agentId: 'opencode' }
assert.equal(machineBaseUrl(daemon), 'http://192.168.1.64:4097')
assert.equal(baseUrl(daemon), 'http://192.168.1.64:4097/v1/agents/opencode')
assert.equal(agentScopedPath(daemon, '/session'), '/v1/agents/opencode/session')
assert.equal(agentScopedPath({ ...daemon, agentId: undefined }, '/session'), '/session')
assert.equal(streamURL(baseUrl(daemon), 'global'), 'http://192.168.1.64:4097/v1/agents/opencode/global/event')
assert.equal(baseUrl({ ...daemon, agentId: 'claude/code' }), 'http://192.168.1.64:4097/v1/agents/claude%2Fcode')

// A machine served by a hub lives under a path prefix on the hub's own host and port.
const hubMachine = { backend: 'opencode', host: 'https://hub.example.com', port: 443, username: '', password: '', basePath: '/m/machine_abc' }
assert.equal(machineBaseUrl(hubMachine), 'https://hub.example.com:443/m/machine_abc')
assert.equal(baseUrl({ ...hubMachine, agentId: 'codex' }), 'https://hub.example.com:443/m/machine_abc/v1/agents/codex')
assert.equal(machineBaseUrl({ ...hubMachine, basePath: undefined }), 'https://hub.example.com:443', 'no prefix -> byte-for-byte the previous URL')
assert.equal(machineBaseUrl({ ...hubMachine, basePath: '/m/machine_abc/' }), 'https://hub.example.com:443/m/machine_abc', 'a trailing slash is dropped')
assert.equal(normalizeBasePath(undefined), '')
assert.equal(normalizeBasePath(''), '')
assert.equal(normalizeBasePath('/'), '')
assert.equal(normalizeBasePath(' /m/x '), '/m/x')
assert.equal(normalizeBasePath('/m/machine_a%20b'), '/m/machine_a%20b')
for (const bad of ['m/x', '/m/../x', '/m/%2e%2e/x', '/m/%2E%2E', '/./x', '/m//x', '/m/x?a=1', '/m/x#f', '/m/x y', 'http://evil/x', '//evil.example/x', '/m/%zz', '/m/\\x']) {
  assert.equal(normalizeBasePath(bad), null, `should reject ${bad}`)
}
assert.equal(isValidServerConfig(hubMachine), true)
assert.equal(isValidServerConfig({ ...hubMachine, basePath: '/../x' }), false, 'a bad prefix makes the whole config invalid, so it can never build a URL')
assert.equal(normalizeServerConfig({ ...hubMachine, basePath: ' /m/machine_abc/ ' }).basePath, '/m/machine_abc')
assert.equal('basePath' in normalizeServerConfig({ ...hubMachine, basePath: '' }), false, 'an empty prefix is not stored at all')
assert.equal('basePath' in normalizeServerConfig(daemon), false)

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const standalone = readFileSync(new URL('./components/standalone-universal-workspace.tsx', import.meta.url), 'utf8')
assert.match(main, /<ErrorBoundary resetKeys=\{SERVER_STORAGE_KEYS\}>/)
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /<StandaloneUniversalWorkspace/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.match(standalone, /discoverMachine\(nextMachine\(\)\.config\)/)
assert.match(standalone, /Number\(port\) >= 1 && Number\(port\) <= 65_535/)

const boundary = readFileSync(new URL('./ErrorBoundary.tsx', import.meta.url), 'utf8')
assert.match(boundary, /localStorage\.removeItem\(key\)/)

const creds = (username, password) => ({ backend: 'opencode', host: 'localhost', port: 4096, username, password })
assert.equal(authHeader(creds('opencode', 'secret')), 'Basic b3BlbmNvZGU6c2VjcmV0')
assert.equal(authHeader(creds(' opencode ', ' secret ')), authHeader(creds('opencode', 'secret')))
assert.equal(authHeader(creds('opencode', 'pàssword')), 'Basic b3BlbmNvZGU6cMOgc3N3b3Jk')
assert.doesNotThrow(() => authHeader(creds('opencode', 'påsswörd☂')))
assert.equal(hasCredentials(creds('', '')), false)
assert.equal(hasCredentials(creds('opencode', '')), false)
assert.equal(hasCredentials(creds('', 'secret')), false)
assert.equal(hasCredentials(creds('opencode', 'secret')), true)

console.log('server config regression tests passed')
