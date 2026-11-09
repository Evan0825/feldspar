const MAX_SUMMARY_LENGTH = 4096
const MAX_EXCERPT_LENGTH = 180
const INCOMPLETE = '【要点不完整，请查看原会话全文】'

function buildConversationContext(context, messages) {
  const entries = []
  let incomplete = false
  const add = (label, value, limit = MAX_EXCERPT_LENGTH) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    if (!text) return
    if (text.length > limit) incomplete = true
    const entry = `${label}${text.slice(0, limit)}${text.length > limit ? '…' : ''}`
    if (!entries.includes(entry)) entries.push(entry)
  }
  // Carried entries already have their source labels. Legacy summaries remain unverified.
  const carried = String(context.carriedMemory || '')
  if (carried.includes(INCOMPLETE)) incomplete = true
  carried.split('\n').filter((line) => line && line !== INCOMPLETE).forEach((line) => {
    const known = /^(用户原话：|助手建议或推测（未获用户确认）：|记录解读（规则演示）：|旧会话摘要（来源未核实）：)/.test(line)
    add(known ? '' : '旧会话摘要（来源未核实）：', line, MAX_EXCERPT_LENGTH + 30)
  })
  add('记录解读（规则演示）：', [context.contextTitle, context.contextConclusion, context.contextSummary].filter(Boolean).join('；'))
  messages.forEach((message) => {
    if (message.status === 'discarded') return
    if (message.role === 'user') add('用户原话：', message.text)
    if (message.role === 'assistant') add('助手建议或推测（未获用户确认）：', message.text)
  })
  const selected = []
  let length = INCOMPLETE.length + 1
  for (const entry of entries) {
    if (length + entry.length + 1 > MAX_SUMMARY_LENGTH) { incomplete = true; continue }
    selected.push(entry)
    length += entry.length + 1
  }
  if (incomplete) selected.push(INCOMPLETE)
  return { summary: selected.join('\n'), incomplete }
}

module.exports = { buildConversationContext }
