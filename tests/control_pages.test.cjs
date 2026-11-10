const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../firmware/miniprogram-latest')
function page(name, device, serviceMode = 'mock') {
  let definition
  const toasts = []
  const routes = []
  const storage = new Map()
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/index.js`), 'utf8'), {
    Page: value => { definition = value },
    require: key => key === '../../services/index' ? { device, serviceMode }
      : require(path.resolve(root, 'pages', name, key)),
    wx: { showToast: value => toasts.push(value), navigateTo: ({ url }) => routes.push(url),
      switchTab: ({ url }) => routes.push(url), navigateBack: () => routes.push('back'),
      removeStorageSync: key => storage.delete(key), setStorageSync: (key, value) => storage.set(key, value) },
    setTimeout, clearTimeout,
  })
  definition.data = { ...definition.data }
  definition.setData = value => Object.assign(definition.data, value)
  return { instance: definition, toasts, routes, storage }
}

test('home reads local device state after BLE reconnect and keeps unknown pad status distinct', async () => {
  let connect
  let reads = 0
  const connection = new Promise(resolve => { connect = resolve })
  const { instance } = page('home', {
    autoConnect: () => connection,
    getStatus: async () => {
      reads++
      return { host: { online: true }, ble: { connected: true }, pad: { status: 'unknown' } }
    },
    getTonightSettings: async () => null,
    getSoundState: async () => null,
    getLightState: async () => null,
  }, 'real')
  const task = instance.loadDeviceData()
  assert.equal(reads, 0)
  connect({ connected: true })
  await task
  assert.equal(reads, 1)
  assert.equal(instance.data.deviceLinkLabel, '蓝牙已连接')
  assert.equal(instance.data.padNotice, '振动片状态待确认')
})

test('a failed BLE reconnect still loads cloud status and shows reported pad disconnection', async () => {
  const { instance } = page('home', {
    autoConnect: async () => { throw new Error('Bluetooth disabled') },
    getStatus: async () => ({ host: { online: false }, pad: { status: 'disconnected' } }),
    getTonightSettings: async () => null,
    getSoundState: async () => null,
    getLightState: async () => null,
  }, 'real')
  await instance.loadDeviceData()
  assert.equal(instance.data.deviceLinkLabel, '设备离线')
  assert.equal(instance.data.padNotice, '枕下振动片未连接')
  assert.equal(instance.data.error, null)
})

test('home does not query output controls when the connected device cannot confirm safety state', async () => {
  let readCalls = 0
  const readOutput = async () => { readCalls++; throw new Error('BLE_RESPONSE_TIMEOUT') }
  const { instance, routes, toasts } = page('home', {
    autoConnect: async () => ({ connected: true }),
    getStatus: async () => ({ host: { online: true }, ble: { connected: true },
      pad: { status: 'unknown' }, safety: { available: false }, controlAvailable: false }),
    getTonightSettings: async () => null,
    getSoundState: readOutput,
    getLightState: readOutput,
  }, 'real')
  await instance.loadDeviceData()
  assert.equal(readCalls, 0)
  assert.equal(instance.data.controlStatusPending, true)
  assert.equal(instance.data.partialError, null)
  assert.equal(instance.data.sound, null)
  instance.openSound()
  assert.deepEqual(routes, [])
  assert.deepEqual(toasts, [])
})

test('home opens manual sound and light directly for a connected device in stop lock', () => {
  const { instance, routes, toasts } = page('home', {}, 'real')
  instance.data.status = {
    ble: { connected: true }, controlAvailable: false, bleManualControlAvailable: true, safety: { available: true, stopLatched: true },
  }
  instance.openLight()
  instance.openSound()
  assert.deepEqual(routes, ['/pages/light/index', '/pages/sound/index'])
  assert.deepEqual(toasts, [])
})

test('the night light page selects distinct colors for steady illumination and bedtime breathing', async () => {
  const commands = []
  const { instance } = page('light', { updateLight: async command => {
    commands.push(command)
    return { ...command, brightness: 15 }
  } }, 'real')
  instance.data.controlAvailable = true
  instance.data.light = { mode: 'night-low', brightness: 15 }
  await instance.setMode({ currentTarget: { dataset: { mode: 'night-low' } } })
  await instance.setMode({ currentTarget: { dataset: { mode: 'bedtime-breathe' } } })
  assert.deepEqual(commands.map(command => command.color), ['white', 'amber'])
})

test('the night light page reads back the end of a manual amber pulse', async (t) => {
  let refresh
  const original = setTimeout
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    if (ms >= 5000 && ms <= 6000) {
      refresh = callback
      return null
    }
    return original(callback, ms, ...args)
  })
  const { instance } = page('light', {
    getLightState: async () => ({ enabled: false, confirmed: true, mode: 'bedtime-breathe', brightness: 15 }),
    updateLight: async () => ({ enabled: true, confirmed: true, mode: 'bedtime-breathe', brightness: 15 }),
  }, 'real')
  instance.data.controlAvailable = true
  instance.data.light = { mode: 'bedtime-breathe', brightness: 15 }
  await instance.setMode({ currentTarget: { dataset: { mode: 'bedtime-breathe' } } })
  assert.equal(instance.data.light.enabled, true)
  assert.equal(typeof refresh, 'function')
  await refresh()
  assert.equal(instance.data.light.enabled, false)
})

test('incomplete self-check can open the bound device without recording a successful setup', async () => {
  const { instance, routes, storage } = page('calibration', {
    runCalibration: async () => ({ ready: false, canViewDevice: true, checks: [
      { id: 'microphones', ready: false }, { id: 'radar', required: false, ready: false },
    ] }),
  })
  await instance.run()
  assert.equal(instance.data.phase, 'failed')
  assert.deepEqual(Array.from(instance.data.failedChecks, item => item.id), ['microphones'])
  instance.viewDevice()
  assert.deepEqual(routes, ['/pages/device/index'])
  assert.equal(storage.has('haomian-setup-complete'), false)
  assert.equal(storage.has('haomian-calibration-success'), false)
})

test('bench confirmation rechecks the same device and opens home without saving automatic calibration', async () => {
  const result = { deviceId: 'sample-a', ready: false, canConfirmPad: true,
    checks: [{ id: 'pad', ready: false }] }
  let current = result
  const { instance, routes, storage } = page('calibration', { runCalibration: async () => current }, 'real')
  await instance.run()
  assert.equal(instance.data.phase, 'failed')
  assert.deepEqual(routes, [])
  current = { ...result, deviceId: 'sample-b' }
  await instance.confirmPad()
  assert.deepEqual(routes, [])
  current = result
  await instance.run()
  await instance.confirmPad()
  assert.deepEqual(routes, ['/pages/home/index'])
  assert.equal(storage.has('haomian-calibration-success'), false)
  assert.equal(storage.has('haomian-setup-complete'), false)
})

test('device details re-read Wi-Fi over an existing Bluetooth connection separately from cloud status', async () => {
  let bleConnected = true
  let reads = 0
  let wifi = { supported: true, configured: true, connected: true, ssid: 'Bench', ip: '192.0.2.5' }
  const { instance, routes } = page('device', {
    getStatus: async () => ({ bound: true, cloudOnline: false, ble: { connected: bleConnected } }),
    getWifiStatus: async () => { reads++; return wifi },
    getFirmwareVersion: async () => '1.0.4-dev.1019',
  }, 'real')
  await instance.load()
  assert.equal(instance.data.wifiStatus.ip, '192.0.2.5')
  assert.equal(instance.data.localFirmwareVersion, '1.0.4-dev.1019')
  assert.equal(instance.data.status.cloudOnline, false)
  wifi = { supported: true, configured: true, connected: false, ssid: 'Bench' }
  await instance.load()
  assert.equal(instance.data.wifiStatus.configured, true)
  assert.equal(instance.data.wifiStatus.connected, false)
  bleConnected = false
  await instance.load()
  assert.equal(reads, 2)
  assert.equal(instance.data.wifiStatus, null)
  assert.equal(instance.data.localFirmwareVersion, '')
  instance.openCalibration()
  assert.deepEqual(routes, ['/pages/calibration/index'])
})

test('successful Wi-Fi setup enters home or returns to device details without recording calibration', () => {
  const initial = page('setup', {}, 'real')
  initial.instance.finish()
  assert.deepEqual(initial.routes, [])
  initial.instance.data.machine = { step: 'success' }
  initial.instance.finish()
  assert.deepEqual(initial.routes, ['/pages/home/index'])
  assert.equal(initial.storage.get('haomian-setup-complete'), true)
  assert.equal(initial.storage.has('haomian-calibration-success'), false)
  const repeat = page('setup', {}, 'real')
  repeat.instance.data.machine = { step: 'success' }
  repeat.instance.data.returnToDevice = true
  repeat.instance.finish()
  assert.deepEqual(repeat.routes, ['back'])
  assert.equal(repeat.storage.has('haomian-calibration-success'), false)
})

test('stop page waits for confirmed service result and never toasts success on failure', async () => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const { instance, toasts } = page('device', { stopAllOutputs: () => pending, getStatus: async () => ({}) })
  const task = instance.safetyAction({ currentTarget: { dataset: { kind: 'stop' } } })
  assert.equal(toasts.length, 0)
  assert.equal(instance.data.safetyBusy, true)
  resolve({ confirmed: true, stopLatched: true })
  await task
  assert.equal(toasts[0].title, '驱动停止已确认')
  const failed = page('device', { stopAllOutputs: async () => { throw new Error('offline') } })
  await failed.instance.safetyAction({ currentTarget: { dataset: { kind: 'stop' } } })
  assert.equal(failed.toasts.length, 0)
  assert.match(failed.instance.data.safetyError, /未确认/)
})

test('sound page keeps last known output until readback and retains sync-pending result', async () => {
  let resolve
  const { instance } = page('sound', { updateSound: () => new Promise(done => { resolve = done }) })
  const previous = { playing: false, volume: 0, scene: 'sleep' }
  Object.assign(instance.data, { sound: previous, controlAvailable: true })
  instance.preparePreviewSource = () => {}
  const task = instance.send({ playing: true })
  assert.equal(instance.data.sound.playing, false)
  resolve({ playing: true, volume: 20, confirmed: true, syncPending: true })
  await task
  assert.equal(instance.data.sound.playing, true)
  assert.equal(instance.data.sound.syncPending, true)
})

test('sound control only offers manual stop with the current BLE firmware', async () => {
  let writes = 0
  const { instance } = page('sound', {
    getSoundState: async () => ({ source: 'ble-driver', timer: 'all-night', volume: 25 }),
    getStatus: async () => ({ ble: { connected: true }, controlAvailable: true, controlTransport: 'ble' }),
    updateSound: async () => { writes++; return {} },
  }, 'real')
  await instance.load()
  assert.equal(instance.data.manualStopOnly, true)
  await instance.setTimer({ currentTarget: { dataset: { timer: 15 } } })
  assert.equal(writes, 0)
})

test('phone preview adjusts volume without sending a device command', () => {
  const { instance } = page('sound', {})
  instance.data.controlAvailable = false
  instance._previewAudio = { volume: 0.25 }
  instance.setVolume({ detail: { value: 63 } })
  assert.equal(instance.data.volumeDraft, 63)
  assert.equal(instance._previewAudio.volume, 0.63)
})

test('the profile can explicitly restore manual control without opening device details', async () => {
  let calls = 0
  const { instance, routes, toasts } = page('profile', {
    resumeManualControl: async () => { calls++; return { stopLatched: false, active: false } },
  }, 'real')
  instance.load = async () => {}
  instance.data.status = { ble: { connected: true }, safety: { available: true, stopLatched: true } }
  await instance.resumeManualControl()
  assert.equal(calls, 1)
  assert.deepEqual(routes, [])
  assert.equal(toasts[0].title, '手动控制已恢复')
})
