// SnoozMate 真实后端服务层
// 适配器：把 37 个 service 函数 → 后端 40 个路由
// 字段命名：mock 驼峰 / 后端 snake_case，本层做翻译

const env = require('../../config/env')
const { isValidSerialNumber, normalizeSerialNumber } = require('../../domain/device-identity')
const { resolveLightColor } = require('../../utils/ble')

function wifiScanError(code, message) {
  const error = new Error(message || code)
  error.code = code
  return error
}

function callWifiApi(name, options = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const method = typeof wx !== 'undefined' && wx[name]
    if (typeof method !== 'function') {
      reject(wifiScanError('WIFI_SCAN_UNAVAILABLE', `微信接口 ${name} 不可用`))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(wifiScanError('WIFI_SCAN_TIMEOUT', `${name} 超时`))
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
        const code = /location|permission|authorize|权限|定位/i.test(message)
          ? 'BLUETOOTH_PERMISSION_DENIED'
          : /wifi.*off|未打开|disabled/i.test(message)
            ? 'WIFI_DISABLED'
            : 'WIFI_SCAN_FAILED'
        reject(wifiScanError(code, message || `${name} 失败`))
      },
    })
  })
}

function normalizePhoneWifiList(items) {
  const networks = new Map()
  for (const raw of items || []) {
    const ssid = String(raw && (raw.SSID || raw.ssid) || '').trim()
    if (!ssid) continue
    const rssi = Number(raw.RSSI)
    const strength = Number(raw.signalStrength)
    const sortValue = Number.isFinite(rssi)
      ? rssi
      : Number.isFinite(strength)
        ? strength
        : -100
    const item = {
      ssid,
      bssid: String(raw.BSSID || raw.bssid || ''),
      secure: raw.secure !== false,
      rssi: Number.isFinite(rssi) ? rssi : null,
      signalStrength: Number.isFinite(strength) ? strength : null,
      signalText: Number.isFinite(rssi)
        ? `${rssi} dBm`
        : Number.isFinite(strength)
          ? `${strength}%`
          : '信号未知',
      source: 'phone',
      sortValue,
    }
    const previous = networks.get(ssid)
    if (!previous || item.sortValue > previous.sortValue) networks.set(ssid, item)
  }
  return Array.from(networks.values()).sort((left, right) => right.sortValue - left.sortValue)
}

async function scanPhoneWifiNetworks({ timeout = 8000 } = {}) {
  if (
    typeof wx === 'undefined'
    || typeof wx.startWifi !== 'function'
    || typeof wx.getWifiList !== 'function'
    || typeof wx.onGetWifiList !== 'function'
  ) {
    throw wifiScanError('WIFI_SCAN_UNAVAILABLE', '当前微信环境不支持附近 Wi-Fi 扫描')
  }
  await callWifiApi('startWifi', {}, 5000)
  let handler = null
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }
      const timer = setTimeout(
        () => finish(reject, wifiScanError('WIFI_SCAN_TIMEOUT', '附近 Wi-Fi 扫描超时')),
        Math.max(3000, Math.min(Number(timeout) || 8000, 15000)),
      )
      handler = (result) => finish(resolve, normalizePhoneWifiList(result && result.wifiList))
      wx.onGetWifiList(handler)
      callWifiApi('getWifiList', {}, 5000).catch((error) => finish(reject, error))
    })
  } finally {
    if (handler && typeof wx.offGetWifiList === 'function') wx.offGetWifiList(handler)
  }
}

// ═══════════════════════════════════════
// 基础：HTTP 客户端 + 错误处理
// ═══════════════════════════════════════

function buildBaseUrl() {
  return (env.apiBaseUrl || 'http://127.0.0.1:8088').replace(/\/$/, '')
}

function getToken() {
  try {
    return wx.getStorageSync('haomian-session-token') || ''
  } catch {
    return ''
  }
}

function setToken(token) {
  try { wx.setStorageSync('haomian-session-token', token) } catch {}
}

function getDeviceId() {
  let id = ''
  try { id = wx.getStorageSync('haomian-device-id') || '' } catch {}
  if (!id && env.demoMode) id = env.defaultDeviceId || 'device_esp32_real_001'
  if (!id) throw serviceError('NOT_PROVISIONED', '当前账号尚未绑定月石设备')
  return String(id)
}

function setDeviceId(id) {
  try { wx.setStorageSync('haomian-device-id', id) } catch {}
}

const GET_CACHE_TTL = 2500
const getCache = new Map()
const inFlightGets = new Map()
let loginPromise = null
let profileCacheAt = 0
let profilePromise = null
let cloudInitState = 'unknown'
let deviceBridge = null
let bleAutoConnectPromise = null

function storageGet(key) {
  try { return wx.getStorageSync(key) } catch { return null }
}

function storageSet(key, value) {
  try { wx.setStorageSync(key, value) } catch {}
}

function configureDeviceBridge(bridge) {
  deviceBridge = bridge
    && typeof bridge.discover === 'function'
    && typeof bridge.confirmBinding === 'function'
    && typeof bridge.getStatus === 'function'
    && typeof bridge.applySound === 'function'
    && typeof bridge.applyLight === 'function'
    ? bridge
    : null
}

function invalidateSession() {
  try {
    wx.removeStorageSync('haomian-session-token')
    wx.removeStorageSync('haomian-session')
    wx.removeStorageSync('haomian-profile')
    wx.removeStorageSync('haomian-device-id')
    wx.removeStorageSync('haomian-device-serial')
    wx.removeStorageSync('haomian-pending-device')
    wx.removeStorageSync('haomian-ai-chat-sessions')
  } catch {}
  getCache.clear()
  profileCacheAt = 0
}

