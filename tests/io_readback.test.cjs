const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWxBleBridge } = require('../firmware/miniprogram-latest/services/real/ble-bridge')
const id = 'haomian_sleep_abcdef'

function setup({ mismatch=false, latched=false } = {}) {
  let notify
  const writes = []
  const state = { rgb: [0,0,0], volume: 0 }
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
      if (!mismatch && bytes[0] === 0x09) state.rgb = bytes.slice(1)
      if (!mismatch && bytes[0] === 0x07) state.volume = bytes[1]
      const lines = bytes[0] === 0x24 ? [`SAFETY,${token},ok,HAPTIC,ok,0,0,0,${latched?1:0}`]
        : bytes[0] === 0x27 ? [`IO,${token},${state.rgb.some(Boolean)?1:0},${state.rgb.join(',')},${state.volume},0,0`]
          : bytes[0] === 0x34 ? ['FILES,0','FILESEND']
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
