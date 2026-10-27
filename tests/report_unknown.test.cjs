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