function getClientId() {
  const existing = storageGet('haomian-client-id')
  if (existing) return String(existing)
  const id = `mini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  storageSet('haomian-client-id', id)
  return id
}

async function refreshBoundDeviceSelection() {
  const response = await request('GET', '/api/v1/user/devices', undefined, { cacheTtl: 0 })
  const devices = Array.isArray(response && response.devices) ? response.devices : []
  const storedId = storageGet('haomian-device-id')
  const selected = devices.find((item) => item && item.device_id === storedId) || devices[0]
  if (selected && selected.device_id) setDeviceId(selected.device_id)
  else {
    try {
      wx.removeStorageSync('haomian-device-id')
      wx.removeStorageSync('haomian-device-serial')
    } catch {}
  }
  return devices
}

async function waitForBoundDevice(deviceId, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const devices = await refreshBoundDeviceSelection()
    const bound = devices.find((item) => item && item.device_id === deviceId)
    if (bound) return bound
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw serviceError('SYNC_TIMEOUT', '设备联网后尚未确认绑定')
}

async function waitForDeviceControlCommand(deviceId, queued, attempts = 20) {
  const commandId = queued && queued.command && (queued.command.command_id || queued.command.commandId)
  if (!commandId) throw serviceError('SYNC_TIMEOUT', '设备控制命令未创建')
  let command = normalizeCommand(queued.command)
  for (
    let attempt = 0;
    attempt < attempts && ['pending', 'readback-pending', 'ack-accepted'].includes(command.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const response = await request(
      'GET',
      `/api/v1/device/${deviceId}/commands/${commandId}`,
      undefined,
      { cacheTtl: 0 },
    )
    command = normalizeCommand(response.command || response)
  }
  if (command.status !== 'applied') {
    if (['NOT_IMPLEMENTED', 'AUTOMATIC_DISABLED'].includes(command.errorCode))
      throw serviceError('CONTROL_UNSUPPORTED', '当前固件未开放此控制')
    throw serviceError(
      command.status === 'readback-mismatch' ? 'READBACK_MISMATCH' : 'SYNC_TIMEOUT',
      '月石尚未确认本次控制',
    )
  }
  return command
}

function isCloudUnavailable(error) {
  return ['NETWORK_ERROR', 'SYNC_TIMEOUT', 'HTTP_5XX', 'CLOUD_NOT_CONFIGURED'].includes(error && error.code)
}

function hasBleIo(id) {
  return deviceBridge && typeof deviceBridge.getIoState === 'function' && deviceBridge.getStatus(id).connected
}

function withIoState(kind, preferences, io) {
  const actual = io[kind]
  return { ...preferences, ...actual,
    ...(kind === 'light' ? { mode: 'night-low', modeName: '低亮起夜',
      brightness: Math.max(actual.r, actual.g, actual.b), rgb: { r: actual.r, g: actual.g, b: actual.b } }
      : { timer: 'all-night' }),
    confirmed: true, source: 'ble-driver', physicalFeedback: false }
}

async function readControlState(id, kind, normalize) {
  let preferences = storageGet(`haomian-control-${kind}:${id}`) || {}
  let cloudError = null
  try {
    const response = await request('GET', `/api/v1/device/${id}/${kind}`, undefined, { cacheTtl: 0 })
    preferences = s2c(response[kind] || response)
  } catch (error) {
    if (!hasBleIo(id) || !isCloudUnavailable(error)) throw error
    cloudError = error.code
  }
  const state = normalize(preferences)
  if (!hasBleIo(id)) return { ...state, confirmed: false, source: 'cloud-preference' }
  const actual = withIoState(kind, state, await deviceBridge.getIoState(id))
  return { ...actual, syncPending: Boolean(cloudError), syncError: cloudError }
}

async function saveConfirmedControl(id, kind, desired, patch, result) {
  if (!result || result.confirmed !== true || !result.readback)
    throw serviceError('READBACK_MISMATCH', '设备尚未确认本次设置')
  const actual = withIoState(kind, desired, result.readback)
  storageSet(`haomian-control-${kind}:${id}`, actual)
  try {
    await request('PUT', `/api/v1/device/${id}/${kind}`, patch)
    return { ...actual, syncPending: false }
  } catch (error) {
    // A cloud save cannot undo a confirmed physical command. Do not resend it.
    return { ...actual, syncPending: true, syncError: error.code || 'UNKNOWN' }
  }
}

function isBleTransportError(error) {
  return [
    'BLUETOOTH_DISABLED',
    'CONNECTION_LOST',
    'CONNECT_FAILED',
    'NOT_FOUND',
    'PROVISION_TIMEOUT',
  ].includes(error && error.code)
}

function serviceError(code, message, statusCode) {
  const error = new Error(message || code)
  error.code = code
  error.statusCode = statusCode
  error.retryable = code === 'NETWORK_ERROR' || code === 'SYNC_TIMEOUT' || code === 'HTTP_5XX'
  return error
}

function responseDetail(data, fallback) {
  const detail = data && data.detail
  if (Array.isArray(detail)) return detail.map((item) => item.msg || String(item)).join('；')
  return typeof detail === 'string' ? detail : fallback
}

function initializeCloudContainer() {
  if (env.transport === 'public') return false
  if (!env.cloudEnvId || !env.cloudServiceName) {
    if (env.transport === 'cloud-container') {
      throw serviceError('CLOUD_NOT_CONFIGURED', '缺少微信云环境 ID 或服务名')
    }
    return false
  }
  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.callContainer !== 'function') {
    if (env.transport === 'cloud-container') {
      throw serviceError('CLOUD_NOT_CONFIGURED', '当前基础库不支持微信云调用，请升级基础库')
    }
    return false
  }
  if (cloudInitState === 'ready') return true
  try {
    if (typeof wx.cloud.init === 'function') {
      wx.cloud.init({ env: env.cloudEnvId, traceUser: true })
    }
    cloudInitState = 'ready'
    return true
  } catch (error) {
    cloudInitState = 'failed'
    if (env.transport === 'cloud-container') {
      throw serviceError('CLOUD_NOT_CONFIGURED', '微信云环境初始化失败')
    }
    return false
  }
}

function shouldUseCloudContainer() {
  if (env.transport === 'public') return false
  return initializeCloudContainer()
}

// All transport failures settle once. GETs may receive one short cold-start retry;
// writes are never retried because their server-side idempotency is not guaranteed.
function request(method, path, body, opts = {}) {
  const url = buildBaseUrl() + path
  const useCloudContainer = shouldUseCloudContainer()
  const token = getToken()
  const headers = { 'Content-Type': 'application/json' }
  if (useCloudContainer) headers['X-WX-SERVICE'] = env.cloudServiceName
  if (token && !opts.skipAuth) headers.Authorization = `Bearer ${token}`
  const isGet = method === 'GET'
  const key = isGet ? `${env.transport}:${token}:${useCloudContainer ? env.cloudEnvId : url}:${path}` : ''
  const ttl = opts.cacheTtl == null ? (isGet ? GET_CACHE_TTL : 0) : opts.cacheTtl
  const cached = isGet && getCache.get(key)
  if (cached && Date.now() - cached.at < ttl) return Promise.resolve(cached.value)
  if (isGet && inFlightGets.has(key)) return inFlightGets.get(key)

  let task = null
  let settled = false
  const execute = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    const attempt = (retry) => {
      const timeout = opts.timeout || (isGet ? (retry ? 3000 : 2500) : 5000)
      const transportTimeout = useCloudContainer ? Math.min(timeout, 15000) : timeout
      let attemptSettled = false
      let watchdog = null
      const failAttempt = (err) => {
        if (attemptSettled || settled) return
        attemptSettled = true
        if (watchdog) clearTimeout(watchdog)
        const timedOut = /timeout/i.test((err && err.errMsg) || '')
        if (isGet && opts.retryColdStart && !retry && timedOut) {
          setTimeout(() => { if (!settled) attempt(true) }, 200)
          return
        }
        finish(reject, serviceError(timedOut ? 'SYNC_TIMEOUT' : 'NETWORK_ERROR', (err && err.errMsg) || 'NETWORK_ERROR'))
      }
      const handleSuccess = (res) => {
        if (attemptSettled || settled) return
        attemptSettled = true
        if (watchdog) clearTimeout(watchdog)
        const statusCode = Number(res && res.statusCode) || 200
        if (statusCode >= 200 && statusCode < 300) {
          if (isGet && ttl > 0) getCache.set(key, { at: Date.now(), value: res.data })
          if (!isGet) getCache.clear()
          finish(resolve, res.data)
          return
        }
        if (statusCode === 401) invalidateSession()
        const code = statusCode === 401 ? 'AUTH_EXPIRED' : (statusCode >= 500 ? 'HTTP_5XX' : 'HTTP_ERROR')
        finish(reject, serviceError(code, responseDetail(res.data, `HTTP ${statusCode}`), statusCode))
      }
      if (useCloudContainer) {
        try {
          const result = wx.cloud.callContainer({
            config: { env: env.cloudEnvId },
            path,
            method,
            data: body,
            header: headers,
            timeout: transportTimeout,
            dataType: 'json',
          })
          if (result && typeof result.then === 'function') {
            result.then(handleSuccess, (error) => failAttempt({
              errMsg: error && (error.errMsg || error.message) || 'cloud callContainer failed',
            }))
          } else {
            failAttempt({ errMsg: 'cloud callContainer did not return a Promise' })
          }
        } catch (error) {
          failAttempt({ errMsg: error && error.message ? error.message : 'cloud callContainer failed' })
        }
      } else {
        task = wx.request({
          url, method, data: body, header: headers, timeout: transportTimeout,
          success: handleSuccess,
          fail: failAttempt,
        })
      }
      watchdog = setTimeout(() => {
        if (task && typeof task.abort === 'function') task.abort()
        failAttempt({ errMsg: 'request timeout' })
      }, transportTimeout + 100)
    }
    attempt(false)
  })
  execute.abort = () => {
    if (task && typeof task.abort === 'function' && !settled) task.abort()
  }
  if (isGet) {
    inFlightGets.set(key, execute)
    execute.then(
      () => inFlightGets.delete(key),
      () => inFlightGets.delete(key),
    )
  }
  return execute
}

// 转换错误消息为前端错误码（保持 mock 错误码一致）
function toServiceError(err) {
  if (err && err.code) return err
  const msg = (err && err.message) || String(err)
  // 后端 detail 是中文描述 → 反查错误码
  if (msg.includes('设备不存在') || msg.includes('DEVICE_NOT_FOUND')) return new Error('NOT_PROVISIONED')
  if (msg.includes('AI_CANDIDATE_NOT_FOUND') || msg.includes('not found')) return new Error('AI_CANDIDATE_NOT_FOUND')
  if (msg.includes('CONFIG_CONFLICT')) return new Error('CONFIG_CONFLICT')
  if (msg.includes('READBACK_MISMATCH')) return serviceError('READBACK_MISMATCH', msg)
  if (msg.includes('SETTINGS_COMMAND_NOT_FOUND')) return new Error('SETTINGS_COMMAND_NOT_FOUND')
  if (msg.includes('auth') || msg.includes('AUTH') || msg.includes('401')) return new Error('AUTH_EXPIRED')
  if (msg.includes('NETWORK') || msg.includes('request:fail') || msg.includes('timeout')) return serviceError('SYNC_TIMEOUT', msg)
  if (msg.includes('cloud') || msg.includes('CLOUD')) return serviceError('CLOUD_NOT_CONFIGURED', msg)
  return serviceError('UNKNOWN', msg)
}

// ═══════════════════════════════════════
// 数据格式翻译：snake_case → camelCase（按需）
// ═══════════════════════════════════════

function s2c(o) {
  // snake → camel 浅转换（只动 key）
  if (!o || typeof o !== 'object') return o
  if (Array.isArray(o)) return o.map(s2c)
  const out = {}
  for (const k of Object.keys(o)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    out[ck] = s2c(o[k])
  }
  return out
}

function c2s(o) {
  // camel → snake（用于写后端）
  if (!o || typeof o !== 'object') return o
  if (Array.isArray(o)) return o.map(c2s)
  const out = {}
  for (const k of Object.keys(o)) {
    const sk = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
    out[sk] = c2s(o[k])
  }
  return out
}

function numberOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeSettings(input) {
  const raw = input && input.config ? input.config : (input || {})
  const config = s2c(raw)
  const threshold = numberOr(config.snoreConfidenceThreshold, 0.65)
  const sensitivity = config.sensitivity == null
    ? (threshold >= 0.7 ? 1 : threshold >= 0.6 ? 2 : 3)
    : config.sensitivity
  const sleepMode = config.sleepMode || config.mode
  return {
    sleepMode: ['shared', 'partner'].includes(sleepMode) ? 'shared' : 'solo',
    sensitivity: Math.max(1, Math.min(3, Math.round(numberOr(sensitivity, 2)))),
    maxVibrationLevel: Math.max(1, Math.min(5, Math.round(numberOr(
      config.maxVibrationLevel,
      Math.max(3, numberOr(config.startVibrationLevel, 1)),
    )))),
    sleepProtectionMinutes: Math.max(15, Math.min(90, Math.round(numberOr(
      config.sleepProtectionMinutes,
      numberOr(config.fallAsleepProtection, 1800) / 60,
    )))),
    nightlyInterventionLimit: Math.max(0, Math.min(12, Math.round(numberOr(
      config.nightlyInterventionLimit,
      numberOr(config.maxRoundsPerNight, 6),
    )))),
  }
}

function normalizeSound(input) {
  const sound = input || {}
  const scene = sound.scene || sound.sceneId || 'sleep'
  const defaultScenes = [
    { id: 'sleep', name: '深睡白噪', trackName: '深睡白噪' },
    { id: 'healing', name: '疗愈雨声', trackName: '疗愈雨声' },
    { id: 'work', name: '专注环境音', trackName: '专注环境音' },
    { id: 'reading', name: '阅读轻音', trackName: '阅读轻音' },
  ]
  const supplied = Array.isArray(sound.scenes) ? sound.scenes : []
  const scenes = defaultScenes.map((fallback) => ({
    ...fallback,
    ...(supplied.find((item) => item && item.id === fallback.id) || {}),
  }))
  const selected = scenes.find((item) => item.id === scene) || scenes[0]
  return {
    ...sound, scenes, scene: selected.id, sceneName: sound.sceneName || selected.name,
    trackName: sound.trackName || selected.trackName || selected.name,
    playing: Boolean(sound.playing), volume: Math.max(0, Math.min(100, numberOr(sound.volume, 50))),
    timer: [15, 30, 60, 'all-night'].includes(sound.timer) ? sound.timer : 'all-night',
  }
}

function normalizeLight(input) {
  const light = input || {}
  const color = resolveLightColor(light.color)
  return {
    ...light,
    enabled: Boolean(light.enabled),
    mode: ['bedtime-breathe', 'night-low'].includes(light.mode) ? light.mode : 'bedtime-breathe',
    modeName: light.modeName || (light.mode === 'night-low' ? '低亮起夜' : '睡前呼吸灯'),
    brightness: Math.max(5, Math.min(40, numberOr(light.brightness, 15))),
    color: color.name,
    colorTemperatureKelvin: color.colorTemperatureKelvin,
    rgb: { r: color.r, g: color.g, b: color.b },
  }
}

function normalizeCommand(command) {
  if (!command) return null
  const normalized = s2c(command)
  const readback = normalized.readback || {}
  const statusMap = {
    accepted: 'ack-accepted',
    pending: 'pending',
    delivered: 'readback-pending',
    applied: 'applied',
    expired: 'readback-timeout',
    failed: 'readback-timeout',
    rejected: 'rejected-boundary',
    'readback-mismatch': 'readback-mismatch',
  }
  const readbackSettings = normalized.readbackSettings || readback.config
  return {
    ...normalized,
    commandId: normalized.commandId || '',
    candidateId: normalized.candidateId || (normalized.payload && normalized.payload.candidateId) || '',
    expectedConfigVersion: numberOr(normalized.expectedConfigVersion, 0),
    currentConfigVersion: numberOr(
      normalized.currentConfigVersion,
      numberOr(
        normalized.readbackConfigVersion,
        readback.configVersion == null ? normalized.expectedConfigVersion : readback.configVersion,
      ),
    ),
    status: statusMap[normalized.status] || normalized.status || 'pending',
    readbackSettings: readbackSettings ? normalizeSettings(readbackSettings) : null,
    matchesCandidate: normalized.matchesCandidate == null
      ? (normalized.status === 'applied' ? true : normalized.status === 'readback-mismatch' ? false : null)
      : Boolean(normalized.matchesCandidate),
  }
}

// ═══════════════════════════════════════
// Auth
// ═════════════════════════════════════===

const auth = {
  login({ code, force = false } = {}) {
    const cached = storageGet('haomian-session')
    if (!force && cached && cached.token && cached.userId && (!cached.expiresAt || cached.expiresAt > Date.now())) {
      setToken(cached.token)
      if (!cached.deviceSelectionResolved && !storageGet('haomian-device-id')) {
        return refreshBoundDeviceSelection().then((devices) => {
          storageSet('haomian-session', { ...cached, deviceSelectionResolved: true })
          return { sessionId: cached.token, userId: cached.userId, profile: wrapProfile(cached.profile || storageGet('haomian-profile')), devices }
        })
      }
      return Promise.resolve({ sessionId: cached.token, userId: cached.userId, profile: wrapProfile(cached.profile || storageGet('haomian-profile')) })
    }
    if (loginPromise) return loginPromise
    if (!code) return Promise.reject(serviceError('AUTH_EXPIRED', '微信登录凭据不可用'))
    loginPromise = request('POST', '/api/v1/auth/login', {
      login_code: code,
      client_id: getClientId(),
    }, { skipAuth: true, timeout: 4500 })
      .then(async (r) => {
        const token = r && (r.session_token || r.token)
        const userId = r && (r.user_id || r.userId || r.id)
        if (!token || !userId) throw serviceError('AUTH_EXPIRED', '登录响应缺少会话信息')
        const previousSession = storageGet('haomian-session')
        if (previousSession && previousSession.userId && previousSession.userId !== userId) {
          try {
            wx.removeStorageSync('haomian-device-id')
            wx.removeStorageSync('haomian-device-serial')
            wx.removeStorageSync('haomian-ai-chat-sessions')
          } catch {}
        }
        const profile = wrapProfile(r.profile || { id: userId })
        setToken(token)
        storageSet('haomian-profile', profile)
        profileCacheAt = Date.now()
        storageSet('haomian-session', {
          token, userId, profile,
          expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : Date.now() + 6 * 24 * 60 * 60 * 1000,
          deviceSelectionResolved: false,
        })
        let devices = []
        let deviceSelectionResolved = false
        try {
          devices = await refreshBoundDeviceSelection()
          deviceSelectionResolved = true
        } catch {}
        const savedSession = storageGet('haomian-session')
        if (savedSession) storageSet('haomian-session', { ...savedSession, deviceSelectionResolved })
        return { sessionId: token, userId, profile, devices }
      })
      .finally(() => { loginPromise = null })
    return loginPromise
  },

  async getProfile() {
    const cached = storageGet('haomian-profile')
    if (cached && typeof cached === 'object' && Date.now() - profileCacheAt < 60000) {
      return wrapProfile(cached)
    }
    if (profilePromise) return profilePromise
    profilePromise = request('GET', '/api/v1/user/me/profile', undefined, { retryColdStart: true, cacheTtl: 10000 })
      .then((r) => {
        const profile = wrapProfile(r)
        storageSet('haomian-profile', profile)
        profileCacheAt = Date.now()
        return profile
      })
      .finally(() => { profilePromise = null })
    return profilePromise
  },

  async saveProfile(profile) {
    const desired = { ...wrapProfile(storageGet('haomian-profile')), ...(profile || {}) }
    // Send both forms while old cloud revisions are still in circulation.
    const r = await request('PUT', '/api/v1/user/me/profile', { ...desired, ...c2s(desired) })
    const saved = wrapProfile(r && (r.profile || r))
    for (const key of ['excludeSoundReminder', 'excludeLightReminder']) {
      if (profile && typeof profile[key] === 'boolean' && saved[key] !== profile[key]) {
        throw toServiceError(Object.assign(new Error('READBACK_MISMATCH'), { code: 'READBACK_MISMATCH' }))
      }
    }
    storageSet('haomian-profile', saved)
    profileCacheAt = Date.now()
    const session = storageGet('haomian-session')
    if (session) storageSet('haomian-session', { ...session, profile: saved })
    return saved
  },
}

// 兼容 mock-data.js profile 字段
function defaultProfile(id) {
  return {
    id: id || '',
    nickname: '月',
    sleepMode: 'shared',
    excludeSoundReminder: true,
    excludeLightReminder: true,
    privacyAccepted: false,
    aiDataAuthorized: false,
    mqttAudioAuthorized: false,
  }
}

function wrapProfile(r) {
  if (!r) return defaultProfile('')
  return {
    id: r.id || r.user_id || r.userId || '',
    nickname: r.nickname || r.name || '月',
    sleepMode: r.sleep_mode || r.sleepMode || 'shared',
    excludeSoundReminder: r.excludeSoundReminder !== false && r.exclude_sound_reminder !== false && r.exclude_sound_reminder !== 0,
    excludeLightReminder: r.excludeLightReminder !== false && r.exclude_light_reminder !== false && r.exclude_light_reminder !== 0,
    privacyAccepted: Boolean(r.privacy_accepted || r.privacyAccepted),
    aiDataAuthorized: Boolean(r.ai_data_authorized || r.aiDataAuthorized),
    mqttAudioAuthorized: Boolean(r.mqtt_audio_authorized || r.mqttAudioAuthorized || r.raw_audio_candidate_consent || r.rawAudioCandidateConsent),
  }
}

// ═══════════════════════════════════════
// Device
// ═════════════════════════════════════===

const device = {
  async discover({ serialNumber } = {}) {
    if (!deviceBridge) throw serviceError('NOT_CONFIGURED', '真实设备发现需要 BLE 设备桥接器')
    const found = await deviceBridge.discover({ serialNumber: serialNumber || '' })
    return Array.isArray(found) ? found : []
  },

  async autoConnect({ deviceId = '', serialNumber = '', timeout = 5000, refreshGatt = false } = {}) {
    const candidateSerial = normalizeSerialNumber(
      serialNumber || storageGet('haomian-device-serial') || '',
    )
    const serial = isValidSerialNumber(candidateSerial) ? candidateSerial : ''
    const derivedId = serial ? `haomian_sleep_${serial.slice(-6).toLowerCase()}` : ''
    const candidateId = String(deviceId || storageGet('haomian-device-id') || '')
    const id = /^haomian_sleep_[0-9a-f]{6}$/.test(candidateId) ? candidateId : derivedId
    if (!getToken() || (!id && !serial)) {
      return { connected: false, skipped: true, reason: 'invalid-device-identity' }
    }
    if (!deviceBridge || typeof deviceBridge.autoConnect !== 'function') {
      return { connected: false, skipped: true }
    }
    const current = deviceBridge.getStatus(id)
    if (current.connected && !refreshGatt) return { ...current, connected: true }
    if (bleAutoConnectPromise) return bleAutoConnectPromise

    const connect = refreshGatt && typeof deviceBridge.refreshConnection === 'function'
      ? deviceBridge.refreshConnection({
        deviceId: id,
        serialNumber: serial,
        timeout: Math.max(8000, timeout),
      })
      : deviceBridge.autoConnect({
        deviceId: id,
        serialNumber: serial,
        timeout,
        refreshGatt,
      })
    bleAutoConnectPromise = connect.then((state) => ({
      connected: Boolean(state && state.connected),
      deviceId: state && state.deviceId || id,
      serialNumber: state && state.serialNumber || serial,
      mtu: state && state.mtu || null,
      protocolVersion: state && state.protocolVersion || '1.0',
      wifiProvisionSupported: Boolean(state && state.provisionId),
    })).finally(() => {
      bleAutoConnectPromise = null
    })
    return bleAutoConnectPromise
  },

  async bind(input = {}) {
    const source = typeof input === 'string' ? { serialNumber: input } : input
    const id = source.deviceId || getDeviceId()
    if (!id) throw serviceError('NOT_PROVISIONED', '缺少设备编号')
    if (!deviceBridge) {
      throw serviceError('NOT_CONFIGURED', '真实设备绑定需要 BLE 设备桥接器')
    }
    const physical = await deviceBridge.confirmBinding({
      deviceId: id,
      serialNumber: source.serialNumber || '',
    })
    const tokenResult = await request('POST', `/api/v1/binding/token?device_id=${encodeURIComponent(id)}`, undefined)
    const bindingToken = tokenResult.binding_token || tokenResult.token
    if (!bindingToken) throw serviceError('BINDING_TOKEN_INVALID', '绑定令牌不可用')
    await request('POST', '/api/v1/binding/confirm-ble', {
      binding_token: bindingToken,
      device_id: id,
      advertised_name: physical.advertisedName || source.serialNumber || '',
      protocol_version: physical.protocolVersion || '1.1',
    })
    await waitForBoundDevice(id)
    setDeviceId(id)
    storageSet('haomian-device-serial', source.serialNumber || '')
    try { wx.removeStorageSync('haomian-pending-device') } catch {}
    return { deviceId: id, bound: true, transport: 'ble-local' }
  },

  async getWifiStatus({ refresh = false } = {}) {
    const id = getDeviceId()
    if (!deviceBridge || typeof deviceBridge.getWifiStatus !== 'function') {
      throw serviceError('WIFI_PROVISION_UNSUPPORTED', '当前设备固件不支持安全 Wi-Fi 配网')
    }
    let status = await deviceBridge.getWifiStatus(id)
    if (status && status.supported === false && refresh && typeof deviceBridge.refreshConnection === 'function') {
      try {
        await deviceBridge.refreshConnection({
          deviceId: id,
          serialNumber: storageGet('haomian-device-serial') || '',
          timeout: 8000,
        })
        status = await deviceBridge.getWifiStatus(id)
      } catch (error) {
        const retryable = ['CONNECTION_LOST', 'CONNECT_FAILED', 'NOT_FOUND', 'PROVISION_TIMEOUT']
        if (!retryable.includes(error && error.code)) throw error
      }
    }
    return status
  },

  async scanWifiNetworks({ source = 'auto' } = {}) {
    const id = getDeviceId()
    const bridgeStatus = deviceBridge && typeof deviceBridge.getStatus === 'function'
      ? deviceBridge.getStatus(id)
      : { wifiProvisionSupported: false }
    const useDeviceScan = source !== 'phone'
      && bridgeStatus.wifiProvisionSupported !== false
      && deviceBridge
      && typeof deviceBridge.scanWifiNetworks === 'function'
    if (useDeviceScan) {
      try {
        const networks = await deviceBridge.scanWifiNetworks(id)
        return networks.map((item) => ({ ...item, source: 'device' }))
      } catch (error) {
        if (!['WIFI_PROVISION_UNSUPPORTED', 'WIFI_SCAN_FAILED', 'BLE_RESPONSE_TIMEOUT'].includes(error.code)) {
          throw error
        }
      }
    }
    return scanPhoneWifiNetworks()
  },
  async provisionWifi({ ssid, password = '', onProgress } = {}) {
    const id = getDeviceId()
    if (!deviceBridge || typeof deviceBridge.provisionWifi !== 'function') {
      throw serviceError('WIFI_PROVISION_UNSUPPORTED', '当前设备固件不支持 Wi-Fi 配网')
    }
    const status = typeof deviceBridge.getWifiStatus === 'function'
      ? await deviceBridge.getWifiStatus(id)
      : { deviceKeyPresent: false }
    // 设备密钥仅 0xFF05 安全配网需要；当前量产固件走 0xFF01 BLE 直配，
    // 云端凭据服务不可用时不应阻断配网流程。
    let credentials = null
    try {
      credentials = await request(
        'POST',
        `/api/v1/device/${encodeURIComponent(id)}/provisioning-credentials`,
        { rotate: !status.deviceKeyPresent },
      )
    } catch (error) {
      if (isBleTransportError(error)) throw error
      credentials = null
    }
    const deviceKey = (credentials && credentials.device_key) || ''
    try {
      return await deviceBridge.provisionWifi({
        deviceId: id,
        ssid,
        password,
        deviceKey,
        onProgress,
      })
    } finally {
      // Avoid retaining raw device credentials beyond this call.
      if (credentials) credentials.device_key = ''
    }
  },

  /* 订阅设备 BLE 主动上报事件（播放开始/结束、WiFi 状态、断连等），返回取消函数 */
  onDeviceEvent(listener) {
    if (deviceBridge && typeof deviceBridge.onEvent === 'function') {
      return deviceBridge.onEvent(listener)
    }
    return () => {}
  },

  async unbind() {
    // OpenAPI does not currently publish an unbind endpoint; retain identity until
    // a server-confirmed unbind is available instead of reporting false success.
    throw serviceError('NOT_CONFIGURED', '云端暂未提供解绑接口')
  },

  async getStatus() {
    const id = getDeviceId()
    const ble = deviceBridge && typeof deviceBridge.getStatus === 'function'
      ? deviceBridge.getStatus(id)
      : { known: false, connected: false, available: false }
    let cloudUnavailable = false
    const [dev, runtime, safety] = await Promise.all([
      Promise.resolve().then(() => request('GET', `/api/v1/device/${id}/status`, undefined,
        { retryColdStart: !ble.connected, cacheTtl: 1000 })).catch(error => {
          if (!ble.connected || !ble.known || !['NETWORK_ERROR', 'SYNC_TIMEOUT', 'HTTP_5XX', 'CLOUD_NOT_CONFIGURED'].includes(error.code)) throw error
          cloudUnavailable = true
          return { device_id: id }
        }),
      Promise.resolve().then(() => request('GET', `/api/v1/device/${id}/runtime/snapshot`, undefined, { cacheTtl: 1000 })).catch(() => ({})),
      ble.connected && deviceBridge && typeof deviceBridge.getSafetyState === 'function'
        ? deviceBridge.getSafetyState(id).then(value => ({ ...value, available: true }))
          .catch(() => ({ available: false }))
        : Promise.resolve({ available: false }),
    ])
    const runtimeFresh = Boolean(runtime.available && runtime.freshness === 'fresh')
    const cloudOnline = dev.device_status === 'online'
    const provisioned = dev.mode ? dev.mode !== 'unprovisioned' : Boolean(ble.known && ble.connected)
    const bleControlAvailable = Boolean(ble.connected && provisioned && safety.available && !safety.stopLatched)
    const online = cloudOnline || Boolean(ble.connected)
    const serialNumber = storageGet('haomian-device-serial') || dev.serial_number || dev.device_id || id
    const hasData = Boolean(dev.has_data)
    const lastEventAt = numberOr(dev.last_event_at, 0)
    const dataSource = dev.data_source || (hasData ? 'device' : 'none')
    const radarStatus = runtimeFresh ? (runtime.radar_status
      || (runtime.capabilities && runtime.capabilities.radar_driver === false ? 'not_installed' : 'unknown')) : 'unknown'
    const modelVersion = runtimeFresh && runtime.model_version ? runtime.model_version : '未核验'
    const firmwareVersion = runtimeFresh && runtime.firmware_version ? runtime.firmware_version : '未核验'
    return {
      deviceId: id,
      bound: true,
      provisioned,
      online,
      cloudOnline,
      cloudUnavailable,
      safety,
      hasData,
      lastEventAt,
      lastNightId: dev.last_night_id || '',
      dataSource,
      // 前端 home/sound/light/tonight 都靠这个字段判断按钮是否可点
      controlAvailable: !(safety.available && safety.stopLatched) && (bleControlAvailable ||
        Boolean(cloudOnline && runtimeFresh && provisioned && runtime.stop_latched === false &&
          runtime.capabilities && runtime.capabilities.actuation_guard === 1 && runtime.pad_status === 'connected')),
      controlTransport: bleControlAvailable ? 'ble' : (cloudOnline ? 'cloud' : 'none'),
      ble,
      mode: dev.mode || 'solo',
      serialNumber,
      firmwareVersion,
      modelVersion,
      host: {
        online,
        firmwareUpdateAvailable: false,
        modelUpdateAvailable: false,
        firmwareVersion,
        modelVersion,
        serialNumber,
      },
      pad: { connected: runtimeFresh && runtime.pad_status === 'connected', status: runtimeFresh ? (runtime.pad_status || 'unknown') : 'unknown' },
      microphones: { status: runtimeFresh ? (runtime.mic_status || 'unknown') : 'unknown', ready: runtimeFresh && runtime.mic_status === 'ready' },
      radar: {
        status: radarStatus,
        ready: radarStatus === 'ready',
        optional: radarStatus === 'not_installed',
      },
      sync: {
        status: hasData ? 'success' : 'empty',
        lastSyncedAt: lastEventAt ? formatEventTime(lastEventAt) : '尚无夜间事件',
        dataSource,
      },
      localLoop: { active: Boolean(runtimeFresh && runtime.capabilities && runtime.capabilities.automatic_enabled === true) },
      runtimeFreshness: runtime.freshness || 'missing',
      agentState: runtime.state || 'STANDBY',
      roundsDone: runtime.rounds_done || 0,
      roundsRemaining: runtime.rounds_remaining || 0,
    }

    function formatEventTime(timestamp) {
      const date = new Date(Number(timestamp) * 1000)
      if (!Number.isFinite(date.getTime())) return '尚无夜间事件'
      const today = new Date()
      const sameDay = date.toDateString() === today.toDateString()
      return `${sameDay ? '今天' : `${date.getMonth() + 1}/${date.getDate()}`} ${date.toTimeString().slice(0, 5)}`
    }
  },

  async resumeManualControl() {
    const id = getDeviceId()
    if (!deviceBridge || typeof deviceBridge.resumeManualControl !== 'function' || !deviceBridge.getStatus(id).connected)
      throw serviceError('DEVICE_OFFLINE', '请先连接设备蓝牙')
    return deviceBridge.resumeManualControl(id)
  },

  async stopAllOutputs() {
    const id = getDeviceId()
    if (deviceBridge && typeof deviceBridge.stopAllOutputs === 'function' && deviceBridge.getStatus(id).connected)
      return deviceBridge.stopAllOutputs(id)
    const queued = await request('POST', `/api/v1/device/${id}/outputs/stop`, {
      request_id: `stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
    })
    const command = await waitForDeviceControlCommand(id, queued)
    const readback = command.readback || {}
    if (readback.stopLatched !== true || readback.outputsStopped !== true || readback.vibrationLevel !== 0)
      throw serviceError('STOP_UNCONFIRMED', '无法确认停止，请长按实体按键 2 秒或断开设备电源')
    return { active: false, stopLatched: true, confirmed: true, physicalFeedback: false, transport: 'mqtt' }
  },

  async runCalibration() {
    const id = getDeviceId()
    const [status, r] = await Promise.all([
      this.getStatus(),
      request('GET', `/api/v1/device/${id}/config`, undefined, { retryColdStart: true }),
    ])
    const online = Boolean(status.bound && status.provisioned && status.host && status.host.online)
    const radarNotInstalled = Boolean(status.radar && status.radar.optional)
    const checks = [
      { id: 'placement', label: '主机放置', ready: online, detail: online ? '主机在线' : '请确认主机在线' },
      { id: 'microphones', label: '双麦克风', ready: Boolean(status.microphones.ready), detail: '请移开遮挡' },
      {
        id: 'radar',
        label: '24G 毫米波雷达（可选）',
        required: false,
        ready: radarNotInstalled || Boolean(status.radar.ready),
        detail: radarNotInstalled ? '当前 demo 未安装雷达，不影响基础流程。' : '雷达未就绪，不影响基础功能。',
      },
      { id: 'pad', label: '枕下定向振动片', ready: Boolean(status.pad.connected), detail: '请确认有线连接' },
    ]
    const ready = checks.filter((item) => item.required !== false).every((item) => item.ready)
    return {
      ready, checks,
      serialNumber: status.host.serialNumber,
      calibrationToken: ready ? `cloud-config:${id}:${r.config_version || 0}` : '',
      guidance: ready ? '设备状态已就绪' : '请完成未通过的检查',
      configVersion: r.config_version || 0,
    }
  },

  async getTonightSettings() {
    const id = getDeviceId()
    const r = await request('GET', `/api/v1/device/${id}/config`)
    return {
      ...normalizeSettings({ ...s2c(r.config || r), sleepMode: r.mode === 'partner' ? 'shared' : 'solo' }),
      configVersion: r.config_version,
      personalStrategy: r.personal_strategy || r.personalStrategy || null,
      name: r.name,
      mode: r.mode,
    }
  },

  async saveTonightSettings(input = {}) {
    const id = getDeviceId()
    const wrapped = input && input.config ? input : { config: input, mode: input.sleepMode }
    const config = normalizeSettings(wrapped.config)
    const mode = (wrapped.mode || config.sleepMode) === 'shared' ? 'partner' : 'solo'
    let expectedConfigVersion = numberOr(
      wrapped.expectedConfigVersion,
      numberOr(input.configVersion, 0),
    )
    if (!expectedConfigVersion) {
      const current = await this.getTonightSettings()
      expectedConfigVersion = current.configVersion
    }
    const queued = await request('POST', `/api/v1/device/${id}/settings-command`, {
      config: toBackendSettings(config),
      mode,
      expected_config_version: expectedConfigVersion,
    })
    const commandId = queued && queued.command && (queued.command.command_id || queued.command.commandId)
    if (!commandId) throw serviceError('SYNC_TIMEOUT', '设置命令未创建')
    let command = normalizeCommand(queued.command)
    for (let attempt = 0; attempt < 20 && ['pending', 'readback-pending', 'ack-accepted'].includes(command.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const response = await request(
        'GET',
        `/api/v1/device/${id}/commands/${commandId}`,
        undefined,
        { cacheTtl: 0 },
      )
      command = normalizeCommand(response.command || response)
    }
    if (command.status !== 'applied' || command.matchesCandidate !== true || !command.readbackSettings) {
      throw serviceError(
        command.status === 'readback-mismatch' ? 'READBACK_MISMATCH' : 'SYNC_TIMEOUT',
        '月石尚未确认今晚设置',
      )
    }
    return {
      ...command.readbackSettings,
      sleepMode: mode === 'partner' ? 'shared' : 'solo',
      configVersion: command.currentConfigVersion,
      mode,
    }
  },

  async getSoundState() {
    const id = getDeviceId()
    return readControlState(id, 'sound', normalizeSound)
  },

  async updateSound(patch) {
    const id = getDeviceId()
    const current = await this.getSoundState()
    const desired = normalizeSound({ ...current, ...(patch || {}) })
    if (hasBleIo(id)) {
      const result = await deviceBridge.applySound(id, current, desired, patch || {})
      return saveConfirmedControl(id, 'sound', desired, patch || {}, result)
    }
    const queued = await request('POST', `/api/v1/device/${id}/sound-command`, { patch: patch || {} })
    await waitForDeviceControlCommand(id, queued)
    return this.getSoundState()
  },

  async listSoundEffects() {
    const id = getDeviceId()
    if (!deviceBridge || typeof deviceBridge.listSfx !== 'function') {
      throw serviceError('NOT_CONFIGURED', '当前 BLE 适配器不支持设备音效列表')
    }
    return deviceBridge.listSfx(id)
  },

  async uploadSoundEffect({ filePath, name, onProgress } = {}) {
    const id = getDeviceId()
    if (!filePath) throw serviceError('INVALID_AUDIO_DATA', '请选择 WAV 文件')
    if (!deviceBridge || typeof deviceBridge.uploadWav !== 'function') {
      throw serviceError('NOT_CONFIGURED', '当前 BLE 适配器不支持音效传输')
    }
    const fileSystem = typeof wx.getFileSystemManager === 'function'
      ? wx.getFileSystemManager()
      : null
    if (!fileSystem || typeof fileSystem.readFile !== 'function') {
      throw serviceError('NOT_CONFIGURED', '当前微信环境无法读取本地音效文件')
    }
    const wavData = await new Promise((resolve, reject) => {
      fileSystem.readFile({
        filePath,
        success(result) { resolve(result.data) },
        fail(error) {
          reject(serviceError('INVALID_AUDIO_DATA', String(error && error.errMsg || '无法读取 WAV 文件')))
        },
      })
    })
    return deviceBridge.uploadWav({
      deviceId: id,
      name,
      wavData,
      onProgress,
    })
  },

  async getLightState() {
    const id = getDeviceId()
    return readControlState(id, 'light', normalizeLight)
  },

  async updateLight(patch) {
    const id = getDeviceId()
    const current = await this.getLightState()
    const desired = normalizeLight({ ...current, ...(patch || {}), color: (patch && patch.color) || current.color })
    const controlPatch = { ...(patch || {}), color: desired.color }
    if (hasBleIo(id)) {
      const result = await deviceBridge.applyLight(id, desired, controlPatch)
      return saveConfirmedControl(id, 'light', desired, controlPatch, result)
    }
    const queued = await request('POST', `/api/v1/device/${id}/light-command`, { patch: controlPatch })
    await waitForDeviceControlCommand(id, queued)
    return this.getLightState()
  },

  async getDemoStates() {
    const id = getDeviceId()
    const r = await request('GET', `/api/v1/device/${id}/demo-states`)
    return s2c(r.demoStates || r.demo_states || r)
  },

  async setDemoState({ kind, enabled }) {
    const id = getDeviceId()
    const r = await request('PUT', `/api/v1/device/${id}/demo-states`, { kind, enabled })
    return s2c(r.demoStates || r.demo_states || r)
  },

  async applyTonightCandidate({ candidateId, expectedConfigVersion } = {}) {
    const id = getDeviceId()
    try {
      const r = await request('POST', `/api/v1/device/${id}/apply-candidate`, {
        candidateId, expectedConfigVersion,
      })
      return normalizeCommand(s2c(r.command || r))
    } catch (e) {
      throw toServiceError(e)
    }
  },

  async getActiveSettingsCommand() {
    const id = getDeviceId()
    const r = await request('GET', `/api/v1/device/${id}/settings-command/active`, undefined, { cacheTtl: 0 })
    return r && (r.command ? normalizeCommand(s2c(r.command)) : null)
  },

  async getSettingsCommand(commandId) {
    const id = getDeviceId()
    try {
      const r = await request('GET', `/api/v1/device/${id}/settings-command/${commandId}`, undefined, { cacheTtl: 0 })
      return normalizeCommand(s2c(r.command || r))
    } catch (e) {
      throw toServiceError(e)
    }
  },

  async reconcileSettingsCommand(commandId) {
    const id = getDeviceId()
    try {
      const r = await request('POST', `/api/v1/device/${id}/settings-command/${commandId}/reconcile`, {})
      return normalizeCommand(s2c(r.command || r))
    } catch (e) {
      throw toServiceError(e)
    }
  },
}

