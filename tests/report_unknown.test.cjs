const { test } = require('node:test')
const assert = require('node:assert/strict')
const env = require('../firmware/miniprogram-latest/config/env')
env.transport = 'public'
function api(payload) {
  global.wx = { getStorageSync: key => key === 'haomian-device-id' ? 'test' : 'test-session',
    setStorageSync() {}, removeStorageSync() {},
    request: o => queueMicrotask(() => o.success({ statusCode: 200, data: payload })) }
  const name = require.resolve('../firmware/miniprogram-latest/services/real')
  delete require.cache[name]
  return require(name).createRealServices()
}
test('partial report does not invent posture, response, quality, duration or assessment', async () => {
  const result = await api({ has_data: true, night_id: 'test', event_count: 2,
    timeline: [{ event_type: 'snore_candidate', timestamp: 1000 }, { event_type: 'snore_candidate', timestamp: 2000 }],
    reminder_stats: { total_count: 1, success_count: 1 } }).reports.getLatest()
  assert.equal(result.supineAssociationRate, null)
  assert.equal(result.snoreStoppedResponses, null)
  assert.equal(result.turnOverResponses, null)
  assert.equal(result.dataQualityScore, null)
  assert.equal(result.dataQuality, '未评估')
  assert.equal(result.effectiveMonitoringMinutes, null)
  assert.equal(result.attentionLevel, 'unknown')
  assert.equal(result.interventionSuccessRate, null)
  assert.equal(result.snoreEventCount, 2)
})
test('explicit zero observations remain zero and empty reports remain empty', async () => {
  let report = await api({ has_data: true, supine_association_rate: 0, snore_stopped_responses: 0,
    turn_over_responses: 0, data_quality_score: 0, effective_monitoring_minutes: 0,
    reminder_stats: { total_count: 1, success_rate: 0 } }).reports.getLatest()
  assert.equal(report.supineAssociationRate, 0)
  assert.equal(report.snoreStoppedResponses, 0)
  assert.equal(report.dataQualityScore, 0)
  assert.equal(report.effectiveMonitoringMinutes, 0)
  assert.equal(report.interventionSuccessRate, 0)
  report = await api({ has_data: false, timeline: [], reminder_stats: {} }).reports.getLatest()
  assert.equal(report.hasData, false)
})

test('AI interpretation does not invent a period, quality, metrics or generation time', () => {
  const { wrapInterpretation } = require('../firmware/miniprogram-latest/services/real').__test__
  const record = wrapInterpretation({ summary: '观察结论', basis: ['仅有文字依据'] }, 'seven-night')
  assert.equal(record.periodStart, null)
  assert.equal(record.periodEnd, null)
  assert.equal(record.dataQuality, '未评估')
  assert.equal(record.generatedAt, '')
  assert.equal(record.source, 'unknown')
  assert.equal(record.sourceLabel, '来源未标注')
  assert.equal(record.evidence[0].value, '—')
  assert.equal(record.evidence[0].unit, '')
})
test('AI interpretation keeps explicitly provided dates and quality', () => {
  const { wrapInterpretation } = require('../firmware/miniprogram-latest/services/real').__test__
  const record = wrapInterpretation({ summary: '观察结论', period_start: '2026-08-25', period_end: '2026-08-31', data_quality: '良好', generated_at: '2026-09-01T00:00:00Z' }, 'seven-night')
  assert.equal(record.periodStart, '2026-08-25')
  assert.equal(record.periodEnd, '2026-08-31')
  assert.equal(record.dataQuality, '良好')
  assert.match(record.periodLabel, /2026-08-25.*2026-08-31/)
})

test('an exact morning date resolves the backend night bucket and keeps its original identifier', async () => {
  const id = '20261107_test'
  const service = api({ has_data: true, night_id: id, date: '20261107', event_count: 1 })
  const request = global.wx.request
  const urls = []
  global.wx.request = options => { urls.push(options.url); request(options) }
  const report = await service.reports.getByNightId('night-2026-11-08')
  assert.equal(report.id, id)
  assert.equal(report.sourceDate, '2026-11-08')
  assert.match(urls[0], /night_id=20261107_test&generate_ai=false/)
  assert.equal(await service.reports.getByNightId('night-2026-11-07'), null)
})

test('the period adapter counts only in-range nights and does not substitute rounds for snoring or time', async () => {
  const service = api({})
  global.wx.request = options => queueMicrotask(() => options.success({ statusCode: 200, data: options.url.includes('/weekly/') ? {
    daily: [
      { night_id: '20261102_test', date: '20261102', event_count: 3, total_rounds: 2 },
      { night_id: '20261030_test', date: '20261030', event_count: 1, total_rounds: 0 },
    ],
  } : { feedbacks: [{ night_id: '20261102_test', awakened: false }] } }))
  const rows = await service.reports.getPeriodTrend({ periodStart: '2026-11-01', periodEnd: '2026-11-08' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].dateISO, '2026-11-03')
  assert.equal(rows[0].interventions, 2)
  assert.equal(rows[0].effectiveMonitoringMinutes, null)
  assert.equal(rows[0].snoreEvents, null)
  assert.equal(rows[0].feedback.awakened, false)
})

test('a historical AI question cannot be sent to the latest-night endpoint', async () => {
  const service = api({})
  let messages = 0
  global.wx.request = options => {
    if (options.url.includes('/ai/chat')) messages++
    const payload = options.url.includes('/user/me/profile')
      ? { id: 'test-user', aiDataAuthorized: true }
      : { night_id: '20261107_test', has_data: true, event_count: 1 }
    queueMicrotask(() => options.success({ statusCode: 200, data: payload }))
  }
  await assert.rejects(service.ai.ask({ message: '这份记录说明什么', sourceDate: '2026-11-07' }), {
    code: 'AI_HISTORICAL_CONTEXT_UNAVAILABLE',
  })
  assert.equal(messages, 0)
})
