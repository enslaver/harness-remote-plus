import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'

const { HubLink, normalizeHubAddress, validateEnrollmentToken, hubMachineProfile } = await import('../dist-electron/electron/hub-link.js')
const { ProfileRegistry } = await import('../dist-electron/electron/profile-registry.js')
const { executeDesktopRequest } = await import('../dist-electron/electron/request-transport.js')

const directories = []
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }) })
// configure() schedules an immediate poll of its own; let it finish so the explicit polls below are the only ones.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const temp = async () => { const directory = await mkdtemp(join(tmpdir(), 'hub-link-')); directories.push(directory); return directory }

test('addresses: host:port, bare host and full URLs normalize; credentials and odd schemes are refused', () => {
  assert.equal(normalizeHubAddress('hub.local:8080'), 'http://hub.local:8080')
  assert.equal(normalizeHubAddress(' https://hub.example.com/ '), 'https://hub.example.com')
  assert.equal(normalizeHubAddress('https://example.com/prefix/'), 'https://example.com/prefix')
  assert.throws(() => normalizeHubAddress(''), /Enter the hub address/)
  assert.throws(() => normalizeHubAddress('ftp://hub.local'), /http or https/)
  assert.throws(() => normalizeHubAddress('https://user:pw@hub.local'), /credentials/)
  assert.throws(() => normalizeHubAddress('hub.local?x=1'), /query/)
  assert.throws(() => validateEnrollmentToken('short'), /16 characters/)
  assert.equal(validateEnrollmentToken('  0123456789abcdef  '), '0123456789abcdef')
})

test('a hub machine becomes a main-owned profile behind the hub proxy, authenticated as hub-machine', () => {
  const mapped = hubMachineProfile({ id: 'm1', name: 'Studio', status: 'online', basePath: '/m/m1' }, 'https://hub.example.com', 'hrm_tok')
  assert.deepEqual(mapped.profile, {
    id: 'hub:m1', backend: 'opencode', host: 'https://hub.example.com', port: 443,
    username: 'hub-machine', password: 'hrm_tok', basePath: '/m/m1'
  })
  assert.equal(mapped.machine.profileId, 'hub:m1')
  assert.equal(hubMachineProfile({ id: 'm1', basePath: '/elsewhere' }, 'http://h:1', 't'), null)
  assert.equal(hubMachineProfile({ id: '', basePath: '/m/x' }, 'http://h:1', 't'), null)
})

test('the transport keeps a profile basePath in front of every route', async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  after(() => server.close())
  const result = await executeDesktopRequest({
    id: 'hub:m1', backend: 'opencode', host: '127.0.0.1', port: server.address().port,
    username: 'hub-machine', password: 'hrm_tok', basePath: '/m/m1'
  }, { path: '/v1/machine' })
  assert.equal(result.ok, true)
  assert.equal(seen[0].url, '/m/m1/v1/machine')
  assert.equal(seen[0].authorization, `Basic ${Buffer.from('hub-machine:hrm_tok').toString('base64')}`)
})

test('the registry validates and round-trips basePath', async () => {
  const directory = await temp()
  const registry = new ProfileRegistry(join(directory, 'profiles.json'))
  registry.setRuntimeProfile({ id: 'hub:m1', backend: 'opencode', host: 'http://hub', port: 80, username: 'u', password: 'p', basePath: '/m/m1' })
  assert.equal(registry.get('hub:m1').basePath, '/m/m1')
  assert.throws(() => registry.setRuntimeProfile({ id: 'hub:m2', backend: 'opencode', host: 'http://hub', port: 80, username: '', password: '', basePath: '/m/../x' }), /base path/)
})

function harness(overrides = {}) {
  const calls = { restart: 0, profiles: new Map() }
  return { calls, options: async () => {
    const directory = await temp()
    return {
      settingsPath: join(directory, 'hub-link.json'),
      daemonStateDirectory: directory,
      environment: () => ({}),
      setProfile: (id, profile) => profile ? calls.profiles.set(id, profile) : calls.profiles.delete(id),
      restartDaemon: async () => { calls.restart += 1 },
      ...overrides
    }
  } }
}

