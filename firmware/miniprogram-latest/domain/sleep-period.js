const PERIOD_METRICS = [
  { id: 'duration', label: '有效监测', averageLabel: '平均有效监测', unit: '小时' },
  { id: 'snore', label: '鼾声事件', averageLabel: '日均鼾声事件', unit: '次' },
  { id: 'reminders', label: '提醒次数', averageLabel: '日均提醒次数', unit: '次' },
  { id: 'response', label: '提醒响应', averageLabel: '平均响应率', unit: '%' },
]
function isoDate(value) {
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/)
  if (!match) return ''
  const date = new Date(`${match[0]}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[0] ? match[0] : ''
}
function shiftDate(value, days) { return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10) }
function dateLabel(value) { return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` }
function periodFor(value, scope, today) {
  const date = isoDate(value)
  if (!date) return null
  let start = date, end = date
  if (scope === 'week') {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    start = shiftDate(date, -(weekday + 6) % 7)
    end = shiftDate(start, 6)
  } else if (scope === 'month') {
    start = date.slice(0, 7) + '-01'
    const next = new Date(`${start}T00:00:00Z`)
    next.setUTCMonth(next.getUTCMonth() + 1)
    end = shiftDate(next.toISOString().slice(0, 10), -1)
  }
  const length = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1
  const dates = Array.from({ length }, (_, index) => shiftDate(start, index))
  const queryEnd = today && today < end ? today : end
  return { start, end, queryEnd, dates, elapsedDays: dates.filter(day => day <= queryEnd).length, label: scope === 'month' ? `${start.slice(0, 4)}年${Number(start.slice(5, 7))}月` : `${start.slice(0, 4)}年${dateLabel(start)} — ${end.slice(0, 4) === start.slice(0, 4) ? '' : end.slice(0, 4) + '年'}${dateLabel(end)}` }
}
function movePeriod(date, scope, direction) {
  if (scope !== 'month') return shiftDate(date, direction * (scope === 'week' ? 7 : 1))
  const next = new Date(`${date.slice(0, 7)}-01T00:00:00Z`)
  next.setUTCMonth(next.getUTCMonth() + direction)
  const first = next.toISOString().slice(0, 10)
  const end = periodFor(first, 'month', '9999-12-31').end
  return first.slice(0, 8) + String(Math.min(Number(date.slice(8)), Number(end.slice(8)))).padStart(2, '0')
}
function metricValue(record, metric) {
  const number = (...values) => values.find(value => Number.isFinite(value) && value >= 0)
  if (metric === 'duration') return number(record.effectiveMonitoringMinutes)
  if (metric === 'snore') return number(record.snoreEvents, record.snoreEventCount)
  if (metric === 'reminders') return number(record.interventions, record.interventionCount)
  const attempts = number(record.interventions, record.interventionCount)
  const responses = number(record.responseCount)
  if (attempts === 0) return undefined
  if (responses !== undefined && attempts > 0) return responses <= attempts ? responses / attempts * 100 : undefined
  const rate = number(record.responseRate, record.successRate)
  return rate <= 100 ? rate : undefined
}
function formatValue(value, metric) {
  if (!Number.isFinite(value)) return '—'
  if (metric === 'duration') { const minutes = Math.round(value); return `${Math.floor(minutes / 60)}小时${minutes % 60}分` }
  return `${Math.round(value * 10) / 10}${metric === 'response' ? '%' : '次'}`
}
function buildPeriodView(records, period, metric = 'duration') {
  const rows = period.dates.map((date, index) => {
    const record = records.find(item => isoDate(item.dateISO || item.sourceDate || item.nightId || item.date) === date || item.date === dateLabel(date))
    const future = date > period.queryEnd
    const valid = Boolean(!future && record && record.valid)
    const value = valid ? metricValue(record, metric) : undefined
    return { date, label: dateLabel(date), axisLabel: period.dates.length <= 7 ? ['一', '二', '三', '四', '五', '六', '日'][index] : (index === 0 || ((index + 1) % 5 === 0 && period.dates.length - 1 - index > 2) || index === period.dates.length - 1 ? String(Number(date.slice(8))) : ''), valid, value: value === undefined ? null : value, state: future ? 'future' : !valid ? 'missing' : value === undefined ? 'unknown' : 'value', valueLabel: formatValue(value, metric) }
  })
  const values = rows.filter(row => row.state === 'value').map(row => row.value)
  const rawMax = Math.max(1, ...values)
  const axisMax = metric === 'response' ? 100 : metric === 'duration' ? Math.ceil(rawMax / 60) * 60 : Math.ceil(rawMax / 5) * 5
  for (const row of rows) row.barHeight = row.state === 'value' ? Math.max(3, Math.round(row.value / axisMax * 190)) : 12
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  return { rows, average, averageLabel: formatValue(average, metric), validCount: rows.filter(row => row.valid).length, coverageCount: values.length, axisTop: !values.length ? '' : metric === 'duration' ? `${axisMax / 60}h` : `${axisMax}${metric === 'response' ? '%' : ''}` }
}
const sleepPeriodApi = { PERIOD_METRICS, isoDate, shiftDate, periodFor, movePeriod, metricValue, formatValue, buildPeriodView }
if (typeof module !== 'undefined' && module.exports) module.exports = sleepPeriodApi
else globalThis.MoonstonePeriod = sleepPeriodApi
