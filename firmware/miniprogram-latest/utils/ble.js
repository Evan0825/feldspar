const BLE_PROTOCOL = Object.freeze({
  version: '1.1',
  namePrefix: 'HAOMIAN-SLEEP_',
  service: 'FF00',
  control: 'FF01',
  audio: 'FF02',
  status: 'FF03',
  data: 'FF04',
  provision: 'FF05',
  requestedMtu: 512,
  fallbackMtu: 20,
})

const LIGHT_COLOR_PRESETS = Object.freeze({
  amber: Object.freeze({
    name: 'amber',
    label: '暖琥珀',
    colorTemperatureKelvin: 2200,
    r: 255,
    g: 132,
    b: 34,
  }),
})

const COMMANDS = Object.freeze({
  LIGHT_LEVEL: 0x01,   // 白光亮度：[level 0-100]，0=关灯
  LIGHT_RGB: 0x09,     // RGB 灯带颜色：[r,g,b 各 0-100]，全 0=关灯（固件 lighting_set_rgb）
  MOTOR_SPEED: 0x02,
  MOTOR_STOP: 0x03,
  SAFETY_STATE: 0x24,
  SAFETY_RESUME: 0x25,
  STOP_ALL: 0x26,
  IO_STATE: 0x27,
  AUDIO_PLAY: 0x04,
  AUDIO_PAUSE: 0x05,
  AUDIO_STOP: 0x06,
  AUDIO_VOLUME: 0x07,
  AUDIO_TEST: 0x08,
  MIC_DIAG: 0x20,      // 麦克风诊断：[1=开始/0=停止]，每秒回 MIC,<rms>,<peak>
  SFX_BEGIN: 0x30,
  SFX_END: 0x31,
  SFX_PLAY: 0x32,
  SFX_DELETE: 0x33,
  SFX_LIST: 0x34,
  SFX_AUTO: 0x35,
  // —— 安全配网（0xFF05 特征，未来固件）——
  WIFI_SCAN: 0x40,
  WIFI_PROVISION_BEGIN: 0x41,
  WIFI_PROVISION_COMMIT: 0x42,
  WIFI_STATUS: 0x43,
  // —— 当前量产固件（components/ble/ble_protocol.h）：WiFi 走 0xFF01 控制特征 ——
  // 0x41 WIFI_CONFIG [ssidLen][ssid UTF-8][pwdLen][pwd UTF-8]，结果经 0xFF04 回 WIFI,...
  WIFI_CONFIG: 0x41,
  WIFI_STATE: 0x42,   // 查询状态，即时回 WIFI,OFF / WIFI,IDLE,<ssid> / WIFI,CONNECTED,<ssid>,<ip>
  WIFI_FORGET: 0x43,  // 清除凭据并断开，回 WIFI,FORGOT
  WIFI_SCAN_SIMPLE: 0x44, // 当前固件扫描，回 WIFI,AP,... / WIFI,SCANEND,n
})

function protocolError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function compactUuid(value) {
  return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase()
}

function uuidMatches(value, shortUuid) {
  const actual = compactUuid(value)
  const expected = compactUuid(shortUuid)
  if (!actual || !expected) return false
  return actual === expected
    || actual.startsWith(`0000${expected}`)
    || actual.endsWith(expected)
}

function clampByte(value, min = 0, max = 100) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw protocolError('INVALID_PARAMETER', '控制参数必须是数字')
  return Math.max(min, Math.min(max, Math.round(number)))
}

function resolveLightColor(value) {
  const requested = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[_\s]+/g, '-')
    : value && typeof value.color === 'string'
      ? value.color.trim().toLowerCase().replace(/[_\s]+/g, '-')
      : 'amber'
  const preset = LIGHT_COLOR_PRESETS[requested] || LIGHT_COLOR_PRESETS.amber
  return { ...preset }
}

function buildControlCommand(command, params = []) {
  const bytes = new Uint8Array(1 + params.length)
  bytes[0] = command & 0xff
  params.forEach((value, index) => { bytes[index + 1] = value & 0xff })
  return bytes
}

/* RGB 灯带命令（固件 0x09）：r/g/b 各 0-100，全 0 视为关灯。
 * 注意：固件 0x01 只识别 params[0] 一个白光亮度字节，多余字节会被忽略，
 * 彩色必须走 0x09。 */
function buildLightRgbCommand(r, g, b) {
  return buildControlCommand(COMMANDS.LIGHT_RGB, [
    clampByte(r),
    clampByte(g),
    clampByte(b),
  ])
}

/* 当前量产固件的 WiFi 直配命令（0x41，走 0xFF01 控制特征）：
 *   [0x41][ssidLen][ssid UTF-8..][pwdLen][pwd UTF-8..]
 * 设备连接结果经 0xFF04 异步上报 WIFI,CONNECTING/CONNECTED/ERR,... */
