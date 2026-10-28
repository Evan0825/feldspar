const services = require('../../services/index')
const env = require('../../config/env')
const { initialSetupState, transitionSetup } = require('../../domain/setup-machine')
const { normalizeSerialNumber, isValidSerialNumber, matchesDiscoveredDevice } = require('../../domain/device-identity')

const errorCopy = {
  BLUETOOTH_UNAVAILABLE: '当前微信环境不支持蓝牙，请使用微信真机并升级微信版本。',
  BLUETOOTH_DISABLED: '请打开手机蓝牙后重试',
  BLUETOOTH_PERMISSION_DENIED: '请在微信的小程序设置中允许蓝牙和位置信息权限。',
  LOCATION_DISABLED: '安卓蓝牙扫描需要开启手机定位服务，请开启后重试。',
  NOT_FOUND: '附近没有发现月石床头主机',
  CONNECT_FAILED: '连接没有完成，请靠近设备重试',
  INVALID_SN: '设备标识格式不正确，请扫码或输入 HAOMIAN-SLEEP_ 后跟 6 位十六进制字符。',
  IDENTITY_MISMATCH: '扫码 SN 与附近设备不一致，请重新搜索。',
  MULTIPLE_DEVICES: '附近发现多台月石，请仅保留需要连接的设备处于配对状态。',
  ALREADY_BOUND: '该月石床头主机已被绑定，请先在原账号解绑。',
  PROVISION_TIMEOUT: '蓝牙连接超时，请靠近主机后重试。',
  AUTH_EXPIRED: '登录状态已过期，请重新授权后继续。',
}

