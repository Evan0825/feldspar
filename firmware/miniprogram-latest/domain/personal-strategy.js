const { reminderRestriction } = require('./user-preferences')
const { dateKey } = require('./ai-display')
const { shiftDate } = require('./sleep-period')
const { rangeFor, buildTrend } = require('./sleep-data-view')

const STAGES = [
  { id: 'collecting', title: '初始方案', detail: '收集 7 晚有效记录' },
  { id: 'preliminary', title: '初步方案', detail: '根据记录适配' },
  { id: 'calibrating', title: '校准期方案', detail: '结合新数据和反馈校准' },
  { id: 'iterating', title: '持续迭代', detail: '随记录评估' },
]

function countCollectionNights(nights) {
  return Array.isArray(nights)
    ? Math.min(7, new Set(nights.filter(night => night.valid && (night.date || night.nightId)).map(night => night.date || night.nightId)).size)
    : null
}

async function loadCalibrationProgress(reports, plan, today) {
  const appliedAt = typeof plan?.appliedAt === 'number' && plan.appliedAt < 1e12 ? plan.appliedAt * 1000 : plan?.appliedAt
  const appliedDay = dateKey(appliedAt)
  const recentStart = shiftDate(today, -6)
  const afterPush = appliedDay ? shiftDate(appliedDay, 1) : ''
  const start = afterPush && afterPush > recentStart ? afterPush : recentStart
  const rows = start <= today ? await reports.getPeriodTrend({ periodStart: start, periodEnd: today }) : []
  const trend = buildTrend(rows, rangeFor(start, today, today))
  const days = trend.rows.length
  return {
    nights: trend.validCount,
    feedback: rows.feedbackUnavailable ? null : trend.feedbackCount,
    coverageLabel: afterPush && start === afterPush ? '本次推送后' : '最近 7 晚',
    days,
    percent: days ? Math.round(trend.validCount / days * 100) : 0,
  }
}

function buildPersonalStrategy({ nights = null, status = null, guardian = null, profile = {}, plan = null } = {}) {
  const days = countCollectionNights(nights)
  const confirmedStage = plan && plan.deviceConfirmed === true ? STAGES.findIndex((stage) => stage.id === plan.stage) : -1
  const stageIndex = Math.max(0, confirmedStage)
  let operation = '状态待同步'
  if (status && status.host && status.host.online && (!status.runtimeFreshness || status.runtimeFreshness === 'fresh') && (!guardian || guardian.freshness !== 'stale')) {
    if ((status.safety && status.safety.stopLatched) || (guardian && guardian.guardianState === 'stopped')) operation = '已停止'
    else if (guardian && guardian.guardianState === 'intervening') operation = '温和提醒中'
    else if (guardian && guardian.guardianState === 'verifying') operation = '验证响应中'
    else operation = status.localLoop && status.localLoop.active === false ? '仅观察' : '观察中'
  }
  return {
    stageIndex,
    title: STAGES[stageIndex].title,
    badge: stageIndex > 0 ? '已确认' : days === null ? '待同步' : days >= 7 ? '待生成' : '收集阶段',
    collectedNights: days,
    canReview: days === 7 || stageIndex > 0,
    progressLabel: days === null ? '进度待同步' : `第${days}/7天`,
    progressPercent: days === null ? null : Math.round(days / 7 * 100),
    stages: STAGES.map((stage, index) => ({ ...stage, current: index === stageIndex, complete: index < stageIndex })),
    operation,
    restriction: reminderRestriction(profile),
    transition: stageIndex === 0 ? '收集满 7 晚后，可查看初步方案。' : '结合新记录和晨间反馈调整。推送后以设备回读为准。',
  }
}

function planKey(mode, deviceId) { return `haomian-calibration-plan:${mode}:${deviceId}` }

function readLocalPlan(storage, mode, deviceId) {
  if (!deviceId || typeof storage?.getStorageSync !== 'function') return null
  try { return storage.getStorageSync(planKey(mode, deviceId)) || null } catch { return null }
}

function confirmedPlan(settings, deviceId, storage, mode) {
  if (settings?.personalStrategy?.deviceConfirmed === true) return settings.personalStrategy
  const local = readLocalPlan(storage, mode, deviceId)?.confirmed
  return local?.configVersion === settings?.configVersion ? local : null
}

function rememberPlanCommand(storage, mode, command) {
  const deviceId = command?.deviceId
  if (!deviceId || !command.commandId || typeof storage?.setStorageSync !== 'function') return
  const state = readLocalPlan(storage, mode, deviceId) || {}
  const previous = state.confirmed
  if (previous?.commandId === command.commandId) return
  if (command.status === 'applied' && command.matchesCandidate === true && command.readbackSettings &&
      Number.isInteger(command.readbackConfigVersion) && command.readbackConfigVersion > command.expectedConfigVersion &&
      (!previous || command.readbackConfigVersion > previous.configVersion)) {
    state.confirmed = {
      deviceConfirmed: true, commandId: command.commandId, configVersion: command.readbackConfigVersion,
      stage: previous?.configVersion === command.expectedConfigVersion ? 'calibrating' : 'preliminary',
      appliedAt: command.readbackAt || new Date().toISOString(),
    }
  }
  if (['pending', 'validating', 'sending', 'ack-accepted', 'readback-pending'].includes(command.status)) {
    state.pendingId = command.commandId
  } else if (state.pendingId === command.commandId) {
    state.pendingId = ''
  }
  try { storage.setStorageSync(planKey(mode, deviceId), state) } catch {}
}

module.exports = { buildPersonalStrategy, countCollectionNights, loadCalibrationProgress, confirmedPlan, readLocalPlan, rememberPlanCommand }
