const services = require('../../services/index')
const { toUserError } = require('../../domain/service-error')
const { groupRecords } = require('../../domain/ai-display')
const { navigate, resetNavigation, openAiAuthorization, rememberRecordsView, getRecordsView } = require('../../domain/ai-navigation')

Page({
  data: { tab: 'conversations', groups: [], loading: true, refreshing: false, error: null, consentRequired: false, deleting: false },
  onLoad(options = {}) { this._requestedTab = ['interpretations', 'conversations'].includes(options.tab) ? options.tab : '' },
  onShow() { resetNavigation(this); return this.load() },
  onPageScroll(event) { this._scrollTop = event.scrollTop },
  onHide() {
    rememberRecordsView(this._ownerId, { tab: this.data.tab, scrollTop: this._restoreScroll == null ? this._scrollTop : this._restoreScroll })
    this._loadId = (this._loadId || 0) + 1
  },
  onUnload() { this.onHide() },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    const id = (this._loadId || 0) + 1
    this._loadId = id
    this.setData({ loading: !this.data.groups.length, refreshing: Boolean(this.data.groups.length), error: null })
    try {
      const profile = await services.auth.getProfile()
      if (id !== this._loadId) return
      if (!profile || !profile.id) {
        this._ownerId = ''
        this.setData({ groups: [], consentRequired: true })
        return
      }
      if (this._ownerId !== profile.id) {
        const view = getRecordsView(profile.id)
        const tab = this._requestedTab || view.tab
        this._restoreScroll = this._requestedTab && this._requestedTab !== view.tab ? 0 : view.scrollTop
        this._scrollTop = this._restoreScroll
        this._requestedTab = ''
        this.setData({ groups: [], loading: true, tab })
      }
      this._ownerId = profile.id
      const rows = this.data.tab === 'conversations' ? await services.ai.getChatSessions() : profile.aiDataAuthorized ? await services.ai.getRecords() : []
      if (id === this._loadId) this.setData({ groups: groupRecords(rows, this.data.tab), consentRequired: !profile.aiDataAuthorized }, () => {
        if (this._restoreScroll != null && id === this._loadId && wx.pageScrollTo) {
          wx.pageScrollTo({ scrollTop: this._restoreScroll, duration: 0 })
          this._restoreScroll = null
        }
      })
    } catch (error) {
      if (id === this._loadId) this.setData({ error: toUserError(error, 'AI 记录') })
    } finally {
      if (id === this._loadId) this.setData({ loading: false, refreshing: false })
    }
  },
  setTab(event) {
    const tab = event.currentTarget.dataset.tab
    if (!['conversations', 'interpretations'].includes(tab) || tab === this.data.tab) return
    this._scrollTop = 0
    this._restoreScroll = null
    if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    this.setData({ tab, groups: [] })
    return this.load()
  },
  openRecord(event) {
    const { id, revision, sourceDate } = event.currentTarget.dataset
    if (!id) return
    const query = this.data.tab === 'conversations' ? `sessionId=${encodeURIComponent(id)}` : `interpretationId=${encodeURIComponent(id)}&revision=${encodeURIComponent(revision || 1)}&sourceDate=${encodeURIComponent(sourceDate || '')}`
    return navigate(this, wx, 'redirectTo', { url: `/pages/ai-chat/index?${query}` })
  },
  async deleteRecord(event) {
    const id = event.currentTarget.dataset.id
    if (!id || this.data.tab !== 'conversations' || this.data.deleting) return
    this.setData({ deleting: true, error: null })
    try {
      const result = await new Promise((resolve) => wx.showModal({ title: '删除这段对话？', content: '删除后无法恢复，不会删除睡眠报告或已确认的偏好。', confirmText: '删除对话', cancelText: '保留', confirmColor: '#A13F31', success: resolve, fail: () => resolve({ confirm: false }) }))
      if (!result.confirm) return
      await services.ai.deleteChatSession(id)
      await this.load()
    } catch (error) { this.setData({ error: toUserError(error, '删除对话') }) }
    finally { this.setData({ deleting: false }) }
  },
  newChat() { if (!this.data.consentRequired) return navigate(this, wx, 'redirectTo', { url: '/pages/ai-chat/index?focus=1' }) },
  openAuthorization() { return openAiAuthorization(this, wx) },
})
