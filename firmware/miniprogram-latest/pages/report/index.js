const services = require('../../services/index')
const { navigate, resetNavigation, takeSleepSourceRequest } = require('../../domain/ai-navigation')
const { dateKey, sourceDateLabel } = require('../../domain/ai-display')
const { isoDate, shiftDate } = require('../../domain/sleep-period')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')
const { fullDate, reminderMetrics, summarizeReminderTiming } = require('../../domain/sleep-data-view')

function recentDates(end) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(end, index - 6)
    return { date, label: fullDate(date), day: Number(date.slice(8)), weekday: '日一二三四五六'[new Date(date).getUTCDay()] }
  })
}

function monthLabel(date) {
  const month = `${Number(date.slice(5, 7))}月`
  return date.slice(0, 4) === dateKey(new Date()).slice(0, 4) ? month : `${date.slice(0, 4)}年${month}`
}

Page({
  data: { sourceLabel: '', recentDays: [], selectedDate: '', selectedMonth: '', report: null, durationHours: null, durationMinutes: null, feedback: null, reminderCount: null, responseCount: null, observationOnly: false, nightSummary: '', phase: 'loading', error: null },
  onShow() {
    resetNavigation(this)
    const source = takeSleepSourceRequest()
    if (source) {
      this._source = source
      this._quickDate = ''
      this.setData({ sourceLabel: sourceDateLabel(source) || '指定记录' })
    }
    return this.load()
  },
  onHide() { this._requestId = (this._requestId || 0) + 1 },
  onPullDownRefresh() { return this.load().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    const id = this._requestId = (this._requestId || 0) + 1
    const source = this._source
    const quickDate = this._quickDate
    this.setData({ report: null, feedback: null, nightSummary: '', error: null, phase: 'loading' })
    if (source?.kind === 'seven-night') {
      this.setData({ phase: source.periodEnd ? 'period' : 'source-unavailable' })
      return
    }
    try {
      const nightId = source ? source.nightId || (source.sourceDate && `night-${source.sourceDate}`) : quickDate && `night-${quickDate}`
      const report = source || quickDate ? (nightId && await services.reports.getByNightId(nightId)) : await services.reports.getLatest()
      if (id !== this._requestId) return
      const reportDate = isoDate(report?.sourceDate) || isoDate(report?.id)
      if (!source && !quickDate) {
        const end = reportDate || dateKey(new Date())
        this.setData({ recentDays: recentDates(end), selectedDate: end, selectedMonth: monthLabel(end) })
      }
      if (!report || report.hasData === false || (source?.nightId && report.id !== source.nightId) ||
        ((source?.sourceDate || quickDate) && reportDate !== (source?.sourceDate || quickDate))) {
        this.setData({ phase: source ? 'source-unavailable' : 'empty' })
        return
      }
      const duration = Number.isFinite(report.effectiveMonitoringMinutes) && report.effectiveMonitoringMinutes >= 0
        ? Math.floor(report.effectiveMonitoringMinutes) : null
      const { reminders, responses } = reminderMetrics(report)
      this.setData({
        report, phase: 'data',
        durationHours: duration === null ? null : Math.floor(duration / 60),
        durationMinutes: duration === null ? null : duration % 60,
        reminderCount: reminders, responseCount: reminders === 0 ? null : responses, observationOnly: report.observationOnly === true && reminders === 0,
      })
      if (reminders >= 3 && report.startTime && report.endTime && !report.eventSpanOnly) this.loadNightSummary(id, report, reminders)
      if (!source) {
        services.reports.getFeedback(report.id).then(feedback => {
          if (id === this._requestId) this.setData({ feedback })
        }).catch(() => {})
      }
    } catch (error) {
      if (id === this._requestId) this.setData({ phase: 'error', error: toUserError(error, '睡眠记录') })
    }
  },
  selectQuickDate(event) {
    const date = event.currentTarget.dataset.date
    if (this._source || date === this.data.selectedDate || !this.data.recentDays.some(day => day.date === date)) return
    this._quickDate = date
    this.setData({ selectedDate: date, selectedMonth: monthLabel(date) })
    return this.load()
  },
  clearSourceSelection() { this._source = null; this._quickDate = ''; this.setData({ sourceLabel: '' }); return this.load() },
  retry() { return this.load() },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.retry(), wx) },
  openData() {
    const source = this._source
    const report = this.data.report
    const date = isoDate(report?.sourceDate) || isoDate(report?.id) || source?.sourceDate || source?.periodEnd || this._quickDate
    const params = []
    if (date) params.push('date=' + encodeURIComponent(date))
    if (source?.kind === 'seven-night') {
      params.push('scope=week')
      if (source.periodStart) params.push('periodStart=' + encodeURIComponent(source.periodStart))
      if (source.periodEnd) params.push('periodEnd=' + encodeURIComponent(source.periodEnd))
    } else if (report?.id) params.push('nightId=' + encodeURIComponent(report.id))
    return navigate(this, wx, 'navigateTo', { url: '/pages/report-detail/index' + (params.length ? '?' + params.join('&') : '') })
  },
  openFeedback() {
    const nightId = this.data.report?.id
    if (!nightId) return
    return navigate(this, wx, 'navigateTo', { url: '/pages/trends/index?focus=feedback&nightId=' + encodeURIComponent(nightId) })
  },
  async loadNightSummary(id, report, reminders) {
    try {
      const events = await services.reports.getEvents({ nightId: report.id })
      if (id === this._requestId) this.setData({ nightSummary: summarizeReminderTiming(report, events, reminders) })
    } catch {}
  },
})
