const { isoDate, shiftDate, periodFor } = require('./sleep-period')
const number = (...values) => values.find(value => Number.isFinite(value) && value >= 0)
const shortDate = date => `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`
const fullDate = date => `${date.slice(0, 4)}年${shortDate(date)}`
const monthLabel = month => `${month.slice(0, 4)}年${Number(month.slice(5))}月`
const rangeLabel = range => range.start.slice(0, 4) === range.end.slice(0, 4) ? `${shortDate(range.start)}—${shortDate(range.end)}` : `${fullDate(range.start)}—${fullDate(range.end)}`
const decimal = value => Number.isFinite(value) ? (Math.round(value * 10) / 10).toFixed(1) : '—'
function recordDate(record) { return isoDate(record.dateISO || record.sourceDate || record.nightId || record.date) }
function findRecord(records, date) { return records.find(record => recordDate(record) ? recordDate(record) === date : record.date === `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`) }
function rangeFor(start, end, today) {
  const dates = []
  for (let date = start; date <= end; date = shiftDate(date, 1)) dates.push(date)
  const queryEnd = end > today ? today : end
  return { start, end, queryEnd, dates, elapsedDays: dates.filter(date => date <= queryEnd).length }
}
function buildTrend(records, range) {
  const rows = range.dates.map(date => {
    const record = findRecord(records, date), future = date > range.queryEnd, valid = Boolean(!future && record && record.valid)
    const minutes = valid ? number(record.effectiveMonitoringMinutes) : undefined
    const events = valid ? number(record.snoreEvents, record.snoreEventCount) : undefined
    const reminders = valid ? number(record.interventions, record.interventionCount) : undefined
    const responses = valid ? number(record.responseCount) : undefined
    const rate = events !== undefined && minutes > 0 ? events / (minutes / 60) : null
    const feedback = valid && record.feedback && typeof record.feedback.awakened === 'boolean' ? record.feedback : null
    return { date, label: fullDate(date), axisLabel: String(Number(date.slice(8))), valid, state: future ? 'future' : !valid ? 'missing' : rate === null ? 'unknown' : 'value', rate, rateLabel: decimal(rate), minutes: minutes === undefined ? null : minutes, events: events === undefined ? null : events, reminders: reminders === undefined ? null : reminders, responses: responses !== undefined && reminders !== undefined && responses <= reminders ? responses : null, feedback }
  })
  const rates = rows.filter(row => row.rate !== null), reminders = rows.filter(row => row.reminders !== null), feedback = rows.filter(row => row.feedback)
  const rate = rates.length ? rates.reduce((sum, row) => sum + row.events, 0) / (rates.reduce((sum, row) => sum + row.minutes, 0) / 60) : null
  const reminderMean = reminders.length ? reminders.reduce((sum, row) => sum + row.reminders, 0) / reminders.length : null
  const awakenedCount = feedback.filter(row => row.feedback.awakened).length
  return { rows, rate, rateLabel: decimal(rate), rateCount: rates.length, validCount: rows.filter(row => row.valid).length, reminderMean, reminderLabel: decimal(reminderMean), reminderCount: reminders.length, feedbackCount: feedback.length, awakenedCount, feedbackLabel: feedback.length ? `${feedback.length}晚 · ${awakenedCount}晚被弄醒` : '暂无晨间反馈' }
}
function monthSpans(records, range) {
  const spans = []
  for (let start = range.start; start <= range.queryEnd;) {
    const end = [periodFor(start, 'week', range.queryEnd).end, range.end, range.queryEnd].sort()[0]
    const part = rangeFor(start, end, range.queryEnd), view = buildTrend(records, part)
    spans.push({ ...part, ...view, label: rangeLabel(part), axisLabel: `${Number(start.slice(8))}—${Number(end.slice(8))}` })
    start = shiftDate(end, 1)
  }
  return spans
}
function buildCalendar(month, selection, today, records) {
  const range = selection.range || periodFor(selection.date, selection.scope, today)
  const natural = periodFor(month + '-01', 'month', today)
  const start = periodFor(natural.start, 'week', today).start
  const count = Math.ceil((Math.round((Date.parse(natural.end) - Date.parse(start)) / 86400000) + 1) / 7) * 7
  return Array.from({ length: count }, (_, index) => {
    const date = shiftDate(start, index)
    return { date, day: Number(date.slice(8)), label: fullDate(date), outside: !date.startsWith(month), inRange: date >= range.start && date <= range.end, selected: date === selection.date, today: date === today, disabled: date > today, hasData: Boolean(date <= today && findRecord(records, date) && findRecord(records, date).valid) }
  })
}
function clockMinutes(value) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')) return null; const parts = value.split(':').map(Number); return parts[0] * 60 + parts[1] }
function buildNight(report, events) {
  const start = clockMinutes(report.startTime), end = clockMinutes(report.endTime), date = recordDate(report)
  const duration = start !== null && end !== null && start !== end ? (end - start + 1440) % 1440 : null
  const offset = time => { const value = clockMinutes(time); return value === null || start === null ? null : (value - start + 1440) % 1440 }
  const rows = events.map(event => {
    const minute = offset(event.time), endMinute = offset(event.endTime)
    return { ...event, time: clockMinutes(event.time) === null ? '—' : event.time, minute, endMinute, positioned: duration !== null && minute !== null && minute <= duration }
  }).sort((a, b) => (a.minute === null ? Infinity : a.minute) - (b.minute === null ? Infinity : b.minute))
  const reminders = rows.filter(event => event.type === 'intervention').map(event => ({ ...event, trigger: rows.find(row => row.id === event.triggerEventId && row.type === 'snore') || null, response: rows.find(row => row.interventionId === event.id && row.type === 'response') || null }))
  const protection = rows.find(event => event.type === 'sleep-protection' && event.positioned)
  const gaps = rows.filter(event => event.type === 'gap' && event.positioned && event.endMinute > event.minute && event.endMinute <= duration)
  const merged = []
  for (const gap of gaps) {
    const last = merged[merged.length - 1]
    if (last && gap.minute <= last.end) last.end = Math.max(last.end, gap.endMinute)
    else merged.push({ start: gap.minute, end: gap.endMinute })
  }
  const missingMinutes = merged.length ? merged.reduce((sum, gap) => sum + gap.end - gap.start, 0) : null
  const crossesMidnight = start !== null && end !== null && end < start
  const startDate = date && crossesMidnight ? shiftDate(date, -1) : date
  return { events: rows, reminders, protectionEnd: protection ? protection.time : '', missingMinutes, start: report.startTime || '—', end: report.endTime || '—', duration, hasTimeline: duration !== null && rows.some(row => row.positioned), rangeLabel: date ? `${shortDate(startDate)} ${report.startTime || '—'} — ${shortDate(date)} ${report.endTime || '—'}` : '起止日期待同步' }
}
function reminderMetrics(report) {
  const count = value => Number.isInteger(value) && value >= 0 ? value : null
  const reminders = count(report.interventionCount)
  const stopped = count(report.snoreStoppedResponses)
  const turned = count(report.turnOverResponses)
  const observed = count(report.responseCount) ?? (stopped !== null && turned !== null ? stopped + turned : null)
  const responses = observed !== null && (reminders === null || observed <= reminders) ? observed : null
  return { reminders, responses, fraction: reminders > 0 && responses !== null ? `${responses}/${reminders}` : '—' }
}

function summarizeReminderTiming(report, events, reminderCount) {
  if (report.eventSpanOnly || !Array.isArray(events) || reminderCount < 3) return ''
  const { duration, reminders } = buildNight(report, events)
  if (!duration || reminders.length !== reminderCount ||
      reminders.some(event => !event.positioned || (!event.id && !(event.roundInNight > 0)) || (event.nightId && event.nightId !== report.id))) return ''
  const identities = new Set(reminders.map(event => event.roundInNight > 0 ? `round:${event.roundInNight}` : `event:${event.id}`))
  if (identities.size !== reminderCount) return ''
  const later = reminders.filter(event => event.minute >= duration / 2).length
  if (later > reminderCount / 2) return '提醒多出现在后半夜。'
  if (later < reminderCount / 2) return '提醒多出现在前半夜。'
  return ''
}

module.exports = { number, shortDate, fullDate, monthLabel, rangeLabel, decimal, rangeFor, buildTrend, monthSpans, buildCalendar, buildNight, reminderMetrics, summarizeReminderTiming }
