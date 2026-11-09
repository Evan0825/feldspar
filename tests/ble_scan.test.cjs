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
  const ssid = '客厅网络'
  const encoded = Buffer.from(ssid, 'utf8').toString('base64')
  const writes = mockWx(['WIFIS,1', `WIFI,0,-45,1,${encoded}`, 'WIFISEND'], true)
  const result = await createWxBleBridge().scanWifiNetworks(deviceId)
  assert.equal(writes[0].bytes[0], 0x40)
  assert.equal(result[0].ssid, ssid)
})

test('current firmware WiFi status uses query 0x42, never forget 0x43', async () => {
  const writes = mockWx(['WIFI,CONNECTED,Bedroom,192.0.2.1'])
  const status = await createWxBleBridge().getWifiStatus(deviceId)
  assert.deepEqual(writes[0].bytes, [0x42])
  assert.equal(status.connected, true)
  assert.equal(status.ssid, 'Bedroom')
})

test('reads the current firmware version through OTA info without initiating an update', async () => {
  const writes = mockWx(['OTA,PROG,0,0', 'OTA,INFO,1.0.4-dev.1019,VALID,0,0'])
  assert.equal(await createWxBleBridge().getFirmwareVersion(deviceId), '1.0.4-dev.1019')
  assert.deepEqual(writes, [{ characteristic: 'FF01', bytes: [0x51] }])
})

test('default ATT MTU accepts an 18-byte legacy Wi-Fi configuration frame', async () => {
  const writes = mockWx(['WIFI,CONNECTED,Bench 1,192.0.2.1'])
  delete wx.setBLEMTU
  const result = await createWxBleBridge().provisionWifi({ deviceId, ssid: 'Bench 1', password: 'testpass' })
  assert.equal(result.connected, true)
  assert.equal(writes[0].bytes[0], 0x41)
  assert.equal(writes[0].bytes.length, 18)
})

test('reads the available single-write MTU when the phone cannot set it', async () => {
  const writes = mockWx(['WIFI,CONNECTED,Bench 1,192.0.2.1'])
  wx.setBLEMTU = o => o.fail({ errMsg: 'not supported' })
  wx.getBLEMTU = o => {
    assert.equal(o.writeType, 'writeNoResponse')
    o.success({ mtu: 35 })
  }
  const result = await createWxBleBridge().provisionWifi({ deviceId, ssid: 'Bench 1', password: 'bench-password' })
  assert.equal(result.connected, true)
  assert.equal(writes[0].bytes.length, 24)
})

test('legacy Wi-Fi still refuses frames above the default single-write limit', async () => {
  const writes = mockWx([])
  delete wx.setBLEMTU
  await assert.rejects(createWxBleBridge().provisionWifi({ deviceId, ssid: 'Bench 1', password: 'bench-password' }),
    { code: 'BLE_FRAME_TOO_LARGE' })
  assert.deepEqual(writes, [])
})

test('legacy Wi-Fi waits for the requested network after the old firmware reports a transient connect error', async () => {
  const writes = mockWx(['WIFI,CONNECTING,Bench 1', 'WIFI,ERR,connect', 'WIFI,ERR,12295',
    'WIFI,DISCONNECTED,Bench 1,8', 'WIFI,CONNECTED,Previous network,192.0.2.2',
    'WIFI,CONNECTED,Bench 1,192.0.2.1'])
  const result = await createWxBleBridge().provisionWifi({ deviceId, ssid: 'Bench 1', password: 'testpass' })
  assert.deepEqual(result, { connected: true, ssid: 'Bench 1', ip: '192.0.2.1' })
  assert.deepEqual(writes.map(write => write.bytes[0]), [0x41])
})

test('legacy Wi-Fi still rejects a malformed provisioning request immediately', async () => {
  mockWx(['WIFI,ERR,badlen'])
  await assert.rejects(createWxBleBridge().provisionWifi({ deviceId, ssid: 'Bench 1', password: 'testpass' }),
    { code: 'WIFI_INVALID_DATA' })
})

test('legacy Wi-Fi times out with the last disconnect reason when the target never gets an IP', async (t) => {
  mockWx(['WIFI,ERR,12295', 'WIFI,DISCONNECTED,Bench 1,201', 'WIFI,CONNECTED,Other network,192.0.2.1'])
  const realSetTimeout = global.setTimeout
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => realSetTimeout(callback, ms === 25000 ? 10 : ms, ...args))
  await assert.rejects(createWxBleBridge().provisionWifi({ deviceId, ssid: 'Bench 1', password: 'testpass' }),
    { code: 'WIFI_CONNECT_TIMEOUT', wifiReason: '201' })
})

test('legacy Wi-Fi state query ignores reconnect notices and reads the complete network name', async () => {
  mockWx(['WIFI,DISCONNECTED,Bench,1,8', 'WIFI,CONNECTED,Bench,1,192.0.2.1'])
  const status = await createWxBleBridge().getWifiStatus(deviceId)
  assert.equal(status.connected, true)
  assert.equal(status.ssid, 'Bench,1')
  assert.equal(status.ip, '192.0.2.1')
})

test('only undecodable AP records with nonempty scan count fail instead of showing empty success', async () => {
  mockWx(['WIFI,AP,bad,1,Name', 'WIFI,SCANEND,1'])
  await assert.rejects(createWxBleBridge().scanWifiNetworks(deviceId), { code: 'WIFI_SCAN_FAILED' })
})

function mockAndroidDiscovery() {
  mockWx([])
  const attempts = { scan: 0, authorize: 0 }
  Object.assign(wx, {
    getSystemInfoSync: () => ({ platform: 'android' }),
    getSystemSetting: () => ({ bluetoothEnabled: true, locationEnabled: true }),
    onBluetoothDeviceFound() {},
    offBluetoothDeviceFound() {},
    startBluetoothDevicesDiscovery(o) { attempts.scan++; o.success({}) },
    stopBluetoothDevicesDiscovery: o => o.success({}),
    getBluetoothDevices: o => o.success({ devices: [
      { deviceId: 'test-transport', localName: 'HAOMIAN-SLEEP_ABCDEF', RSSI: -42 },
    ] }),
    authorize(o) { attempts.authorize++; o.success({}) },
  })
  return attempts
}

test('Android continues with native BLE discovery if the settings callback times out', async () => {
  const attempts = mockAndroidDiscovery()
  wx.getSetting = () => {}
  const [device] = await createWxBleBridge().discover({ serialNumber: 'HAOMIAN-SLEEP_ABCDEF' })
  assert.equal(device.deviceId, deviceId)
  assert.deepEqual(attempts, { scan: 1, authorize: 0 })
})

test('Android does not scan after an explicit location denial', async () => {
  const attempts = mockAndroidDiscovery()
  wx.getSetting = o => o.success({ authSetting: { 'scope.userLocation': false } })
  await assert.rejects(createWxBleBridge().discover(), { code: 'BLUETOOTH_PERMISSION_DENIED' })
  assert.deepEqual(attempts, { scan: 0, authorize: 0 })
})

test('a native BLE permission denial still stops the scan after a settings timeout', async () => {
  const attempts = mockAndroidDiscovery()
  wx.getSetting = o => o.fail({ errCode: 10012, errMsg: 'getSetting:fail timeout' })
  wx.startBluetoothDevicesDiscovery = o => {
    attempts.scan++
    o.fail({ errMsg: 'startBluetoothDevicesDiscovery:fail permission denied' })
  }
  await assert.rejects(createWxBleBridge().discover(), { code: 'BLUETOOTH_PERMISSION_DENIED' })
  assert.deepEqual(attempts, { scan: 1, authorize: 0 })
})
