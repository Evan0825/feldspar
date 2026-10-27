const services = require('../../services/index')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')
const { isValidSerialNumber } = require('../../domain/device-identity')

Page({
  data: {
    status: null,
    loading: true,
    error: null,
    phase: 'loading',
    reconnecting: false,
    reconnectError: '',
    safetyBusy: false,
    safetyError: '',
  },
  onShow() { this.load() },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    this.setData({ loading: true, error: null, phase: 'loading' })
    try {
      const status = await services.device.getStatus()
      this.setData({ status, phase: status ? 'data' : 'empty' })
    } catch (error) {
      this.setData({ status: null, error: toUserError(error, '设备状态'), phase: 'error' })
    } finally {
      this.setData({ loading: false })
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
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.retry(), wx) },
  showUpdateInfo(event) {
    wx.showModal({ title: event.currentTarget.dataset.kind === 'model' ? '检测算法更新' : '固件更新', content: '当前为接口占位状态。正式版本需由硬件 OTA 与云端发布服务提供更新包和签名。', showCancel: false, confirmColor: '#B97728' })
  },
})
