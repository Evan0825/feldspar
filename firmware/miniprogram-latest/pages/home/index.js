const services = require('../../services/index')
const { buildPersonalStrategy, confirmedPlan } = require('../../domain/personal-strategy')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')
const { buildDirectShare, buildTimelineShare } = require('../../domain/share-card')

Page({
  data: {
    loading: true,
    error: null,
    partialError: null,
    status: null,
    deviceLinkLabel: '',
    padNotice: '',
    controlStatusPending: false,
    settings: null,
    strategy: null,
    strategyError: null,
    strategyLoading: true,
    sound: null,
    light: null,
    guardian: null,
    activeCommand: null,
    morningReportState: 'loading',
    morningReportCopy: '',
    morningReportError: null,
  },

  onShow() { this.loadData() },
  onPullDownRefresh() { this.loadData().finally(() => wx.stopPullDownRefresh()) },

  async loadData() {
    const preserveDevice = Boolean(this.data.status)
    const preserveReport = ['ready', 'empty'].includes(this.data.morningReportState)
    this.setData({
      loading: !preserveDevice,
      error: null,
      partialError: null,
      morningReportState: preserveReport ? this.data.morningReportState : 'loading',
      morningReportCopy: preserveReport ? this.data.morningReportCopy : '',
      morningReportError: null,
    })
    await Promise.all([this.loadDeviceData(), this.loadMorningReport()])
    await this.loadStrategy()
  },

  async loadDeviceData() {
    const requestId = (this._deviceRequestId || 0) + 1
    this._deviceRequestId = requestId
    const preserveContent = Boolean(this.data.status)
    this.setData({ loading: !preserveContent, error: null, partialError: null })
    try {
      const reconnect = services.serviceMode === 'real' && services.device.autoConnect
        ? settle(Promise.resolve().then(() => services.device.autoConnect({ timeout: 4000, preferCloud: true })))
        : Promise.resolve()
      const deviceStatus = reconnect.then(() => services.device.getStatus())
      const results = await Promise.all([
        deviceStatus,
        services.device.getTonightSettings(),
        deviceStatus.then(status => !isControlStatusPending(status) || status.cloudSoundAvailable,
          () => true).then(read => read ? services.device.getSoundState() : null),
        deviceStatus.then(status => !isControlStatusPending(status) || status.cloudLightAvailable,
          () => true).then(read => read ? services.device.getLightState() : null),
        services.guardian && services.guardian.getSnapshot ? services.guardian.getSnapshot() : Promise.resolve(null),
        services.device.getActiveSettingsCommand ? services.device.getActiveSettingsCommand() : Promise.resolve(null),
      ].map(settle))
      if (requestId !== this._deviceRequestId) return
      const [status, settings, sound, light, guardian, activeCommand] = results
      const firstFailure = results.find((result) => !result.ok)
      const criticalError = status.ok ? null : toUserError(status.error, '设备状态')
      const nextStatus = status.ok ? status.value : this.data.status
      const padNotice = {
        disconnected: '枕下振动片未连接',
        fault: '振动片故障',
        unknown: '振动片状态待确认',
      }[nextStatus?.pad?.status] || ''
      this.setData({
        status: nextStatus,
        deviceLinkLabel: nextStatus?.cloudOnline ? '设备在线' : (nextStatus?.ble?.connected ? '蓝牙已连接' : (nextStatus?.host?.online ? '设备在线' : '设备离线')),
        padNotice,
        controlStatusPending: isControlStatusPending(nextStatus),
        settings: settings.ok ? settings.value : this.data.settings,
        sound: sound.ok ? sound.value : this.data.sound,
        light: light.ok ? light.value : this.data.light,
        guardian: guardian.ok ? guardian.value : this.data.guardian,
        activeCommand: activeCommand.ok ? activeCommand.value : this.data.activeCommand,
        error: criticalError,
        partialError: !criticalError && firstFailure ? toUserError(firstFailure.error, '部分设备状态') : null,
      })
    } finally {
      if (requestId === this._deviceRequestId) this.setData({ loading: false })
    }
  },

  async loadMorningReport() {
    const requestId = (this._reportRequestId || 0) + 1
    this._reportRequestId = requestId
    const preserveContent = ['ready', 'empty'].includes(this.data.morningReportState)
    this.setData({
      morningReportState: preserveContent ? this.data.morningReportState : 'loading',
      morningReportCopy: preserveContent ? this.data.morningReportCopy : '',
      morningReportError: null,
    })

    try {
      const latestReport = await services.reports.getLatest()
      if (requestId === this._reportRequestId) {
        const hasReport = Boolean(latestReport && latestReport.hasData !== false)
        this.setData({
          morningReportState: hasReport ? 'ready' : 'empty',
          morningReportCopy: hasReport ? '查看睡眠记录' : '尚未收到有效夜间记录',
        })
      }
    } catch (error) {
      if (requestId === this._reportRequestId) this.setData({ morningReportState: 'error', morningReportCopy: '晨报同步失败', morningReportError: toUserError(error, '晨报') })
    }
  },

  async loadStrategy() {
    const requestId = (this._strategyRequestId || 0) + 1
    this._strategyRequestId = requestId
    this.setData({ strategyLoading: !this.data.strategy, strategyError: null })
    try {
      const [profile, nights] = await Promise.all([services.auth.getProfile(), (services.reports.getCollectionNights || services.reports.getSevenNightTrend)()])
      if (requestId === this._strategyRequestId) this.setData({ strategy: buildPersonalStrategy({ profile, nights, status: this.data.status, guardian: this.data.guardian, plan: confirmedPlan(this.data.settings, this.data.status?.deviceId, wx, services.serviceMode) }) })
    } catch (error) {
      if (requestId === this._strategyRequestId) this.setData({ strategyError: toUserError(error, '温和方案') })
    } finally {
      if (requestId === this._strategyRequestId) this.setData({ strategyLoading: false })
    }
  },
  openStrategy() { wx.navigateTo({ url: '/pages/strategy/index' }) },

  retryDevice() { return this.loadDeviceData().then(() => this.loadStrategy()) },
  retryMorningReport() { return this.loadMorningReport() },
  handleDeviceAction(event) { return runServiceErrorAction(event.detail.action, () => this.retryDevice(), wx) },
  handleMorningReportAction(event) { return runServiceErrorAction(event.detail.action, () => this.retryMorningReport(), wx) },

  openDevice() { wx.navigateTo({ url: '/pages/device/index' }) },
  openLive() { wx.navigateTo({ url: '/pages/live/index' }) },
  openAi() { wx.switchTab({ url: '/pages/ai/index' }) },
  openActiveCommand() {
    if (!this.data.activeCommand) return
    wx.navigateTo({ url: `/pages/ai-plan/index?commandId=${this.data.activeCommand.commandId}` })
  },
  openTonight() { if (this.canOpenControl()) wx.navigateTo({ url: '/pages/tonight/index' }) },
  openSound() { if (this.data.status?.cloudSoundAvailable || this.canOpenControl()) wx.navigateTo({ url: '/pages/sound/index' }) },
  openLight() { if (this.data.status?.cloudLightAvailable || this.canOpenControl()) wx.navigateTo({ url: '/pages/light/index' }) },
  openReport() { wx.switchTab({ url: '/pages/report/index' }) },
  canOpenControl() {
    const safety = this.data.status?.safety
    if (safety?.available && safety.stopLatched) {
      this.openDevice()
      return false
    }
    if (this.data.status && this.data.status.controlAvailable) return true
    if (this.data.controlStatusPending) return false
    wx.showToast({ title: '设备离线或尚未配网，控制暂不可用', icon: 'none' })
    return false
  },
  onShareAppMessage() { return buildDirectShare() },
  onShareTimeline() { return buildTimelineShare() },
})

function isControlStatusPending(status) {
  return Boolean(status?.ble?.connected && status.safety?.available === false && !status.controlAvailable)
}

async function settle(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}