// ═══════════════════════════════════════
// Reports（晨报 / 周报 / 事件 / 反馈）
// ═════════════════════════════════════===

const reports = {
  async getLatest({ nightId } = {}) {
    const id = getDeviceId()
    // Report data must never wait for an external LLM. AI has a separate endpoint.
    const path = nightId
      ? `/api/v1/morning_report/${id}?night_id=${encodeURIComponent(nightId)}&generate_ai=false`
      : `/api/v1/morning_report/${id}?generate_ai=false`
    const r = await request('GET', path, undefined, { retryColdStart: true, cacheTtl: 8000 })
    return translateMorningReport(r)
  },

  async getEvents({ nightId, type, limit = 100 } = {}) {
    const id = getDeviceId()
    const path = nightId
      ? `/api/v1/events/${id}/night/${encodeURIComponent(nightId)}`
      : `/api/v1/events/${id}`
    const separator = path.includes('?') ? '&' : '?'
    const r = await request('GET', `${path}${separator}limit=${Math.max(1, Math.min(100, Number(limit) || 100))}`, undefined, { cacheTtl: 5000 })
    const events = Array.isArray(r) ? r : (r.events || [])
    let out = events
      .map(translateEvent)
      .filter(Boolean)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
    if (type && type !== 'all') {
      out = out.filter(e => e.eventType === type)
    }
    return out
  },

  async getSevenNightTrend({ days = 7 } = {}) {
    const id = getDeviceId()
    const r = await request('GET', `/api/v1/weekly/${id}?days=${Math.max(1, Math.min(30, Number(days) || 7))}`, undefined, { retryColdStart: true, cacheTtl: 15000 })
    // 19 页面 wxml 期待 nights.map() —— 必须返回数组
    // mock 契约：[{date, valid, snoreEvents, interventions, successRate, quality, barHeight}]
    const translated = translateWeeklyTrend(r)
    const nights = translated.nights_list || []
    nights.dataSource = translated.dataSource || 'none'
    return nights
  },

  async submitFeedback(input = {}) {
    const { nightId, comment } = input
    // Accept the mock-facing feedback fields and the older real-facing aliases.
    const FEELING_MAP = { terrible: 1, bad: 2, okay: 3, good: 4, great: 5 }
    const sourceFeeling = input.nextDayEnergy == null ? input.morningFeeling : input.nextDayEnergy
    const feelingInt = typeof sourceFeeling === 'number'
      ? Math.max(1, Math.min(5, Math.round(sourceFeeling)))
      : (FEELING_MAP[String(sourceFeeling).toLowerCase()] || 3)
    const wasDisturbed = input.wasDisturbed == null ? input.awakened : input.wasDisturbed
    const r = await request('POST', '/api/v1/morning_feedback', {
      device_id: getDeviceId(),
      night_id: nightId,
      was_disturbed: !!wasDisturbed,
      morning_feeling: feelingInt,
      partner_affected: typeof input.partnerAffected === 'boolean' ? input.partnerAffected : null,
      comment: comment || '',
    })
    return wrapFeedback(r.feedback || r)
  },

  async getFeedback(nightId) {
    const id = getDeviceId()
    // 支持 getFeedback() 无参 或 getFeedback(nightId) 字符串 或 getFeedback({nightId}) 对象
    const target = typeof nightId === 'object' && nightId ? nightId.nightId : nightId
    const r = await request('GET', `/api/v1/morning_feedback/${id}?limit=7`, undefined, { cacheTtl: 10000 })
    // 后端返回 { feedbacks: [...] }，同时兼容旧版数组
    const items = Array.isArray(r) ? r : (r.feedbacks || r.feedback || [])
    if (!target) return items.map(f => wrapFeedback(f))
    const found = items.find(f => f.night_id === target)
    return found ? wrapFeedback(found) : null
  },
}

