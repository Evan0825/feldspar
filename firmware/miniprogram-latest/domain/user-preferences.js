function normalizePreferences(input = {}) {
  return {
    nickname: String(input.nickname || '月石用户').trim().slice(0, 16) || '月石用户',
    sleepMode: input.sleepMode === 'solo' ? 'solo' : 'shared',
    excludeSoundReminder: input.excludeSoundReminder === true,
    excludeLightReminder: input.excludeLightReminder === true,
  }
}

function reminderRestriction(input) {
  const preferences = normalizePreferences(input)
  const excluded = []
  if (preferences.excludeSoundReminder) excluded.push('声音')
  if (preferences.excludeLightReminder) excluded.push('灯光')
  return excluded.length ? `不使用${excluded.join('、')}${excluded.length === 1 ? '提醒' : ''}` : '无'
}

module.exports = { normalizePreferences, reminderRestriction }
