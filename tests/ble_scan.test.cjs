const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWxBleBridge } = require('../firmware/miniprogram-latest/services/real/ble-bridge')

const deviceId = 'haomian_sleep_abcdef'
function mockWx(messages, modern = false) {
  let notify
  const writes = []
  const ok = (o) => o.success({})
  global.wx = {
    getStorageSync: () => [{ deviceId, transportDeviceId: 'test-transport' }],
    onBLECharacteristicValueChange: (fn) => { notify = fn },
    openBluetoothAdapter: ok,
    createBLEConnection: ok,
    getBLEDeviceServices: (o) => o.success({ services: [{ uuid: 'FF00' }] }),
    getBLEDeviceCharacteristics: (o) => o.success({ characteristics:
      ['FF01', 'FF02', 'FF03', 'FF04', ...(modern ? ['FF05'] : [])].map(uuid => ({ uuid })) }),
    notifyBLECharacteristicValueChange: ok,
    setBLEMTU: (o) => o.success({ mtu: 128 }),
    writeBLECharacteristicValue: (o) => {
      writes.push({ characteristic: o.characteristicId, bytes: [...new Uint8Array(o.value)] })
      o.success({})
      queueMicrotask(() => {
        for (const line of messages) notify({ deviceId: 'test-transport', characteristicId: 'FF04',
          value: Uint8Array.from(Buffer.from(line)).buffer })
      })
    },
  }
  return writes
}

test('current firmware scans over FF01 0x44 without FF05; comma/UTF8 SSID and dedup', async () => {
  const writes = mockWx(['WIFI,SCANNING', 'WIFI,AP,-65,1,卧室,WiFi',
    'WIFI,AP,-40,1,卧室,WiFi', 'WIFI,AP,-80,0,Guest', 'WIFI,SCANEND,3'])
  const bridge = createWxBleBridge()
  const networks = await bridge.scanWifiNetworks(deviceId)
  assert.deepEqual(writes, [{ characteristic: 'FF01', bytes: [0x44] }])
  assert.deepEqual(networks.map(n => [n.ssid, n.rssi, n.secure]),
    [['卧室,WiFi', -40, true], ['Guest', -80, false]])
  assert.equal(bridge.getStatus(deviceId).wifiProvisionSupported, true)
  assert.equal(bridge.getStatus(deviceId).protocolVersion, '1.0')
  assert.equal((await bridge.confirmBinding({ deviceId })).protocolVersion, '1.0')
})

test('empty scan succeeds and scan failure is reported', async () => {
  mockWx(['WIFI,SCANEND,0'])
  assert.deepEqual(await createWxBleBridge().scanWifiNetworks(deviceId), [])
  mockWx(['WIFI,SCANERR'])
  await assert.rejects(createWxBleBridge().scanWifiNetworks(deviceId), { code: 'WIFI_SCAN_FAILED' })
})

test('future FF05 protocol retains 0x40/base64 scan behavior', async () => {
  const writes = mockWx(['WIFIS,1', 'WIFI,0,-45,1,TmV0', 'WIFISEND'], true)
  const result = await createWxBleBridge().scanWifiNetworks(deviceId)
  assert.equal(writes[0].bytes[0], 0x40)
  assert.equal(result[0].ssid, 'Net')
})

test('current firmware WiFi status uses query 0x42, never forget 0x43', async () => {
  const writes = mockWx(['WIFI,CONNECTED,Bedroom,192.0.2.1'])
  const status = await createWxBleBridge().getWifiStatus(deviceId)
  assert.deepEqual(writes[0].bytes, [0x42])
  assert.equal(status.connected, true)
  assert.equal(status.ssid, 'Bedroom')
})

test('only undecodable AP records with nonempty scan count fail instead of showing empty success', async () => {
  mockWx(['WIFI,AP,bad,1,Name', 'WIFI,SCANEND,1'])
  await assert.rejects(createWxBleBridge().scanWifiNetworks(deviceId), { code: 'WIFI_SCAN_FAILED' })
})