// ═══════════════════════════════════════
// 字段翻译
// ═══════════════════════════════════════

function observedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function translateMorningReport(r) {
  if (!r) return null
  const stats = r.reminder_stats || {}
  const wt = r.weekly_trend || {}
  const ai = r.ai_interpretation || {}
  const timeline = Array.isArray(r.timeline) ? r.timeline : []
  const candidateObservationCount = timeline.filter((event) => (
    event && ['snore_candidate', 'audio_candidate_local'].includes(event.event_type)
  )).length
  const confirmedSnoreCount = timeline.filter((event) => (
    event && ['snore_detected', 'snore_start'].includes(event.event_type)
  )).length
  // Candidate observations are real device-derived data, but not confirmed diagnoses.
  const snoreEventCount = confirmedSnoreCount + candidateObservationCount

  const interventionCount = stats.total_count || 0
  const successCount = stats.success_count || 0
  const successRate = observedNumber(stats.success_rate)
  const timestamps = timeline.map((event) => Number(event.timestamp)).filter(Number.isFinite)
  const eventCount = numberOr(r.event_count, timeline.length)
  const hasData = typeof r.has_data === 'boolean' ? r.has_data : eventCount > 0
  const effectiveMonitoringMinutes = observedNumber(r.effective_monitoring_minutes)
  const supineAssociationRate = hasData ? observedNumber(r.supine_association_rate) : null
  const snoreStopped = observedNumber(r.snore_stopped_responses)
  const turnOver = observedNumber(r.turn_over_responses)
  const startTime = r.start_time || (timestamps.length ? new Date(Math.min(...timestamps) * 1000).toTimeString().slice(0, 5) : '')
  const endTime = r.end_time || (timestamps.length ? new Date(Math.max(...timestamps) * 1000).toTimeString().slice(0, 5) : '')
  return {
    // 前端要 id（mock 用法）
    id: r.night_id,
    nightId: r.night_id,
    date: r.date || '',
    hasData,
    eventCount,
    dataSource: r.data_source || (hasData ? 'device' : 'none'),
    // 19 字段（mock 契约）
    effectiveMonitoringMinutes,
    snoreEventCount,
    candidateObservationCount,
    soundObservationLabel: candidateObservationCount > 0 && confirmedSnoreCount === 0
      ? '声音候选'
      : '鼾声趋势',
    supineAssociationRate,
    supineSnoreTrend: !hasData ? '暂无有效数据' : (r.supine_snore_trend || '缺少体位关联评估'),
    interventionCount,
    snoreStoppedResponses: snoreStopped,
    turnOverResponses: turnOver,
    interventionSuccessRate: successRate === null ? null : Math.round(successRate * 100),
    dataQuality: r.data_quality || (hasData ? '未评估' : '无有效数据'),
    dataQualityScore: observedNumber(r.data_quality_score),
    startTime,
    endTime,
    timelineMarks: r.timeline_marks || (timestamps.length > 1 && Math.max(...timestamps) > Math.min(...timestamps)
      ? timestamps.map(time => (time - Math.min(...timestamps)) * 100 / (Math.max(...timestamps) - Math.min(...timestamps))) : []),
    attentionLevel: r.attention_level || 'unknown',
    safetyNotice: '用于趋势观察与体位提醒，不替代医疗检查',
    // 兼容老字段
    sourceTag: r.source_tag,
    timeline,
    summary: {
      interventionCount,
      successCount,
      successRate,
      avgResponseSec: observedNumber(stats.avg_response_sec),
      maxLevel: stats.max_level || 0,
      peakHour: stats.peak_hour,
      snoreEventCount,
      eventCount,
      hasData,
      dataSource: r.data_source || (hasData ? 'device' : 'none'),
      startTime,
      endTime,
      dataQuality: r.data_quality || (hasData ? '未评估' : '无有效数据'),
      dataQualityScore: observedNumber(r.data_quality_score),
    },
    weeklyTrend: translateWeeklyTrend(wt),
    aiInterpretation: ai && Object.keys(ai).length ? ai : null,
  }
}

