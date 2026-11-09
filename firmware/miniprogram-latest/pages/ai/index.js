const services = require('../../services/index')
const { toUserError } = require('../../domain/service-error')
const { dateKey } = require('../../domain/ai-display')
const { buildDirectShare, buildTimelineShare } = require('../../domain/share-card')
const { navigate, resetNavigation, openSleepSource } = require('../../domain/ai-navigation')

Page({
  data: { daily: null, loading: true, refreshing: false, consentRequired: false, authorizing: false, error: null, question: '' },
  onShow() { resetNavigation(this); return this.load() },
  onHide() { this._requestId = (this._requestId || 0) + 1 },
  onUnload() { this.onHide() },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()) },

  async load() {
    const requestId = (this._requestId || 0) + 1
    this._requestId = requestId
    const preserveContent = Boolean(this.data.daily || this.data.consentRequired)
    this.setData({ loading: !preserveContent, refreshing: preserveContent, error: null })
    try {
      const profile = await services.auth.getProfile()
      if (requestId !== this._requestId) return
      if (!profile || !profile.aiDataAuthorized) {
        this._ownerId = ''
        this.setData({ consentRequired: true, daily: null, question: '' })
        return
      }
      if (this._ownerId && this._ownerId !== profile.id) this.setData({ daily: null, question: '', loading: true })
      this._ownerId = profile.id
      const daily = await services.ai.getDailyHome()
      if (requestId !== this._requestId) return
      this.setData({ daily, consentRequired: false })
    } catch (error) {
      if (requestId === this._requestId) this.setData({ error: toUserError(error, 'AI') })
    } finally {
      if (requestId === this._requestId) this.setData({ loading: false, refreshing: false })
    }
  },

  async requestAiConsent() {
    if (this.data.authorizing) return
    this.setData({ authorizing: true, error: null })
    try {
      const result = await new Promise((resolve, reject) => wx.showModal({
        title: '允许 AI 读取睡眠资料？',
        content: '仅使用结构化夜间记录、趋势和主动反馈，默认不读取整夜原始录音。你可随时在“我的”关闭授权。',
        confirmText: '允许', cancelText: '暂不', confirmColor: '#654617', success: resolve, fail: reject,
      }))
      if (!result.confirm) return
      await services.auth.saveProfile({ aiDataAuthorized: true, aiConsentVersion: 'ai-data-v1' })
      await this.load()
    } catch (error) {
      this.setData({ error: toUserError(error, 'AI 数据授权') })
    } finally { this.setData({ authorizing: false }) }
  },

  onQuestionInput(event) { this.setData({ question: event.detail.value }) },
  sendQuestion() { const question = this.data.question.trim(); if (question) this.openChatWithQuestion(question) },
  askQuestion(event) { this.openChatWithQuestion(event.currentTarget.dataset.question || '') },
  askWhy() { this.openChatWithQuestion('为什么这样判断？') },
  openChat() { this.openChatWithQuestion('') },
  openChatWithQuestion(question) {
    const daily = this.data.daily
    if (this.data.consentRequired || !daily || this._routePending) return
    const today = dateKey(new Date())
    if (daily.dayKey !== today) {
      if (this.data.refreshing) return
      return this.load().then(() => {
        if (this.data.daily && this.data.daily.dayKey === today && !this.data.error) this.openChatWithQuestion(question)
      })
    }
    const params = []
    if (daily.activeSessionId) params.push('sessionId=' + encodeURIComponent(daily.activeSessionId))
    else if (daily.overview) {
      params.push('interpretationId=' + encodeURIComponent(daily.overview.interpretationId))
      params.push('revision=' + encodeURIComponent(daily.overview.revision || 1))
    }
    params.push('dayKey=' + encodeURIComponent(daily.dayKey), 'sourceDate=' + encodeURIComponent(daily.sourceDate || ''))
    params.push(question ? 'question=' + encodeURIComponent(question) : 'focus=1')
    return navigate(this, wx, 'navigateTo', {
      url: '/pages/ai-chat/index?' + params.join('&'),
      success: () => { if (question === this.data.question.trim()) this.setData({ question: '' }) },
    })
  },
  openPlan() {
    const overview = this.data.daily && this.data.daily.overview
    if (overview && overview.kind === 'single-night') return navigate(this, wx, 'navigateTo', { url: '/pages/ai-plan/index?interpretationId=' + encodeURIComponent(overview.interpretationId) })
  },
  openRecordSource() { if (this.data.daily && this.data.daily.overview) return openSleepSource(this, wx, this.data.daily.overview) },
  openRecords() { return navigate(this, wx, 'navigateTo', { url: '/pages/ai-records/index' }) },
  openMemory() { return navigate(this, wx, 'navigateTo', { url: '/pages/ai-memory/index' }) },
  onShareAppMessage() { return buildDirectShare() },
  onShareTimeline() { return buildTimelineShare() },
})
