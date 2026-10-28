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
