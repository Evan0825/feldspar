const services = require('../../services/index')
const { getAttentionGuidance } = require('../../domain/attention-guidance')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')

function isCompleteFeedback(feedback) {
  return Boolean(feedback)
    && typeof feedback.awakened === 'boolean'
    && typeof feedback.partnerAffected === 'boolean'
    && Number.isInteger(feedback.nextDayEnergy)
    && feedback.nextDayEnergy >= 1
    && feedback.nextDayEnergy <= 5
}

function emptyFeedback() {
  return { awakened: null, partnerAffected: null, nextDayEnergy: null }
}

function feedbackForNight(feedback, nightId) {
  return isCompleteFeedback(feedback) && feedback.nightId === nightId
    ? { awakened: feedback.awakened, partnerAffected: feedback.partnerAffected, nextDayEnergy: feedback.nextDayEnergy }
    : null
}

Page({
  data: {
    nights: [],
    feedback: emptyFeedback(),
    currentNightId: '',
    currentNightDate: '',
    submitted: false,
    energyOptions: [1, 2, 3, 4, 5],
    validCount: 0,
    lastSuccessRate: 0,
    guidance: null,
    phase: 'loading',
    loading: true,
    error: null,
    errorMessage: '',
    insufficientData: false,
    submitting: false,
    dataSource: 'none',
    feedbackOnly: false,
  },
  onLoad(options = {}) {
    this._focusFeedback = options.focus === 'feedback'
    if (this._focusFeedback) {
      this._feedbackNightId = decodeURIComponent(options.nightId || '')
      this.setData({ feedbackOnly: true })
      if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '晨间反馈' })
    }
  },
  onReady() { this.focusFeedback() },
  focusFeedback() {
    if (this._focusFeedback && this.data.phase === 'data' && typeof wx.pageScrollTo === 'function') {
      this._focusFeedback = false
      wx.pageScrollTo({ selector: '#morning-feedback', duration: 0 })
    }
  },
  onShow() { return this.load() },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    const requestId = (this._requestId || 0) + 1
    this._requestId = requestId
    this.setData({ loading: true, phase: 'loading', error: null, errorMessage: '', nights: [], guidance: null, insufficientData: false, dataSource: 'none' })
    try {
      const nightId = this._feedbackNightId
      const [nights, report] = await Promise.all([
        this.data.feedbackOnly ? [] : services.reports.getSevenNightTrend(),
        nightId ? services.reports.getByNightId(nightId) : services.reports.getLatest(),
      ])
      if (requestId !== this._requestId) return
      const latestReport = nightId && report?.id !== nightId ? null : report
      const counts = nights.map(night => night.valid && Number.isFinite(night.snoreEvents) && night.snoreEvents >= 0 ? night.snoreEvents : null)
      const maxCount = Math.max(1, ...counts.filter(count => count !== null))
      const normalizedNights = nights.map((night, index) => ({
        ...night,
        snoreCount: counts[index],
        barHeight: counts[index] === null ? 0 : counts[index] * 130 / maxCount,
      }))
      const validNights = normalizedNights.filter((night) => night.valid)
      const trendDataSource = nights.dataSource || 'none'
      const latestValidNight = validNights.length ? validNights[validNights.length - 1] : null
      const currentNightId = latestReport && latestReport.hasData !== false && latestReport.id || (latestValidNight ? latestValidNight.nightId : '')
      const guidance = latestReport && latestReport.hasData !== false ? getAttentionGuidance(latestReport.attentionLevel) : null
      if (!validNights.length && (!this.data.feedbackOnly || !currentNightId)) {
        this.setData({
          nights: normalizedNights,
          currentNightId: '',
          feedback: emptyFeedback(),
          submitted: false,
          guidance: null,
          phase: 'empty',
          validCount: 0,
          lastSuccessRate: 0,
          dataSource: 'none',
        })
        return
      }
      if (!guidance && !this.data.feedbackOnly) {
        this.setData({
          nights: normalizedNights,
          currentNightId,
          feedback: emptyFeedback(),
          submitted: false,
          guidance: null,
          phase: 'unavailable',
          errorMessage: '趋势关注类别暂不可用，请同步后重试。',
        })
        return
      }
      const feedback = currentNightId ? await services.reports.getFeedback(currentNightId) : null
      if (requestId !== this._requestId) return
      const savedFeedback = feedbackForNight(feedback, currentNightId)
      const keepDraft = this._feedbackDirty && this.data.currentNightId === currentNightId
      if (!keepDraft) this._feedbackDirty = false
      this.setData({
        nights: normalizedNights,
        guidance,
        phase: 'data',
        validCount: validNights.length,
        insufficientData: validNights.length < 3,
        lastSuccessRate: latestValidNight?.interventions > 0 ? latestValidNight.successRate : null,
        currentNightId,
        currentNightDate: latestReport && latestReport.id === currentNightId ? latestReport.date || '' : latestValidNight && latestValidNight.date || '',
        feedback: keepDraft ? this.data.feedback : savedFeedback || emptyFeedback(),
        submitted: keepDraft ? false : Boolean(savedFeedback),
        dataSource: trendDataSource === 'mixed' || trendDataSource === 'simulated'
          ? trendDataSource
          : (latestReport?.dataSource || 'device'),
      }, () => this.focusFeedback())
    } catch (error) {
      if (requestId === this._requestId) {
        const userError = toUserError(error, this.data.feedbackOnly ? '晨间反馈' : '七晚趋势')
        this.setData({ phase: 'error', error: userError, errorMessage: userError.detail })
      }
    } finally {
      if (requestId === this._requestId) this.setData({ loading: false })
    }
  },
  chooseBoolean(event) {
    if (this.data.submitting) return
    this._feedbackDirty = true
    const key = event.currentTarget.dataset.key
    const value = event.currentTarget.dataset.value === 'true'
    this.setData({ [`feedback.${key}`]: value, submitted: false })
  },
  retry() { return this.load() },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.retry(), wx) },
  setEnergy(event) {
    if (this.data.submitting) return
    this._feedbackDirty = true
    const value = Math.min(5, Math.max(1, Math.round(Number(event.currentTarget.dataset.value))))
    this.setData({ 'feedback.nextDayEnergy': value, submitted: false })
  },
  async submitFeedback() {
    if (this.data.submitting) return
    if (!isCompleteFeedback(this.data.feedback)) {
      wx.showToast({ title: '请完成三项反馈', icon: 'none' }); return
    }
    if (!this.data.currentNightId) {
      wx.showToast({ title: '当前夜晚尚未生成，暂不能记录反馈', icon: 'none' }); return
    }
    const nightId = this.data.currentNightId
    this.setData({ submitting: true })
    try {
      const response = await services.reports.submitFeedback({ nightId, ...this.data.feedback })
      const feedback = {
        ...response,
        nightId: response.nightId || nightId,
        awakened: typeof response.awakened === 'boolean' ? response.awakened : this.data.feedback.awakened,
        partnerAffected: typeof response.partnerAffected === 'boolean' ? response.partnerAffected : this.data.feedback.partnerAffected,
        nextDayEnergy: Number.isInteger(response.nextDayEnergy) ? response.nextDayEnergy : this.data.feedback.nextDayEnergy,
      }
      const savedFeedback = feedbackForNight(feedback, nightId)
      if (!savedFeedback) {
        wx.showToast({ title: '反馈暂未记录，请稍后重试', icon: 'none' }); return
      }
      if (this.data.currentNightId !== nightId) return
      this._feedbackDirty = false
      this.setData({ feedback: savedFeedback, submitted: true })
      wx.showToast({ title: '反馈已记录', icon: 'success' })
    } catch (error) {
      const userError = toUserError(error, '晨间反馈')
      wx.showToast({ title: userError.title, icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
