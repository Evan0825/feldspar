function dateKey(value) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10)
}
function groupRecords(records, tab, now = new Date()) {
  const today = dateKey(now)
  const previous = new Date(now); previous.setDate(previous.getDate() - 1)
  const yesterday = dateKey(previous)
  const groups = [{ label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '更早', items: [] }]
  records.slice().sort((a, b) => timestamp(b) - timestamp(a)).forEach((item) => {
    const value = item.updatedAt || item.generatedAtISO || item.generatedAt
    const key = dateKey(value)
    const time = new Date(new Date(value).getTime() + 8 * 3600000)
    const group = key === today ? groups[0] : key === yesterday ? groups[1] : groups[2]
    group.items.push({
      id: tab === 'conversations' ? item.sessionId : item.interpretationId,
      revision: item.revision || 1,
      title: item.contextConclusion && /^(为什么这样判断[？?]?|针对本次继续追问|告诉我更多|继续聊聊)/.test(item.title || '') ? item.contextConclusion : item.title || item.conclusion || '与 AI 的对话',
      sourceDate: item.sourceDate || item.contextDate || '',
      sourceLabel: sourceDateLabel({ ...item, sourceDate: item.sourceDate || item.contextDate }),
      preview: item.preview || item.summary || '点击继续对话',
      timeLabel: !key ? '历史记录' : key === today || key === yesterday ? `${String(time.getUTCHours()).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')}` : `${time.getUTCMonth() + 1} 月 ${time.getUTCDate()} 日`,
      kindLabel: tab === 'interpretations' ? item.kind === 'seven-night' ? '7 晚解读' : '单晚解读' : '',
    })
  })
  return groups.filter((item) => item.items.length)
}
function formatSourceDate(value) {
  const match = String(value || '').match(/(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日` : ''
}
function sourceDateLabel(source = {}) {
  if (source.periodStart && source.periodEnd) return `${formatSourceDate(source.periodStart)} — ${formatSourceDate(source.periodEnd)}`
  return formatSourceDate(source.sourceDate || source.nightId)
}
function timestamp(item) { return new Date(item.updatedAt || item.generatedAtISO || item.generatedAt).getTime() || 0 }
module.exports = { dateKey, groupRecords, formatSourceDate, sourceDateLabel }