function translateEvent(e) {
  if (!e) return null
  // 后端 event_type → 前端 type
  const typeMap = {
    'snore_detected': 'snore',
    'snore_start': 'snore',
    'snore_candidate': 'snore',
    'audio_candidate_local': 'snore',
    'snore_stop': 'snore-stop',
    'intervention_start': 'intervention',
    'intervention': 'intervention',
    'response': 'response',
    'position_change': 'response',
    'vibration_stop': 'response',
    'verification_success': 'response',
    'sleep_protection': 'sleep-protection',
    'bedtime': 'bedtime',
    'in_bed': 'bedtime',
    'body_motion': 'motion',
    'wake_up': 'wake-up',
  }
  const type = typeMap[e.event_type] || e.event_type || 'event'
  // 时间戳 → HH:MM
  let time = ''
  if (e.timestamp) {
    const d = new Date(typeof e.timestamp === 'number' ? e.timestamp * 1000 : e.timestamp)
    time = d.toTimeString().slice(0, 5)
  } else if (e.created_at) {
    time = new Date(e.created_at * 1000).toTimeString().slice(0, 5)
  }
  // 标题/详情
  let title = ''
  let detail = ''
  if (type === 'snore') {
    const isCandidate = ['snore_candidate', 'audio_candidate_local'].includes(e.event_type)
    title = isCandidate ? '声音候选已记录' : '鼾声趋势上升'
    detail = isCandidate
      ? `${e.event_type === 'audio_candidate_local' ? '设备本地' : '云端'}完成候选观察（置信度 ${(e.snore_confidence || 0).toFixed(2)}），不等同于诊断`
      : `本地规则完成判断（置信度 ${(e.snore_confidence || 0).toFixed(2)}）`
  } else if (type === 'intervention') {
    title = '渐进振动提醒'
    const dur = e.vibration_duration_ms ? Math.round(e.vibration_duration_ms / 1000) : 24
    detail = `第 ${e.vibration_level || 1} 级，${dur} 秒后停止`
  } else if (type === 'response') {
    title = e.event_type === 'verification_success' ? '提醒响应已确认' : '检测到翻身响应'
    detail = `趋势回落，验证后停止（响应 ${e.response_time_sec || 0} 秒）`
  } else if (type === 'snore-stop') {
    title = '声音趋势回落'
    detail = '月石已暂停振动并进入响应验证'
  } else if (type === 'sleep-protection') {
    title = '入睡保护结束'
    detail = '设备开始本地趋势观察'
  } else if (type === 'bedtime') {
    title = e.event_type === 'in_bed' ? '已上床' : '开始夜间观察'
    detail = e.event_type === 'in_bed' ? '开始记录本晚结构化事件' : '入睡保护启动'
  } else if (type === 'motion') {
    title = '检测到体动'
    detail = e.body_motion_level != null ? `体动强度 ${(Number(e.body_motion_level) || 0).toFixed(2)}` : ''
  } else if (type === 'wake-up') {
    title = '起床'
    detail = '本晚记录结束'
  } else {
    title = e.event_type || '事件'
    detail = e.note || ''
  }
  return {
    id: e.id,
    deviceId: e.device_id,
    nightId: e.night_id,
    timestamp: e.timestamp,
    time,         // 前端 wxml 用 item.time
    type,         // 前端 wxml 用 item.type
    title,        // 前端 wxml 用 item.title
    detail,       // 前端 wxml 用 item.detail
    // 保留原始字段供高级查询
    eventType: e.event_type,
    snoreDurationSec: e.snore_duration_sec,
    snoreConfidence: e.snore_confidence,
    inBed: e.in_bed,
    bodyMotionLevel: e.body_motion_level,
    vibrationLevel: e.vibration_level,
    vibrationDurationMs: e.vibration_duration_ms,
    result: e.result,
    responseTimeSec: e.response_time_sec,
    roundInNight: e.round_in_night,
    modelVersion: e.model_version,
    errorCode: e.error_code,
    note: e.note,
  }
}

