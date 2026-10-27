const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWxBleBridge } = require('../firmware/miniprogram-latest/services/real/ble-bridge')

const id = 'haomian_sleep_abcdef'
function setup(reply) {
  let notify
  const writes = []
  const ok = o => o.success({})
  global.wx = {
    getStorageSync: () => [{ deviceId: id, transportDeviceId: 'transport' }],
    onBLECharacteristicValueChange: f => { notify = f },
    openBluetoothAdapter: ok, createBLEConnection: ok,
    getBLEDeviceServices: o => o.success({ services: [{ uuid: 'FF00' }] }),
    getBLEDeviceCharacteristics: o => o.success({ characteristics: ['FF01','FF02','FF03','FF04'].map(uuid => ({ uuid })) }),
    notifyBLECharacteristicValueChange: ok, setBLEMTU: o => o.success({ mtu: 128 }),
    writeBLECharacteristicValue: o => {
      const bytes = [...new Uint8Array(o.value)]
      writes.push(bytes); o.success({})
      const token = bytes[1] | (bytes[2] << 8)
      queueMicrotask(() => {
        for (const line of reply(bytes[0], token)) notify({ deviceId: 'transport', characteristicId: 'FF04',
          value: Uint8Array.from(Buffer.from(line)).buffer })
      })
    },
  }
  return { bridge: createWxBleBridge(), writes }
}

test('safety requests ignore stale tokens and confirm actual readback', async () => {
  const { bridge, writes } = setup((cmd, token) => [
    'SAFETY,0,ok,HAPTIC,ok,0,0,0,0',
    `SAFETY,${token},ok,HAPTIC,stopped,0,0,0,1`,
  ])
  const status = await bridge.getSafetyState(id)
  assert.equal(status.stopLatched, true)
  assert.equal(status.physicalFeedback, false)
  assert.equal(writes[0][0], 0x24)
  const stopped = await bridge.stopAllOutputs(id)
  assert.equal(stopped.stopLatched, true)
  assert.equal(writes[1][0], 0x26)
  assert.notDeepEqual(writes[0].slice(1), writes[1].slice(1))
})

test('resume needs a cleared latch and stopping needs an inactive latched readback', async () => {
  let setupResult = setup((cmd, token) => [`SAFETY,${token},ok,HAPTIC,ok,0,0,0,0`])
  assert.equal((await setupResult.bridge.resumeManualControl(id)).stopLatched, false)
  await assert.rejects(setupResult.bridge.stopAllOutputs(id), { code: 'STOP_UNCONFIRMED' })
  setupResult = setup((cmd, token) => [`SAFETY,${token},error,HAPTIC,storage,0,0,0,1`])
  await assert.rejects(setupResult.bridge.resumeManualControl(id), { code: 'SAFETY_REJECTED' })
})
