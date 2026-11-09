const calendarPeriods = require('./sleep-period')
const cloneSelection = value => JSON.parse(JSON.stringify(value))
class FilterState {
  constructor(today) { this.today = today; this.view = { scope: 'night', date: today, focus: {} }; this.draft = null; this.history = [] }
  open() { this.draft = cloneSelection(this.view); return this.draft }
  chooseScope(scope) {
    if (!this.draft || !['night', 'week', 'month'].includes(scope)) return false
    if (scope !== this.draft.scope) { this.draft.scope = scope; this.draft.focus = {}; delete this.draft.range }
    return true
  }
  chooseDate(date) {
    if (!this.draft || calendarPeriods.isoDate(date) !== date || date > this.today) return false
    this.draft.date = date; this.draft.focus = {}; delete this.draft.range
    return true
  }
  apply() {
    if (!this.draft) return false
    const query = value => JSON.stringify([value.scope, value.date, value.range || null])
    if (query(this.draft) !== query(this.view)) { this.view = cloneSelection(this.draft); this.history = [] }
    this.draft = null
    return true
  }
  cancel() { this.draft = null }
  focus(values) { Object.assign(this.view.focus, values) }
  drill(scope, date, range) {
    if (!['night', 'week'].includes(scope) || !calendarPeriods.isoDate(date) || date > this.today) return false
    this.history.push(cloneSelection(this.view))
    this.view = { scope, date, focus: {} }
    if (range) this.view.range = cloneSelection(range)
    return true
  }
  back() { if (!this.history.length) return false; this.view = this.history.pop(); this.draft = null; return true }
  range(value = this.view) {
    if (!value.range) return calendarPeriods.periodFor(value.date, value.scope, this.today)
    const { start, end } = value.range
    const dates = []
    for (let day = start; day <= end; day = calendarPeriods.shiftDate(day, 1)) dates.push(day)
    const queryEnd = end > this.today ? this.today : end
    return { start, end, queryEnd, dates, elapsedDays: dates.filter(day => day <= queryEnd).length, label: `${start} — ${end}` }
  }
}
module.exports = { FilterState }
