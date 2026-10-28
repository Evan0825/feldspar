const services = require('../../services/index')
const { normalizePreferences } = require('../../domain/user-preferences')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')

Page({
  data: {
    phase: 'login',
    editingProfile: false,
    preferencesLoaded: false,
    excludeSoundReminder: false,
    excludeLightReminder: false,
    loading: false,
    submitting: false,
    error: null,
    nickname: '月石用户',
    sleepMode: 'shared',
    privacy: { structured: true, rawAudio: true, nonMedical: true },
  },

  onLoad(options = {}) {
    if (options.edit === '1') {
      this.setData({ editingProfile: true, phase: 'profile' })
      if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: '个性化偏好' })
      return this.loadPreferences()
    }
    this._reauth = options.reauth === '1'
    if (!this._reauth && wx.getStorageSync('haomian-setup-complete')) {
      wx.switchTab({ url: '/pages/home/index' })
    }
  },

  async login() {
    if (this.data.submitting) return
    this.setData({ loading: true, submitting: true, error: null })
    try {
      // A valid cached session resolves immediately. Only invoke wx.login when
      // the adapter explicitly says the session is missing or expired.
      let result
      if (this._reauth) {
        result = await services.auth.login({ code: await getWeChatLoginCode(), force: true })
      } else {
        try {
          result = await services.auth.login({})
        } catch (error) {
          if (error.code !== 'AUTH_EXPIRED' && error.message !== 'AUTH_EXPIRED') throw error
          result = await services.auth.login({ code: await getWeChatLoginCode() })
        }
      }
      const hasBoundDevice = Array.isArray(result.devices) && result.devices.length > 0
      if (hasBoundDevice && result.profile && result.profile.privacyAccepted) {
        wx.setStorageSync('haomian-setup-complete', true)
        wx.switchTab({ url: '/pages/home/index' })
        return
      }
      if (this._reauth && wx.getStorageSync('haomian-setup-complete')) {
        wx.removeStorageSync('haomian-setup-complete')
      }
      this.setData({ phase: 'profile', ...normalizePreferences(result.profile) })
    } catch (error) {
      this.setData({ error: toUserError(error, '微信登录') })
    } finally {
      this.setData({ loading: false, submitting: false })
    }
  },

  async loadPreferences() {
    this.setData({ loading: true, error: null, preferencesLoaded: false })
    try {
      const profile = await services.auth.getProfile()
      if (!profile) throw new Error('个人资料暂不可用')
      this.setData({ ...normalizePreferences(profile), preferencesLoaded: true })
    } catch (error) { this.setData({ error: toUserError(error, '个性化偏好') }) }
    finally { this.setData({ loading: false }) }
  },
  toggleReminderExclusion(event) {
    const key = event.currentTarget.dataset.key
    if (this.data.submitting || (this.data.editingProfile && !this.data.preferencesLoaded) || !['excludeSoundReminder', 'excludeLightReminder'].includes(key)) return
    this.setData({ [key]: !this.data[key] })
  },
  explainReminderPreferences() {
    wx.showModal({ title: '提醒方案', content: '振动固定；其余取消勾选即不纳入方案。此处不直接启动提醒，助眠声音和夜灯仍可手动控制。', showCancel: false, confirmText: '知道了' })
  },

  setNickname(event) { if (!this.data.submitting) this.setData({ nickname: event.detail.value }) },
  setSleepMode(event) { if (!this.data.submitting) this.setData({ sleepMode: event.currentTarget.dataset.mode }) },

  async saveProfile() {
    if (this.data.submitting || (this.data.editingProfile && !this.data.preferencesLoaded)) return
    this.setData({ submitting: true, error: null })
    try {
      const profile = await services.auth.saveProfile(normalizePreferences(this.data))
      if (this.data.editingProfile) {
        wx.setStorageSync('haomian-profile', profile)
        wx.navigateBack()
        return
      }
      this.setData({ phase: 'privacy' })
    } catch (error) {
      this.setData({ error: toUserError(error, '个人资料') })
    } finally {
      this.setData({ submitting: false })
    }
  },

  togglePrivacy(event) {
    if (this.data.submitting) return
    const key = event.currentTarget.dataset.key
    this.setData({ [`privacy.${key}`]: event.detail.value })
  },

  async acceptPrivacy() {
    if (this.data.submitting || !Object.values(this.data.privacy).every(Boolean)) return
    this.setData({ submitting: true, error: null })
    try {
      const profile = await services.auth.saveProfile({ privacyAccepted: true })
      wx.setStorageSync('haomian-profile', profile)
      wx.removeStorageSync('haomian-demo-mode')
      wx.removeStorageSync('haomian-setup-complete')
      wx.setStorageSync('haomian-setup-mode', 'normal')
      wx.navigateTo({ url: '/pages/setup/index' })
    } catch (error) {
      this.setData({ error: toUserError(error, '隐私授权') })
    } finally {
      this.setData({ submitting: false })
    }
  },

  handleServiceAction(event) {
    if (this.data.editingProfile && !this.data.preferencesLoaded) return this.loadPreferences()
    const retry = this.data.phase === 'login'
      ? () => this.login()
      : this.data.phase === 'profile'
        ? () => this.saveProfile()
        : () => this.acceptPrivacy()
    return runServiceErrorAction(event.detail.action, retry, wx)
  },
})

function getWeChatLoginCode() {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(
      () => finish(reject, Object.assign(new Error('微信登录超时'), { code: 'SYNC_TIMEOUT' })),
      5000,
    )
    wx.login({
      success(result) {
        if (result && result.code) finish(resolve, result.code)
        else finish(reject, Object.assign(new Error('AUTH_EXPIRED'), { code: 'AUTH_EXPIRED' }))
      },
      fail(error) { finish(reject, error) },
    })
  })
}
