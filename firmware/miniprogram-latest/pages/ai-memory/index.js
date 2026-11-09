const services = require('../../services/index')
const { toUserError } = require('../../domain/service-error')
const { resetNavigation, openAiAuthorization } = require('../../domain/ai-navigation')
Page({
  data: { memory: null, gentleReminder: false, includeSleepMode: false, loading: true, saving: false, consentRequired: false, error: null },
  onShow() { resetNavigation(this); return this.load() },
  onHide() { this._requestId = (this._requestId || 0) + 1 },
  onUnload() { this.onHide() },
  async load() {
    const id = (this._requestId || 0) + 1
    this._requestId = id
    this.setData({ loading: !this.data.memory, error: null })
    try {
      const profile = await services.auth.getProfile()
      if (id !== this._requestId) return
      if (!profile || !profile.id) { this._ownerId = ''; this.setData({ memory: null, gentleReminder: false, includeSleepMode: false, consentRequired: true }); return }
      if (this._ownerId && this._ownerId !== profile.id) this.setData({ memory: null, gentleReminder: false, includeSleepMode: false, loading: true })
      this._ownerId = profile.id
      const memory = await services.ai.getMemory()
      if (id !== this._requestId) return
      this.applyMemory(memory)
      this.setData({ consentRequired: !profile.aiDataAuthorized })
    } catch (error) { if (id === this._requestId) this.setData({ error: toUserError(error, 'AI 记忆') }) }
    finally { if (id === this._requestId) this.setData({ loading: false }) }
  },
  applyMemory(memory) { this.setData({ memory, gentleReminder: memory.items.some((item) => item.id === 'gentle-reminder'), includeSleepMode: memory.items.some((item) => item.id === 'sleep-mode') }) },
  toggleGentle(event) { return this.updatePreference('gentleReminder', event) },
  toggleSleepMemory(event) { return this.updatePreference('includeSleepMode', event) },
  async updatePreference(key, event) {
    if (this.data.saving) return
    const enabled = Boolean(event.detail.value)
    if (enabled && this.data.consentRequired) { this.setData({ [key]: this.data[key] }); return }
    if (enabled === this.data[key]) return
    const requestId = this._requestId
    const ownerId = this._ownerId
    this.setData({ saving: true, error: null })
    try {
      const label = key === 'gentleReminder' ? '偏好温和提醒' : '同睡情况'
      const result = await new Promise((resolve) => wx.showModal({ title: enabled ? '记住这项资料？' : '移除这项记忆？', content: enabled ? `以后对话会参考“${label}”，不会自动更改设备设置。` : '以后 AI 不再使用这项资料。旧对话原文仍保留，设备当前设置保持不变。', confirmText: enabled ? '记住' : '移除', cancelText: '取消', confirmColor: '#654617', success: resolve, fail: () => resolve({ confirm: false }) }))
      if (requestId !== this._requestId) return
      if (result.confirm) {
        const profile = await services.auth.getProfile()
        if (requestId !== this._requestId || !profile || profile.id !== ownerId) return
        const memory = await services.ai.updateMemory({ [key]: enabled })
        if (requestId === this._requestId) this.applyMemory(memory)
      }
      else this.setData({ [key]: this.data[key] })
    } catch (error) { this.setData({ error: toUserError(error, '记忆设置'), [key]: this.data[key] }) }
    finally { this.setData({ saving: false }) }
  },
  openProfile() { return openAiAuthorization(this, wx) },
  async openSleepMode() {
    if (this.data.saving || this.data.consentRequired) return
    const selected = await new Promise((resolve) => wx.showActionSheet({ itemList: ['独睡', '共享睡眠'], success: (value) => resolve(value.tapIndex), fail: () => resolve(-1) }))
    if (selected < 0) return
    this.setData({ saving: true, error: null })
    try {
      await services.auth.saveProfile({ sleepMode: selected === 0 ? 'solo' : 'shared' })
      await this.load()
    } catch (error) { this.setData({ error: toUserError(error, '同睡资料') }) }
    finally { this.setData({ saving: false }) }
  },
})
