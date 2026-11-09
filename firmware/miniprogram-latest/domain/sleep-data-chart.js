const { shortDate } = require('./sleep-data-view')
const color = { ink: '#28231d', muted: '#6f6558', line: '#eae2d5', amber: '#876611', gold: '#f9c747', paper: '#fffdf8', olive: '#5c7044', gray: '#958878' }
function text(ctx, value, x, y, size = 10, align = 'left', fill = color.muted) { ctx.font = `${size}px sans-serif`; ctx.fillStyle = fill; ctx.textAlign = align; ctx.fillText(value, x, y) }
function line(ctx, x1, y1, x2, y2, fill = color.line, width = 1, dash = []) { ctx.beginPath(); ctx.strokeStyle = fill; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]) }
function dot(ctx, x, y, radius, fill) { ctx.beginPath(); ctx.fillStyle = fill; ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill() }
function box(ctx, x, y, width, height, fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, width, height) }
function bar(ctx, x, y, width, height, fill) {
  if (!ctx.roundRect) return box(ctx, x, y, width, height, fill)
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, [Math.min(6, height / 2), Math.min(6, height / 2), 0, 0])
  ctx.fillStyle = fill
  ctx.fill()
}
function paintChart(ctx, kind, chart, width, height) {
  ctx.clearRect(0, 0, width, height)
  if (kind === 'night') return nightChart(ctx, chart, width, height)
  return periodChart(ctx, kind, chart, width, height)
}
function nightChart(ctx, chart, width, height) {
  const left = 38, right = width - 6, top = 15, bottom = height - 25, ys = [29, 66, 103], duration = chart.duration
  const x = minute => left + minute / duration * (right - left)
  const protection = chart.events.find(event => event.type === 'sleep-protection' && event.positioned)
  if (protection) box(ctx, left, top - 5, x(protection.minute) - left, bottom - top + 3, '#f0e5d4')
  chart.events.filter(event => event.type === 'gap' && event.positioned && event.endMinute > event.minute && event.endMinute <= duration).forEach(event => {
    const start = x(event.minute), end = x(event.endMinute)
    box(ctx, start, top - 5, end - start, bottom - top + 3, '#eee8df')
    ctx.save(); ctx.beginPath(); ctx.rect(start, top - 5, end - start, bottom - top + 3); ctx.clip()
    for (let offset = -height; offset < end - start; offset += 5) line(ctx, start + offset, top - 5, start + offset + height, bottom, '#d2c6b5', 0.7)
    ctx.restore()
  })
  ;['鼾声', '提醒', '响应'].forEach((label, index) => { text(ctx, label, 0, ys[index] + 4); line(ctx, left, ys[index], right, ys[index]) })
  chart.events.filter(event => event.positioned).forEach(event => {
    if (event.type === 'snore') box(ctx, x(event.minute), ys[0] - 5, Math.max(2, event.endMinute > event.minute && event.endMinute <= duration ? x(event.endMinute) - x(event.minute) : 2), 10, color.gold)
    if (event.type === 'intervention') { line(ctx, x(event.minute), ys[1] - 8, x(event.minute), ys[1] + 8, color.amber, 3); dot(ctx, x(event.minute), ys[1] - 9, 3, color.amber) }
    if (event.type === 'response') dot(ctx, x(event.minute), ys[2], 3.5, color.olive)
  })
  const selected = chart.reminders[chart.selectedIndex]
  if (selected && selected.positioned) { line(ctx, x(selected.minute), top + 6, x(selected.minute), bottom - 3, color.amber, 1, [2, 3]); text(ctx, selected.time, x(selected.minute), 12, 10, 'center', color.amber) }
  const startParts = chart.start.split(':').map(Number), startMinute = startParts[0] * 60 + startParts[1]
  for (let minute = 60 - startMinute % 60; minute < duration; minute += 60) {
    const clock = (startMinute + minute) % 1440
    if (duration > 360 && Math.floor(clock / 60) % 2) continue
    text(ctx, `${String(Math.floor(clock / 60)).padStart(2, '0')}:00`, x(minute), height - 3, 9, 'center')
  }
  return { kind: 'night', points: chart.reminders.map((item, index) => ({ x: item.positioned ? x(item.minute) : -100, index })) }
}
function periodChart(ctx, kind, chart, width, height) {
  const rows = kind === 'month' ? chart.spans : chart.rows, prior = chart.previous || [], left = 23, right = width - 8, top = 33, bottom = height - 26
  const values = rows.concat(kind === 'week' ? prior : []).filter(row => row.rate !== null).map(row => row.rate)
  const max = Math.max(6, Math.ceil(Math.max(0, ...values) / 2) * 2), x = index => left + (index + 0.5) * (right - left) / rows.length, y = value => bottom - value / max * (bottom - top)
  for (let index = 0; index <= 3; index++) { const value = max * index / 3; line(ctx, left, y(value), right, y(value)); text(ctx, String(Math.round(value * 10) / 10), left - 8, y(value) + 3, 9, 'right') }
  rows.forEach((row, index) => { if (row.state !== 'future') line(ctx, x(index), top, x(index), bottom, color.line, .7, [2, 3]) })
  const selectedIndex = kind === 'week' ? rows.findIndex(row => row.date === chart.selectedDate) : chart.selectedIndex
  const selected = rows[selectedIndex]
  if (kind === 'week') {
    ;[prior, rows].forEach((series, order) => {
      let last = null
      rows.forEach((row, index) => {
        const value = series[index]
        if (row.state === 'future' || !value || value.rate === null) { last = null; return }
        const point = { x: x(index), y: y(value.rate) }
        if (last) line(ctx, last.x, last.y, point.x, point.y, order ? color.amber : color.gray, 2, order ? [] : [4, 3])
        dot(ctx, point.x, point.y, 3.5, order ? color.amber : color.gray); if (order) dot(ctx, point.x, point.y, 1.7, color.paper); last = point
      })
    })
    if (selected && selected.rate !== null) { dot(ctx, x(selectedIndex), y(selected.rate), 4.7, color.paper); dot(ctx, x(selectedIndex), y(selected.rate), 3, color.amber) }
  } else rows.forEach((row, index) => {
    if (row.rate !== null) { bar(ctx, x(index) - 14, y(row.rate), 28, Math.max(row.rate === 0 ? 1 : 0, bottom - y(row.rate)), index === selectedIndex ? color.amber : color.gold); if (index !== selectedIndex) text(ctx, row.rateLabel, x(index), y(row.rate) - 8, 11, 'center') }
    else text(ctx, '—', x(index), bottom - 8, 11, 'center')
  })
  rows.forEach((row, index) => text(ctx, kind === 'week' && rows.length === 7 ? ['一', '二', '三', '四', '五', '六', '日'][index] : row.axisLabel, x(index), height - 6, 10, 'center', row.state === 'future' ? '#b4a99c' : color.muted))
  let tooltip = null
  if (selected && selected.state !== 'future') {
    const label = kind === 'week' ? shortDate(selected.date) : selected.label
    const tipWidth = Math.min(kind === 'month' ? 160 : 128, width), tipHeight = kind === 'month' || selected.rate === null ? 91 : 76
    const tipX = Math.max(0, Math.min(x(selectedIndex) - 14, width - tipWidth)), tipY = 8
    if (selected.rate !== null) line(ctx, x(selectedIndex), tipY + tipHeight, x(selectedIndex), y(selected.rate), '#bd9258', 0.8, [2, 3])
    box(ctx, tipX, tipY, tipWidth, tipHeight, color.paper)
    ctx.strokeStyle = '#d9c7ac'; ctx.lineWidth = 1; ctx.strokeRect(tipX, tipY, tipWidth, tipHeight)
    text(ctx, label, tipX + 12, tipY + 20, 11)
    line(ctx, tipX + 12, tipY + 28, tipX + tipWidth - 12, tipY + 28)
    text(ctx, selected.rateLabel, tipX + 12, tipY + 57, 24, 'left', color.ink)
    text(ctx, '次/小时', tipX + 64, tipY + 56, 10)
    if (kind === 'month') text(ctx, `${selected.rateCount}/${selected.elapsedDays}晚可计算`, tipX + 12, tipY + 78, 10)
    else if (selected.rate === null) text(ctx, selected.valid ? '频率待同步' : '暂无有效记录', tipX + 12, tipY + 78, 10)
    tooltip = { x: tipX, y: tipY, width: tipWidth, height: tipHeight, label }
  }
  return { kind, left, right, tooltip, points: rows.map((row, index) => ({ x: x(index), index, date: row.date, disabled: row.state === 'future' })) }
}
function pickChartPoint(geometry, x) {
  const points = geometry.points
  if (!points.length || !Number.isFinite(x)) return null
  const closest = points.reduce((best, point) => Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best)
  if (closest.disabled || geometry.kind === 'night' && Math.abs(closest.x - x) > 18 || geometry.kind !== 'night' && (x < geometry.left || x > geometry.right)) return null
  return geometry.kind === 'week' ? { date: closest.date } : { index: closest.index }
}
module.exports = { paintChart, pickChartPoint }
