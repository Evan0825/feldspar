const { reminderRestriction } = require('./user-preferences')

const STAGES = [
  { id: 'collecting', title: '初始方案', detail: '收集7日记录' },
  { id: 'preliminary', title: '初步方案', detail: '根据记录生成' },
  { id: 'calibrating', title: '校准期方案', detail: '结合反馈调整' },
  { id: 'iterating', title: '持续迭代', detail: '随记录评估' },
]

function buildPersonalStrategy({ nights = null, status = null, guardian = null, profile = {}, plan = null } = {}) {
  const days = Array.isArray(nights)
    ? Math.min(7, new Set(nights.filter((night) => night.valid && (night.date || night.nightId)).map((night) => night.date || night.nightId)).size)
    : null
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
    progressLabel: days === null ? '进度待同步' : `第${days}/7天`,
    progressPercent: days === null ? null : Math.round(days / 7 * 100),
    stages: STAGES.map((stage, index) => ({ ...stage, current: index === stageIndex, complete: index < stageIndex })),
    operation,
    restriction: reminderRestriction(profile),
    transition: stageIndex === 0 ? '完成7日收集后生成待确认方案。' : '方案调整需确认，并等待设备回读。',
  }
}

module.exports = { buildPersonalStrategy }
