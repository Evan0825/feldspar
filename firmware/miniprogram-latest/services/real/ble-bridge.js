const {
  BLE_PROTOCOL,
  COMMANDS,
  buildControlCommand,
  buildLightRgbCommand,
  buildMotorCommand,
  buildSfxBeginCommand,
  buildSfxEndCommand,
  buildWifiConfigCommand,
  buildWifiProvisionBeginCommand,
  buildWifiProvisionPayload,
  buildVolumeCommand,
  decodeBase64,
  decodeUtf8,
  parseAdvertisement,
  parseNotification,
  resolveLightColor,
  uuidMatches,
} = require('../../utils/ble')
const { crc32Ieee, prepareWavUpload, splitDataFrames } = require('../../utils/sfx')
const { parseSafetyReply, parseIoReply } = require('../../domain/safety-state')

const DEFAULT_TIMEOUT = 8000
const RESPONSE_TIMEOUT = 3000
const KNOWN_DEVICE_KEY = 'haomian-ble-devices-v1'
/* 场景 → 设备音效文件名关键词（小写包含匹配，不含内置 test）。
 * 固件音效序号按上传顺序分配（test.sfx 内置且最先存在），不能写死序号；
 * 匹配不到时下发 index=0 由设备按预设规则轮播。 */
const SCENE_KEYWORDS = Object.freeze({
  sleep: ['sleep', '睡眠', '深睡', '白噪', '安眠', '助眠'],
  healing: ['heal', '疗愈', '愈疗', '雨', 'rain', '放松', '冥想'],
  work: ['work', '专注', '工作', 'focus', '办公'],
  reading: ['read', '阅读', '读书', '看书'],
})

function matchSfxIndex(files, scene) {
  const keywords = SCENE_KEYWORDS[scene] || []
  if (!keywords.length) return 0
  const hit = (files || []).find((file) => {
    const name = String(file && file.name || '').toLowerCase()
    if (!name || name === 'test') return false
    return keywords.some((keyword) => name.includes(keyword.toLowerCase()))
  })
  return hit ? hit.index : 0
}

function bridgeError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function callWx(name, options = {}, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const method = typeof wx !== 'undefined' && wx[name]
    if (typeof method !== 'function') {
      reject(bridgeError('BLUETOOTH_UNAVAILABLE', `微信接口 ${name} 不可用`))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(bridgeError('PROVISION_TIMEOUT', `${name} 超时`))
    }, timeout)
    method.call(wx, {
      ...options,
      success(result) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result || {})
      },
      fail(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const message = String(error && error.errMsg || '')
        const numericCode = String(error && error.errCode || '')
        let code = 'CONNECT_FAILED'
        if (/location.*(off|disabled)|定位.*关闭/i.test(message)) code = 'LOCATION_DISABLED'
        else if (/permission.*denied|not authorized|unauthorized|权限.*(拒绝|未授予)/i.test(message)) code = 'BLUETOOTH_PERMISSION_DENIED'
        else if (numericCode === '10001' || /adapter|bluetooth.*off/i.test(message)) code = 'BLUETOOTH_DISABLED'
        else if (numericCode === '10002' || /no device/i.test(message)) code = 'NOT_FOUND'
        else if (/insufficient.*(auth|encrypt)|authentication|encryption|pairing/i.test(message)) code = 'WIFI_BLE_SECURITY_REQUIRED'
        else if (numericCode === '10004' || numericCode === '10005') code = 'IDENTITY_MISMATCH'
        else if (numericCode === '10006' || /disconnect/i.test(message)) code = 'CONNECTION_LOST'
        else if (numericCode === '10012' || /timeout/i.test(message)) code = 'PROVISION_TIMEOUT'
        reject(bridgeError(code, message || `${name} 失败`))
      },
    })
  })
}

function loadKnownDevices() {
  try {
    const stored = wx.getStorageSync(KNOWN_DEVICE_KEY)
    if (!Array.isArray(stored)) return new Map()
    return new Map(stored
      .filter((item) => item && item.deviceId && item.transportDeviceId)
      .map((item) => [item.deviceId, item]))
  } catch {
    return new Map()
  }
}

function persistKnownDevices(knownDevices) {
  try {
    wx.setStorageSync(KNOWN_DEVICE_KEY, Array.from(knownDevices.values()).map((item) => ({
      deviceId: item.deviceId,
      transportDeviceId: item.transportDeviceId,
      serialNumber: item.serialNumber,
      advertisedName: item.advertisedName,
      protocolVersion: item.protocolVersion,
    })))
  } catch {
    // BLE remains usable for the current process even when local storage is unavailable.
  }
}

