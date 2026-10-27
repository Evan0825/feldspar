const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { COMMANDS, buildWifiConfigCommand } = require('../firmware/miniprogram-latest/utils/ble')

test('active app command numbers match imported firmware header', () => {
  const header = fs.readFileSync(path.join(__dirname, '../firmware/components/ble/include/ble_protocol.h'), 'utf8')
  const pairs = { LIGHT_LEVEL: 'LIGHT_LEVEL', LIGHT_RGB: 'LIGHT_RGB', MOTOR_SPEED: 'MOTOR_SPEED',
    MOTOR_STOP: 'MOTOR_STOP', MIC_DIAG: 'MIC_DIAG', AUDIO_STOP: 'AUDIO_STOP',
    SAFETY_STATE: 'SAFETY_STATE', SAFETY_RESUME: 'SAFETY_RESUME', STOP_ALL: 'STOP_ALL',
    IO_STATE: 'IO_STATE',
    WIFI_CONFIG: 'WIFI_CONFIG', WIFI_STATE: 'WIFI_STATE', WIFI_FORGET: 'WIFI_FORGET',
    WIFI_SCAN_SIMPLE: 'WIFI_SCAN' }
  for (const [app, firmware] of Object.entries(pairs)) {
    const match = header.match(new RegExp(`BLE_CMD_${firmware}\\s*=\\s*(0x[0-9A-Fa-f]+)`))
    assert.ok(match, firmware)
    assert.equal(COMMANDS[app], Number(match[1]), app)
  }
})

test('WiFi config lengths are UTF8 bytes, with bounded SSID/password', () => {
  const bytes = buildWifiConfigCommand('卧室', 'test-only')
  assert.equal(bytes[0], 0x41)
  assert.equal(bytes[1], 6)
  assert.equal(Buffer.from(bytes.slice(2, 8)).toString(), '卧室')
  assert.equal(bytes[8], 9)
  assert.throws(() => buildWifiConfigCommand('a'.repeat(33)), { code: 'INVALID_WIFI_SSID' })
  assert.throws(() => buildWifiConfigCommand('ssid', 'a'.repeat(64)), { code: 'INVALID_WIFI_PASSWORD' })
})