function translateWeeklyTrend(r) {
  if (!r) return null
  const daily = Array.isArray(r.daily) ? r.daily : []
  const byDate = new Map(daily.map((item) => [String(item.date || '').replace(/-/g, ''), item]))
  const latestDailyKey = daily
    .map((item) => String(item.date || '').replace(/-/g, ''))
    .filter((value) => /^\d{8}$/.test(value))
    .sort()
    .pop()
  const anchor = latestDailyKey
    ? new Date(Number(latestDailyKey.slice(0, 4)), Number(latestDailyKey.slice(4, 6)) - 1, Number(latestDailyKey.slice(6, 8)))
    : new Date()
  if (!latestDailyKey && anchor.getHours() < 18) anchor.setDate(anchor.getDate() - 1)
  const dateKeys = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(anchor)
    date.setDate(anchor.getDate() - offset)
    dateKeys.push(`${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`)
  }
  // Always return seven chronological slots so missing nights are explicit.
  const nights_list = dateKeys.map((dateKey) => {
    const d = byDate.get(dateKey) || { date: dateKey }
    const totalRounds = d.total_rounds || 0
    const eventCount = numberOr(d.event_count, totalRounds)
    const valid = eventCount > 0
    const rawRate = numberOr(d.success_rate, 0)
    return {
      date: `${dateKey.slice(4, 6)}/${dateKey.slice(6, 8)}`,
      rawDate: dateKey,
      nightId: d.night_id,
      valid,
      snoreEvents: d.snore_event_count || totalRounds,
      interventions: totalRounds,
      eventCount,
      successRate: Math.round(rawRate <= 1 ? rawRate * 100 : rawRate),
      quality: valid ? observedNumber(d.data_quality_score) : null,
      barHeight: valid ? Math.max(30, Math.min(150, totalRounds * 5)) : 18,
    }
  })
  return {
    nights: nights_list.filter((night) => night.valid).length,
    totalRounds: r.total_rounds || 0,
    successRounds: r.success_rounds || 0,
    successRate: r.success_rate || 0,
    avgRoundsPerNight: r.avg_rounds_per_night || 0,
    trend: r.trend || 'stable',
    dataSource: r.data_source || 'none',
    // 前端 wxml 用 nights.*.date / .valid / .snoreEvents
    nights_list,
    // 兼容老字段
    daily: daily.map(d => ({
      date: d.date,
      nightId: d.night_id,
      totalRounds: d.total_rounds,
      successRounds: d.success_rounds,
      successRate: d.success_rate,
      maxLevel: d.max_level,
    })),
  }
}

