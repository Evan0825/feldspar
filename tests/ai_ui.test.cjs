const { test } = require('node:test')
const assert = require('node:assert/strict')
const { attachAiUi } = require('../firmware/miniprogram-latest/services/ai-ui')

test('AI home uses only an interpretation for the exact record being shown', async () => {
  global.wx = { getStorageSync: () => null }
  let record = { nightId: 'other-night', sourceDate: '2026-11-07', conclusion: '其他记录' }
  const service = attachAiUi({
    serviceMode: 'real',
    auth: { getProfile: async () => ({ id: 'user-a', aiDataAuthorized: true }) },
    reports: { getLatest: async () => ({ id: 'this-night', hasData: true }) },
    ai: { getChatSessions: async () => [], getOverview: async () => record },
  })
  assert.equal((await service.ai.getDailyHome()).overview, null)
  record = { nightId: 'this-night', sourceDate: '2026-11-08', conclusion: '当前记录' }
  assert.equal((await service.ai.getDailyHome()).sourceDate, '2026-11-08')
})

test('memory and draft settings are scoped to their user and consent', async () => {
  const storage = new Map()
  global.wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value) }
  let user = { id: 'user-a', aiDataAuthorized: true, sleepMode: 'solo' }
  const service = attachAiUi({ serviceMode: 'real', auth: { getProfile: async () => user }, ai: {}, reports: {} })
  assert.equal((await service.ai.getMemory()).summary, '')
  await service.ai.updateMemory({ includeSleepMode: true })
  await service.ai.saveChatDraft('current', 'draft-a', { ownerId: 'user-a' })
  assert.equal((await service.ai.getMemory()).summary, '独睡')
  user = { id: 'user-b', aiDataAuthorized: false }
  assert.equal(await service.ai.getChatDraft('current'), '')
  assert.equal((await service.ai.getMemory()).summary, '')
  await assert.rejects(service.ai.updateMemory({ gentleReminder: true }), /AI_CONSENT_REQUIRED/)
  await assert.rejects(service.ai.saveChatDraft('current', 'draft-a', { ownerId: 'user-a' }), /AUTH_EXPIRED/)
})