function buildWifiConfigCommand(ssid, password = '') {
  const ssidBytes = encodeUtf8(String(ssid || '').trim())
  const passwordBytes = encodeUtf8(String(password || ''))
  if (!ssidBytes.length || ssidBytes.length > 32) {
    throw protocolError('INVALID_WIFI_SSID', 'Wi-Fi 名称必须为 1-32 字节')
  }
  if (passwordBytes.length > 63) {
    throw protocolError('INVALID_WIFI_PASSWORD', 'Wi-Fi 密码不能超过 63 字节')
  }
  const bytes = new Uint8Array(2 + ssidBytes.length + 1 + passwordBytes.length)
  bytes[0] = COMMANDS.WIFI_CONFIG
  bytes[1] = ssidBytes.length
  bytes.set(ssidBytes, 2)
  bytes[2 + ssidBytes.length] = passwordBytes.length
  bytes.set(passwordBytes, 3 + ssidBytes.length)
  return bytes
}

function buildMotorCommand(speed) {
  const normalized = clampByte(speed, -100, 100)
  return buildControlCommand(COMMANDS.MOTOR_SPEED, [normalized & 0xff])
}

function buildVolumeCommand(volume) {
  return buildControlCommand(COMMANDS.AUDIO_VOLUME, [clampByte(volume)])
}

function buildSfxBeginCommand(name, size, format = 1) {
  if (!/^[0-9A-Za-z_-]{1,24}$/.test(name || '')) {
    throw protocolError('INVALID_SFX_NAME', '音效名称仅支持 1-24 位字母、数字、下划线或连字符')
  }
  const nameBytes = asciiBytes(name)
  const total = Number(size)
  if (!Number.isInteger(total) || total <= 0 || total > 0xffffffff) {
    throw protocolError('INVALID_SFX_SIZE', '音效文件长度无效')
  }
  if (![0, 1].includes(format)) throw protocolError('INVALID_SFX_FORMAT', '音效格式无效')
  const bytes = new Uint8Array(7 + nameBytes.length)
  const view = new DataView(bytes.buffer)
  bytes[0] = COMMANDS.SFX_BEGIN
  bytes[1] = nameBytes.length
  bytes.set(nameBytes, 2)
  view.setUint32(2 + nameBytes.length, total, true)
  bytes[6 + nameBytes.length] = format
  return bytes
}

function buildSfxEndCommand(crc32) {
  const bytes = new Uint8Array(5)
  const view = new DataView(bytes.buffer)
  bytes[0] = COMMANDS.SFX_END
  view.setUint32(1, Number(crc32) >>> 0, true)
  return bytes
}

function buildWifiProvisionBeginCommand(size, crc32) {
  const total = Number(size)
  if (!Number.isInteger(total) || total < 5 || total > 255) {
    throw protocolError('INVALID_WIFI_DATA', 'Wi-Fi 配网数据长度无效')
  }
  const bytes = new Uint8Array(7)
  const view = new DataView(bytes.buffer)
  bytes[0] = COMMANDS.WIFI_PROVISION_BEGIN
  view.setUint16(1, total, true)
  view.setUint32(3, Number(crc32) >>> 0, true)
  return bytes
}

function encodeUtf8(value) {
  const text = unescape(encodeURIComponent(String(value || '')))
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index)
  return bytes
}

function decodeUtf8(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  try {
    return decodeURIComponent(escape(text))
  } catch {
    return text
  }
}

function encodeBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0789+/'
  let output = ''
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]
    const b = offset + 1 < bytes.length ? bytes[offset + 1] : 0
    const c = offset + 2 < bytes.length ? bytes[offset + 2] : 0
    const value24 = (a << 16) | (b << 8) | c
    output += alphabet[(value24 >>> 18) & 63]
    output += alphabet[(value24 >>> 12) & 63]
    output += offset + 1 < bytes.length ? alphabet[(value24 >>> 6) & 63] : '='
    output += offset + 2 < bytes.length ? alphabet[value24 & 63] : '='
  }
  return output
}

function decodeBase64(value) {
  const text = String(value || '').replace(/\s/g, '')
  if (!text || text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text)) {
    throw protocolError('INVALID_WIFI_DATA', 'Wi-Fi 名称编码无效')
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0789+/'
  const output = []
  for (let offset = 0; offset < text.length; offset += 4) {
    const a = alphabet.indexOf(text[offset])
    const b = alphabet.indexOf(text[offset + 1])
    const c = text[offset + 2] === '=' ? 0 : alphabet.indexOf(text[offset + 2])
    const d = text[offset + 3] === '=' ? 0 : alphabet.indexOf(text[offset + 3])
    if (a < 0 || b < 0 || c < 0 || d < 0) throw protocolError('INVALID_WIFI_DATA', 'Wi-Fi 名称编码无效')
    const value24 = (a << 18) | (b << 12) | (c << 6) | d
    output.push((value24 >>> 16) & 0xff)
    if (text[offset + 2] !== '=') output.push((value24 >>> 8) & 0xff)
    if (text[offset + 3] !== '=') output.push(value24 & 0xff)
  }
  return Uint8Array.from(output)
}