// ═══════════════════════════════════════
// AI（解读 / 聊天 / 候选 / 历史）
// ═════════════════════════════════════===

function wrapFeedback(f) {
  if (!f) return null
  // morning_feeling 是 1-5 int，前端可能读 comfort 字符串
  const feeling = f.morning_feeling
  const comfort = feeling >= 4 ? 'comfortable' : feeling === 3 ? 'okay' : 'uncomfortable'
  return {
    id: f.id,
    deviceId: f.device_id,
    userId: f.user_id,
    nightId: f.night_id,
    wasDisturbed: Boolean(f.was_disturbed),
    awakened: Boolean(f.awakened == null ? f.was_disturbed : f.awakened),
    // Keep compatibility with older responses that did not include partner feedback.
    partnerAffected: typeof f.partner_affected === 'boolean' ? f.partner_affected : (typeof f.partnerAffected === 'boolean' ? f.partnerAffected : null),
    morningFeeling: feeling,
    nextDayEnergy: Math.max(1, Math.min(5, numberOr(feeling, 3))),
    comfort,
    // 前端 trends/report 用 wasDisturbed/comment/createdAt
    comment: f.comment || '',
    createdAt: f.created_at,
  }
}

// 通用 interpretation 包装器 —— 后端 /ai/interpretation 返回基础 LLM 解读
// 包装为前端 interpretation 对象（17 字段 mock 契约）
function wrapInterpretation(ai, scope, nightId) {
  if (!ai) return null
  const isWeek = scope === 'seven-night'
  const basis = Array.isArray(ai.basis) ? ai.basis : []
  // evidence 数组：basis.map 推 3 条结构化证据（前端 wxml 用 evidence[].metric/value/unit/window/explanation）
  const evidence = basis.map((text, i) => ({
    id: `ev-real-${i}`,
    metric: i === 0 ? '整体响应' : i === 1 ? '趋势' : '观察项',
    value: text.length,
    unit: '项',
    window: isWeek ? '7 晚' : '昨夜',
    sourceRefs: [`summary:${nightId || 'current'}`],
    quality: 'good',
    explanation: text,
  }))
  // periodStart/periodEnd：7 晚解读用最近 7 天推算，单晚用当天
  let periodStart = ai.period_start
  let periodEnd = ai.period_end
  if (isWeek && !periodStart) {
    const end = new Date()
    const start = new Date()
    start.setDate(end.getDate() - 6)
    periodStart = start.toISOString().slice(0, 10)
    periodEnd = end.toISOString().slice(0, 10)
  }
  return {
    interpretationId: ai.interpretation_id
      || (isWeek ? `week-${nightId || 'current'}-r1` : `night-${nightId || 'current'}-r1`),
    kind: isWeek ? 'seven-night' : 'single-night',
    nightId: isWeek ? null : (nightId || ai.night_id || ''),
    periodStart: isWeek ? periodStart : null,
    periodEnd: isWeek ? periodEnd : null,
    timezone: isWeek ? 'Asia/Shanghai' : null,
    status: 'ready',
    hasData: ai.has_data !== false,
    eventCount: numberOr(ai.event_count, 0),
    source: ai.source || 'llm',
    sourceLabel: ai.source === 'llm' ? '云端 AI 解读' : '本地规则',
    generatedAt: ai.generated_at || new Date().toISOString(),
    periodLabel: isWeek ? '最近 7 晚' : (ai.date ? ai.date + ' 昨夜' : '昨夜'),
    revision: ai.revision || 1,
    modelVersion: 'SnoozMate Insight 0.9',
    inputSnapshotVersion: 'night-summary-v1',
    dataQuality: '良好',
    consentVersion: 'privacy-v1',
    conclusion: ai.summary || '',
    summary: ai.summary || '',
    nextStep: ai.tonight_suggestion || ai.next_step || '继续观察',
    evidence,
  }
}

async function requireAiAuthorization() {
  const profile = await auth.getProfile()
  if (!profile.aiDataAuthorized) throw serviceError('AI_CONSENT_REQUIRED', '请先允许 AI 使用结构化睡眠资料')
  return profile
}