test('configure saves 0600, restarts the daemon with the hub env, then lists the fleet once the daemon has enrolled', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, authorization: init.headers.Authorization })
    return new Response(JSON.stringify({ hub: true, authenticated: true, machines: [
      { id: 'self', name: 'This one', basePath: '/m/self' },
      { id: 'other', name: 'Other', status: 'online', basePath: '/m/other' }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const h = harness({ fetchImpl })
  const options = await h.options()
  const link = new HubLink(options)
  await link.load()
  assert.equal(link.state().configured, false)

  const configured = await link.configure({ url: 'hub.local:8080', token: '0123456789abcdef-token' })
  link.stop()
  await settle()
  assert.equal(configured.url, 'http://hub.local:8080')
  assert.equal(configured.source, 'saved')
  assert.equal(JSON.stringify(configured).includes('0123456789abcdef-token'), false, 'the token never leaves main')
  assert.equal(h.calls.restart, 1)
  assert.deepEqual(link.daemonEnvironment(), { HARNESS_REMOTE_HUB_URL: 'http://hub.local:8080', HARNESS_REMOTE_HUB_TOKEN: '0123456789abcdef-token' })
  assert.match(await readFile(options.settingsPath, 'utf8'), /hub\.local/)

  // Not enrolled yet: no token to ask with, so no request is made.
  await link.poll()
  link.stop()
  assert.equal(link.state().status, 'enrolling')
  assert.equal(requests.length, 0)

  await writeFile(join(options.daemonStateDirectory, 'hub.json'), JSON.stringify({ url: 'http://hub.local:8080', machineId: 'self', machineToken: 'hrm_machine' }))
  await link.poll()
  link.stop()
  assert.equal(requests[0].url, 'http://hub.local:8080/api/v1/fleet')
  assert.equal(requests[0].authorization, 'Bearer hrm_machine')
  const state = link.state()
  assert.equal(state.status, 'connected')
  assert.deepEqual(state.machines.map((machine) => machine.profileId), ['hub:other'], 'this machine is the local runtime, not a second entry')
  assert.equal(h.calls.profiles.get('hub:other').password, 'hrm_machine')

  const cleared = await link.clear()
  link.stop()
  assert.equal(cleared.configured, false)
  assert.equal(h.calls.profiles.size, 0)
})

test('the environment wins and makes the form read-only', async () => {
  const h = harness({ environment: () => ({ HARNESS_REMOTE_HUB_URL: 'https://hub.example.com', HARNESS_REMOTE_HUB_TOKEN: '0123456789abcdef' }) })
  const link = new HubLink(await h.options())
  const state = link.state()
  assert.equal(state.source, 'environment')
  assert.equal(state.url, 'https://hub.example.com')
  assert.deepEqual(link.daemonEnvironment(), {}, 'the daemon inherits the environment itself')
  await assert.rejects(link.configure({ url: 'other:1', token: '0123456789abcdef' }), /environment/)
  await assert.rejects(link.clear(), /environment/)
})

test('a rejected token and an unreachable hub are statuses, never throws', async () => {
  for (const [fetchImpl, expected] of [
    [async () => new Response('{}', { status: 401 }), /no longer accepts/],
    [async () => new Response('<html>', { status: 200 }), /not a Harness Remote Hub|Unexpected/],
    [async () => { throw new TypeError('fetch failed') }, /fetch failed/]
  ]) {
    const h = harness({ fetchImpl })
    const options = await h.options()
    const link = new HubLink(options)
    await link.configure({ url: 'http://hub:1', token: '0123456789abcdef' })
    link.stop()
    await settle()
    await writeFile(join(options.daemonStateDirectory, 'hub.json'), JSON.stringify({ url: 'http://hub:1', machineToken: 'hrm_x' }))
    await link.poll()
    link.stop()
    assert.equal(link.state().status, 'error')
    assert.match(link.state().error, expected)
  }
})
