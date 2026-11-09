const { test } = require('node:test')
const assert = require('node:assert/strict')
const env = require('../firmware/miniprogram-latest/config/env')
env.transport = 'public'

function services({ cloudFails=false, authFails=false, fresh=false, padStatus='connected',
  padDetection, micStatus='ready', envVersion='develop' } = {}) {
  const values = { 'haomian-device-id': 'haomian_sleep_abcdef', 'haomian-session-token': 'test-only' }
  global.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion } }),
    getStorageSync: key => values[key], setStorageSync: (key, value) => { values[key] = value },
    removeStorageSync: key => { delete values[key] },
    request: options => {
      if (cloudFails) { options.fail({ errMsg: 'request:fail offline' }); return }
      if (authFails) { options.success({ statusCode: 401, data: {} }); return }
      const runtime = options.url.includes('/runtime/')
      options.success({ statusCode: 200, data: runtime
        ? { available: true, freshness: fresh ? 'fresh' : 'stale', mic_status: micStatus,
            radar_status: 'ready', pad_status: padStatus, firmware_version: 'test-fw',
            stop_latched: false, capabilities: { actuation_guard: 1, pad_detection: padDetection } }
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

test('calibration distinguishes missing sensor reports from physical adjustments', async () => {
  const result = await services().device.runCalibration()
  assert.equal(result.ready, false)
  assert.equal(result.calibrationToken, '')
  assert.equal(result.canViewDevice, true)
  const mic = result.checks.find(check => check.id === 'microphones')
  const pad = result.checks.find(check => check.id === 'pad')
  assert.equal(mic.label, '麦克风')
  assert.equal(mic.detail, '未收到麦克风状态')
  assert.equal(pad.detail, '未收到振动片连接状态')
})

test('bench calibration offers manual confirmation only for an explicit missing detector and otherwise ready device', async () => {
  const options = { fresh: true, padStatus: 'unknown', padDetection: false }
  const original = env.testManualPadConfirmation
  try {
    env.testManualPadConfirmation = false
    assert.equal((await services(options).device.runCalibration()).canConfirmPad, false)
    env.testManualPadConfirmation = true
    const api = services(options)
    const result = await api.device.runCalibration()
    assert.equal(result.canConfirmPad, true)
    assert.equal(result.deviceId, 'haomian_sleep_abcdef')
    assert.equal(result.ready, false)
    assert.equal(result.calibrationToken, '')
    assert.equal((await api.device.getStatus()).pad.connected, false)
    assert.equal((await api.device.getStatus()).controlAvailable, false)
    for (const variant of [{ envVersion: 'release' }, { fresh: false }, { micStatus: 'calibrating' },
      { padDetection: undefined }, { padDetection: true }, { padStatus: 'disconnected' }, { padStatus: 'fault' }]) {
      assert.equal((await services({ ...options, ...variant }).device.runCalibration()).canConfirmPad, false)
    }
  } finally {
    env.testManualPadConfirmation = original
  }
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

test('light status uses the effect reported by the device', async () => {
  const api = services()
  api.configureDeviceBridge({
    discover() {}, confirmBinding() {}, applySound() {}, applyLight() {},
    getStatus: () => ({ connected: true }),
    getIoState: async () => ({ light: { enabled: true, r: 20, g: 10, b: 2, mode: 'bedtime-breathe' } }),
  })
  const light = await api.device.getLightState()
  assert.equal(light.source, 'ble-driver')
  assert.equal(light.mode, 'bedtime-breathe')
  assert.equal(light.modeName, '睡前呼吸灯')
  assert.equal(light.brightness, 20)
})

test('a legacy cloud limit keeps confirmed 100 percent brightness available locally while off', async () => {
  const api = services()
  let light = { enabled: false, r: 0, g: 0, b: 0, mode: 'night-low' }
  api.configureDeviceBridge({
    discover() {}, confirmBinding() {}, applySound() {},
    getStatus: () => ({ connected: true }),
    getIoState: async () => ({ light }),
    applyLight: async (_id, desired) => {
      const channel = desired.enabled ? desired.brightness : 0
      light = { enabled: desired.enabled, r: channel, g: channel, b: channel, mode: 'night-low' }
      return { confirmed: true, readback: { light } }
    },
  })
  wx.request = o => o.success(o.method === 'PUT' && o.data.brightness > 40
    ? { statusCode: 400, data: { detail: 'brightness 必须在 5-40' } }
    : { statusCode: 200, data: { light: { mode: 'night-low', brightness: 15 } } })
  const on = await api.device.updateLight({ enabled: true, color: 'white', brightness: 100 })
  assert.equal(on.brightness, 100)
  assert.equal(on.syncPending, true)
  await api.device.updateLight({ enabled: false, color: 'white' })
  const off = await api.device.getLightState()
  assert.equal(off.enabled, false)
  assert.equal(off.brightness, 100)
  assert.equal(off.syncPending, true)
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

test('Wi-Fi controls use device readbacks and skip Bluetooth on an already online host', async () => {
  const requests = []
  const runtime = { available: true, freshness: 'fresh', clock_valid: true, stop_latched: false,
    pad_status: 'unknown', manual_active: false,
    capabilities: { actuation_guard: 1, cloud_light_control: true, cloud_sound_control: true, cloud_vibration_test: true },
    sound_output: { playing: false, paused: false, volume: 32, timer_minutes: 0, remaining_seconds: 0 },
    light_output: { enabled: false, r: 0, g: 0, b: 0, mode: 'night-low' } }
  global.wx = {
    getStorageSync: key => ({ 'haomian-device-id': 'haomian_sleep_abcdef', 'haomian-session-token': 'test-only' }[key]),
    setStorageSync() {},
    request(options) {
      requests.push({ method: options.method, url: options.url, data: options.data })
      const data = options.url.endsWith('/runtime/snapshot') ? runtime
        : options.url.endsWith('/status') ? { device_status: 'online', mode: 'solo' }
        : options.url.endsWith('/light-command') ? { command: { command_id: 'night-light-1', status: 'applied',
          readback: { light: { enabled: true, brightness: 25, mode: 'night-low', color: 'amber' } } } }
        : options.url.endsWith('/sound-command') ? { command: { command_id: 'sound-1', status: 'applied',
          readback: { sound: { playing: true, volume: 32, scene: 'sleep', timer: 15, timer_remaining_seconds: 900 } } } }
        : options.url.endsWith('/vibration-test') ? { command: { command_id: 'test-1', status: 'applied',
          readback: { vibration_test: { started: true, duration_ms: 2000 } } } }
        : { light: { enabled: true, brightness: 25, mode: 'night-low', color: 'amber' } }
      options.success({ statusCode: 200, data })
    },
  }
  const modulePath = require.resolve('../firmware/miniprogram-latest/services/real')
  delete require.cache[modulePath]
  const api = require(modulePath).createRealServices()
  const status = await api.device.getStatus()
  assert.equal(status.ble.connected, false)
  assert.equal(status.cloudLightAvailable, true)
  assert.equal(status.cloudSoundAvailable, true)
  assert.equal(status.cloudVibrationTestAvailable, true)
  assert.equal((await api.device.autoConnect({ preferCloud: true })).reason, 'cloud-online')
  const before = await api.device.getLightState()
  assert.equal(before.enabled, false)
  assert.equal(before.confirmed, true)
  assert.equal(before.source, 'cloud-driver')
  const after = await api.device.updateLight({ enabled: true, color: 'amber' })
  assert.equal(after.enabled, true)
  assert.equal(after.confirmed, true)
  assert.equal(after.source, 'cloud-driver')
  assert.equal(requests.filter(call => call.url.endsWith('/light-command')).length, 1)
  const sound = await api.device.updateSound({ playing: true, timer: 15 })
  assert.equal(sound.confirmed, true)
  assert.equal(sound.playing, true)
  assert.equal(sound.timerRemainingSeconds, 900)
  assert.equal((await api.device.startVibrationTest()).durationMs, 2000)
  assert.equal(requests.filter(call => call.url.endsWith('/vibration-test')).length, 1)
})

test('real-time page shows fresh cloud acoustic windows separately from device status', async () => {
  let featureSnapshot = { available: true, freshness: 'fresh',
    observation: { quality: 'good', valid_windows: 30, rule_version: 'feature-rule-v1-unvalidated' } }
  global.wx = {
    getStorageSync: key => ({ 'haomian-device-id': 'haomian_sleep_abcdef', 'haomian-session-token': 'test-only' }[key]),
    request(options) {
      const data = options.url.endsWith('/features/latest') ? featureSnapshot
        : { available: true, freshness: 'fresh', state: 'MONITORING', sequence: 1 }
      options.success({ statusCode: 200, data })
    },
  }
  const modulePath = require.resolve('../firmware/miniprogram-latest/services/real')
  delete require.cache[modulePath]
  const { guardian } = require(modulePath).createRealServices()
  let snapshot = await guardian.getSnapshot()
  assert.equal(snapshot.guardianState, 'observing')
  assert.equal(snapshot.cloudRealtime.acoustic.label, '观察已更新')
  assert.equal(snapshot.cloudRealtime.acoustic.validWindows, 30)
  featureSnapshot = { ...featureSnapshot, freshness: 'stale' }
  snapshot = await guardian.getSnapshot()
  assert.equal(snapshot.cloudRealtime.acoustic.label, '数据已延迟')
  assert.equal(snapshot.cloudRealtime.acoustic.validWindows, null)
})