function arrayBufferOf(bytes) {
  const copy = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes)
  return copy.buffer
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createWxBleBridge(config = {}) {
  let safetyRequestId = 0
  const ids = {
    service: config.serviceUuid || BLE_PROTOCOL.service,
    control: config.controlCharacteristicUuid || config.writeCharacteristicUuid || BLE_PROTOCOL.control,
    audio: config.audioCharacteristicUuid || BLE_PROTOCOL.audio,
    status: config.statusCharacteristicUuid || BLE_PROTOCOL.status,
    data: config.dataCharacteristicUuid || config.notifyCharacteristicUuid || BLE_PROTOCOL.data,
    provision: config.provisionCharacteristicUuid || BLE_PROTOCOL.provision,
  }
  const namePrefix = String(config.namePrefix || BLE_PROTOCOL.namePrefix).toUpperCase()
  const knownDevices = loadKnownDevices()
  const connections = new Map()
  const connectionAttempts = new Map()
  // 设备主动上报事件订阅者（SFXSTART/SFXDONE/SFXERR/MIC/WIFI,... 及断连）
  const eventListeners = new Set()
  let listenersRegistered = false
  let adapterOpened = false

  function emitDeviceEvent(state, message) {
    for (const listener of Array.from(eventListeners)) {
      try {
        listener({
          deviceId: state.deviceId,
          transportDeviceId: state.transportDeviceId,
          serialNumber: state.serialNumber,
          message,
        })
      } catch {
        // 单个订阅者异常不影响 BLE 数据面
      }
    }
  }

  function registerListeners() {
    if (listenersRegistered) return
    if (typeof wx.onBLECharacteristicValueChange === 'function') {
      wx.onBLECharacteristicValueChange((event) => {
        const state = Array.from(connections.values())
          .find((item) => item.transportDeviceId === event.deviceId)
        if (!state) return
        const channel = uuidMatches(event.characteristicId, ids.status) ? 'status'
          : uuidMatches(event.characteristicId, ids.data) ? 'data'
            : ''
        if (!channel) return
        const message = { ...parseNotification(event.value), channel }
        state.lastMessage = message
        for (const listener of Array.from(state.messageListeners)) listener(message)
        emitDeviceEvent(state, message)
      })
    }
    if (typeof wx.onBLEConnectionStateChange === 'function') {
      wx.onBLEConnectionStateChange((event) => {
        const state = Array.from(connections.values())
          .find((item) => item.transportDeviceId === event.deviceId)
        if (!state) return
        state.connected = Boolean(event.connected)
        if (!state.connected) {
          const error = bridgeError('CONNECTION_LOST', '设备蓝牙连接已断开')
          for (const reject of Array.from(state.disconnectRejectors)) reject(error)
          state.disconnectRejectors.clear()
          emitDeviceEvent(state, {
            channel: 'connection',
            type: 'BLE_DISCONNECTED',
            fields: [],
            raw: '',
          })
        }
      })
    }
    if (typeof wx.onBluetoothAdapterStateChange === 'function') {
      wx.onBluetoothAdapterStateChange((event) => {
        adapterOpened = Boolean(event.available)
        if (adapterOpened) return
        const error = bridgeError('BLUETOOTH_DISABLED', '手机蓝牙已关闭')
        for (const state of connections.values()) {
          state.connected = false
          for (const reject of Array.from(state.disconnectRejectors)) reject(error)
          state.disconnectRejectors.clear()
        }
      })
    }
    listenersRegistered = true
  }

  async function openAdapter() {
    registerListeners()
    if (adapterOpened && typeof wx.getBluetoothAdapterState === 'function') {
      try {
        const state = await callWx('getBluetoothAdapterState', {}, 2000)
        if (state.available !== false) return
      } catch {
        // Re-open below so a stale adapter session can recover after app resume.
      }
      adapterOpened = false
    }
    if (adapterOpened) return
    await callWx('openBluetoothAdapter')
    adapterOpened = true
  }

  async function ensureScanPermission() {
    let platform = ''
    try {
      if (typeof wx.getSystemInfoSync === 'function') {
        platform = String(wx.getSystemInfoSync().platform || '').toLowerCase()
      }
      if (typeof wx.getSystemSetting === 'function') {
        const system = wx.getSystemSetting() || {}
        if (system.bluetoothEnabled === false) {
          throw bridgeError('BLUETOOTH_DISABLED', '手机蓝牙未开启')
        }
        if (platform === 'android' && system.locationEnabled === false) {
          throw bridgeError('LOCATION_DISABLED', '安卓系统定位服务未开启')
        }
      }
      if (typeof wx.getAppAuthorizeSetting === 'function') {
        const authorization = wx.getAppAuthorizeSetting() || {}
        if (authorization.bluetoothAuthorized === 'denied') {
          throw bridgeError('BLUETOOTH_PERMISSION_DENIED', '微信蓝牙权限已被拒绝')
        }
        if (platform === 'android' && authorization.locationAuthorized === 'denied') {
          throw bridgeError('BLUETOOTH_PERMISSION_DENIED', '微信定位权限已被拒绝')
        }
      }
    } catch (error) {
      if (error && error.code) throw error
    }
    if (platform !== 'android' || typeof wx.getSetting !== 'function' || typeof wx.authorize !== 'function') return
    const settings = await callWx('getSetting', {}, 2000)
    const locationPermission = settings.authSetting && settings.authSetting['scope.userLocation']
    if (locationPermission === false) {
      throw bridgeError('BLUETOOTH_PERMISSION_DENIED', '请在小程序设置中允许位置信息权限')
    }
    if (locationPermission === undefined) {
      try {
        await callWx('authorize', { scope: 'scope.userLocation' }, 5000)
      } catch {
        throw bridgeError('BLUETOOTH_PERMISSION_DENIED', '安卓蓝牙扫描需要位置信息权限')
      }
    }
  }

  async function discover({ serialNumber = '', timeout = 8000 } = {}) {
    await ensureScanPermission()
    await openAdapter()
    const expectedSerial = String(serialNumber || '').trim().toUpperCase()
    const found = new Map()
    let handler = null
    let refreshTimer = null
    let scanError = null
    let discoveryStarted = false
    try {
      await new Promise((resolve) => {
        let settleTimer = null
        let hardTimer = null
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(hardTimer)
          clearTimeout(settleTimer)
          clearInterval(refreshTimer)
          resolve()
        }
        const acceptDevices = (result) => {
          for (const raw of result.devices || []) {
            const item = parseAdvertisement(raw, namePrefix)
            if (!item || (expectedSerial && item.serialNumber !== expectedSerial)) continue
            found.set(item.deviceId, item)
            knownDevices.set(item.deviceId, item)
            if (expectedSerial) {
              if (discoveryStarted) finish()
            } else if (discoveryStarted) {
              clearTimeout(settleTimer)
              settleTimer = setTimeout(finish, 600)
            }
          }
        }
        handler = acceptDevices
        wx.onBluetoothDeviceFound(handler)
        callWx('startBluetoothDevicesDiscovery', {
          // The complete local name lives in Scan Response, so keep updates until
          // that packet arrives and deduplicate by stable device_id ourselves.
          allowDuplicatesKey: true,
          interval: 0,
          powerLevel: 'high',
        }).then(async () => {
          discoveryStarted = true
          if (finished) return
          const refresh = async () => {
            if (typeof wx.getBluetoothDevices === 'function') {
              try {
                acceptDevices(await callWx('getBluetoothDevices', {}, 2000))
              } catch {
                // Live discovery remains authoritative when cached enumeration fails.
              }
            }
            if (typeof wx.getConnectedBluetoothDevices === 'function') {
              try {
                acceptDevices(await callWx('getConnectedBluetoothDevices', {
                  services: [`0000${String(ids.service).toUpperCase()}-0000-1000-8000-00805F9B34FB`],
                }, 2000))
              } catch {
                // The target may be advertising rather than already connected.
              }
            }
          }
          await refresh()
          if (finished) return
          refreshTimer = setInterval(refresh, 750)
          hardTimer = setTimeout(
            finish,
            Math.max(2000, Math.min(Number(timeout) || 8000, 15000)),
          )
          if (found.size) settleTimer = setTimeout(finish, expectedSerial ? 0 : 600)
        }).catch((error) => {
          if (finished) return
          scanError = error
          clearInterval(refreshTimer)
          finish()
        })
      })
      if (scanError) throw scanError
    } finally {
      if (handler && typeof wx.offBluetoothDeviceFound === 'function') wx.offBluetoothDeviceFound(handler)
      if (discoveryStarted && typeof wx.stopBluetoothDevicesDiscovery === 'function') {
        try {
          await callWx('stopBluetoothDevicesDiscovery', {}, 2000)
        } catch (error) {
          if (error.code !== 'BLUETOOTH_DISABLED') throw error
        }
      }
    }
    persistKnownDevices(knownDevices)
    return Array.from(found.values()).sort((left, right) => right.rssi - left.rssi)
  }

  async function negotiateMtu(state) {
    state.mtu = BLE_PROTOCOL.fallbackMtu
    if (typeof wx.setBLEMTU !== 'function') return
    try {
      const result = await callWx('setBLEMTU', {
        deviceId: state.transportDeviceId,
        mtu: BLE_PROTOCOL.requestedMtu,
      }, 3000)
      if (Number(result.mtu) >= BLE_PROTOCOL.fallbackMtu) state.mtu = Number(result.mtu)
    } catch (error) {
      state.mtuNegotiationError = error.code || 'MTU_NEGOTIATION_FAILED'
      return
    }
    if (typeof wx.getBLEMTU !== 'function') return
    try {
      const result = await callWx('getBLEMTU', {
        deviceId: state.transportDeviceId,
        writeType: 'write',
      }, 2000)
      if (Number(result.mtu) >= BLE_PROTOCOL.fallbackMtu) state.mtu = Number(result.mtu)
    } catch (error) {
      state.mtuReadError = error.code || 'MTU_READ_FAILED'
    }
  }

  async function connectKnownDevice(deviceId, timeout = DEFAULT_TIMEOUT) {
    await openAdapter()
    const known = knownDevices.get(deviceId)
    if (!known || !known.transportDeviceId) {
      throw bridgeError('NOT_FOUND', '请重新搜索附近的好眠设备')
    }

    let linkCreated = false
    try {
      await callWx('createBLEConnection', {
        deviceId: known.transportDeviceId,
        timeout: Math.max(1000, Math.min(Number(timeout) || DEFAULT_TIMEOUT, DEFAULT_TIMEOUT)),
      })
      linkCreated = true
      const services = await callWx('getBLEDeviceServices', { deviceId: known.transportDeviceId })
      const service = (services.services || []).find((item) => uuidMatches(item.uuid, ids.service))
      if (!service) throw bridgeError('IDENTITY_MISMATCH', '设备未提供 0xFF00 好眠服务')

      const readCharacteristics = async () => callWx('getBLEDeviceCharacteristics', {
        deviceId: known.transportDeviceId,
        serviceId: service.uuid,
      })
      let characteristics = await readCharacteristics()
      // Android/微信 can return a cached list immediately after a firmware
      // update. Read it once more before declaring FF05 unavailable.
      const hasProvisionCharacteristic = (result) => (result.characteristics || [])
        .some((item) => uuidMatches(item.uuid || item.characteristicId, ids.provision))
      if (!hasProvisionCharacteristic(characteristics)) {
        await delay(180)
        characteristics = await readCharacteristics()
      }
      const findCharacteristic = (shortUuid) => (characteristics.characteristics || [])
        .find((item) => uuidMatches(item.uuid || item.characteristicId, shortUuid))
      const control = findCharacteristic(ids.control)
      const audio = findCharacteristic(ids.audio)
      const status = findCharacteristic(ids.status)
      const data = findCharacteristic(ids.data)
      const provision = findCharacteristic(ids.provision)
      if (!control || !audio || !status || !data) {
        throw bridgeError('IDENTITY_MISMATCH', '设备必须提供 0xFF01-0xFF04 全部特征')
      }
      const state = {
        ...known,
        protocolVersion: provision ? BLE_PROTOCOL.version : '1.0',
        connected: true,
        serviceId: service.uuid,
        controlId: control.uuid,
        audioId: audio.uuid,
        statusId: status.uuid,
        dataId: data.uuid,
        provisionId: provision ? provision.uuid : '',
        mtu: BLE_PROTOCOL.fallbackMtu,
        messageListeners: new Set(),
        disconnectRejectors: new Set(),
      }
      connections.set(deviceId, state)
      await negotiateMtu(state)
      await callWx('notifyBLECharacteristicValueChange', {
        deviceId: state.transportDeviceId,
        serviceId: state.serviceId,
        characteristicId: state.statusId,
        state: true,
      })
      await callWx('notifyBLECharacteristicValueChange', {
        deviceId: state.transportDeviceId,
        serviceId: state.serviceId,
        characteristicId: state.dataId,
        state: true,
      })
      return state
    } catch (error) {
      const state = connections.get(deviceId)
      if (state) state.connected = false
      connections.delete(deviceId)
      if (linkCreated) {
        try {
          await callWx('closeBLEConnection', { deviceId: known.transportDeviceId }, 2000)
        } catch {
          // Keep the original connection/setup error.
        }
      }
      throw error
    }
  }

  async function ensureConnected(deviceId, options = {}) {
    const existing = connections.get(deviceId)
    if (existing && existing.connected) return existing
    if (connectionAttempts.has(deviceId)) return connectionAttempts.get(deviceId)

    const attempt = connectKnownDevice(deviceId, options.timeout)
      .finally(() => connectionAttempts.delete(deviceId))
    connectionAttempts.set(deviceId, attempt)
    return attempt
  }

  async function closeConnection(deviceId) {
    const state = connections.get(deviceId)
    if (!state) return
    try {
      await callWx('closeBLEConnection', { deviceId: state.transportDeviceId }, 2000)
    } finally {
      state.connected = false
      connections.delete(deviceId)
    }
  }

  async function autoConnect({
    deviceId = '',
    serialNumber = '',
    timeout = 5000,
    refreshGatt = false,
  } = {}) {
    const targetId = String(deviceId || '')
    let targetSerial = String(serialNumber || '').trim().toUpperCase()
    let lastError = null
    const known = targetId ? knownDevices.get(targetId) : null
    if (!targetSerial && known) targetSerial = String(known.serialNumber || '').toUpperCase()

    if (refreshGatt && targetId && connections.has(targetId)) {
      await closeConnection(targetId)
      await delay(180)
    }

    if (targetId && known) {
      try {
        return await ensureConnected(targetId, { timeout })
      } catch (error) {
        if (error.code === 'BLUETOOTH_DISABLED') throw error
        lastError = error
      }
    }

    const found = await discover({ serialNumber: targetSerial, timeout })
    const candidates = targetId
      ? found.filter((item) => item.deviceId === targetId)
      : found
    if (!candidates.length) {
      throw lastError || bridgeError('NOT_FOUND', '附近没有发现已绑定的好眠设备')
    }
    for (const candidate of candidates) {
      try {
        return await ensureConnected(candidate.deviceId, { timeout })
      } catch (error) {
        if (error.code === 'BLUETOOTH_DISABLED') throw error
        lastError = error
      }
    }
    throw lastError || bridgeError('CONNECT_FAILED', '未能连接好眠设备')
  }

  async function writeBytes(state, characteristicId, bytes, writeType = 'write') {
    if (!state.connected) throw bridgeError('CONNECTION_LOST', '设备蓝牙连接已断开')
    const byteLength = bytes instanceof Uint8Array ? bytes.byteLength : new Uint8Array(bytes).byteLength
    if (byteLength > state.mtu - 3) {
      throw bridgeError(
        'BLE_FRAME_TOO_LARGE',
        `BLE 帧 ${byteLength} 字节超过当前 MTU ${state.mtu} 的单次写入上限`,
      )
    }
    try {
      await callWx('writeBLECharacteristicValue', {
        deviceId: state.transportDeviceId,
        serviceId: state.serviceId,
        characteristicId,
        value: arrayBufferOf(bytes),
        writeType,
      })
    } catch (error) {
      if (error.code === 'CONNECTION_LOST' || error.code === 'NOT_FOUND') state.connected = false
      throw error
    }
  }

  function subscribe(state, listener) {
    state.messageListeners.add(listener)
    return () => state.messageListeners.delete(listener)
  }

  function waitForMessage(state, predicate, timeout, timeoutMessage) {
    return new Promise((resolve, reject) => {
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        state.messageListeners.delete(onMessage)
        state.disconnectRejectors.delete(onDisconnect)
      }
      const onMessage = (message) => {
        if (!predicate(message)) return
        cleanup()
        resolve(message)
      }
      const onDisconnect = (error) => {
        cleanup()
        reject(error)
      }
      timer = setTimeout(() => {
        cleanup()
        reject(bridgeError('BLE_RESPONSE_TIMEOUT', timeoutMessage || '设备应答超时'))
      }, timeout)
      state.messageListeners.add(onMessage)
      state.disconnectRejectors.add(onDisconnect)
    })
  }

  async function controlWithReply(deviceId, bytes, acceptedTypes, timeout = RESPONSE_TIMEOUT) {
    const state = await ensureConnected(deviceId)
    const response = waitForMessage(
      state,
      (message) => message.channel === 'data' && acceptedTypes.includes(message.type),
      timeout,
      `等待 ${acceptedTypes.join('/')} 超时`,
    )
    try {
      await writeBytes(state, state.controlId, bytes)
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await response
      } catch {
        // The original write error is more actionable than the cancelled waiter.
      }
      throw error
    }
    return response
  }

  async function sendControl(deviceId, bytes) {
    const state = await ensureConnected(deviceId)
    await writeBytes(state, state.controlId, bytes)
    return state
  }

  async function readSafety(deviceId, command) {
    const state = await ensureConnected(deviceId)
    const token = safetyRequestId = (safetyRequestId % 65535) + 1
    const response = waitForMessage(state, message => message.channel === 'data' &&
      parseSafetyReply(message, token) !== null, RESPONSE_TIMEOUT, '设备未确认安全控制状态')
    try {
      await writeBytes(state, state.controlId, buildControlCommand(command, [token & 255, token >> 8]))
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      await response.catch(() => {})
      throw error
    }
    const status = parseSafetyReply(await response, token)
    if (!status.accepted) throw bridgeError('SAFETY_REJECTED', '设备拒绝操作，请检查停止状态或存储')
    return status
  }

  async function readIo(deviceId) {
    const state = await ensureConnected(deviceId)
    const token = safetyRequestId = (safetyRequestId % 65535) + 1
    const response = waitForMessage(state, message => message.channel === 'data' &&
      parseIoReply(message, token) !== null, RESPONSE_TIMEOUT, '设备未提供控制回读')
    try {
      await writeBytes(state, state.controlId, buildControlCommand(COMMANDS.IO_STATE, [token & 255, token >> 8]))
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      await response.catch(() => {})
      throw error
    }
    return parseIoReply(await response, token)
  }

  async function requireManualControl(deviceId) {
    const state = await readSafety(deviceId, COMMANDS.SAFETY_STATE)
    if (state.stopLatched) throw bridgeError('DEVICE_STOPPED', '请先在设备页恢复手动控制')
  }

  async function confirmIo(deviceId, predicate) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const state = await readIo(deviceId)
      if (predicate(state)) return state
      if (attempt < 5) await delay(100)
    }
    throw bridgeError('READBACK_MISMATCH', '设备回读与本次操作不一致')
  }

  async function listSfx(deviceId) {
    const state = await ensureConnected(deviceId)
    const files = []
    let expectedCount = null
    const result = new Promise((resolve, reject) => {
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        state.messageListeners.delete(onMessage)
        state.disconnectRejectors.delete(onDisconnect)
      }
      const onDisconnect = (error) => {
        cleanup()
        reject(error)
      }
      const onMessage = (message) => {
        if (message.channel !== 'data') return
        if (message.type === 'FILES') expectedCount = Number(message.fields[0] || 0)
        else if (message.type === 'FILE') {
          files.push({
            index: Number(message.fields[0] || 0),
            name: message.fields[1] || '',
            size: Number(message.fields[2] || 0),
            format: Number(message.fields[3] || 0),
          })
        } else if (message.type === 'FILESEND') {
          cleanup()
          if (expectedCount !== null && files.length !== expectedCount) {
            reject(bridgeError('SFX_LIST_INCOMPLETE', '设备音效列表不完整'))
          } else {
            resolve(files)
          }
        } else if (message.type === 'RXERR') {
          cleanup()
          reject(bridgeError('SFX_LIST_FAILED', message.raw))
        }
      }
      timer = setTimeout(() => {
        cleanup()
        reject(bridgeError('BLE_RESPONSE_TIMEOUT', '读取设备音效列表超时'))
      }, RESPONSE_TIMEOUT)
      state.messageListeners.add(onMessage)
      state.disconnectRejectors.add(onDisconnect)
    })
    try {
      await writeBytes(state, state.controlId, buildControlCommand(COMMANDS.SFX_LIST))
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await result
      } catch {
        // Preserve the concrete write failure.
      }
      throw error
    }
    return result
  }

  async function playSfx(deviceId, index) {
    const response = await controlWithReply(
      deviceId,
      buildControlCommand(COMMANDS.SFX_PLAY, [Number(index) & 0xff]),
      ['PLAYCMD', 'PLAYERR'],
    )
    if (response.type === 'PLAYERR') throw bridgeError('SFX_PLAY_FAILED', `设备无法播放音效 ${index}`)
    return response
  }

  async function playTestTone(deviceId) {
    const response = await controlWithReply(
      deviceId,
      buildControlCommand(COMMANDS.AUDIO_TEST),
      ['TESTTONE', 'TESTERR'],
    )
    if (response.type === 'TESTERR') throw bridgeError('AUDIO_TEST_FAILED', '设备测试音生成失败')
    return response
  }

  function wifiName(encoded) {
    try {
      return decodeUtf8(decodeBase64(encoded))
    } catch {
      return ''
    }
  }

  async function scanWifiNetworks(deviceId) {
    const state = await ensureConnected(deviceId)
    const simpleProtocol = !state.provisionId
    const networks = new Map()
    let expectedCount = null
    const result = new Promise((resolve, reject) => {
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        state.messageListeners.delete(onMessage)
        state.disconnectRejectors.delete(onDisconnect)
      }
      const onDisconnect = (error) => {
        cleanup()
        reject(error)
      }
      const onMessage = (message) => {
        if (message.channel !== 'data') return
        if (simpleProtocol) {
          if (message.type !== 'WIFI') return
          const [sub, rssiText, authText, ...nameParts] = message.fields
          if (sub === 'AP') {
            const ssid = nameParts.join(',')
            const rssi = Number(rssiText)
            const auth = Number(authText)
            if (!ssid || !Number.isFinite(rssi) || ![0, 1].includes(auth)) return
            const item = { index: networks.size, ssid, rssi, auth,
              secure: auth !== 0, signalText: `${rssi} dBm` }
            const previous = networks.get(ssid)
            if (!previous || rssi > previous.rssi) networks.set(ssid, item)
            return
          }
          if (sub === 'SCANEND') {
            expectedCount = Number(rssiText)
            message = { ...message, type: 'WIFISEND' }
          } else if (sub === 'SCANERR') {
            message = { ...message, type: 'WIFIERR' }
          } else return
        }
        if (message.type === 'WIFIS') expectedCount = Number(message.fields[0] || 0)
        else if (message.type === 'WIFI') {
          const ssid = wifiName(message.fields[3])
          if (!ssid) return
          const item = {
            index: Number(message.fields[0] || 0),
            rssi: Number(message.fields[1] || -100),
            auth: Number(message.fields[2] || 0),
            secure: Number(message.fields[2] || 0) !== 0,
            ssid,
            signalText: `${Number(message.fields[1] || -100)} dBm`,
          }
          const previous = networks.get(ssid)
          if (!previous || item.rssi > previous.rssi) networks.set(ssid, item)
        } else if (message.type === 'WIFISEND') {
          cleanup()
          const list = Array.from(networks.values()).sort((left, right) => right.rssi - left.rssi)
          if (expectedCount !== null && expectedCount > 0 && !list.length) {
            reject(bridgeError('WIFI_SCAN_FAILED', '设备没有返回可用 Wi-Fi 名称'))
          } else {
            resolve(list)
          }
        } else if (message.type === 'WIFIERR') {
          cleanup()
          reject(bridgeError('WIFI_SCAN_FAILED', message.raw))
        }
      }
      timer = setTimeout(() => {
        cleanup()
        reject(bridgeError('BLE_RESPONSE_TIMEOUT', '扫描附近 Wi-Fi 超时'))
      }, 15000)
      state.messageListeners.add(onMessage)
      state.disconnectRejectors.add(onDisconnect)
    })
    try {
      await writeBytes(state, state.controlId, buildControlCommand(
        simpleProtocol ? COMMANDS.WIFI_SCAN_SIMPLE : COMMANDS.WIFI_SCAN,
      ))
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await result
      } catch {
        // Preserve the concrete write failure.
      }
      throw error
    }
    return result
  }

  /* 当前量产固件 WiFi 状态查询（0x42 WIFI_STATE）：
   * 设备即时回 WIFI,OFF / WIFI,IDLE,<ssid> / WIFI,CONNECTED,<ssid>,<ip> */
  async function getWifiStatusSimple(state) {
    const response = await controlWithReply(
      state.deviceId,
      buildControlCommand(COMMANDS.WIFI_STATE),
      ['WIFI'],
      4000,
    )
    const sub = String(response.fields[0] || '').toUpperCase()
    if (sub === 'CONNECTED') {
      return {
        supported: true,
        connected: true,
        configured: true,
        deviceKeyPresent: false,
        ssid: String(response.fields[1] || ''),
        ip: String(response.fields[2] || ''),
        rssi: null,
      }
    }
    if (sub === 'IDLE') {
      return {
        supported: true,
        connected: false,
        configured: true,
        deviceKeyPresent: false,
        ssid: String(response.fields[1] || ''),
        rssi: null,
      }
    }
    // WIFI,OFF（未配置）或其它状态：按未配置处理
    return {
      supported: true,
      connected: false,
      configured: false,
      deviceKeyPresent: false,
      ssid: '',
      rssi: null,
    }
  }

  async function getWifiStatus(deviceId) {
    const state = await ensureConnected(deviceId)
    if (!state.provisionId) {
      // 当前量产固件：无 0xFF05 安全配网特征，WiFi 走 0xFF01 直配，能力依然支持
      return getWifiStatusSimple(state)
    }
    const response = await controlWithReply(
      deviceId,
      buildControlCommand(COMMANDS.WIFI_STATUS),
      ['WIFISTATUS', 'WIFIERR'],
      4000,
    )
    if (response.type === 'WIFIERR') throw bridgeError('WIFI_STATUS_FAILED', response.raw)
    return {
      supported: true,
      connected: Number(response.fields[0] || 0) === 1,
      configured: Number(response.fields[1] || 0) === 1,
      deviceKeyPresent: Number(response.fields[2] || 0) === 1,
      rssi: Number(response.fields[3] || -100),
      ssid: wifiName(response.fields[4]),
    }
  }

  /* 当前量产固件 WiFi 直配（0x41 WIFI_CONFIG，走 0xFF01 控制特征）：
   * 下发 [0x41][ssidLen][ssid UTF-8][pwdLen][pwd UTF-8] 后，设备经 0xFF04 异步上报
   *   WIFI,CONNECTING,<ssid> → WIFI,CONNECTED,<ssid>,<ip>（成功）
   *   WIFI,ERR,<reason> / WIFI,DISCONNECTED,...（失败） */
  async function provisionWifiSimple(state, { ssid, password = '', onProgress } = {}) {
    const command = buildWifiConfigCommand(ssid, password)
    if (command.byteLength > state.mtu - 3) {
      throw bridgeError('BLE_FRAME_TOO_LARGE', 'WiFi 名称或密码过长，单次 BLE 写入超出当前 MTU')
    }
    const result = new Promise((resolve, reject) => {
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        state.messageListeners.delete(onMessage)
        state.disconnectRejectors.delete(onDisconnect)
      }
      const onDisconnect = (error) => {
        cleanup()
        reject(error)
      }
      const onMessage = (message) => {
        if (message.channel !== 'data' || message.type !== 'WIFI') return
        const sub = String(message.fields[0] || '').toUpperCase()
        if (sub === 'CONNECTING') {
          if (typeof onProgress === 'function') onProgress(45)
          return
        }
        if (sub === 'CONNECTED') {
          cleanup()
          resolve({
            connected: true,
            ssid: String(message.fields[1] || ssid),
            ip: String(message.fields[2] || ''),
          })
          return
        }
        if (sub === 'ERR') {
          cleanup()
          const reason = String(message.fields[1] || '').toLowerCase()
          const code = reason === 'badlen' ? 'WIFI_INVALID_DATA' : 'WIFI_CONNECT_FAILED'
          reject(bridgeError(code, message.raw))
          return
        }
        if (sub === 'DISCONNECTED') {
          cleanup()
          reject(bridgeError('WIFI_CONNECT_FAILED', message.raw))
        }
      }
      timer = setTimeout(() => {
        cleanup()
        reject(bridgeError('WIFI_CONNECT_TIMEOUT', '设备连接 Wi-Fi 超时，请确认密码与 2.4GHz 网络'))
      }, 25000)
      state.messageListeners.add(onMessage)
      state.disconnectRejectors.add(onDisconnect)
    })
    if (typeof onProgress === 'function') onProgress(15)
    try {
      await writeBytes(state, state.controlId, command)
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await result
      } catch {
        // 保留原始写入错误
      }
      throw error
    }
    if (typeof onProgress === 'function') onProgress(30)
    return result
  }

  async function provisionWifi(options = {}) {
    const { deviceId } = options
    const state = await ensureConnected(deviceId)
    if (!state.provisionId) {
      // 当前量产固件：0xFF01 直配（无需 0xFF05 加密特征与设备密钥）
      return provisionWifiSimple(state, options)
    }
    const { ssid, password = '', deviceKey = '', onProgress } = options
    const payload = buildWifiProvisionPayload({ ssid, password, deviceKey })
    const payloadCrc32 = crc32Ieee(payload)
    const beginResponse = waitForMessage(
      state,
      (message) => message.channel === 'data' && ['WIFIBEGIN', 'WIFIERR'].includes(message.type),
      4000,
      '设备未建立 Wi-Fi 配网会话',
    )
    try {
      await writeBytes(
        state,
        state.controlId,
        buildWifiProvisionBeginCommand(payload.length, payloadCrc32),
      )
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await beginResponse
      } catch {
        // Preserve the concrete write failure.
      }
      throw error
    }
    const begin = await beginResponse
    if (begin.type === 'WIFIERR') throw bridgeError('WIFI_PROVISION_FAILED', begin.raw)

    const frames = splitDataFrames(payload, state.mtu, 0xb0)
    let nextIndex = 0
    let rewindSequence = null
    let fatalError = null
    let rewindCount = 0
    const unsubscribe = subscribe(state, (message) => {
      if (message.channel !== 'data') return
      if (message.type === 'WIFINAK') rewindSequence = Number(message.fields[0]) & 0xff
      else if (message.type === 'WIFICRC') rewindSequence = Number(message.fields[0]) & 0xff
      else if (message.type === 'WIFIERR') fatalError = bridgeError('WIFI_PROVISION_FAILED', message.raw)
      else if (message.type === 'WIFIRX' && typeof onProgress === 'function') {
        onProgress(Math.max(0, Math.min(95, Number(String(message.fields[0] || '').replace('%', '')) || 0)))
      }
    })
    try {
      while (nextIndex < frames.length || rewindSequence !== null) {
        if (fatalError) throw fatalError
        if (rewindSequence !== null) {
          const rewindIndex = frames.findIndex((frame, index) => (
            index <= nextIndex && frame.sequence === rewindSequence
          ))
          if (rewindIndex < 0) throw bridgeError('WIFI_RETRY_FAILED', '设备请求的 Wi-Fi 配网帧不存在')
          nextIndex = rewindIndex
          rewindSequence = null
          rewindCount += 1
          if (rewindCount > 8) throw bridgeError('WIFI_RETRY_FAILED', 'Wi-Fi 配网数据重试次数过多')
        }
        if (nextIndex >= frames.length) break
        await writeBytes(state, state.provisionId, frames[nextIndex].frame, 'writeNoResponse')
        nextIndex += 1
        if (typeof onProgress === 'function') {
          onProgress(Math.min(95, Math.round((nextIndex / frames.length) * 90)))
        }
        await delay(15)
      }
      if (fatalError) throw fatalError
    } finally {
      unsubscribe()
    }

    const completedResponse = waitForMessage(
      state,
      (message) => message.channel === 'data' && ['WIFIOK', 'WIFIERR'].includes(message.type),
      30000,
      '设备连接 Wi-Fi 超时',
    )
    try {
      await writeBytes(state, state.controlId, buildControlCommand(COMMANDS.WIFI_PROVISION_COMMIT))
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await completedResponse
      } catch {
        // Preserve the concrete write failure.
      }
      throw error
    }
    const completed = await completedResponse
    if (completed.type === 'WIFIERR') {
      const reason = completed.fields[0] || 'unknown'
      const code = reason === 'auth' ? 'WIFI_AUTH_FAILED'
        : reason === 'notfound' ? 'WIFI_NOT_FOUND'
          : 'WIFI_CONNECT_FAILED'
      throw bridgeError(code, completed.raw)
    }
    if (typeof onProgress === 'function') onProgress(100)
    return { connected: true, ssid, ip: completed.fields[0] || '' }
  }

  async function applySound(deviceId, current, desired, patch = {}) {
    if (Object.prototype.hasOwnProperty.call(patch, 'timer') && patch.timer !== 'all-night')
      throw bridgeError('CONTROL_UNSUPPORTED', '当前固件尚未支持设备定时')
    const shouldStart = patch.playing === true || (patch.scene && current && current.playing)
    if (shouldStart && desired.timer !== 'all-night') throw bridgeError('CONTROL_UNSUPPORTED', '请先选择整夜播放，当前固件尚未支持定时')
    if (shouldStart || (Object.prototype.hasOwnProperty.call(patch, 'volume') && desired.volume > 0)) await requireManualControl(deviceId)
    let selectedIndex = 0
    if (shouldStart) {
      const files = await listSfx(deviceId)
      selectedIndex = matchSfxIndex(files, desired.scene)
      if (!selectedIndex) throw bridgeError('SCENE_NOT_AVAILABLE', '设备尚未安装所选场景音效')
    }
    const applied = []
    if (Object.prototype.hasOwnProperty.call(patch, 'volume') || shouldStart) {
      await sendControl(deviceId, buildVolumeCommand(desired.volume))
      applied.push('volume')
    }
    if (patch.playing === false) {
      await sendControl(deviceId, buildControlCommand(COMMANDS.AUDIO_STOP))
      applied.push('stop')
    }
    if (shouldStart) {
      await playSfx(deviceId, selectedIndex)
      applied.push(`sfx:${selectedIndex}`)
    }
    const readback = await confirmIo(deviceId, io =>
      (!Object.prototype.hasOwnProperty.call(patch, 'volume') && !shouldStart || io.sound.volume === desired.volume) &&
      (patch.playing !== false || !io.sound.playing && !io.sound.paused) &&
      (!shouldStart || io.sound.playing && io.sound.index === selectedIndex))
    return { applied, confirmed: true, readback, transport: 'ble', protocolVersion: BLE_PROTOCOL.version }
  }

  /* Keep the displayed control range; never stretch 40 to full output. */
  function brightnessFactor(brightness) {
    const value = Math.max(5, Math.min(40, Number(brightness) || 15))
    return value / 100
  }

  async function applyLight(deviceId, desired, patch = {}) {
    if (desired.enabled && desired.mode !== 'night-low') throw bridgeError('CONTROL_UNSUPPORTED', '当前固件仅支持稳定夜灯')
    if (desired.enabled) await requireManualControl(deviceId)
    if (!Object.prototype.hasOwnProperty.call(patch, 'enabled')
      && !Object.prototype.hasOwnProperty.call(patch, 'brightness')
      && !Object.prototype.hasOwnProperty.call(patch, 'mode')
      && !Object.prototype.hasOwnProperty.call(patch, 'color')) {
      return { applied: [], transport: 'ble', protocolVersion: BLE_PROTOCOL.version }
    }
    // 固件灯光：0x09 [r,g,b]（各 0-100，全 0 熄灯并记忆）；0x01 仅支持单字节白光亮度
    let rgb = { r: 0, g: 0, b: 0 }
    let level = 0
    if (desired.enabled) {
      const preset = resolveLightColor(desired.color)
      const factor = brightnessFactor(desired.brightness)
      const scale = (channel) => Math.max(0, Math.min(100, Math.round(channel * 100 / 255 * factor)))
      rgb = { r: scale(preset.r), g: scale(preset.g), b: scale(preset.b) }
      level = Math.round(factor * 100)
    }
    await sendControl(deviceId, buildLightRgbCommand(rgb.r, rgb.g, rgb.b))
    const readback = await confirmIo(deviceId, io => io.light.enabled === Boolean(desired.enabled) &&
      io.light.r === rgb.r && io.light.g === rgb.g && io.light.b === rgb.b)
    return {
      confirmed: true,
      readback,
      applied: ['light'],
      enabled: Boolean(desired.enabled),
      level,
      color: desired.enabled ? resolveLightColor(desired.color).name : 'off',
      rgb,
      transport: 'ble',
      protocolVersion: BLE_PROTOCOL.version,
    }
  }

  async function uploadWav({ deviceId, name, wavData, onProgress } = {}) {
    const upload = prepareWavUpload(name, wavData)
    const state = await ensureConnected(deviceId)
    const transmittedName = upload.name.slice(0, Math.max(1, Math.min(24, state.mtu - 10)))
    const beginResponse = waitForMessage(
      state,
      (message) => message.channel === 'data' && ['RXBEGIN', 'RXERR'].includes(message.type),
      4000,
      '设备未建立音效传输会话',
    )
    try {
      await writeBytes(
        state,
        state.controlId,
        buildSfxBeginCommand(transmittedName, upload.size, upload.format),
      )
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await beginResponse
      } catch {
        // Preserve the concrete write failure.
      }
      throw error
    }
    const begin = await beginResponse
    if (begin.type === 'RXERR') throw bridgeError('SFX_BEGIN_FAILED', begin.raw)
    if (Number(begin.fields[0]) !== upload.size) {
      throw bridgeError('SFX_SIZE_MISMATCH', '设备确认的音效长度不一致')
    }

    const frames = splitDataFrames(upload.payload, state.mtu)
    let nextIndex = 0
    let rewindSequence = null
    let fatalError = null
    let rewindCount = 0
    const unsubscribe = subscribe(state, (message) => {
      if (message.channel !== 'data') return
      if (message.type === 'NAK') rewindSequence = Number(message.fields[0]) & 0xff
      else if (message.type === 'CRCERR') rewindSequence = Number(message.fields[0]) & 0xff
      else if (message.type === 'RXERR') fatalError = bridgeError('SFX_TRANSFER_FAILED', message.raw)
      else if (message.type === 'RX' && typeof onProgress === 'function') {
        onProgress(Math.max(0, Math.min(100, Number(String(message.fields[0] || '').replace('%', '')) || 0)))
      }
    })
    try {
      while (true) {
        if (fatalError) throw fatalError
        if (rewindSequence !== null) {
          const start = Math.max(0, nextIndex - 128)
          let rewindIndex = -1
          for (let index = nextIndex - 1; index >= start; index -= 1) {
            if (frames[index].sequence === rewindSequence) {
              rewindIndex = index
              break
            }
          }
          if (rewindIndex < 0) throw bridgeError('SFX_RETRY_WINDOW_EXCEEDED', '设备请求的重传帧已超出 128 帧缓存')
          nextIndex = rewindIndex
          rewindSequence = null
          rewindCount += 1
          if (rewindCount > 16) throw bridgeError('SFX_RETRY_LIMIT', '音效传输重试次数过多')
        }
        if (nextIndex >= frames.length) {
          await delay(60)
          if (rewindSequence === null) break
          continue
        }
        await writeBytes(state, state.audioId, frames[nextIndex].frame, 'writeNoResponse')
        nextIndex += 1
        await delay(12)
      }
      if (fatalError) throw fatalError
    } finally {
      unsubscribe()
    }

    const endResponse = waitForMessage(
      state,
      (message) => message.channel === 'data' && ['FILEOK', 'FILEERR'].includes(message.type),
      8000,
      '设备校验音效文件超时',
    )
    try {
      await writeBytes(state, state.controlId, buildSfxEndCommand(upload.crc32))
    } catch (error) {
      for (const reject of Array.from(state.disconnectRejectors)) reject(error)
      try {
        await endResponse
      } catch {
        // Preserve the concrete write failure.
      }
      throw error
    }
    const completed = await endResponse
    if (completed.type === 'FILEERR') throw bridgeError('SFX_FILE_REJECTED', completed.raw)
    if (typeof onProgress === 'function') onProgress(100)
    return {
      index: Number(completed.fields[0] || 0),
      name: completed.fields[1] || transmittedName,
      size: upload.size,
      crc32: upload.crc32,
    }
  }

  return {
    initialize: registerListeners,
    /* 订阅设备主动上报事件（SFXSTART/SFXDONE/SFXERR/MIC/WIFI,.../BLE_DISCONNECTED），
     * 回调参数 { deviceId, serialNumber, message: { channel, type, fields, raw } }，
     * 返回取消订阅函数 */
    onEvent(listener) {
      if (typeof listener !== 'function') return () => {}
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    discover,
    autoConnect,
    ensureConnected,
    async confirmBinding({ deviceId, serialNumber }) {
      const state = await ensureConnected(deviceId)
      if (serialNumber && String(serialNumber).toUpperCase() !== state.serialNumber) {
        throw bridgeError('IDENTITY_MISMATCH', '扫码设备与当前蓝牙设备不一致')
      }
      return {
        confirmed: true,
        deviceId,
        serialNumber: state.serialNumber,
        advertisedName: state.advertisedName,
        protocolVersion: state.protocolVersion,
        transport: 'ble-local',
      }
    },
    async refreshConnection({ deviceId, serialNumber = '', timeout = 8000 } = {}) {
      try {
        await closeConnection(deviceId)
      } catch (error) {
        if (error.code !== 'CONNECTION_LOST') throw error
      }
      if (typeof wx.closeBluetoothAdapter === 'function') {
        try {
          await callWx('closeBluetoothAdapter', {}, 3000)
        } catch (error) {
          if (error.code !== 'BLUETOOTH_DISABLED') throw error
        }
        adapterOpened = false
        await delay(300)
      }
      await openAdapter()
      await delay(180)
      return autoConnect({ deviceId, serialNumber, timeout })
    },
    provisionWifi,
    scanWifiNetworks,
    getWifiStatus,
    getStatus(deviceId) {
      const known = knownDevices.get(deviceId)
      const state = connections.get(deviceId)
      return {
        known: Boolean(known),
        connected: Boolean(state && state.connected),
        available: Boolean(known),
        mtu: state ? state.mtu : null,
        protocolVersion: state ? state.protocolVersion : (known ? known.protocolVersion : null),
        serialNumber: known ? known.serialNumber : '',
        wifiProvisionSupported: Boolean(state && state.connected && state.controlId && state.dataId),
      }
    },
    applyLight,
    applySound,
    listSfx,
    playSfx,
    playTestTone,
    uploadWav,
    getIoState: readIo,
    getSafetyState(deviceId) {
      return readSafety(deviceId, COMMANDS.SAFETY_STATE)
    },
    async resumeManualControl(deviceId) {
      const state = await readSafety(deviceId, COMMANDS.SAFETY_RESUME)
      if (state.stopLatched || state.active) throw bridgeError('SAFETY_REJECTED', '设备未确认恢复手动控制')
      return state
    },
    async stopAllOutputs(deviceId) {
      const state = await readSafety(deviceId, COMMANDS.STOP_ALL)
      if (!state.stopLatched || state.active) throw bridgeError('STOP_UNCONFIRMED', '停止结果待核对，请使用实体按键')
      return state
    },
    setMotorSpeed(deviceId, speed) {
      return sendControl(deviceId, buildMotorCommand(speed))
    },
    stopMotor(deviceId) {
      return sendControl(deviceId, buildControlCommand(COMMANDS.MOTOR_STOP))
    },
    disconnect: closeConnection,
    __test__: {
      ids,
      knownDevices,
      connections,
    },
  }
}

module.exports = { createWxBleBridge }
