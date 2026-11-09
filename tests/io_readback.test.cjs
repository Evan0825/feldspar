const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWxBleBridge } = require('../firmware/miniprogram-latest/services/real/ble-bridge')
const id = 'haomian_sleep_abcdef'

function setup({ mismatch=false, latched=false, effects=false, timers=false } = {}) {
  let notify
  const writes = []
  const state = { rgb: [0,0,0], volume: 0, effect: 0, index: 0, timer: 0 }
  const ok = o => o.success({})
  global.wx = {
    getStorageSync: () => [{ deviceId: id, transportDeviceId: 'transport' }],
    onBLECharacteristicValueChange: callback => { notify = callback },
    openBluetoothAdapter: ok, createBLEConnection: ok,
    getBLEDeviceServices: o => o.success({ services: [{ uuid: 'FF00' }] }),
    getBLEDeviceCharacteristics: o => o.success({ characteristics: ['FF01','FF02','FF03','FF04'].map(uuid => ({ uuid })) }),
    notifyBLECharacteristicValueChange: ok, setBLEMTU: o => o.success({ mtu: 128 }),
    writeBLECharacteristicValue: o => {
      const bytes = [...new Uint8Array(o.value)]
      writes.push(bytes); o.success({})
      const token = bytes[1] | bytes[2]<<8
      if (!mismatch && (bytes[0] === 0x09 || bytes[0] === 0x0b && effects)) {
        state.rgb = bytes.slice(1)
        state.effect = bytes[0] === 0x0b ? 1 : 0
      }
      if (!mismatch && bytes[0] === 0x07) state.volume = bytes[1]
      if (!mismatch && timers && bytes[0] === 0x32) { state.index = bytes[1]; state.timer = bytes[2] || 0 }
      if (!mismatch && timers && bytes[0] === 0x36 && state.index) state.timer = bytes[1]
      if (!mismatch && bytes[0] === 0x06) { state.index = 0; state.timer = 0 }
      const extended = (effects || timers) && bytes[3] === 1 ? ',' + state.effect : ''
      const timerReadback = timers && bytes[4] === 1 ? `,${state.timer},${state.timer * 60}` : ''
      const lines = bytes[0] === 0x24 ? [`SAFETY,${token},ok,HAPTIC,ok,0,0,0,${latched?1:0}`]
        : bytes[0] === 0x27 ? [`IO,${token},${state.rgb.some(Boolean)?1:0},${state.rgb.join(',')},${state.volume},${state.index ? 1 : 0},${state.index}${extended}${timerReadback}`]
          : bytes[0] === 0x34 ? (timers ? ['FILES,1', 'FILE,1,sleep,100,0','FILESEND'] : ['FILES,0','FILESEND'])
            : bytes[0] === 0x32 ? [`PLAYCMD,${bytes[1]}`] : []
      queueMicrotask(() => lines.forEach(line => notify({ deviceId: 'transport', characteristicId: 'FF04',
        value: Uint8Array.from(Buffer.from(line)).buffer })))
    },
  }
  return { bridge: createWxBleBridge(), writes }
}

test('light command respects the control range and requires matching IO readback', async () => {
  const { bridge, writes } = setup()
  const desired = { enabled: true, mode: 'night-low', color: 'amber', brightness: 40 }
  const result = await bridge.applyLight(id, desired, { enabled: true, brightness: 40 })
  assert.deepEqual(writes.find(bytes => bytes[0] === 0x09), [0x09,40,21,5])
  assert.equal(result.confirmed, true)
  await assert.rejects(setup({ mismatch: true }).bridge.applyLight(id, desired, { enabled: true }), { code: 'READBACK_MISMATCH' })
  await assert.rejects(setup({ latched: true }).bridge.applyLight(id, desired, { enabled: true }), { code: 'DEVICE_STOPPED' })
})

test('bedtime breathing requires device support and a matching effect readback', async () => {
  const desired = { enabled: true, mode: 'bedtime-breathe', color: 'amber', brightness: 40 }
  const { bridge, writes } = setup({ effects: true })
  const result = await bridge.applyLight(id, desired, { enabled: true, mode: desired.mode })
  assert.deepEqual(writes.find(bytes => bytes[0] === 0x0b), [0x0b,40,21,5])
  assert.equal(result.readback.light.mode, 'bedtime-breathe')
  const off = await bridge.applyLight(id, { ...desired, enabled: false }, { enabled: false })
  assert.equal(off.readback.light.enabled, false)
  assert.equal(off.readback.light.mode, 'night-low')
  const legacy = setup()
  await assert.rejects(legacy.bridge.applyLight(id, desired, { enabled: true }), { code: 'CONTROL_UNSUPPORTED' })
  assert.equal(legacy.writes.some(bytes => bytes[0] === 0x0b), false)
  await assert.rejects(setup({ effects: true, latched: true }).bridge.applyLight(id, desired, { enabled: true }), { code: 'DEVICE_STOPPED' })
})

test('white illumination sends equal RGB channels and confirms steady mode', async () => {
  const { bridge, writes } = setup({ effects: true })
  const desired = { enabled: true, mode: 'night-low', color: 'white', brightness: 100 }
  const result = await bridge.applyLight(id, desired, { enabled: true, mode: desired.mode })
  assert.deepEqual(writes.find(bytes => bytes[0] === 0x09), [0x09,100,100,100])
  assert.equal(result.readback.light.mode, 'night-low')
})

test('sound volume needs readback; unsupported timer or missing scene is not success', async () => {
  let { bridge } = setup()
  const current = { playing: false, timer: 'all-night', scene: 'sleep', volume: 0 }
  assert.equal((await bridge.applySound(id, current, { ...current, volume: 60 }, { volume: 60 })).confirmed, true)
  bridge = setup({ mismatch: true }).bridge
  await assert.rejects(bridge.applySound(id, current, { ...current, volume: 60 }, { volume: 60 }), { code: 'READBACK_MISMATCH' })
  bridge = setup().bridge
  await assert.rejects(bridge.applySound(id, current, { ...current, timer: 30 }, { timer: 30 }), { code: 'CONTROL_UNSUPPORTED' })
  const missing = setup()
  await assert.rejects(missing.bridge.applySound(id, current, { ...current, playing: true }, { playing: true }), { code: 'SCENE_NOT_AVAILABLE' })
  assert.equal(missing.writes.some(bytes => bytes[0] === 0x32), false)
  assert.equal(missing.writes.some(bytes => bytes[0] === 0x07), false)
})

test('sound timer is part of device playback, can be changed live and cancels on stop', async () => {
  const { bridge, writes } = setup({ timers: true })
  const current = (await bridge.getIoState(id)).sound
  assert.equal(current.timerSupported, true)
  const timed = { ...current, scene: 'sleep', timer: 15, playing: true }
  const started = (await bridge.applySound(id, current, timed, { playing: true, timer: 15 })).readback.sound
  assert.deepEqual(writes.find(bytes => bytes[0] === 0x32), [0x32,1,15])
  assert.equal(started.timerRemainingSeconds, 900)
  const adjusted = (await bridge.applySound(id, started, { ...timed, timer: 30 }, { timer: 30 })).readback.sound
  assert.deepEqual(writes.find(bytes => bytes[0] === 0x36), [0x36,30])
  assert.equal(adjusted.timerRemainingSeconds, 1800)
  const stopped = (await bridge.applySound(id, adjusted, timed, { playing: false })).readback.sound
  assert.equal(stopped.playing, false)
  assert.equal(stopped.timerRemainingSeconds, 0)
})
