const services = require('../../services/index')
const { buildPersonalStrategy, confirmedPlan, readLocalPlan, rememberPlanCommand, loadCalibrationProgress } = require('../../domain/personal-strategy')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')
const { dateKey } = require('../../domain/ai-display')

Page({
  data: { loading: true, error: null, strategy: null, status: null, settings: null, parametersOpen: false, stagesOpen: false, calibration: null, calibrationLoading: false, planLoading: false, planError: null },
  onShow() { return this.load() },
  async load() {
    const requestId = this._collectionRequest = (this._collectionRequest || 0) + 1
    this.setData({ loading: !this.data.strategy, error: null, calibration: null, calibrationLoading: false })
    try {
      const [profile, nights, status, settings, guardian] = await Promise.all([
        services.auth.getProfile(), (services.reports.getCollectionNights || services.reports.getSevenNightTrend)(), services.device.getStatus(),
        services.device.getTonightSettings(), services.guardian.getSnapshot(),
      ])
      if (requestId !== this._collectionRequest) return
      const deviceId = status?.deviceId
      const pending = readLocalPlan(wx, services.serviceMode, deviceId)?.pendingId
      if (pending && services.device.getSettingsCommand) {
        const receipt = await services.device.getSettingsCommand(pending).catch(() => null)
        if (requestId !== this._collectionRequest) return
        if (receipt?.deviceId === deviceId) rememberPlanCommand(wx, services.serviceMode, receipt)
      }
      const plan = confirmedPlan(settings, deviceId, wx, services.serviceMode)
      const strategy = buildPersonalStrategy({ profile, nights, status, guardian, plan })
      this.setData({ status, settings, strategy })
      if (strategy.stageIndex > 0 && services.reports.getPeriodTrend) this.loadCalibration(requestId, plan)
    } catch (error) {
      if (requestId === this._collectionRequest) this.setData({ error: toUserError(error, '温和方案') })
    } finally { if (requestId === this._collectionRequest) this.setData({ loading: false }) }
  },
  onUnload() { this._collectionRequest = (this._collectionRequest || 0) + 1 },
  async loadCalibration(requestId, plan) {
    this.setData({ calibrationLoading: true })
    try {
      const calibration = await loadCalibrationProgress(services.reports, plan, dateKey(new Date()))
      if (requestId === this._collectionRequest) this.setData({ calibration })
    } catch {
      if (requestId === this._collectionRequest) this.setData({ calibration: null })
    } finally {
      if (requestId === this._collectionRequest) this.setData({ calibrationLoading: false })
    }
  },
  openSleepData() { wx.navigateTo({ url: '/pages/report-detail/index?scope=week' }) },
  async openPlan() {
    if (!this.data.strategy?.canReview || this.data.planLoading) return
    this.setData({ planLoading: true, planError: null })
    try {
      const overview = await services.ai.getOverview('single-night')
      if (!overview?.interpretationId || overview.hasData === false) throw new Error('AI_INTERPRETATION_NOT_FOUND')
      wx.navigateTo({ url: '/pages/ai-plan/index?from=calibration&interpretationId=' + encodeURIComponent(overview.interpretationId) })
    } catch (error) {
      this.setData({ planError: toUserError(error, '温和方案建议') })
    } finally { this.setData({ planLoading: false }) }
  },
  retry() { return this.load() },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.load(), wx) },
  toggleStages() { this.setData({ stagesOpen: !this.data.stagesOpen }) },
  toggleParameters() { this.setData({ parametersOpen: !this.data.parametersOpen }) },
  openSettings() { wx.navigateTo({ url: '/pages/tonight/index' }) },
})