const ai = {
  async getOverview(scope = 'single-night') {
    await requireAiAuthorization()
    const id = getDeviceId()
    const r = await request('GET', `/api/v1/ai/interpretation/${id}`, undefined, { timeout: 35000, cacheTtl: 10000 })
    const inner = { ...((r && r.ai_interpretation) || {}), has_data: r && r.has_data, event_count: r && r.event_count }
    return wrapInterpretation(inner, scope, r.night_id)
  },

  
  async getRecords({ kind } = {}) {
    await requireAiAuthorization()
    const id = getDeviceId()
    const r = await request('GET', `/api/v1/ai/interpretation/${id}`, undefined, { timeout: 35000, cacheTtl: 10000 })
    const inner = { ...((r && r.ai_interpretation) || {}), has_data: r && r.has_data, event_count: r && r.event_count }
    const single = wrapInterpretation(inner, 'single-night', r.night_id)
    const week = wrapInterpretation(inner, 'seven-night', r.night_id)
    const all = [single, week].filter(Boolean)
    return kind ? all.filter(x => x.kind === kind) : all
  },

  async getChatSessions() {
    try {
      const stored = wx.getStorageSync('haomian-ai-chat-sessions') || []
      return stored.map(s => ({
        sessionId: s.sessionId || s.id,
        title: s.title || '新对话',
        preview: s.messages && s.messages.length ? (s.messages[s.messages.length - 1].text || '') : '',
        updatedAt: s.updatedAt || s.updated_at || new Date().toISOString(),
        messages: s.messages || [],
        interpretationId: s.interpretationId,
        interpretationRevision: s.interpretationRevision,
        contextTitle: s.contextTitle,
        contextConclusion: s.contextConclusion,
        contextSummary: s.contextSummary,
        conversationSummary: s.conversationSummary,
        carriedMemory: s.carriedMemory,
      }))
    } catch { return [] }
  },

  async getChatSession(input) {
    const sessionId = typeof input === 'string' ? input : input && input.sessionId
    try {
      const stored = wx.getStorageSync('haomian-ai-chat-sessions') || []
      return stored.find(s => (s.sessionId || s.id) === sessionId) || null
    } catch { return null }
  },

  async saveChatSession(session = {}) {
    try {
      const stored = wx.getStorageSync('haomian-ai-chat-sessions') || []
      const sid = session.sessionId || session.id || `ai-chat-${Date.now()}`
      const idx = stored.findIndex(s => (s.sessionId || s.id) === sid)
      const next = { ...session, sessionId: sid, updatedAt: new Date().toISOString() }
      if (idx >= 0) stored[idx] = next
      else stored.unshift(next)
      const trimmed = stored.slice(0, 30)
      wx.setStorageSync('haomian-ai-chat-sessions', trimmed)
      return next
    } catch { return session }
  },

  async getInterpretation(input = {}) {
    await requireAiAuthorization()
    const source = typeof input === 'string' ? { interpretationId: input } : input
    const { interpretationId, nightId } = source
    const id = getDeviceId()
    const r = await request('GET', `/api/v1/ai/interpretation/${id}`, undefined, { timeout: 35000 })
    const inner = { ...((r && r.ai_interpretation) || {}), has_data: r && r.has_data, event_count: r && r.event_count }
    const scope = interpretationId && interpretationId.includes('week') ? 'seven-night' : 'single-night'
    return wrapInterpretation(inner, scope, nightId || r.night_id)
  },

  async ask({ message, question, interpretationId, recentMessages = [], conversationSummary = '' } = {}) {
    await requireAiAuthorization()
    const text = (message || question || '').toString().trim()
    if (!text) throw new Error('AI_MESSAGE_REQUIRED')
    const id = getDeviceId()
    const r = await request('POST', '/api/v1/ai/chat', {
      device_id: id,
      message: text,
      interpretation_id: interpretationId || '',
      chat_history: recentMessages
        .filter((item) => item && ['user', 'assistant'].includes(item.role) && (item.text || item.content))
        .slice(-12)
        .map((item) => ({ role: item.role, content: item.text || item.content })),
      conversation_summary: conversationSummary,
    }, { timeout: 35000 })
    const sections = r.sections && Object.values(r.sections).some(Boolean)
      ? r.sections
      : {
        canExplain: '可以解释已记录的事件、提醒次数、响应率和连续趋势。',
        cannotDetermine: '不能据此进行医疗诊断，也不能给出用药建议。',
        nextStep: '继续保持设备在线并结合晨间感受观察变化。',
      }
    return {
      role: 'assistant',
      id: 'ai-' + Date.now(),
      text: r.answer || r.text || '',
      answer: r.answer || r.text || '',
      sections,
      actions: r.actions || [],
      answerKind: r.answerKind || r.answer_kind || (r.source === 'llm' ? 'trend' : 'data-unavailable'),
      safetyClass: r.safetyClass || r.safety_class || 'trend',
      evidenceRefs: r.evidenceRefs || r.evidence_refs || [],
      messageId: r.messageId || r.message_id,
      source: r.source || 'llm',
      contextUsed: r.context_used || null,
    }
  },

  async getTonightCandidate(interpretationId) {
    await requireAiAuthorization()
    const id = getDeviceId()
    const [existing, currentSettings] = await Promise.all([
      request('GET', `/api/v1/candidates/${id}?status=pending`, undefined, { cacheTtl: 2000 }),
      device.getTonightSettings(),
    ])
    const candidates = existing && Array.isArray(existing.candidates) ? existing.candidates : []
    let cand = candidates.find(
      (item) => numberOr(item && item.expected_config_version, -1) === currentSettings.configVersion,
    ) || null
    if (!cand) {
      const generated = await request('POST', `/api/v1/weekly/${id}/generate_candidate`)
      cand = (generated && generated.candidate) || generated || {}
    }
    let basis = cand.basis
    if (typeof basis === 'string') {
      try { basis = JSON.parse(basis) } catch { basis = [] }
    }
    return {
      candidateId: cand.candidate_id,
      currentSettings,
      currentConfigVersion: cand.expected_config_version || currentSettings.configVersion || 0,
      interpretationId: cand.interpretation_id || interpretationId || '',
      candidateSettings: normalizeSettings(s2c(cand.suggested_config || cand.candidate_settings || {})),
      rationale: cand.summary || '基于近期趋势的参数建议',
      summary: cand.summary || '',
      basis: Array.isArray(basis) ? basis : [],
      source: cand.source || 'ai',
      createdAt: cand.created_at || '刚刚',
      expiresAt: cand.expires_at || '明天 06:00',
    }
  },
}

// ═══════════════════════════════════════
// Guardian（实时守护 / 演示阶段）
// ═════════════════════════════════════===

const guardian = {
  async getSnapshot() {
    const id = getDeviceId()
    const runtime = await request('GET', `/api/v1/device/${id}/runtime/snapshot`, undefined, { cacheTtl: 500 })
    const stateMap = {
      STANDBY: 'observing',
      MONITORING: 'observing',
      CONFIRMING: 'deciding',
      INTERVENTION: 'intervening',
      VERIFYING: 'verifying',
      COOLDOWN: 'observing',
      SAFETY_LOCKED: 'stopped',
    }
    const runtimeFresh = Boolean(runtime.available && runtime.freshness === 'fresh')
    const state = runtimeFresh ? (stateMap[runtime.state] || 'delayed') : 'delayed'
    const sequence = runtime.sequence || 0
    const cycleId = runtimeFresh && ['intervening', 'verifying'].includes(state)
      ? (runtime.cycle_id || null)
      : null
    const receivedAt = runtime.received_at
      ? new Date(Number(runtime.received_at) * 1000).toISOString()
      : null
    return {
      deviceId: id,
      nightId: runtime.night_id || '',
      sessionId: runtime.session_id || '',
      snapshotId: runtime.available ? `runtime-${sequence}` : '',
      sequence,
      deviceTime: runtime.device_time ? new Date(Number(runtime.device_time) * 1000).toISOString() : null,
      receivedAt,
      validUntil: runtime.received_at ? new Date((Number(runtime.received_at) + 15) * 1000).toISOString() : null,
      source: 'device-runtime',
      freshness: runtime.freshness || 'missing',
      guardianState: state,
      state,
      cycleId,
      enteredAt: receivedAt,
      activeIntervention: cycleId ? {
        level: runtime.active_level || 1,
        startedAt: receivedAt,
        elapsedSeconds: 0,
      } : null,
      protectionRemainingSeconds: runtime.protection_remaining_seconds || 0,
      interventionCount: runtime.rounds_done || 0,
      interventionLimit: (runtime.rounds_done || 0) + (runtime.rounds_remaining || 0),
      micStatus: runtime.mic_status || 'offline',
      radarStatus: runtime.radar_status
        || (runtime.capabilities && runtime.capabilities.radar_driver === false ? 'not_installed' : 'offline'),
      padStatus: runtime.pad_status || 'disconnected',
      stopResult: null,
      reasonCodes: [runtime.available ? `LOCAL_${String(runtime.state || 'UNKNOWN')}` : 'RUNTIME_MISSING'],
      configVersion: runtime.config_version || 0,
      cloudRealtime: {
        mqttConnected: Boolean(runtime.mqtt_connected || (runtime.mqtt && runtime.mqtt.connected)),
        audioEnabled: Boolean(runtime.mqtt_audio_enabled || (runtime.mqtt && runtime.mqtt.audio_enabled)),
        audioQueueDepth: numberOr(runtime.mqtt_audio_queue_depth || (runtime.mqtt && runtime.mqtt.audio_queue_depth), 0),
        audioDropped: numberOr(runtime.mqtt_audio_dropped || (runtime.mqtt && runtime.mqtt.audio_dropped), 0),
        lastDecision: runtime.cloud_decision || runtime.mqtt_last_command || '',
      },    }
  },

  async stopCurrentIntervention({ snapshotId, cycleId } = {}) {
    const id = getDeviceId()
    const created = await request('POST', `/api/v1/device/${id}/intervention/stop`, {
      snapshot_id: snapshotId || '',
      cycle_id: cycleId || '',
    })
    const commandId = created && created.command && (created.command.command_id || created.command.commandId)
    if (!commandId) throw serviceError('SYNC_TIMEOUT', '停止命令未创建')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const response = await request('GET', `/api/v1/device/${id}/commands/${commandId}`, undefined, { cacheTtl: 0 })
      const command = response && response.command
      if (command && command.status === 'applied') {
        return { ...(await this.getSnapshot()), guardianState: 'stopped', cycleId: null, activeIntervention: null, stopResult: 'confirmed' }
      }
      if (command && ['rejected', 'failed', 'expired'].includes(command.status)) {
        throw serviceError('SYNC_TIMEOUT', '月石未确认停止，请检查设备连接')
      }
    }
    const snapshot = await this.getSnapshot()
    return {
      ...snapshot,
      guardianState: 'stop-pending',
      stopResult: 'pending',
    }
  },

  async setDemoPhase(input = {}) {
    const phase = typeof input === 'string' ? input : input.phase
    // 后端通过 demo-states 演示
    const id = getDeviceId()
    const kindMap = {
      'offline': { kind: 'offline', enabled: true },
      'unprovisioned': { kind: 'unprovisioned', enabled: true },
      'pad-disconnected': { kind: 'pad-disconnected', enabled: true },
      'no-data': { kind: 'no-data', enabled: true },
      'sync-failed': { kind: 'sync-failed', enabled: true },
      'high-attention': { kind: 'high-attention', enabled: true },
      'firmware-update': { kind: 'firmware-update', enabled: true },
      'model-update': { kind: 'model-update', enabled: true },
      'reset': { kind: 'offline', enabled: false },
    }
    const patch = kindMap[phase] || { kind: phase, enabled: true }
    const r = await request('PUT', `/api/v1/device/${id}/demo-states`, patch)
    return this.getSnapshot()
  },
}

// ═══════════════════════════════════════
// 工厂导出
// ═══════════════════════════════════════

function createRealServices() {
  return {
    serviceMode: 'real',
    configured: true,
    transport: env.transport,
    initializeCloudContainer,
    configureDeviceBridge,
    auth,
    device,
    reports,
    ai,
    guardian,
  }
}

function toBackendSettings(input) {
  const settings = normalizeSettings(input)
  const thresholds = { 1: 0.75, 2: 0.65, 3: 0.55 }
  return {
    max_rounds_per_night: settings.nightlyInterventionLimit,
    fall_asleep_protection: settings.sleepProtectionMinutes * 60,
    max_vibration_level: settings.maxVibrationLevel,
    snore_confidence_threshold: thresholds[settings.sensitivity],
  }
}

module.exports = {
  createRealServices,
  __test__: {
    c2s,
    getClientId,
    initializeCloudContainer,
    invalidateSession,
    normalizeCommand,
    normalizePhoneWifiList,
    normalizeLight,
    normalizeSettings,
    normalizeSound,
    request,
    s2c,
    toBackendSettings,
    translateMorningReport,
    translateEvent,
    translateWeeklyTrend,
    wrapFeedback,
    wrapInterpretation,
    wrapProfile,
  },
}