function buildWifiProvisionPayload({ ssid, password = '', deviceKey = '' } = {}) {
  const ssidText = String(ssid || '').trim()
  const passwordText = String(password || '')
  const keyText = String(deviceKey || '')
  if ([ssidText, passwordText, keyText].some((value) => value.includes('\0'))) {
    throw protocolError('INVALID_WIFI_DATA', 'Wi-Fi 配网数据不能包含空字符')
  }
  const ssidBytes = encodeUtf8(ssidText)
  const passwordBytes = encodeUtf8(passwordText)
  const keyBytes = encodeUtf8(keyText)
  if (!ssidBytes.length || ssidBytes.length > 32) {
    throw protocolError('INVALID_WIFI_SSID', 'Wi-Fi 名称必须为 1-32 字节')
  }
  if (passwordBytes.length > 63) {
    throw protocolError('INVALID_WIFI_PASSWORD', 'Wi-Fi 密码不能超过 63 字节')
  }
  if (keyBytes.length > 96) {
    throw protocolError('INVALID_DEVICE_KEY', '设备凭据长度无效')
  }
  const bytes = new Uint8Array(4 + ssidBytes.length + passwordBytes.length + keyBytes.length)
  bytes.set([1, ssidBytes.length, passwordBytes.length, keyBytes.length], 0)
  bytes.set(ssidBytes, 4)
  bytes.set(passwordBytes, 4 + ssidBytes.length)
  bytes.set(keyBytes, 4 + ssidBytes.length + passwordBytes.length)
  return bytes
}

function asciiBytes(value) {
  const text = String(value || '')
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0x7f
  return bytes
}

function decodeText(value) {
  return decodeUtf8(value)
}

function parseNotification(value) {
  const raw = decodeText(value).replace(/\0+$/g, '').trim()
  const fields = raw ? raw.split(',') : []
  return {
    raw,
    type: String(fields[0] || '').toUpperCase(),
    fields: fields.slice(1),
  }
}

function advertisedNameFromData(value) {
  if (!value) return ''
  let bytes
  try {
    bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  } catch {
    return ''
  }
  for (let offset = 0; offset < bytes.length;) {
    const fieldLength = bytes[offset]
    if (!fieldLength || offset + fieldLength >= bytes.length) break
    const type = bytes[offset + 1]
    if ((type === 0x08 || type === 0x09) && fieldLength > 1) {
      return decodeUtf8(bytes.slice(offset + 2, offset + 1 + fieldLength)).replace(/\0+$/g, '').trim()
    }
    offset += fieldLength + 1
  }
  return ''
}

function parseAdvertisement(device, prefix = BLE_PROTOCOL.namePrefix) {
  const expectedPrefix = String(prefix || BLE_PROTOCOL.namePrefix).toUpperCase()
  const candidateNames = [
    device && device.localName,
    device && device.name,
    advertisedNameFromData(device && device.advertisData),
  ].map((value) => String(value || '').trim()).filter(Boolean)
  const rawName = candidateNames.find((value) => value.toUpperCase().startsWith(expectedPrefix))
    || candidateNames[0]
    || ''
  const upperName = rawName.toUpperCase()
  if (!upperName.startsWith(expectedPrefix)) return null
  const suffix = upperName.slice(expectedPrefix.length)
  if (!/^[0-9A-F]{6}$/.test(suffix)) return null
  return {
    deviceId: `haomian_sleep_${suffix.toLowerCase()}`,
    transportDeviceId: device.deviceId,
    serialNumber: `${expectedPrefix}${suffix}`,
    advertisedName: `${expectedPrefix}${suffix}`,
    name: '好眠睡眠主机',
    mode: 'ble-local',
    signal: '已发现',
    rssi: Number(device.RSSI || -100),
    provisioned: true,
    protocolVersion: BLE_PROTOCOL.version,
  }
}

module.exports = {
  BLE_PROTOCOL,
  COMMANDS,
  asciiBytes,
  advertisedNameFromData,
  buildControlCommand,
  buildLightRgbCommand,
  buildMotorCommand,
  buildSfxBeginCommand,
  buildSfxEndCommand,
  buildWifiConfigCommand,
  buildWifiProvisionBeginCommand,
  buildWifiProvisionPayload,
  buildVolumeCommand,
  clampByte,
  compactUuid,
  decodeText,
  decodeBase64,
  decodeUtf8,
  encodeBase64,
  encodeUtf8,
  parseAdvertisement,
  parseNotification,
  protocolError,
  resolveLightColor,
  uuidMatches,
}
