const { dateKey } = require('../domain/ai-display')
const { isoDate } = require('../domain/sleep-period')

function attachAiUi(services) {
  const { ai, auth, reports } = services

  async function profile() {
    const user = await auth.getProfile()
    if (!user?.id) throw new Error('AUTH_EXPIRED')
    return user
  }

  function key(user, kind) { return `haomian-ai-ui:${services.serviceMode}:${user.id}:${kind}` }
  function read(user, kind) { return wx.getStorageSync(key(user, kind)) || {} }
  function write(user, kind, value) { wx.setStorageSync(key(user, kind), value) }

  function memoryFor(user) {
    const preferences = read(user, 'memory')
    const items = []
    if (preferences.includeSleepMode === true && ['shared', 'solo'].includes(user.sleepMode)) {
      items.push({ id: 'sleep-mode', label: user.sleepMode === 'shared' ? '共享睡眠' : '独睡', source: '个人设置' })
    }
    if (preferences.gentleReminder === true) items.push({ id: 'gentle-reminder', label: '偏好温和提醒', source: '你主动保存的偏好' })
    return { items, summary: items.map(item => item.label).join(' · ') }
  }

  Object.assign(ai, {
    async getDailyHome() {
      const user = await profile()
      if (!user.aiDataAuthorized) throw new Error('AI_CONSENT_REQUIRED')
      const now = new Date()
      const dayKey = dateKey(now)
      const hour = new Date(now.getTime() + 8 * 3600000).getUTCHours()
      const [report, sessions] = await Promise.all([
        reports.getLatest().catch(error => { if (error.code === 'NOT_PROVISIONED') return null; throw error }),
        ai.getChatSessions(),
      ])
      const record = report && report.hasData !== false ? await ai.getOverview('single-night') : null
      const overview = record && record.hasData !== false && record.nightId === report.id && record.conclusion ? record : null
      const sourceDate = overview ? isoDate(overview.sourceDate || overview.nightId) : ''
      const active = sessions.find(item => item.dayKey === dayKey && item.interpretationId === (overview?.interpretationId || '') &&
        (!overview || item.interpretationRevision === overview.revision))
      const prompts = overview ? ['这份记录值得注意什么？', '怎样让提醒更温和？'] : ['睡前怎样做好准备？', '共享睡眠怎样减少打扰？']
      return {
        dayKey, dateLabel: `${Number(dayKey.slice(5, 7))} 月 ${Number(dayKey.slice(8))} 日`,
        period: hour < 5 || hour >= 18 ? 'evening' : hour < 11 ? 'morning' : 'afternoon',
        overview, sourceDate, empty: !overview, activeSessionId: active?.sessionId || '',
        messageTitle: '暂无睡眠解读',
        messageText: overview ? overview.summary || overview.conclusion : report ? '可先查看睡眠记录。' : '可以先聊聊睡前准备。',
        memorySummary: memoryFor(user).summary,
        questions: prompts.map((text, index) => ({ id: index + 1, text })),
      }
    },
    async getMemory() { return memoryFor(await profile()) },
    async updateMemory(next) {
      const user = await profile()
      const state = read(user, 'memory')
      for (const field of ['gentleReminder', 'includeSleepMode']) {
        if (typeof next[field] !== 'boolean') continue
        if (next[field] && !user.aiDataAuthorized) throw new Error('AI_CONSENT_REQUIRED')
        state[field] = next[field]
      }
      write(user, 'memory', state)
      return memoryFor(user)
    },
    async getChatDraft(context) {
      const user = await profile()
      if (!user.aiDataAuthorized) return ''
      return read(user, 'drafts')[context] || ''
    },
    async saveChatDraft(context, text, { ownerId } = {}) {
      const user = await profile()
      if (ownerId && ownerId !== user.id) throw new Error('AUTH_EXPIRED')
      if (!user.aiDataAuthorized) throw new Error('AI_CONSENT_REQUIRED')
      const drafts = read(user, 'drafts')
      if (text) {
        delete drafts[context]
        drafts[context] = text
      } else delete drafts[context]
      const entries = Object.entries(drafts).slice(-30)
      write(user, 'drafts', Object.fromEntries(entries))
      return text || ''
    },
  })
  return services
}

module.exports = { attachAiUi }
