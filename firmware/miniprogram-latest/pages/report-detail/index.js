const services = require('../../services/index')
const { toUserError, runServiceErrorAction } = require('../../domain/service-error')
const { dateKey } = require('../../domain/ai-display')
const { navigate, resetNavigation } = require('../../domain/ai-navigation')
const { isoDate, periodFor, movePeriod, shiftDate } = require('../../domain/sleep-period')
const { FilterState } = require('../../domain/sleep-filter')
const { countCollectionNights, confirmedPlan, loadCalibrationProgress } = require('../../domain/personal-strategy')
const { number, decimal, shortDate, fullDate, monthLabel, rangeLabel, rangeFor, buildCalendar, buildTrend, monthSpans, buildNight, reminderMetrics } = require('../../domain/sleep-data-view')

Page({
  data: {
    collection: null, collectionLoading: true, collectionPercent: null,
    loading: true, phase: 'loading', error: null, demoMode: services.serviceMode === 'mock',
    scope: 'night', selectedDate: '', selectedDateLabel: '', accessibleDateLabel: '', maxDate: '', periodStart: '', periodEnd: '', canBack: false, canAdvance: false,
    report: null, interpretation: null, snoreRateLabel: '—', durationHours: '—', durationMinutes: '—', responseCount: '—', reminderComparison: [], quality: '—', association: '—',
    nightDetail: { events: [], reminders: [], hasTimeline: false }, selectedReminder: null, reminderIndex: 0, eventsOpen: false, eventError: null,
    feedbackLabel: '未填写', explanationOpen: false, trend: null, previousTrend: null, chart: null, comparisonLabel: '', comparisonError: false,
    nights: [], validCount: 0, elapsedDays: 0, selectedPointDate: '', selectedPoint: null, selectedPointValid: false,
    spans: [], selectedSpanIndex: 0, selectedSpan: null,
    calendarOpen: false, calendarScope: 'night', calendarDate: '', calendarMonth: '', calendarMonthLabel: '', calendarDays: [], calendarPreview: '', calendarNext: false,
    calendarWeekdays: ['一', '二', '三', '四', '五', '六', '日'], infoTitle: '', infoText: '',
  },
  onLoad(options = {}) {
    const today = dateKey(new Date()), date = [isoDate(options.date) || isoDate(options.nightId) || today, today].sort()[0]
    this._filter = new FilterState(today)
    const scope = ['week', 'month'].includes(options.scope) ? options.scope : 'night'
    const start = isoDate(options.periodStart), end = isoDate(options.periodEnd)
    const range = scope === 'week' && start && end && start <= end && end <= today && shiftDate(start, 6) >= end ? { start, end } : undefined
    this._filter.view = { scope, date, focus: {}, ...(range ? { range } : {}) }
    this._entryNightId = options.nightId ? decodeURIComponent(options.nightId) : ''
    this._nightId = this._entryNightId || `night-${date}`
    this.setData({ maxDate: today })
    return this.load()
  },
  onShow() { resetNavigation(this); return this.loadCollection() },
  onUnload() {
    this._requestId = (this._requestId || 0) + 1
    this._calendarRequest = (this._calendarRequest || 0) + 1
    this._collectionRequest = (this._collectionRequest || 0) + 1
  },
  onPageScroll(event) { this._scrollTop = event.scrollTop },
  async load() {
    const requestId = this._requestId = (this._requestId || 0) + 1
    this._filter.today = this.data.maxDate
    const selection = this._filter.view, range = this._filter.range(), nightId = this._nightId
    const currentYear = this.data.maxDate.slice(0, 4)
    const dayPrefix = selection.date === this.data.maxDate ? '今天 · ' : ''
    const label = selection.scope === 'night' ? dayPrefix + (selection.date.startsWith(currentYear) ? shortDate(selection.date) : fullDate(selection.date)) : compactPeriodLabel(selection, range, currentYear)
    const accessibleDateLabel = selection.scope === 'night' ? dayPrefix + fullDate(selection.date)
      : selection.scope === 'month' ? monthLabel(selection.date.slice(0, 7))
        : range.start === range.end ? fullDate(range.start) : `${fullDate(range.start)}至${fullDate(range.end)}`
    this.setData({ loading: true, phase: 'loading', error: null, report: null, interpretation: null, eventError: null, explanationOpen: false, infoTitle: '',
      scope: selection.scope, selectedDate: selection.date, selectedDateLabel: label, accessibleDateLabel, periodStart: range.start, periodEnd: range.end, elapsedDays: range.elapsedDays, canBack: this._filter.history.length > 0, canAdvance: periodFor(movePeriod(selection.date, selection.scope, 1), selection.scope, this.data.maxDate).start <= this.data.maxDate,
      nightDetail: { events: [], reminders: [], hasTimeline: false }, selectedReminder: null, trend: null, chart: null, selectedPoint: null })
    try {
      if (selection.scope !== 'night') {
        const query = { periodStart: range.start, periodEnd: range.queryEnd }
        const previousRange = rangeFor(shiftDate(range.start, -7), shiftDate(range.queryEnd, -7), this.data.maxDate)
        const currentRead = services.reports.getPeriodTrend ? services.reports.getPeriodTrend(query) : services.reports.getSevenNightTrend(query)
        const [current, previous] = await Promise.all([settle(currentRead), settle(selection.scope === 'week' && services.reports.getPeriodTrend ? services.reports.getPeriodTrend({ periodStart: previousRange.start, periodEnd: previousRange.queryEnd }) : Promise.resolve([]))])
        if (requestId !== this._requestId) return
        if (!current.ok) throw current.error
        this._periodRecords = current.value
        this._period = range
        this._previousTrend = buildTrend(previous.ok ? previous.value : [], previousRange)
        this.setData({ comparisonError: !previous.ok })
        this.presentPeriod()
        return
      }
      const report = await services.reports.getByNightId(nightId)
      if (requestId !== this._requestId) return
      if (!report || report.hasData === false || (report.sourceDate || isoDate(report.id)) !== selection.date) { this.setData({ phase: 'empty' }); return }
      const minutes = number(report.effectiveMonitoringMinutes)
      const { reminders, responses: count } = reminderMetrics(report)
      const reminderComparison = [
        { name: '提醒次数', icon: '/images/ui/vibration.png', value: reminders, fill: reminders > 0 ? 100 : 0 },
        { name: '后续响应', icon: '/images/ai-ui/check.png', value: reminders === 0 ? null : count, fill: reminders > 0 && count !== null ? count * 100 / reminders : 0 },
      ]
      const snoreCount = report.snoreCountUnconfirmed ? undefined : number(report.confirmedSnoreEventCount, report.snoreEventCount)
      this.setData({ report, phase: 'data', reminderComparison, snoreRateLabel: decimal(snoreCount !== undefined && minutes > 0 ? snoreCount / (minutes / 60) : null), durationHours: minutes === undefined ? '—' : Math.floor(minutes / 60), durationMinutes: minutes === undefined ? '—' : minutes % 60, responseCount: count === null ? '—' : count,
        quality: Number.isFinite(report.dataQualityScore) ? `${report.dataQualityScore}%` : report.dataQuality || '—', association: Number.isFinite(report.supineAssociationRate) ? `${report.supineAssociationRate}%` : '—' })
      if (report.id === this._entryNightId && services.ai?.getOverview) this.loadInterpretation(requestId, report.id)
      const [events, feedback] = await Promise.all([
        settle(services.reports.getEvents ? services.reports.getEvents({ nightId: report.id }) : Promise.resolve([])),
        settle(services.reports.getFeedback ? services.reports.getFeedback(report.id) : Promise.resolve(null)),
      ])
      if (requestId !== this._requestId) return
      const nightDetail = buildNight({ ...report, sourceDate: report.sourceDate || isoDate(nightId) }, events.ok ? events.value : [])
      const reminderIndex = Math.min(selection.focus.reminder || 0, Math.max(0, nightDetail.reminders.length - 1))
      this.setData({ nightDetail, eventError: events.ok ? null : toUserError(events.error, '夜间事件'), reminderIndex, selectedReminder: nightDetail.reminders[reminderIndex] || null, eventsOpen: Boolean(selection.focus.eventsOpen),
        feedbackLabel: !feedback.ok ? '读取失败' : feedback.value && feedback.value.nightId === report.id && typeof feedback.value.awakened === 'boolean' ? feedback.value.awakened ? '被弄醒' : '未被弄醒' : '未填写',
        chart: { ...nightDetail, selectedIndex: reminderIndex } })
    } catch (error) { if (requestId === this._requestId) this.setData({ phase: 'error', error: toUserError(error, '睡眠数据') }) }
    finally {
      if (requestId === this._requestId) {
        this.setData({ loading: false })
        if (this._restoreScroll !== undefined) { wx.pageScrollTo({ scrollTop: this._restoreScroll, duration: 0 }); this._restoreScroll = undefined }
      }
    }
  },
  presentPeriod() {
    const trend = buildTrend(this._periodRecords, this._period), selection = this._filter.view
    const point = trend.rows.find(row => row.date === selection.focus.date) || trend.rows.find(row => row.date === selection.date && row.valid) || trend.rows.filter(row => row.valid).slice(-1)[0]
    const spans = monthSpans(this._periodRecords, this._period)
    const latestSpan = spans.reduce((last, span, index) => span.validCount ? index : last, 0)
    const selectedSpanIndex = Math.min(selection.focus.span ?? latestSpan, spans.length - 1)
    const prior = this._previousTrend
    const comparable = trend.rateCount >= 3 && prior.rateCount >= 3 && prior.rate > 0
    const change = comparable ? Math.round((trend.rate / prior.rate - 1) * 100) : null
    this.setData({ trend, periodDataSource: this._periodRecords.dataSource || '', periodFeedbackUnavailable: Boolean(this._periodRecords.feedbackUnavailable), previousTrend: prior, nights: trend.rows, validCount: trend.validCount, phase: trend.validCount ? 'data' : 'empty',
      comparisonLabel: this.data.comparisonError ? '上周数据未同步' : change === null ? '可比记录不足' : `较上周同期 ${change > 0 ? '↑' : '↓'}${Math.abs(change)}%`,
      selectedPointDate: point ? point.date : '', selectedPoint: point || null, selectedPointValid: Boolean(point && point.valid), canStepBack: selection.scope === 'week' ? point?.date > this._period.start : selectedSpanIndex > 0, canStepForward: selection.scope === 'week' ? point?.date < this._period.queryEnd : selectedSpanIndex < spans.length - 1, spans, selectedSpanIndex, selectedSpan: spans[selectedSpanIndex] || null,
      chart: { rows: trend.rows, previous: prior.rows, selectedDate: point ? point.date : '', spans, selectedIndex: selectedSpanIndex } })
  },
  changeDate(value, scope = this.data.scope) {
    const date = isoDate(value)
    if (!date || date > this.data.maxDate || !['night', 'week', 'month'].includes(scope)) return
    this._filter.view = { scope, date, focus: {} }; this._filter.history = []
    this._nightId = `night-${date}`
    this._restoreScroll = 0
    return this.load()
  },
  stepPeriod(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if (this.data.canBack || ![-1, 1].includes(direction) || (direction > 0 && !this.data.canAdvance)) return
    const date = movePeriod(this.data.selectedDate, this.data.scope, direction)
    return this.changeDate(date > this.data.maxDate ? this.data.maxDate : date)
  },
  async loadCollection() {
    const requestId = this._collectionRequest = (this._collectionRequest || 0) + 1
    this.setData({ collectionLoading: true })
    let collection = null
    try {
      const settings = await settle(services.device?.getTonightSettings?.())
      const plan = confirmedPlan(settings.value, settings.value?.deviceId, wx, services.serviceMode)
      if (plan && ['preliminary', 'calibrating', 'iterating'].includes(plan.stage)) {
        const progress = await loadCalibrationProgress(services.reports, plan, dateKey(new Date()))
        collection = { ...progress, calibrating: true }
      } else {
        const getNights = services.reports.getCollectionNights || services.reports.getSevenNightTrend
        const nights = countCollectionNights(await getNights())
        if (nights !== null) collection = { nights, days: 7, calibrating: false }
      }
    } catch { /* An unavailable progress count must not block the selected report. */ }
    if (requestId === this._collectionRequest) {
      const collectionPercent = Number.isFinite(collection?.nights) && collection.days > 0 ? Math.min(100, collection.nights * 100 / collection.days) : null
      this.setData({ collection, collectionPercent, collectionLoading: false })
    }
  },
  openCollection() { return navigate(this, wx, 'navigateTo', { url: '/pages/strategy/index' }) },
  stepChart(event) {
    const direction = Number(event.currentTarget.dataset.direction)
    if (this.data.scope === 'month') {
      return this.selectSpan({ detail: { index: this.data.selectedSpanIndex + direction } })
    }
    const points = this.data.nights.filter(row => row.state !== 'future')
    const current = points.findIndex(row => row.date === this.data.selectedPointDate)
    const next = points[current + direction]
    if (next) this.selectPoint({ detail: { date: next.date } })
  },
  selectDate(event) { return this.changeDate(event.detail.value) },
  selectScope(event) { return this.changeDate(this.data.selectedDate, event.currentTarget.dataset.scope) },
  openCalendar() {
    this._filter.today = this.data.maxDate
    this._filter.open()
    this._calendarRecords = this._periodRecords || []
    this._calendarMonth = this.data.selectedDate.slice(0, 7)
    this.setData({ calendarOpen: true })
    this.presentCalendar()
    return this.loadCalendarRecords()
  },
  async loadCalendarRecords() {
    const month = this._calendarMonth, request = this._calendarRequest = (this._calendarRequest || 0) + 1
    if (!services.reports.getPeriodTrend) return
    const range = periodFor(month + '-01', 'month', this.data.maxDate)
    const result = await settle(services.reports.getPeriodTrend({ periodStart: range.start, periodEnd: range.queryEnd }))
    if (request !== this._calendarRequest || !this.data.calendarOpen || month !== this._calendarMonth) return
    this._calendarRecords = result.ok ? result.value : []
    this.presentCalendar()
  },
  presentCalendar() {
    const draft = this._filter.draft
    if (!draft) return
    const range = this._filter.range(draft)
    this.setData({ calendarScope: draft.scope, calendarDate: draft.date, calendarMonth: this._calendarMonth, calendarMonthLabel: monthLabel(this._calendarMonth), calendarNext: this._calendarMonth < this.data.maxDate.slice(0, 7),
      calendarDays: buildCalendar(this._calendarMonth, draft, this.data.maxDate, this._calendarRecords),
      calendarPreview: draft.scope === 'night' ? fullDate(draft.date) : draft.scope === 'month' ? monthLabel(draft.date.slice(0, 7)) : rangeLabel(range) })
  },
  chooseCalendarScope(event) {
    this._filter.chooseScope(event.currentTarget.dataset.scope)
    if (this._filter.draft.scope === 'month') this._filter.chooseDate(this.monthAnchor(this._calendarMonth))
    this.presentCalendar()
  },
  chooseCalendarDate(event) {
    const date = event.currentTarget.dataset.date
    if (!this._filter.chooseDate(date)) return
    const changed = this._calendarMonth !== date.slice(0, 7)
    this._calendarMonth = date.slice(0, 7)
    if (this._filter.draft.scope === 'month') this._filter.chooseDate(this.monthAnchor(this._calendarMonth))
    this.presentCalendar()
    if (changed) return this.loadCalendarRecords()
  },
  monthAnchor(month) { const end = periodFor(month + '-01', 'month', this.data.maxDate).end; return end > this.data.maxDate ? this.data.maxDate : end },
  chooseCalendarMonth(event) {
    const month = String(event.detail.value).slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(month) || !isoDate(month + '-01') || month > this.data.maxDate.slice(0, 7)) return
    this._calendarMonth = month
    if (this._filter.draft.scope === 'month') this._filter.chooseDate(this.monthAnchor(month))
    this.presentCalendar()
    return this.loadCalendarRecords()
  },
  moveCalendarMonth(event) { return this.chooseCalendarMonth({ detail: { value: movePeriod(this._calendarMonth + '-01', 'month', Number(event.currentTarget.dataset.direction)) } }) },
  calendarCurrent() { this._filter.chooseDate(this.data.maxDate); this._calendarMonth = this.data.maxDate.slice(0, 7); this.presentCalendar(); return this.loadCalendarRecords() },
  cancelCalendar() { this._filter.cancel(); this._calendarRequest = (this._calendarRequest || 0) + 1; this.setData({ calendarOpen: false }) },
  applyCalendar() {
    const before = JSON.stringify([this._filter.view.scope, this._filter.view.date, this._filter.view.range || null])
    this._filter.apply(); this._calendarRequest = (this._calendarRequest || 0) + 1; this.setData({ calendarOpen: false })
    if (before === JSON.stringify([this._filter.view.scope, this._filter.view.date, this._filter.view.range || null])) return
    this._nightId = `night-${this._filter.view.date}`; this._restoreScroll = 0
    return this.load()
  },
  selectPoint(event) {
    const date = event.detail && event.detail.date || event.currentTarget && event.currentTarget.dataset.date
    const point = this.data.nights.find(row => row.date === date && row.state !== 'future')
    if (point) { this._filter.focus({ date }); this.setData({ selectedPointDate: date, selectedPoint: point, selectedPointValid: point.valid, canStepBack: date > this._period.start, canStepForward: date < this._period.queryEnd, chart: { ...this.data.chart, selectedDate: date } }) }
  },
  selectSpan(event) {
    const index = Number(event.detail && event.detail.index !== undefined ? event.detail.index : event.currentTarget.dataset.index)
    if (!this.data.spans[index]) return
    this._filter.focus({ span: index }); this.setData({ selectedSpanIndex: index, canStepBack: index > 0, canStepForward: index < this.data.spans.length - 1, selectedSpan: this.data.spans[index], chart: { ...this.data.chart, selectedIndex: index } })
  },
  async openSelectedWeek() {
    const span = this.data.selectedSpan
    if (!span || !span.validCount) return
    this._filter.focus({ scroll: this._scrollTop || 0 })
    const date = span.rows.filter(row => row.valid).slice(-1)[0].date
    this._filter.drill('week', date, { start: span.start, end: span.end })
    this._restoreScroll = 0
    return this.load()
  },
  openSelectedNight() {
    if (!this.data.selectedPointValid) return
    this._filter.focus({ scroll: this._scrollTop || 0 })
    this._filter.drill('night', this.data.selectedPointDate)
    this._nightId = `night-${this.data.selectedPointDate}`; this._restoreScroll = 0
    return this.load()
  },
  backToPeriod() {
    if (!this._filter.back()) return
    this._nightId = `night-${this._filter.view.date}`; this._restoreScroll = this._filter.view.focus.scroll || 0
    return this.load()
  },
  selectReminder(event) {
    const index = Number(event.detail && event.detail.index !== undefined ? event.detail.index : event.currentTarget.dataset.index)
    const reminder = this.data.nightDetail.reminders[index]
    if (!reminder) return
    this._filter.focus({ reminder: index }); this.setData({ reminderIndex: index, selectedReminder: reminder, chart: { ...this.data.chart, selectedIndex: index } })
  },
  moveReminder(event) { this.selectReminder({ detail: { index: this.data.reminderIndex + Number(event.currentTarget.dataset.direction) } }) },
  toggleEvents() {
    const eventsOpen = !this.data.eventsOpen
    if (eventsOpen) this._eventScroll = this._scrollTop || 0
    this._filter.focus({ eventsOpen })
    this.setData({ eventsOpen }, () => wx.pageScrollTo(eventsOpen ? { selector: '#all-events', duration: 180 } : { scrollTop: this._eventScroll || 0, duration: 0 }))
  },
  toggleExplanation() {
    if (this.data.scope !== 'night') return this.explainPeriod()
    this.setData({ infoTitle: '数据说明', infoText: `有效监测：${this.data.durationHours}小时${this.data.durationMinutes}分\n数据质量：${this.data.quality}\n仰卧关联：${this.data.association}\n\n有效监测不等于实际睡眠时长；关联和后续响应不能认定因果或医疗疗效。` })
  },
  async loadInterpretation(requestId, nightId) {
    try {
      const interpretation = await services.ai.getOverview('single-night')
      if (requestId === this._requestId && interpretation?.nightId === nightId && interpretation.hasData !== false) {
        this.setData({ interpretation })
      }
    } catch {}
  },
  openInterpretation() {
    const record = this.data.interpretation
    if (record) return navigate(this, wx, 'navigateTo', { url: '/pages/ai-detail/index?interpretationId=' + encodeURIComponent(record.interpretationId) + '&sourceDate=' + encodeURIComponent(record.sourceDate || this.data.selectedDate) })
  },
  askAi() {
    if (!this.data.report) return
    const date = isoDate(this.data.report.sourceDate) || isoDate(this.data.report.id)
    if (!date) return
    return navigate(this, wx, 'navigateTo', { url: `/pages/ai-chat/index?sourceDate=${encodeURIComponent(date)}&focus=1` })
  },
  explainPeriod() { this.setData({ infoTitle: '周期数据说明', infoText: '鼾声频率按有效监测小时计算；缺失的时长和事件数不按0统计。提醒均值只按有提醒次数的有效晚计算；感受仅统计已填写的反馈。记录不能替代医疗检查。' }) },
  closeInfo() { this.setData({ infoTitle: '' }) },
  noop() {},
  retry() { return this.load() },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.load(), wx) },
  openEvents() { if (this.data.report) wx.navigateTo({ url: `/pages/events/index?nightId=${encodeURIComponent(this.data.report.id)}&date=${encodeURIComponent(this.data.selectedDateLabel)}` }) },
})
function compactPeriodLabel(selection, range, currentYear) {
  if (selection.scope === 'month') {
    const month = selection.date.slice(0, 7)
    return month.startsWith(currentYear) ? `${Number(month.slice(5))}月` : monthLabel(month)
  }
  const [startYear, startMonth, startDay] = range.start.split('-').map(Number)
  const [endYear, endMonth, endDay] = range.end.split('-').map(Number)
  const start = `${startMonth}/${startDay}`
  const end = `${endMonth}/${endDay}`
  if (startYear !== endYear) return `${startYear}/${start}–${endYear}/${end}`
  const prefix = String(startYear) === currentYear ? '' : `${startYear}年 `
  return range.start === range.end ? prefix + start : `${prefix}${start}–${end}`
}
async function settle(promise) { try { return { ok: true, value: await promise } } catch (error) { return { ok: false, error } } }
