let pendingSource = null

function rememberSleepSource(source) {
  const date = String(source.sourceDate || source.nightId || '').match(/\d{4}-\d{2}-\d{2}/)
  pendingSource = {
    nightId: source.nightId || '',
    kind: source.kind,
    label: source.periodStart && source.periodEnd ? `${source.periodStart} — ${source.periodEnd}` : date ? date[0] : '所选记录',
  }
  return pendingSource
}
function clearSleepSource(source) { if (pendingSource === source) pendingSource = null }
function takeSleepSource() { const source = pendingSource; pendingSource = null; return source }
module.exports = { rememberSleepSource, takeSleepSource, clearSleepSource }
