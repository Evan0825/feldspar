const services = require('../../services/index')
const { buildPersonalStrategy } = require('../../domain/personal-strategy')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')

Page({
  data: { loading: true, error: null, strategy: null, status: null, settings: null, parametersOpen: false },
  onShow() { return this.load() },
  async load() {
    this.setData({ loading: !this.data.strategy, error: null })
    try {
      const [profile, nights, status, settings, guardian] = await Promise.all([
        services.auth.getProfile(), services.reports.getSevenNightTrend(), services.device.getStatus(),
        services.device.getTonightSettings(), services.guardian.getSnapshot(),
      ])
      this.setData({ status, settings, strategy: buildPersonalStrategy({ profile, nights, status, guardian, plan: settings && settings.personalStrategy }) })
    } catch (error) {
      this.setData({ error: toUserError(error, '温和方案') })
    } finally { this.setData({ loading: false }) }
  },
  retry() { return this.load() },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.load(), wx) },
  toggleParameters() { this.setData({ parametersOpen: !this.data.parametersOpen }) },
  openSettings() { wx.navigateTo({ url: '/pages/tonight/index' }) },
})