Page({
  data: {
    machine: initialSetupState(),
    serialNumber: '',
    errorMessage: '',
    errorCode: '',
    errorAction: '',
    scanFeedback: '',
    demoMode: Boolean(env.demoMode),
    wifiNetworks: [],
    selectedSsid: '',
    wifiPassword: '',
    wifiScanning: false,
    wifiConnecting: false,
    wifiProgress: 0,
    wifiError: '',
    wifiNotice: '',
    wifiProvisionSupported: null,
    wifiScanSource: '',
    showWifiPassword: false,
  },

  onLoad(options = {}) {
    this._forceWifiSetup = options.forceWifi === '1'
    this._requestedDeviceId = String(options.deviceId || '')
    const serialNumber = normalizeSerialNumber(options.serialNumber || this.data.serialNumber)
    if (serialNumber !== this.data.serialNumber) this.setData({ serialNumber })
    // 演示模式：直接进首页，不跑硬件配对流程
    if (options.demo === '1' || wx.getStorageSync('haomian-demo-mode')) {
      this.completeDemoSetup()
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    if (this._forceWifiSetup && this._requestedDeviceId && isValidSerialNumber(serialNumber)) {
      return this.resumeConnectedDevice({
        deviceId: this._requestedDeviceId,
        serialNumber,
      })
    }
    return this.startSearch()
  },

  onUnload() {
    this._searchRequestId = (this._searchRequestId || 0) + 1
    this._searching = false
    this.setData({ wifiPassword: '' })
  },

  setMachine(event) {
    const machine = transitionSetup(this.data.machine, event)
    this.setData({
      machine,
      errorCode: machine.reason || '',
      errorAction: machine.reason === 'AUTH_EXPIRED'
        ? 'reauth'
        : ['BLUETOOTH_PERMISSION_DENIED', 'LOCATION_DISABLED'].includes(machine.reason)
          ? 'settings'
          : '',
      errorMessage: machine.reason ? (errorCopy[machine.reason] || '暂时无法完成，请重试') : '',
    })
  },

  inputSerial(event) { this.setData({ serialNumber: event.detail.value, scanFeedback: '' }) },

  scanCode() {
    wx.scanCode({
      onlyFromCamera: true,
      success: ({ result }) => this.setData({ serialNumber: normalizeSerialNumber(result), scanFeedback: '' }),
      fail: ({ errMsg }) => this.setData({
        scanFeedback: String(errMsg || '').toLowerCase().includes('cancel')
          ? '已取消扫码，可手动输入设备 SN。'
          : '扫码未完成，请手动输入设备 SN。',
      }),
    })
  },

  async startSearch() {
    if (this._searching) return
    this._searching = true
    const requestId = (this._searchRequestId || 0) + 1
    this._searchRequestId = requestId
    this.setMachine({ type: 'START_SEARCH' })
    const serialNumber = normalizeSerialNumber(this.data.serialNumber)
    if (serialNumber && !isValidSerialNumber(serialNumber)) {
      this.setMachine({ type: 'FAILED', reason: 'INVALID_SN', retryStep: 'idle' })
      this._searching = false
      return
    }
    this.setData({ serialNumber, scanFeedback: '' })
    try {
      const devices = await services.device.discover(serialNumber ? { serialNumber } : {})
      if (requestId !== this._searchRequestId) return
      if (!devices.length) throw { code: 'NOT_FOUND' }
      const validDevices = devices.filter((device) => isValidSerialNumber(device && device.serialNumber))
      if (!serialNumber && validDevices.length > 1) {
        this.setMachine({ type: 'FAILED', reason: 'MULTIPLE_DEVICES', retryStep: 'searching' })
        return
      }
      const matchedDevice = serialNumber
        ? validDevices.find((device) => matchesDiscoveredDevice(serialNumber, device))
        : validDevices[0]
      if (!matchedDevice) {
        this.setMachine({ type: 'FAILED', reason: 'IDENTITY_MISMATCH', retryStep: 'searching' })
        return
      }
      this.setData({ serialNumber: normalizeSerialNumber(matchedDevice.serialNumber) })
      this.setMachine({ type: 'DEVICE_FOUND', device: matchedDevice })
      await this.connect()
    } catch (error) {
      if (requestId === this._searchRequestId) this.setMachine({ type: 'FAILED', reason: stableError(error, 'NOT_FOUND'), retryStep: 'searching' })
    } finally {
      if (requestId === this._searchRequestId) this._searching = false
    }
  },

  async resumeConnectedDevice({ deviceId, serialNumber }) {
    if (this._searching || this._connecting) return
    this._connecting = true
    this.setMachine({ type: 'START_SEARCH' })
    try {
      const connection = await services.device.autoConnect({
        deviceId,
        serialNumber,
        timeout: 5000,
      })
      if (!connection || !connection.connected) throw { code: 'CONNECT_FAILED' }
      const resolvedSerial = normalizeSerialNumber(connection.serialNumber || serialNumber)
      if (!isValidSerialNumber(resolvedSerial)) throw { code: 'IDENTITY_MISMATCH' }
      const connectedDevice = {
        deviceId: connection.deviceId || deviceId,
        serialNumber: resolvedSerial,
        advertisedName: resolvedSerial,
        name: '月石睡眠主机',
        provisioned: true,
        protocolVersion: connection.protocolVersion || '1.0',
      }
      this.setData({
        serialNumber: resolvedSerial,
        scanFeedback: '已复用当前蓝牙连接，正在读取设备网络状态。',
      })
      this.setMachine({ type: 'DEVICE_FOUND', device: connectedDevice })
      this.setMachine({ type: 'START_CONNECT' })
      this.setMachine({ type: 'CONNECTED' })
      await this.prepareWifiSetup()
    } catch (error) {
      this._connecting = false
      this._searching = false
      this.setMachine({ type: 'FAILED', reason: stableError(error, 'CONNECT_FAILED'), retryStep: 'searching' })
      return
    } finally {
      this._connecting = false
    }
  },

  async connect() {
    if (this._connecting || this.data.machine.step !== 'found') return
    if (!matchesDiscoveredDevice(this.data.serialNumber, this.data.machine.device)) {
      this.setMachine({ type: 'FAILED', reason: 'IDENTITY_MISMATCH', retryStep: 'found' })
      return
    }
    this._connecting = true
    this.setMachine({ type: 'START_CONNECT' })
    try {
      const discovered = this.data.machine.device
      await services.device.bind({
        deviceId: discovered.deviceId,
        serialNumber: discovered.serialNumber,
        provisioned: Boolean(discovered.provisioned),
      })
      this.setMachine({ type: 'CONNECTED' })
      if (discovered.provisioned) {
        this.setData({ scanFeedback: '蓝牙已连接，正在检查设备网络。' })
        await this.prepareWifiSetup()
      }
    } catch (error) {
      this.setMachine({ type: 'FAILED', reason: stableError(error, 'CONNECT_FAILED'), retryStep: 'found' })
    } finally {
      this._connecting = false
    }
  },

  async prepareWifiSetup() {
    try {
      const status = await services.device.getWifiStatus()
      const refreshedStatus = status && status.supported === false && typeof services.device.getWifiStatus === 'function'
        ? await services.device.getWifiStatus({ refresh: true })
        : status
      this.setData({
        wifiProvisionSupported: refreshedStatus.supported !== false,
        wifiNotice: refreshedStatus.supported === false
          ? '尚未读取到 FF05 安全配网特征。已自动刷新蓝牙服务；如果仍显示此提示，请点击“重新读取设备能力”后再试。'
          : '',
      })
      if (refreshedStatus.connected && !this._forceWifiSetup) {
        this.setMachine({ type: 'START_PROVISION' })
        this.setMachine({ type: 'PROVISIONED' })
        this.setData({
          scanFeedback: `蓝牙与 Wi-Fi 均已连接${refreshedStatus.ssid ? ` · ${refreshedStatus.ssid}` : ''}`,
          wifiPassword: '',
        })
        return
      }
      await this.scanWifiNetworks()
    } catch (error) {
      this.setData({ wifiError: wifiErrorMessage(error) })
    }
  },

  async refreshWifiCapability() {
    if (this.data.wifiScanning || this.data.wifiConnecting) return
    this.setData({ wifiError: '', wifiNotice: '正在重新读取 ESP32 的 BLE/Wi-Fi 服务…' })
    try {
      await services.device.getWifiStatus({ refresh: true })
      await this.prepareWifiSetup()
    } catch (error) {
      this.setData({ wifiError: wifiErrorMessage(error) })
    }
  },

  async scanWifiNetworks() {
    if (this.data.wifiScanning || this.data.wifiConnecting) return
    this.setData({ wifiScanning: true, wifiError: '', wifiNetworks: [] })
    try {
      const wifiNetworks = await services.device.scanWifiNetworks({
        source: this.data.wifiProvisionSupported === false ? 'phone' : 'auto',
      })
      const selectedSsid = wifiNetworks.some((item) => item.ssid === this.data.selectedSsid)
        ? this.data.selectedSsid
        : (wifiNetworks[0] && wifiNetworks[0].ssid) || ''
      this.setData({
        wifiNetworks,
        selectedSsid,
        wifiScanSource: wifiNetworks[0] && wifiNetworks[0].source || '',
      })
      if (!wifiNetworks.length) this.setData({ wifiError: '设备附近没有发现可用的 2.4GHz Wi-Fi。' })
    } catch (error) {
      this.setData({ wifiError: wifiErrorMessage(error) })
    } finally {
      this.setData({ wifiScanning: false })
    }
  },

  selectWifi(event) {
    if (this.data.wifiConnecting) return
    const selectedSsid = String(event.currentTarget.dataset.ssid || '')
    this.setData({ selectedSsid, wifiPassword: '', wifiError: '' })
  },

  inputWifiName(event) {
    this.setData({ selectedSsid: event.detail.value, wifiError: '' })
  },

  inputWifiPassword(event) {
    this.setData({ wifiPassword: event.detail.value, wifiError: '' })
  },

  toggleWifiPassword() {
    this.setData({ showWifiPassword: !this.data.showWifiPassword })
  },

  async submitWifi() {
    if (this.data.wifiConnecting) return
    if (this.data.wifiProvisionSupported === false) {
      this.setData({ wifiError: '当前硬件仍是旧协议，请先烧录最新版 esp32_firmware 后再连接 Wi-Fi。' })
      return
    }
    const ssid = String(this.data.selectedSsid || '').trim()
    const selected = this.data.wifiNetworks.find((item) => item.ssid === ssid)
    if (!ssid) {
      this.setData({ wifiError: '请选择 Wi-Fi，或手动输入 2.4GHz 网络名称。' })
      return
    }
    if (selected && selected.secure && !this.data.wifiPassword) {
      this.setData({ wifiError: '请输入该 Wi-Fi 的密码。' })
      return
    }
    if (selected && selected.secure && this.data.wifiPassword.length < 8) {
      this.setData({ wifiError: '常规 WPA/WPA2 Wi-Fi 密码至少需要 8 位。' })
      return
    }
    this.setData({ wifiConnecting: true, wifiProgress: 0, wifiError: '' })
    try {
      const result = await services.device.provisionWifi({
        ssid,
        password: this.data.wifiPassword,
        onProgress: (wifiProgress) => this.setData({ wifiProgress }),
      })
      this.setData({
        wifiPassword: '',
        wifiProgress: 100,
        scanFeedback: `设备已连接 ${result.ssid || ssid}${result.ip ? ` · ${result.ip}` : ''}`,
      })
      this.setMachine({ type: 'START_PROVISION' })
      this.setMachine({ type: 'PROVISIONED' })
    } catch (error) {
      this.setData({ wifiPassword: '', wifiError: wifiErrorMessage(error) })
    } finally {
      this.setData({ wifiConnecting: false })
    }
  },

  async reconnectBle() {
    if (this._connecting || this.data.wifiConnecting) return
    this.setData({ wifiError: '', scanFeedback: '正在重新连接蓝牙…' })
    try {
      const discovered = this.data.machine.device
      const result = await services.device.autoConnect({
        deviceId: discovered && discovered.deviceId,
        serialNumber: discovered && discovered.serialNumber,
        timeout: 5000,
        refreshGatt: true,
      })
      if (!result.connected) throw { code: 'CONNECT_FAILED' }
      this.setData({ scanFeedback: '蓝牙已重新连接。' })
      await this.prepareWifiSetup()
    } catch (error) {
      this.setData({ wifiError: errorCopy[stableError(error, 'CONNECT_FAILED')] || '蓝牙重新连接失败。' })
    }
  },

  retry() {
    const retryStep = this.data.machine.retryStep
    this.setMachine({ type: 'RETRY' })
    if (retryStep === 'searching') this.startSearch()
    else if (retryStep === 'found') this.connect()
  },

  recoverAuth() {
    wx.reLaunch({ url: '/pages/onboarding/index?reauth=1' })
  },

  openPermissionSettings() {
    if (typeof wx.openSetting !== 'function') return
    wx.openSetting({
      success: () => this.retry(),
    })
  },

  // 演示模式：跳过硬件配对，直接进首页
  skipToHome() {
    if (!this.data.demoMode) return
    this.completeDemoSetup()
    wx.switchTab({ url: '/pages/home/index' })
  },
  completeDemoSetup() {
    // A demo is deliberately marked so it cannot masquerade as a calibrated
    // physical-device setup or send the user back into onboarding.
    wx.setStorageSync('haomian-demo-mode', true)
    wx.setStorageSync('haomian-setup-mode', 'demo')
    wx.setStorageSync('haomian-setup-complete', true)
  },

  simulateBluetoothOff() {
    this.setData({ machine: { ...this.data.machine, step: 'searching' } })
    this.setMachine({ type: 'FAILED', reason: 'BLUETOOTH_DISABLED', retryStep: 'searching' })
  },

  finish() {
    wx.navigateTo({ url: '/pages/calibration/index' })
  },
})

function stableError(error, fallback) {
  const code = readErrorCode(error)
  return Object.prototype.hasOwnProperty.call(errorCopy, code) ? code : fallback
}

function readErrorCode(error) {
  const directCode = error && typeof error.code === 'string' ? error.code : ''
  if (Object.prototype.hasOwnProperty.call(errorCopy, directCode)) return directCode
  const message = error && typeof error.message === 'string' ? error.message : ''
  const match = message.match(/^([A-Z][A-Z0-9_]+)(?::|\b)/)
  if (match && Object.prototype.hasOwnProperty.call(errorCopy, match[1])) return match[1]
  return directCode || (match ? match[1] : '')
}

function wifiErrorMessage(error) {
  const messages = {
    WIFI_PROVISION_UNSUPPORTED: '当前硬件固件不支持安全 Wi-Fi 配网，请升级到 BLE_PROTOCOL v1.1。',
    WIFI_BLE_SECURITY_REQUIRED: '请接受手机系统的蓝牙配对提示，再重新连接 Wi-Fi。',
    WIFI_SCAN_FAILED: '设备扫描 Wi-Fi 失败，请靠近路由器后重试。',
    WIFI_AUTH_FAILED: 'Wi-Fi 密码错误，请重新输入。',
    WIFI_NOT_FOUND: '设备没有找到该网络，请确认是 2.4GHz Wi-Fi。',
    WIFI_CONNECT_FAILED: '设备未能连接 Wi-Fi，请检查网络和密码。',
    WIFI_CONNECT_TIMEOUT: '设备连接 Wi-Fi 超时，请确认密码正确且网络为 2.4GHz 后重试。',
    WIFI_INVALID_DATA: 'Wi-Fi 名称或密码长度超出设备支持范围，请缩短后重试。',
    WIFI_DISABLED: '请先打开手机 Wi-Fi 后重新扫描。',
    WIFI_SCAN_UNAVAILABLE: '当前微信或手机系统不支持读取附近 Wi-Fi 列表。',
    WIFI_SCAN_TIMEOUT: '附近 Wi-Fi 扫描超时，请打开定位权限后重试。',
    BLE_RESPONSE_TIMEOUT: '设备应答超时，请保持手机靠近设备后重试。',
    CONNECTION_LOST: '蓝牙已断开，请先重新连接。',
  }
  const code = readErrorCode(error)
  return messages[code] || (error && error.message) || 'Wi-Fi 配网失败，请重试。'
}
