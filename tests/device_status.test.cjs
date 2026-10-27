const { test } = require('node:test')
const assert = require('node:assert/strict')
const env = require('../firmware/miniprogram-latest/config/env')
env.transport = 'public'

function services({ cloudFails=false, authFails=false, fresh=false } = {}) {
  const values = { 'haomian-device-id': 'haomian_sleep_abcdef', 'haomian-session-token': 'test-only' }
  global.wx = {
    getStorageSync: key => values[key], setStorageSync: (key, value) => { values[key] = value },
    removeStorageSync: key => { delete values[key] },
    request: options => {
      if (cloudFails) { options.fail({ errMsg: 'request:fail offline' }); return }
      if (authFails) { options.success({ statusCode: 401, data: {} }); return }
      const runtime = options.url.includes('/runtime/')
      options.success({ statusCode: 200, data: runtime
        ? { available: true, freshness: fresh ? 'fresh' : 'stale', mic_status: 'ready',
            radar_status: 'ready', pad_status: 'connected', firmware_version: 'test-fw',
            stop_latched: false, capabilities: { actuation_guard: 1 } }
        : { device_id: values['haomian-device-id'], device_status: 'online', mode: 'solo' } })
    },
  }
  const modulePath = require.resolve('../firmware/miniprogram-latest/services/real')
  delete require.cache[modulePath]
  const result = require(modulePath).createRealServices()
  result.configureDeviceBridge({ discover() {}, confirmBinding() {}, applySound: async (_id, _current, desired) => ({ confirmed: true,
      readback: { sound: { volume: desired.volume, playing: desired.playing, index: 0 } } }),
    applyLight: async (_id, desired) => ({ confirmed: true,
      readback: { light: { enabled: desired.enabled, r: 20, g: 10, b: 2 } } }),
    getIoState: async () => ({ light: { enabled: true, r: 20, g: 10, b: 2 },
      sound: { volume: 0, playing: false, index: 0 } }),
    getStatus: () => ({ connected: true, known: true }),
    getSafetyState: async () => ({ stopLatched: true, active: false, physicalFeedback: false }),
    resumeManualControl: async () => ({ stopLatched: false, active: false }),
    stopAllOutputs: async () => ({ stopLatched: true, active: false }),
  })
  return result
}

test('BLE safety controls remain reachable during cloud network failure', async () => {
  const api = services({ cloudFails: true })
  const status = await api.device.getStatus()
  assert.equal(status.ble.connected, true)
  assert.equal(status.cloudOnline, false)
  assert.equal(status.controlAvailable, false)
  assert.equal(status.safety.stopLatched, true)
  assert.equal(status.microphones.status, 'unknown')
  assert.equal((await api.device.resumeManualControl()).stopLatched, false)
  assert.equal((await api.device.stopAllOutputs()).stopLatched, true)
})

test('stale sensor data does not show ready or an active local loop', async () => {
  const status = await services().device.getStatus()
  assert.equal(status.microphones.ready, false)
  assert.equal(status.radar.ready, false)
  assert.equal(status.pad.status, 'unknown')
  assert.equal(status.localLoop.active, false)
  assert.equal(status.host.modelVersion, '未核验')
})

test('cloud authorization failures are not converted to successful device status', async () => {
  await assert.rejects(services({ authFails: true }).device.getStatus(), { code: 'AUTH_EXPIRED' })
})

test('local stop latch takes precedence over a fresh cloud snapshot', async () => {
  const status = await services({ fresh: true }).device.getStatus()
  assert.equal(status.cloudOnline, true)
  assert.equal(status.controlAvailable, false)
})

test('offline controls show driver readback and keep confirmed changes pending cloud sync', async () => {
  const api = services({ cloudFails: true })
  const initial = await api.device.getLightState()
  assert.equal(initial.confirmed, true)
  assert.equal(initial.enabled, true)
  assert.equal(initial.brightness, 20)
  const changed = await api.device.updateLight({ enabled: false })
  assert.equal(changed.confirmed, true)
  assert.equal(changed.enabled, false)
  assert.equal(changed.syncPending, true)
  assert.equal(changed.syncError, 'NETWORK_ERROR')
  const sound = await api.device.updateSound({ volume: 25 })
  assert.equal(sound.volume, 25)
  assert.equal(sound.confirmed, true)
  assert.equal(sound.syncPending, true)
})

test('cloud preferences do not bypass authorization via BLE', async () => {
  await assert.rejects(services({ authFails: true }).device.getLightState(), { code: 'AUTH_EXPIRED' })
})

test('remote global stop needs explicit applied readback; queued alone is not confirmation', async () => {
  const api = services()
  api.configureDeviceBridge(null)
  let payload
  global.wx.request = o => {
    payload = o.data
    o.success({ statusCode: 200, data: { command: { command_id: 'stop-test', status: 'applied',
      readback: { stop_latched: true, outputs_stopped: true, vibration_level: 0 } } } })
  }
  const result = await api.device.stopAllOutputs()
  assert.equal(result.confirmed, true)
  assert.equal(result.transport, 'mqtt')
  assert.ok(payload.request_id.startsWith('stop-'))
  global.wx.request = o => o.success({ statusCode: 200, data: { command: { command_id: 'bad', status: 'applied', readback: {} } } })
  await assert.rejects(api.device.stopAllOutputs(), { code: 'STOP_UNCONFIRMED' })
})

test('remote unsupported settings report an explicit limitation', async () => {
  const api = services()
  api.configureDeviceBridge(null)
  global.wx.request = o => o.success({ statusCode: 200, data: o.method === 'POST'
    ? { command: { command_id: 'unsupported', status: 'rejected', error_code: 'NOT_IMPLEMENTED' } }
    : { light: { mode: 'night-low', enabled: false, brightness: 15 } } })
  await assert.rejects(api.device.updateLight({ enabled: true }), { code: 'CONTROL_UNSUPPORTED' })
})
