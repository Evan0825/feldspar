const services = require('../../services/index')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')
const { isValidSerialNumber } = require('../../domain/device-identity')

Page({
  data: {
    status: null,
    wifiStatus: null,
    localFirmwareVersion: '',
    loading: true,
    error: null,
    phase: 'loading',
    reconnecting: false,
    reconnectError: '',
    safetyBusy: false,
    safetyError: '',
    vibrationTesting: false,
    vibrationMessage: '',
  },
  onShow() { this.load() },
  onUnload() { this._loadId = (this._loadId || 0) + 1 },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    const loadId = this._loadId = (this._loadId || 0) + 1
    this.setData({ loading: true, error: null, phase: 'loading', wifiStatus: null, localFirmwareVersion: '' })
    let status
    try {
      status = await services.device.getStatus()
    } catch (error) {
      if (loadId === this._loadId) this.setData({
        status: null, error: toUserError(error, '设备状态'), phase: 'error', loading: false,
      })
      return
    }
    if (loadId !== this._loadId) return
    this.setData({ status, phase: status ? 'data' : 'empty', loading: false })
    if (!status?.ble?.connected) return
    if (typeof services.device.getWifiStatus === 'function') {
      const wifi = await services.device.getWifiStatus().catch(() => null)
      if (loadId !== this._loadId) return
      if (wifi?.supported === true) this.setData({ wifiStatus: wifi })
    }
    if (typeof services.device.getFirmwareVersion === 'function') {
      const version = await services.device.getFirmwareVersion().catch(() => '')
      if (loadId === this._loadId && version) this.setData({ localFirmwareVersion: version })
    }
  },
  retry() { return this.load() },
  async safetyAction(event) {
    if (this.data.safetyBusy) return
    const stop = event.currentTarget.dataset.kind === 'stop'
    const action = stop ? services.device.stopAllOutputs : services.device.resumeManualControl
    if (typeof action !== 'function') return
    this.setData({ safetyBusy: true, safetyError: '' })
    try {
      await action.call(services.device)
      wx.showToast({ title: stop ? '驱动停止已确认' : '手动控制已恢复', icon: 'success' })
      await this.load()
    } catch (error) {
      this.setData({ safetyError: stop ? '停止结果未确认，请断开设备电源。' : '设备未确认恢复，请重新连接后核对。' })
    } finally {
      this.setData({ safetyBusy: false })
    }
  },
  async reconnectBluetooth() {
    if (this.data.reconnecting || !this.data.status) return
    if (!isValidSerialNumber(this.data.status.serialNumber)) {
      wx.navigateTo({ url: '/pages/setup/index' })
      return
    }
    this.setData({ reconnecting: true, reconnectError: '' })
    try {
      const result = await services.device.autoConnect({
        deviceId: this.data.status.deviceId,
        serialNumber: this.data.status.serialNumber,
        timeout: 5000,
      })
      if (!result.connected) throw Object.assign(new Error('蓝牙连接未完成'), { code: 'CONNECT_FAILED' })
      wx.showToast({ title: '蓝牙已连接', icon: 'success' })
      await this.load()
    } catch (error) {
      const userError = toUserError(error, '蓝牙重连')
      this.setData({ reconnectError: userError.detail })
      wx.showToast({ title: userError.title, icon: 'none' })
    } finally {
      this.setData({ reconnecting: false })
    }
  },
  openWifiSetup() {
    const deviceId = this.data.status && this.data.status.deviceId || ''
    const serialNumber = this.data.status && this.data.status.serialNumber || ''
    const deviceQuery = deviceId ? `&deviceId=${encodeURIComponent(deviceId)}` : ''
    const suffix = isValidSerialNumber(serialNumber)
      ? `&serialNumber=${encodeURIComponent(serialNumber)}`
      : ''
    wx.navigateTo({ url: `/pages/setup/index?forceWifi=1${deviceQuery}${suffix}` })
  },
  async startVibrationTest() {
    if (this.data.vibrationTesting || !this.data.status?.cloudVibrationTestAvailable) return
    this.setData({ vibrationTesting: true, vibrationMessage: '等待设备确认' })
    try {
      await services.device.startVibrationTest()
      this.setData({ vibrationMessage: '设备已开始试振，约 2 秒' })
    } catch (error) {
      this.setData({ vibrationMessage: toUserError(error, '试振').title })
    } finally {
      this.setData({ vibrationTesting: false })
    }
  },
  openCalibration() {
    if (this.data.status?.bound) wx.navigateTo({ url: '/pages/calibration/index' })
  },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.retry(), wx) },
  showSafetyHelp() {
    wx.showModal({ title: '实体按键', content: '短按切换灯光，长按 2 秒停止全部输出。停止后，通过蓝牙恢复手动控制。', showCancel: false, confirmColor: '#654617' })
  },
  showUpdateInfo(event) {
    const host = this.data.status?.host
    if (!host) return
    const isModel = event.currentTarget.dataset.kind === 'model'
    const title = isModel ? '本地模型' : '固件版本'
    const version = (isModel ? host.modelVersion : this.data.localFirmwareVersion || host.firmwareVersion) || '未核验'
    const available = isModel ? host.modelUpdateAvailable : host.firmwareUpdateAvailable
    const update = available === true ? '有待更新版本。' : available === false ? '暂无更新。' : '更新状态未核验。'
    wx.showModal({ title, content: version + '\n' + update, showCancel: false, confirmColor: '#654617' })
  },
})
